import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { WSClient, EventDispatcher, defaultHttpInstance } from "@larksuiteoapi/node-sdk";
import { classifyFeishuError, createFeishuTransport, feishuInteractiveRequest, feishuReplyRequest, feishuTextRequest, FeishuError, parseFeishuCardAction, parseFeishuText,
  quietSdkLogger, readFeishuConfig, receiveFeishuEvent, type FeishuConfig } from "./adapter.js";
import type { Outbox } from "../../runtime/types.js";

const config: FeishuConfig = { appId: "cli_0000000000000001", appSecret: "secret-never-log", tenantKey: "tenant",
  ownerOpenId: "ou_owner", statePath: ":memory:" };
const event = () => ({ app_id: config.appId, tenant_key: config.tenantKey,
  sender: { sender_type: "user", tenant_key: config.tenantKey, sender_id: { open_id: config.ownerOpenId } },
  message: { chat_id: "oc_chat", message_id: "om_message", chat_type: "p2p", message_type: "text",
    content: JSON.stringify({ text: " private text https://example.com " }) } });
const outbox = (payload: unknown = { text: "回答" }) => ({ id: "outbox-id", payload } as Outbox);
const noWs = () => ({ start: async () => {}, close: () => {} });

test("configuration and untrusted events fail closed; preserve text and never dispatch invalid inputs", () => {
  const env = { FEISHU_APP_ID: config.appId, FEISHU_APP_SECRET: config.appSecret, FEISHU_TENANT_KEY: config.tenantKey,
    FEISHU_ALLOWED_OPEN_ID: config.ownerOpenId, KNOWLEDGE_RADAR_STATE_PATH: config.statePath };
  assert.deepEqual(readFeishuConfig(env), config);
  for (const key of Object.keys(env)) assert.throws(() => readFeishuConfig({ ...env, [key]: "" }), FeishuError);
  assert.equal(parseFeishuText(event(), config)?.text, " private text https://example.com ");
  const mutations: ((e: ReturnType<typeof event>) => void)[] = [
    e => { e.app_id = "other"; }, e => { e.tenant_key = "other"; },
    e => { e.sender.tenant_key = "other"; }, e => { e.sender.sender_id.open_id = "other"; },
    e => { e.sender.sender_type = "app"; }, e => { e.message.chat_type = "group"; },
    e => { e.message.message_type = "image"; }, e => { e.message.chat_id = ""; },
    e => { e.message.message_id = ""; }, e => { e.message.content = "{"; },
    e => { e.message.content = '{"text":"  "}'; }, e => { e.message.content = '{"text":42}'; },
  ];
  for (const mutate of mutations) {
    const value = event(); mutate(value);
    receiveFeishuEvent(value, config, () => assert.fail("no storage call"), () => {});
  }
  for (const value of [null, [], {}, "event"]) assert.equal(parseFeishuText(value, config), null);
  const value = event();
  const withoutTenant = { ...value, tenant_key: undefined, sender: { ...value.sender, tenant_key: undefined } };
  assert.equal(parseFeishuText(withoutTenant, config), null);
  assert.throws(() => receiveFeishuEvent(event(), config, () => { throw Error("commit failed"); }, () => {}));
});

test("card action parser validates scope, event identity, and controlled interest values", () => {
  const value = {
    app_id: config.appId,
    tenant_key: config.tenantKey,
    event_id: "event-1",
    context: { open_message_id: "om_card" },
    operator: { open_id: config.ownerOpenId },
    action: { tag: "button", value: { action: "digest_interest", item_id: "item-1", target_interested: true } },
  };
  assert.deepEqual(parseFeishuCardAction(value, config), {
    ...config, eventId: "event-1", messageId: "om_card", operatorOpenId: config.ownerOpenId,
    action: { action: "digest_interest", item_id: "item-1", target_interested: true },
  });
  for (const mutate of [
    (event: typeof value) => { event.app_id = "other"; },
    (event: typeof value) => { event.tenant_key = "other"; },
    (event: typeof value) => { event.event_id = ""; },
    (event: typeof value) => { event.context.open_message_id = ""; },
    (event: typeof value) => { event.operator.open_id = "other"; },
    (event: typeof value) => { event.action.tag = "select_static"; },
    (event: typeof value) => { (event.action.value as Record<string, unknown>).target_interested = "true"; },
    (event: typeof value) => { event.action.value.action = "other"; },
  ]) {
    const event = structuredClone(value); mutate(event);
    assert.equal(parseFeishuCardAction(event, config), null);
  }
});

