import { setTimeout as delay } from "node:timers/promises";
import { createFeishuTransport, parseFeishuCardAction, receiveFeishuEvent, FeishuError,
  type FeishuConfig, type FeishuTransport, type FeishuSend, type SafeLog } from "../channels/feishu/adapter.js";
import type { TopicAgentRuntime } from "../agent/topic-runtime.js";
import { openRuntimeStore, RuntimeStoreError, StorageBusyError, type RuntimeStore } from "./store.js";
import type { FeishuScope } from "./types.js";
import { processConversationOnce } from "./turn-worker.js";
import { processCaptureJobOnce, type CaptureDependencies } from "./capture-worker.js";
import { probeArchive } from "../article/durable-archive.js";
import { CaptureCleanupError } from "../article/capture-error.js";
import type { FeedConfig } from "../feed/config.js";
import { scheduleFeedPollsOnce } from "../feed/scheduler.js";
import { processFeedPollOnce } from "../feed/worker.js";
import { scheduleFeedDigestOnce } from "../feed/digest-scheduler.js";
import { processFeedDigestOnce } from "../feed/digest-worker.js";
import { updateDigestCardInterest } from "../feed/digest.js";

export async function deliverFeishuOnce({ store, scope, send, now = Date.now, log = () => {} }: {
  store: RuntimeStore; scope: FeishuScope; send: FeishuSend; now?: () => number; log?: SafeLog;
}): Promise<{ outcome: "idle" | "sent" | "retry_scheduled" | "failed" | "lost_lease"; outboxId?: string }> {
  store.backfillCaptureRejections(scope);
  for (const recovered of store.recoverFeishuOutbox(scope)) {
    log({ event: "outbox_recovered", outbox_id: recovered.id, outcome: recovered.state, error_code: "lease_expired" });
  }
  const outbox = store.claimOutbox(60_000, scope);
  if (!outbox) return { outcome: "idle" };
  const token = outbox.runToken!;
  // Destination is immutable stored source data, never the last received chat.
  const messageId = store.getFeishuReplyTarget(outbox.turnId, scope);
  try {
    if (!messageId) throw new FeishuError("feishu_target_unavailable", true);
    await send(messageId, outbox);
  } catch (error) {
    const failure = error instanceof FeishuError ? error : new FeishuError("feishu_unavailable");
    const changed = failure.permanent
      ? store.failOutbox(outbox.id, token, failure.code)
      : store.retryOutbox(outbox.id, token, now() + Math.max(30_000, failure.retryAfterMs), failure.code);
    const outcome = !changed ? "lost_lease" : failure.permanent || outbox.attempts >= outbox.maxAttempts ? "failed" : "retry_scheduled";
    log({ event: "outbox", outbox_id: outbox.id, turn_id: outbox.turnId, outcome, error_code: failure.code });
    return { outcome, outboxId: outbox.id };
  }
  // A commit failure is a storage error, not a failed send. Recovery retains the UUID.
  const outcome = store.markOutboxSent(outbox.id, token) ? "sent" : "lost_lease";
  log({ event: "outbox", outbox_id: outbox.id, turn_id: outbox.turnId, outcome });
  return { outcome, outboxId: outbox.id };
}

export async function processFeishuTurnsOnce({ store, scope, agent, now = Date.now, log, signal, captureAvailable = false }: {
  store: RuntimeStore; scope: FeishuScope; agent: TopicAgentRuntime; now?: () => number;
  log: SafeLog; signal: AbortSignal; captureAvailable?: boolean;
}): Promise<boolean> {
  let progress = false;
  for (const conversationId of store.listFeishuConversations(scope)) {
    if (signal.aborted) break;
    const previous = store.getHeadTurn(conversationId);
    store.recoverExpiredTurns(conversationId);
    if (previous && store.getTurn(previous.id)?.state === "failed") {
      log({ event: "turn", conversation_id: conversationId, turn_id: previous.id,
        outcome: "failed", error_code: "lease_expired" });
    }
    const head = store.getHeadTurn(conversationId);
    const result = await processConversationOnce(conversationId, { store, agent, now, feishu: { scope, captureAvailable } });
    if (result.outcome !== "idle") {
      progress = true;
      const turn = head ? store.getTurn(head.id) : null;
      log({ event: "turn", conversation_id: conversationId, turn_id: head?.id,
        outcome: result.outcome, error_code: turn?.errorCode ?? undefined });
    }
  }
  return progress;
}

