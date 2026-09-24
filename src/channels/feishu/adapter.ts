import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { Client, WSClient, EventDispatcher, Domain, LoggerLevel, defaultHttpInstance } from "@larksuiteoapi/node-sdk";
import type { FeishuAcceptance, FeishuScope, FeishuText, Outbox } from "../../runtime/types.js";

export type FeishuConfig = FeishuScope & { appSecret: string; statePath: string; archiveDir?: string };
export type SafeLog = (record: { event: string; [key: string]: string | number | undefined }) => void;
export type FeishuSend = (messageId: string, outbox: Outbox) => Promise<void>;
export type FeishuSendText = (receiveId: string, text: string, uuid: string) => Promise<{ messageId: string }>;
export type FeishuTransport = {
  start: (receive: (event: unknown) => Promise<void>) => Promise<void>;
  close: () => void;
  send: FeishuSend;
  sendText?: FeishuSendText;
};

export class FeishuError extends Error {
  constructor(
    readonly code: "feishu_configuration" | "feishu_timeout" | "feishu_rate_limited" | "feishu_unavailable"
      | "feishu_forbidden" | "feishu_target_unavailable" | "feishu_invalid_payload" | "feishu_payload_too_large",
    readonly permanent = false,
    readonly retryAfterMs = 0,
  ) { super(code); this.name = "FeishuError"; }
}

export function readFeishuConfig(env: NodeJS.ProcessEnv): FeishuConfig {
  const appId = env.FEISHU_APP_ID?.trim() ?? "";
  const appSecret = env.FEISHU_APP_SECRET?.trim() ?? "";
  const tenantKey = env.FEISHU_TENANT_KEY?.trim() ?? "";
  const ownerOpenId = env.FEISHU_ALLOWED_OPEN_ID?.trim() ?? "";
  const statePath = env.KNOWLEDGE_RADAR_STATE_PATH?.trim() ?? "";
  if (!/^cli_[0-9a-fA-F]{16}$/.test(appId) || !appSecret || !tenantKey || !/^ou_[a-zA-Z0-9]+$/.test(ownerOpenId) || !statePath) {
    throw new FeishuError("feishu_configuration", true);
  }
  return { appId, appSecret, tenantKey, ownerOpenId, statePath,
    ...(env.KNOWLEDGE_RADAR_ARCHIVE_DIR?.trim() ? { archiveDir: env.KNOWLEDGE_RADAR_ARCHIVE_DIR.trim() } : {}) };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function nonempty(value: unknown): value is string { return typeof value === "string" && Boolean(value.trim()); }

export function parseFeishuText(event: unknown, scope: FeishuScope): FeishuText | null {
  const data = record(event);
  const sender = record(data.sender);
  const message = record(data.message);
  const tenant = data.tenant_key ?? sender.tenant_key;
  if ((data.app_id !== undefined && data.app_id !== scope.appId) || tenant !== scope.tenantKey
    || (sender.tenant_key !== undefined && sender.tenant_key !== scope.tenantKey)
    || sender.sender_type !== "user" || record(sender.sender_id).open_id !== scope.ownerOpenId
    || message.chat_type !== "p2p" || message.message_type !== "text"
    || !nonempty(message.chat_id) || !nonempty(message.message_id) || typeof message.content !== "string") return null;
  let text: unknown;
  try { text = record(JSON.parse(message.content)).text; } catch { return null; }
  return nonempty(text) ? { appId: scope.appId, tenantKey: scope.tenantKey, ownerOpenId: scope.ownerOpenId,
    chatId: message.chat_id, messageId: message.message_id, text } : null;
}

export function receiveFeishuEvent(
  event: unknown, scope: FeishuScope, accept: (text: FeishuText) => FeishuAcceptance, log: SafeLog,
): void {
  const text = parseFeishuText(event, scope);
  if (!text) { log({ event: "ignored", reason: "unsupported_or_unauthorized" }); return; }
  // No catch here: a failed transaction MUST reject the SDK callback, producing a failed ACK.
  const result = accept(text);
  if (result.outcome === "ignored") log({ event: "ignored", reason: result.reason });
  else log({ event: result.outcome, conversation_id: result.conversationId, turn_id: result.turnId });
}

export function feishuReplyRequest(messageId: string, outbox: Outbox) {
  const text = record(outbox.payload).text;
  if (!nonempty(messageId) || !nonempty(text) || text.length > 6_000) throw new FeishuError("feishu_invalid_payload", true);
  const content = JSON.stringify({ text });
  if (Buffer.byteLength(content, "utf8") > 20_000) throw new FeishuError("feishu_payload_too_large", true);
  return { path: { message_id: messageId }, data: { msg_type: "text", content,
    uuid: createHash("sha256").update(outbox.id).digest("hex").slice(0, 40) } };
}

export function feishuTextRequest(receiveId: string, text: string, uuid: string) {
  if (!nonempty(receiveId) || !nonempty(text) || !/^[a-f0-9]{40}$/.test(uuid)) {
    throw new FeishuError("feishu_invalid_payload", true);
  }
  const content = JSON.stringify({ text });
  if (Buffer.byteLength(content, "utf8") > 20_000) throw new FeishuError("feishu_payload_too_large", true);
  return { params: { receive_id_type: "open_id" as const }, data: {
    receive_id: receiveId, msg_type: "text", content, uuid,
  } };
}

export function classifyFeishuError(value: unknown, now = Date.now()): FeishuError {
  if (value instanceof FeishuError) return value;
  const error = record(value);
  const response = record(error.response);
  const body = record(response.data ?? value);
  const code = body.code;
  const status = response.status;
  const retry = record(response.headers)["retry-after"];
  const seconds = typeof retry === "string" || typeof retry === "number" ? Number(retry) : NaN;
  const date = typeof retry === "string" ? Date.parse(retry) : NaN;
  const requestedDelay = Math.ceil(Number.isFinite(seconds) ? seconds * 1_000 : Number.isFinite(date) ? date - now : 0);
  const retryAfterMs = Number.isSafeInteger(requestedDelay) && requestedDelay > 0
    && Number.isSafeInteger(now + requestedDelay) ? requestedDelay : 0;
  if (status === 429 || code === 230020 || code === 99991400) return new FeishuError("feishu_rate_limited", false, retryAfterMs);
  if (status === 403 || [230002, 230006, 230013, 230017, 230018, 230027, 230035, 230038, 99991672].includes(Number(code))) {
    return new FeishuError("feishu_forbidden", true);
  }
  if ([230011, 230019, 230050, 230054].includes(Number(code))) return new FeishuError("feishu_target_unavailable", true);
  if (code === 230025) return new FeishuError("feishu_payload_too_large", true);
  if ([230001, 230022, 230028].includes(Number(code))) return new FeishuError("feishu_invalid_payload", true);
  if (["ETIMEDOUT", "ECONNABORTED", "ERR_CANCELED"].includes(String(error.code))) return new FeishuError("feishu_timeout");
  return new FeishuError("feishu_unavailable");
}

export const quietSdkLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };

type TransportOptions = {
  http?: ReturnType<typeof defaultHttpInstance.create>;
  makeWs?: (params: ConstructorParameters<typeof WSClient>[0]) => Pick<WSClient, "start" | "close">;
  sendTimeoutMs?: number;
};

export function createFeishuTransport(
  config: FeishuConfig, log: SafeLog, fatal: () => void, options: TransportOptions = {},
): FeishuTransport {
  const deadline = new AsyncLocalStorage<AbortSignal>();
  const http = options.http ?? defaultHttpInstance.create();
  http.defaults.timeout = 10_000;
  http.defaults.maxRedirects = 0;
  // SDK token fetch and message request inherit the SAME deadline; no detached retries.
  http.interceptors.request.use(request => {
    const signal = deadline.getStore();
    signal?.throwIfAborted();
    if (signal) request.signal = signal;
    return request;
  });
  http.interceptors.response.use(response => response.data);
  const base = { appId: config.appId, appSecret: config.appSecret, domain: Domain.Feishu,
    // The response interceptor unwraps AxiosResponse to the SDK's body-returning contract.
    httpInstance: http as unknown as NonNullable<ConstructorParameters<typeof Client>[0]["httpInstance"]>,
    logger: quietSdkLogger, loggerLevel: LoggerLevel.error };
  const client = new Client(base);
  let closed = false;
  const ws = (options.makeWs ?? (params => new WSClient(params)))({
    ...base, handshakeTimeoutMs: 15_000,
    onReady: () => { if (!closed) log({ event: "connected" }); },
    onReconnecting: () => { if (!closed) log({ event: "reconnecting" }); },
    onReconnected: () => { if (!closed) log({ event: "reconnected" }); },
    onError: () => { if (!closed) { log({ event: "connection_failed" }); fatal(); } },
  });
  return {
    async start(receive) {
      log({ event: "connecting" });
      const dispatcher = new EventDispatcher({ logger: quietSdkLogger, loggerLevel: LoggerLevel.error })
        .register({ "im.message.receive_v1": receive });
      await ws.start({ eventDispatcher: dispatcher });
    },
    close() { closed = true; ws.close({ force: true }); },
    async send(messageId, outbox) {
      const request = feishuReplyRequest(messageId, outbox);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.sendTimeoutMs ?? 10_000);
      try {
        const response = await deadline.run(controller.signal, () => client.im.message.reply(request));
        if (response.code !== 0 || !nonempty(response.data?.message_id)) throw classifyFeishuError(response);
      } catch (error) {
        throw controller.signal.aborted ? new FeishuError("feishu_timeout") : classifyFeishuError(error);
      } finally { clearTimeout(timer); }
    },
    async sendText(receiveId, text, uuid) {
      const request = feishuTextRequest(receiveId, text, uuid);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.sendTimeoutMs ?? 10_000);
      try {
        const response = await deadline.run(controller.signal, () => client.im.message.create(request));
        if (response.code !== 0 || !nonempty(response.data?.message_id)) throw classifyFeishuError(response);
        return { messageId: response.data.message_id };
      } catch (error) {
        throw controller.signal.aborted ? new FeishuError("feishu_timeout") : classifyFeishuError(error);
      } finally { clearTimeout(timer); }
    },
  };
}