test("reply uses immutable destination, deterministic bounded UUID, and actual serialized bytes", () => {
  const a = feishuReplyRequest("om_original", outbox());
  assert.equal(a.path.message_id, "om_original");
  assert.equal(a.data.msg_type, "text");
  assert.equal(a.data.uuid.length, 40);
  assert.deepEqual(feishuReplyRequest("om_original", outbox()), a);
  assert.equal(feishuReplyRequest("om", outbox({ text: "中".repeat(6_000) })).data.content.length, 6_011);
  assert.throws(() => feishuReplyRequest("om", outbox({ text: "\u0001".repeat(4_000) })),
    (e: unknown) => e instanceof FeishuError && e.code === "feishu_payload_too_large");
  for (const payload of [{}, { text: "" }, { text: 42 }, { text: "x".repeat(6_001) }]) {
    assert.throws(() => feishuReplyRequest("om", outbox(payload)), FeishuError);
  }
});

test("safe error codes and Retry-After do not expose provider content", () => {
  assert.equal(classifyFeishuError({ code: 230011 }).code, "feishu_target_unavailable");
  assert.equal(classifyFeishuError({ code: 230027 }).permanent, true);
  assert.equal(classifyFeishuError({ code: 230025 }).code, "feishu_payload_too_large");
  assert.equal(classifyFeishuError({ code: 230001 }).code, "feishu_invalid_payload");
  assert.equal(classifyFeishuError({ response: { status: 429, headers: { "retry-after": "90" } } }).retryAfterMs, 90_000);
  assert.equal(classifyFeishuError({ response: { status: 429, headers: { "retry-after": new Date(90_000).toUTCString() } } }, 0).retryAfterMs, 90_000);
  assert.equal(classifyFeishuError(Error("secret-never-log")).message, "feishu_unavailable");
});

test("real SDK callback rejection becomes failed ACK; successful callback becomes 200", async () => {
  const ws = new WSClient({ appId: config.appId, appSecret: config.appSecret, logger: quietSdkLogger });
  // Deliberate SDK contract test: exercise its real dispatcher/frame handler without opening a socket.
  const internal = ws as unknown as {
    eventDispatcher: EventDispatcher;
    sendMessage: (frame: { payload: Uint8Array }) => void;
    handleEventData: (frame: unknown) => Promise<void>;
  };
  const codes: number[] = [];
  internal.sendMessage = frame => codes.push(JSON.parse(new TextDecoder().decode(frame.payload)).code);
  let fail = true;
  internal.eventDispatcher = new EventDispatcher({ logger: quietSdkLogger }).register({
    "im.message.receive_v1": async data => {
      assert.equal(parseFeishuText(data, config)?.messageId, "om_message");
      if (fail) throw Error("storage_busy");
    },
  });
  const envelope = { schema: "2.0", header: { app_id: config.appId, tenant_key: config.tenantKey,
    event_type: "im.message.receive_v1", event_id: "event" }, event: event() };
  const frame = { headers: Object.entries({ message_id: "frame", sum: "1", seq: "0", type: "event", trace_id: "trace" })
    .map(([key, value]) => ({ key, value })), payload: new TextEncoder().encode(JSON.stringify(envelope)) };
  try {
    await internal.handleEventData(frame);
    fail = false;
    await internal.handleEventData(frame);
    assert.deepEqual(codes, [500, 200]);
  } finally { ws.close({ force: true }); }
});