export function processFeishuCardActionOnce({ store, scope, event, log = () => {} }: {
  store: RuntimeStore;
  scope: FeishuScope;
  event: unknown;
  log?: SafeLog;
}): unknown {
  const action = parseFeishuCardAction(event, scope);
  if (!action) {
    log({ event: "ignored", reason: "invalid_card_action" });
    return undefined;
  }
  const message = store.getDigestMessage(scope, action.messageId);
  if (!message) {
    log({ event: "ignored", reason: "digest_message_not_found", message_id: action.messageId, item_id: action.action.item_id });
    return undefined;
  }
  const proposedCard = updateDigestCardInterest(message.card, action.action.item_id, action.action.target_interested);
  if (!proposedCard) {
    log({ event: "ignored", reason: "digest_action_not_in_card", message_id: action.messageId, item_id: action.action.item_id });
    return undefined;
  }
  const result = store.applyDigestFeedback({
    scope,
    eventId: action.eventId,
    messageId: action.messageId,
    feedItemId: action.action.item_id,
    targetInterested: action.action.target_interested,
  });
  const updatedCard = result.interested === action.action.target_interested
    ? proposedCard
    : updateDigestCardInterest(message.card, action.action.item_id, result.interested);
  if (!updatedCard) {
    log({ event: "ignored", reason: "digest_card_update_failed", message_id: action.messageId, item_id: action.action.item_id });
    return undefined;
  }
  log({ event: "digest_feedback", message_id: action.messageId, item_id: action.action.item_id,
    event_id: action.eventId, target_interested: result.interested ? 1 : 0, outcome: result.outcome });
  // Card 2.0 callback responses wrap the returned card as a raw card. The
  // event itself is accepted without this envelope, but Feishu will not apply
  // the replacement to the original message.
  return { card: { type: "raw", data: JSON.parse(updatedCard) } };
}

export type FeishuServiceOptions = {
  config: FeishuConfig;
  agent: TopicAgentRuntime;
  signal: AbortSignal;
  log: SafeLog;
  createTransport?: typeof createFeishuTransport;
  openStore?: typeof openRuntimeStore;
  now?: () => number;
  wait?: (signal: AbortSignal) => Promise<void>;
  drainTimeoutMs?: number;
  capture?: CaptureDependencies;
  probeArchive?: typeof probeArchive;
  feedConfig?: FeedConfig;
};