test("real SDK card callback returns a Card 2.0 response in the ACK", async () => {
  const ws = new WSClient({ appId: config.appId, appSecret: config.appSecret, logger: quietSdkLogger });
  const internal = ws as unknown as {
    eventDispatcher: EventDispatcher;
    sendMessage: (frame: { payload: Uint8Array }) => void;
    handleEventData: (frame: unknown) => Promise<void>;
  };
  const acknowledgements: any[] = [];
  internal.sendMessage = frame => acknowledgements.push(JSON.parse(new TextDecoder().decode(frame.payload)));
  internal.eventDispatcher = new EventDispatcher({ logger: quietSdkLogger }).register({
    "card.action.trigger": async (data: unknown) => {
      assert.equal((data as any).action.value.action, "digest_interest");
      return { card: { type: "raw", data: { schema: "2.0", body: { elements: [] } } } };
    },
  });
  const envelope = {
    schema: "2.0",
    header: { app_id: config.appId, tenant_key: config.tenantKey, event_type: "card.action.trigger", event_id: "event-card" },
    event: { app_id: config.appId, tenant_key: config.tenantKey, event_id: "event-card",
      context: { open_message_id: "om_card" }, operator: { open_id: config.ownerOpenId },
      action: { tag: "button", value: { action: "digest_interest", item_id: "item-1", target_interested: true } } },
  };
  const frame = { headers: Object.entries({ message_id: "frame", sum: "1", seq: "0", type: "event", trace_id: "trace" })
    .map(([key, value]) => ({ key, value })), payload: new TextEncoder().encode(JSON.stringify(envelope)) };
  try {
    await internal.handleEventData(frame);
    assert.equal(acknowledgements.length, 1);
    assert.equal(acknowledgements[0].code, 200);
    assert.deepEqual(JSON.parse(Buffer.from(acknowledgements[0].data, "base64").toString("utf8")),
      { card: { type: "raw", data: { schema: "2.0", body: { elements: [] } } } });
  } finally { ws.close({ force: true }); }
});

test("start does not claim ready, lifecycle signals are safe, close uses SDK", async () => {
  const logs: unknown[] = [];
  let params!: ConstructorParameters<typeof WSClient>[0];
  let closed = false, fatal = false;
  const transport = createFeishuTransport(config, entry => logs.push(entry), () => { fatal = true; }, {
    makeWs: p => { params = p; return { start: async () => {}, close: () => { closed = true; } }; },
  });
  await transport.start(async () => {});
  assert.deepEqual(logs, [{ event: "connecting" }]);
  params.onReady?.();
  params.onReconnecting?.();
  params.onReconnected?.();
  params.onError?.(Error("raw-secret"));
  assert.equal(fatal, true);
  transport.close();
  assert.equal(closed, true);
  assert.ok(!JSON.stringify(logs).includes("raw-secret"));
});

test("real SDK sends one token request and one reply, and rejects business failure or missing receipt", async () => {
  const requests: { url?: string; body: unknown; signal: unknown }[] = [];
  let body: unknown = { code: 0, data: { message_id: "om_reply" } };
  const http = defaultHttpInstance.create({ adapter: async request => {
    requests.push({ url: request.url, body: JSON.parse(request.data ?? "{}"), signal: request.signal });
    return { config: request, headers: {}, status: 200, statusText: "OK",
      data: request.url?.includes("tenant_access_token") ? { code: 0, tenant_access_token: "fake-token", expire: 7200 } : body };
  } });
  const isolated = { ...config, appId: "cli_" + randomUUID().replaceAll("-", "").slice(0, 16) };
  const transport = createFeishuTransport(isolated, () => {}, () => assert.fail(), { http, makeWs: noWs });
  await transport.send("om_original", outbox());
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal, requests[1].signal);
  assert.ok(requests[1].url?.endsWith("/messages/om_original/reply"));
  assert.deepEqual(requests[1].body, feishuReplyRequest("om_original", outbox()).data);
  body = { code: 230013, msg: "secret-never-log" };
  await assert.rejects(transport.send("om_original", outbox()), (e: unknown) => e instanceof FeishuError && e.code === "feishu_forbidden");
  body = { code: 0, data: {} };
  await assert.rejects(transport.send("om_original", outbox()), FeishuError);
  assert.equal(requests.length, 4); // cache reused; no hidden message retry
  transport.close();
});

test("real SDK sends a proactive text to an open_id with a stable UUID", async () => {
  const requests: { url?: string; body: unknown }[] = [];
  const http = defaultHttpInstance.create({ adapter: async request => {
    requests.push({ url: request.url, body: JSON.parse(request.data ?? "{}") });
    return { config: request, headers: {}, status: 200, statusText: "OK",
      data: request.url?.includes("tenant_access_token") ? { code: 0, tenant_access_token: "fake-token", expire: 7200 }
        : { code: 0, data: { message_id: "om_digest" } } };
  } });
  const isolated = { ...config, appId: "cli_" + randomUUID().replaceAll("-", "").slice(0, 16) };
  const transport = createFeishuTransport(isolated, () => {}, () => assert.fail(), { http, makeWs: noWs });
  const request = feishuTextRequest("ou_owner", "digest", "a".repeat(40));
  assert.deepEqual(request.data, { receive_id: "ou_owner", msg_type: "text", content: '{"text":"digest"}', uuid: "a".repeat(40) });
  const result = await transport.sendText!("ou_owner", "digest", "a".repeat(40));
  assert.deepEqual(result, { messageId: "om_digest" });
  assert.ok(requests[1].url?.endsWith("/messages"));
  assert.deepEqual(requests[1].body, request.data);
  await assert.rejects(transport.sendText!("", "digest", "a".repeat(40)), FeishuError);
  transport.close();
});

test("real SDK sends a Card 2.0 payload and rejects malformed cards", async () => {
  const requests: { url?: string; body: any }[] = [];
  const http = defaultHttpInstance.create({ adapter: async request => {
    requests.push({ url: request.url, body: JSON.parse(request.data ?? "{}") });
    return { config: request, headers: {}, status: 200, statusText: "OK",
      data: request.url?.includes("tenant_access_token") ? { code: 0, tenant_access_token: "fake-token", expire: 7200 }
        : { code: 0, data: { message_id: "om_card" } } };
  } });
  const isolated = { ...config, appId: "cli_" + randomUUID().replaceAll("-", "").slice(0, 16) };
  const transport = createFeishuTransport(isolated, () => {}, () => assert.fail(), { http, makeWs: noWs });
  const card = JSON.stringify({ schema: "2.0", body: { elements: [] } });
  const request = feishuInteractiveRequest("ou_owner", card, "b".repeat(40));
  assert.deepEqual(request.data, { receive_id: "ou_owner", msg_type: "interactive", content: card, uuid: "b".repeat(40) });
  assert.deepEqual(await transport.sendInteractive!("ou_owner", card, "b".repeat(40)), { messageId: "om_card" });
  assert.deepEqual(requests[1].body, request.data);
  assert.throws(() => feishuInteractiveRequest("ou_owner", "{}", "b".repeat(40)),
    (error: unknown) => error instanceof FeishuError && error.code === "feishu_invalid_payload");
  assert.throws(() => feishuInteractiveRequest("ou_owner", JSON.stringify({ schema: "2.0", x: "x".repeat(20_001) }), "b".repeat(40)),
    (error: unknown) => error instanceof FeishuError && error.code === "feishu_payload_too_large");
  transport.close();
});

test("deadline aborts token HTTP and never proceeds to a late message send", async () => {
  let calls = 0, aborted = false;
  const http = defaultHttpInstance.create({ adapter: request => new Promise((_resolve, reject) => {
    calls++;
    request.signal?.addEventListener?.("abort", () => { aborted = true; reject(Error("raw-secret")); }, { once: true });
  }) });
  const isolated = { ...config, appId: "cli_" + randomUUID().replaceAll("-", "").slice(0, 16) };
  const transport = createFeishuTransport(isolated, () => {}, () => {}, { http, makeWs: noWs, sendTimeoutMs: 20 });
  await assert.rejects(transport.send("om", outbox()), (e: unknown) => e instanceof FeishuError && e.code === "feishu_timeout");
  assert.equal(aborted, true);
  assert.equal(calls, 1);
  transport.close();
});