export async function serveFeishu(options: FeishuServiceOptions): Promise<{ exitCode: number; drained: boolean }> {
  const { config, agent, signal, log, now = Date.now, openStore = openRuntimeStore,
    createTransport = createFeishuTransport, drainTimeoutMs = 85_000,
    wait = signal => delay(1_000, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; }) } = options;
  const stopping = new AbortController();
  let exitCode = 0;
  let cleanupFailed = false;
  let store: RuntimeStore | undefined;
  let transport: FeishuTransport | undefined;
  let finishStop!: () => void;
  const stopped = new Promise<void>(resolve => { finishStop = resolve; });
  const stop = (code = 0) => {
    exitCode = Math.max(exitCode, code);
    if (stopping.signal.aborted) return;
    stopping.abort();
    try { transport?.close(); } catch { exitCode = 1; }
    finishStop();
  };
  const onSignal = () => stop();
  signal.addEventListener("abort", onSignal, { once: true });
  if (signal.aborted) stop();
  const loops: Promise<void>[] = [];
  try {
    if (!stopping.signal.aborted) {
      store = openStore({ path: config.statePath, now });
      const activeStore = store;
      const captureAvailable = await (options.probeArchive ?? probeArchive)(config.archiveDir);
      log({ event: captureAvailable ? "capture_enabled" : "capture_disabled" });
      if (!stopping.signal.aborted) {
      transport = createTransport(config, log, () => stop(1));
      await transport.start(async event => {
        if (stopping.signal.aborted) throw new Error("service_stopping");
        if (parseFeishuCardAction(event, config)) {
          try {
            return processFeishuCardActionOnce({ store: activeStore, scope: config, event, log });
          } catch (error) {
            if (error instanceof StorageBusyError) {
              log({ event: "card_action_error", error_code: "storage_busy" });
              throw new Error("storage_busy");
            }
            if (error instanceof RuntimeStoreError) {
              log({ event: "card_action_error", error_code: error.message });
              return undefined;
            }
            log({ event: "card_action_error", error_code: "storage_or_internal_failure" });
            stop(1);
            throw new Error("storage_or_internal_failure");
          }
        }
        try {
          receiveFeishuEvent(event, config, input => activeStore.acceptFeishuText(input), log);
          return undefined;
        } catch (error) {
          const busy = error instanceof StorageBusyError;
          log({ event: "ingress_error", error_code: busy ? "storage_busy" : "storage_failure" });
          if (!busy) stop(1);
          // No raw provider/event data in SDK's exception handling either.
          throw new Error(busy ? "storage_busy" : "storage_failure");
        }
      });
      const activeTransport = transport;
      const loop = async (work: () => Promise<boolean>) => {
        while (!stopping.signal.aborted) {
          let progress = false;
          try { progress = await work(); }
          catch (error) {
            if (error instanceof StorageBusyError) log({ event: "storage_busy" });
            else {
              if (error instanceof CaptureCleanupError) cleanupFailed = true;
              log({ event: "service_failed", error_code: cleanupFailed ? "capture_cleanup_failed" : "storage_or_internal_failure" }); stop(1);
            }
          }
          if (!progress && !stopping.signal.aborted) await wait(stopping.signal);
        }
      };
      loops.push(loop(() => processFeishuTurnsOnce({
        store: activeStore, scope: config, agent, now, log, signal: stopping.signal, captureAvailable,
      })).catch(() => { log({ event: "service_failed", error_code: "loop_failure" }); stop(1); }));
      loops.push(loop(async () => (await deliverFeishuOnce({
        store: activeStore, scope: config, send: activeTransport.send, now, log,
      })).outcome !== "idle").catch(() => { log({ event: "service_failed", error_code: "loop_failure" }); stop(1); }));
      loops.push(loop(async () => (await processCaptureJobOnce({ store: activeStore, scope: config,
        archiveDir: captureAvailable ? config.archiveDir : undefined, now, log, dependencies: options.capture,
      })).outcome !== "idle").catch(() => { log({ event: "service_failed", error_code: "loop_failure" }); stop(1); }));
      if (options.feedConfig?.sources.some(source => source.enabled)) {
        loops.push(loop(async () => scheduleFeedPollsOnce({ store: activeStore, config: options.feedConfig!, now }) > 0)
          .catch(() => { log({ event: "service_failed", error_code: "feed_scheduler_failure" }); stop(1); }));
        loops.push(loop(async () => (await processFeedPollOnce({
          store: activeStore, config: options.feedConfig!, now, signal: stopping.signal, log,
        })).outcome !== "idle").catch(() => { if (!stopping.signal.aborted) { log({ event: "service_failed", error_code: "feed_worker_failure" }); stop(1); } }));
        if (options.feedConfig.digest?.enabled) {
          if (!activeTransport.sendText) throw new FeishuError("feishu_configuration", true);
          const sendText = activeTransport.sendText;
          loops.push(loop(async () => scheduleFeedDigestOnce({
            store: activeStore, config: options.feedConfig!, scope: config, now,
          })).catch(() => { log({ event: "service_failed", error_code: "feed_digest_scheduler_failure" }); stop(1); }));
          loops.push(loop(async () => (await processFeedDigestOnce({
            store: activeStore, config: options.feedConfig!, scope: config, send: sendText,
            sendInteractive: activeTransport.sendInteractive, now, log,
          })).outcome !== "idle").catch(() => { if (!stopping.signal.aborted) { log({ event: "service_failed", error_code: "feed_digest_worker_failure" }); stop(1); } }));
        }
      }
      }
    }
  } catch {
    log({ event: "service_failed", error_code: "startup_failure" });
    stop(1);
  }
  await stopped;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    Promise.all(loops).then(() => true),
    new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), drainTimeoutMs); }),
  ]) && !cleanupFailed;
  clearTimeout(timer);
  signal.removeEventListener("abort", onSignal);
  if (drained) store?.close();
  else exitCode = 1;
  log({ event: "stopped", outcome: drained ? "drained" : "drain_timeout", exit_code: exitCode });
  // On timeout the CLI must exit the process, leaving active leases for recovery.
  return { exitCode, drained };
}
