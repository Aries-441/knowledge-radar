import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { openRuntimeStore, StorageBusyError } from "./store.js";
import { processConversationOnce } from "./turn-worker.js";
import { deliverFeishuOnce, processFeishuTurnsOnce, serveFeishu } from "./feishu-service.js";
import { FeishuError, feishuReplyRequest, type FeishuConfig, type SafeLog } from "../channels/feishu/adapter.js";
import type { FeishuText } from "./types.js";

const scope = { appId: "cli_0000000000000001", tenantKey: "tenant", ownerOpenId: "ou_owner" };
const input = (messageId = "message", chatId = "chat", text = "hello"): FeishuText => ({ ...scope, messageId, chatId, text });
const log: SafeLog = () => {};
const alive = new AbortController().signal;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "radar-feishu-test-"));
  const path = join(directory, "radar.db");
  const clock = { value: 1_000 };
  const now = () => clock.value;
  let store = openRuntimeStore({ path, now, busyTimeoutMs: 0 });
  const db = new DatabaseSync(path);
  t.after(async () => { store.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  const accept = (data = input()) => {
    const result = store.acceptFeishuText(data);
    assert.notEqual(result.outcome, "ignored");
    if (result.outcome === "ignored") throw Error("unexpected ignored");
    return result;
  };
  const answer = async (data = input()) => {
    const result = accept(data);
    await processConversationOnce(result.conversationId, { store, now, agent: async () => ({ text: "answer" }) });
    return result;
  };
  const reopen = () => { store.close(); store = openRuntimeStore({ path, now, busyTimeoutMs: 0 }); return store; };
  return { get store() { return store; }, db, path, now, clock, accept, answer, reopen };
}

test("v1 upgrade preserves original queues; failed migration rolls back and v2 reopen is idempotent", async t => {
  const f = await fixture(t);
  const conversation = f.store.createConversation({ kind: "local", title: "local" });
  const turn = f.store.createTurn({ conversationId: conversation.id, source: "test", content: "preserve", maxAttempts: 3 });
  const running = f.store.claimTurn(conversation.id, 120_000)!;
  const job = f.store.enqueueJob({ kind: "untouched", payload: {}, idempotencyKey: "job", maxAttempts: 3 });
  const outbox = f.store.enqueueOutbox({ turnId: turn.id, kind: "local", payload: {}, maxAttempts: 3 });
  const sending = f.store.claimOutbox(60_000)!;
  f.store.close();
  f.db.exec("DROP TABLE feed_items; DROP TABLE feed_sources; DROP TABLE article_captures; DROP INDEX capture_origin_unique; DROP TABLE feishu_inbound_messages; DROP TABLE feishu_chats; PRAGMA user_version = 1;");
  // Deliberate conflict in a disposable DB: v2 must not commit partially.
  f.db.exec("CREATE TABLE feishu_inbound_messages (conflict TEXT)");
  assert.throws(() => openRuntimeStore({ path: f.path }));
  assert.equal(f.db.prepare("PRAGMA user_version").get()?.user_version, 1);
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name = 'feishu_chats'").get(), undefined);
  f.db.exec("DROP TABLE feishu_inbound_messages");
  f.reopen();
  assert.equal(f.db.prepare("PRAGMA user_version").get()?.user_version, 5);
  assert.deepEqual(f.store.getTurn(turn.id), running);
  assert.deepEqual(f.store.getOutbox(outbox.id), sending);
  assert.deepEqual(f.store.getJob(job.id), job);
  f.accept();
  f.reopen();
  assert.equal(f.store.listFeishuConversations(scope).length, 1);
});

test("intake commits mapping, sequence and source once across connections/restarts and rolls back failures", async t => {
  const f = await fixture(t);
  f.db.exec("CREATE TRIGGER fail_intake BEFORE INSERT ON feishu_inbound_messages BEGIN SELECT RAISE(ABORT, 'injected'); END;");
  assert.throws(() => f.accept());
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM conversations").get()?.n, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM turns").get()?.n, 0);
  f.db.exec("DROP TRIGGER fail_intake");
  const first = f.accept();
  const other = openRuntimeStore({ path: f.path, now: f.now, busyTimeoutMs: 0 });
  try {
    const duplicate = other.acceptFeishuText({ ...input(), text: "changed" });
    assert.deepEqual(duplicate, { ...first, outcome: "duplicate" });
    assert.equal(f.store.getTurn(first.turnId)?.content, "hello");
    const next = f.accept(input("second"));
    assert.equal(next.conversationId, first.conversationId);
    assert.equal(f.store.getTurn(next.turnId)?.sequence, 2);
    assert.equal(f.store.getTurn(next.turnId)?.maxAttempts, 3);
    f.db.exec("BEGIN IMMEDIATE");
    try { assert.throws(() => other.acceptFeishuText(input("locked")), StorageBusyError); }
    finally { f.db.exec("ROLLBACK"); }
    assert.notEqual(other.acceptFeishuText(input("locked")).outcome, "ignored");
  } finally { other.close(); }
  f.reopen();
  assert.equal(f.accept().turnId, first.turnId);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM feishu_chats").get()?.n, 1);
  assert.equal(f.store.acceptFeishuText(input("message", "wrong-chat")).outcome, "ignored");
  assert.equal(f.store.acceptFeishuText({ ...input(), ownerOpenId: "ou_wrong" }).outcome, "ignored");
  f.db.prepare("UPDATE conversations SET status = 'archived' WHERE id = ?").run(first.conversationId);
  assert.deepEqual(f.store.acceptFeishuText(input("new")), { outcome: "ignored", reason: "conversation_archived" });
});

test("scoped claiming/recovery never consumes local, other identity, other kind or Job work; FIFO is per conversation", async t => {
  const f = await fixture(t);
  const first = await f.answer(input("one", "a"));
  await f.answer(input("two", "a"));
  const parallel = await f.answer(input("three", "b"));
  const otherApp = await f.answer({ ...input("app"), appId: "cli_0000000000000002" });
  const otherOwner = await f.answer({ ...input("owner", "owner-chat"), ownerOpenId: "ou_else" });
  const local = f.store.createConversation({ kind: "local", title: "local" });
  const localTurn = f.store.createTurn({ conversationId: local.id, source: "test", content: "local", maxAttempts: 3 });
  const localOut = f.store.enqueueOutbox({ turnId: localTurn.id, kind: "final_message", payload: { text: "local" }, maxAttempts: 3 });
  const otherKind = f.store.enqueueOutbox({ turnId: first.turnId, kind: "status", payload: {}, maxAttempts: 3 });
  const job = f.store.enqueueJob({ kind: "job", payload: {}, maxAttempts: 3, idempotencyKey: "job" });
  f.store.claimJob(1);
  const claimed = f.store.claimOutbox(60_000, scope)!;
  // Conversation IDs are random; whichever conversation is first, verify its own FIFO.
  const claimedTurn = f.store.getTurn(claimed.turnId)!;
  assert.equal(claimedTurn.sequence, 1);
  f.store.retryOutbox(claimed.id, claimed.runToken!, f.now() + 30_000, "retry");
  const another = f.store.claimOutbox(60_000, scope)!;
  assert.notEqual(f.store.getTurn(another.turnId)?.conversationId, claimedTurn.conversationId);
  assert.ok([first.turnId, parallel.turnId].includes(another.turnId));
  f.clock.value += 60_000;
  const recovered = f.store.recoverFeishuOutbox(scope);
  assert.deepEqual(recovered, [{ id: another.id, state: "pending" }]);
  for (const id of [localOut.id, otherKind.id]) assert.equal(f.store.getOutbox(id)?.attempts, 0);
  for (const result of [otherApp, otherOwner]) {
    assert.equal(f.db.prepare("SELECT attempts FROM outbox WHERE turn_id = ?").get(result.turnId)?.attempts, 0);
  }
  assert.equal(f.store.getJob(job.id)?.state, "running"); // expired, but not ours to recover
});

test("real store + Fake Agent survives restart through final_message and sent without regenerating answer", async t => {
  const f = await fixture(t);
  const first = f.accept();
  assert.equal(f.accept().outcome, "duplicate");
  let calls = 0;
  const agent = async () => { calls++; return { text: "final" }; };
  await processConversationOnce(first.conversationId, { store: f.store, agent, now: f.now });
  f.reopen();
  const sent: unknown[] = [];
  const result = await deliverFeishuOnce({ store: f.store, scope, now: f.now, send: async (target, outbox) => {
    sent.push(feishuReplyRequest(target, outbox));
  } });
  assert.equal(result.outcome, "sent");
  assert.equal(sent.length, 1);
  assert.equal(f.store.getOutbox(result.outboxId!)?.state, "sent");
  assert.equal(await processFeishuTurnsOnce({ store: f.store, scope, agent, now: f.now, log, signal: alive }), false);
  assert.equal(calls, 1);
});

test("failed sent commit retains sending lease; recovery reuses identical request", async t => {
  const f = await fixture(t);
  await f.answer();
  const requests: unknown[] = [];
  const send = async (target: string, outbox: Parameters<typeof feishuReplyRequest>[1]) => { requests.push(feishuReplyRequest(target, outbox)); };
  const mark = f.store.markOutboxSent;
  f.store.markOutboxSent = () => { throw new StorageBusyError(Error("busy")); };
  await assert.rejects(deliverFeishuOnce({ store: f.store, scope, now: f.now, send }), StorageBusyError);
  f.store.markOutboxSent = mark;
  f.reopen();
  f.clock.value += 60_000;
  assert.equal((await deliverFeishuOnce({ store: f.store, scope, now: f.now, send })).outcome, "sent");
  assert.deepEqual(requests[0], requests[1]);
});

test("send failures back off, respect Retry-After, and stop after three attempts", async t => {
  const f = await fixture(t);
  await f.answer();
  const send = async () => { throw new FeishuError("feishu_rate_limited", false, 90_000); };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await deliverFeishuOnce({ store: f.store, scope, now: f.now, send });
    assert.equal(result.outcome, attempt === 3 ? "failed" : "retry_scheduled");
    assert.equal(f.store.getOutbox(result.outboxId!)?.attempts, attempt);
    assert.equal((await deliverFeishuOnce({ store: f.store, scope, now: f.now, send })).outcome, "idle");
    f.clock.value += 90_000;
  }
  await f.answer(input("later"));
  assert.equal((await deliverFeishuOnce({ store: f.store, scope, now: f.now, send: async () => {} })).outcome, "sent");
});

for (const kind of ["success", "temporary", "permanent"] as const) {
  test("expired token cannot write back " + kind, async t => {
    const f = await fixture(t);
    await f.answer();
    const result = await deliverFeishuOnce({ store: f.store, scope, now: f.now, send: async () => {
      f.clock.value += 60_000;
      f.store.recoverFeishuOutbox(scope);
      f.store.claimOutbox(60_000, scope); // new token
      if (kind !== "success") throw new FeishuError("feishu_unavailable", kind === "permanent");
    } });
    assert.equal(result.outcome, "lost_lease");
    assert.equal(f.store.getOutbox(result.outboxId!)?.state, "sending");
    assert.equal(f.store.getOutbox(result.outboxId!)?.attempts, 2);
  });
}

test("Turn recovery, exhausted lease logs, long input and terminal Agent failure follow existing worker", async t => {
  const f = await fixture(t);
  const first = f.accept();
  f.store.claimTurn(first.conversationId, 120_000);
  f.clock.value += 120_000;
  const entries: unknown[] = [];
  await processFeishuTurnsOnce({ store: f.store, scope, now: f.now, agent: async () => ({ text: "recovered" }),
    signal: alive, log: value => entries.push(value) });
  assert.equal(f.store.getTurn(first.turnId)?.attempts, 2);
  const expired = f.accept(input("expired"));
  f.store.claimTurn(expired.conversationId, 1);
  f.db.prepare("UPDATE turns SET attempts = 3 WHERE id = ?").run(expired.turnId);
  f.clock.value++;
  const tooLong = f.accept(input("long", "chat", "x".repeat(4_001)));
  await processFeishuTurnsOnce({ store: f.store, scope, now: f.now, agent: async () => assert.fail(),
    signal: alive, log: value => entries.push(value) });
  assert.equal(f.store.getTurn(expired.turnId)?.state, "failed");
  assert.equal(f.store.getTurn(tooLong.turnId)?.errorCode, "turn_too_large");
  assert.ok(JSON.stringify(entries).includes("lease_expired"));
  const failed = f.accept(input("failed"));
  for (let i = 0; i < 3; i++) {
    await processFeishuTurnsOnce({ store: f.store, scope, now: f.now, agent: async () => { throw Error("secret"); }, signal: alive, log });
    f.clock.value += 30_000;
  }
  assert.equal(f.store.getTurn(failed.turnId)?.state, "failed");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM outbox WHERE turn_id = ?").get(failed.turnId)?.n, 0);
});

function message(text: string, id: string) {
  return { app_id: scope.appId, tenant_key: scope.tenantKey,
    sender: { sender_type: "user", sender_id: { open_id: scope.ownerOpenId } },
    message: { chat_id: "chat", message_id: id, chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }) } };
}
async function eventually(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await delay(2); }
  assert.fail("condition did not become true");
}
const fastWait = (signal: AbortSignal) => delay(2, undefined, { signal }).catch(() => {});

test("service processes real intake independently of pending Agent, delivers previous reply, and drains", async t => {
  const f = await fixture(t);
  await f.answer(input("previous"));
  let receive!: (event: unknown) => Promise<void>;
  let release!: (value: { text: string }) => void;
  let calls = 0, closed = false;
  const sent: string[] = [], entries: unknown[] = [];
  const controller = new AbortController();
  const running = serveFeishu({
    config: { ...scope, appSecret: "never-log", statePath: f.path }, agent: async request => {
      calls++;
      assert.equal(request.history[0].text, "answer");
      return new Promise(resolve => { release = resolve; });
    },
    signal: controller.signal, log: value => entries.push(value), now: f.now,
    openStore: () => f.store, wait: fastWait,
    createTransport: () => ({ start: async cb => { receive = cb; }, close: () => { closed = true; },
      send: async target => { sent.push(target); } }),
  });
  await eventually(() => Boolean(receive));
  await receive(message("private-secret", "next"));
  await eventually(() => calls === 1 && sent.includes("previous"));
  await receive(message("more-private", "third")); // must not await pending Agent
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM turns").get()?.n, 3);
  controller.abort();
  release({ text: "reply" });
  assert.deepEqual(await running, { exitCode: 0, drained: true });
  assert.equal(closed, true);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(entries).includes("private"));
});

test("service reports busy ingress as failure ACK and fatal storage errors stop safely", async t => {
  const f = await fixture(t);
  let receive!: (event: unknown) => Promise<void>;
  const controller = new AbortController();
  const entries: unknown[] = [];
  const running = serveFeishu({
    config: { ...scope, appSecret: "secret", statePath: f.path }, agent: async () => ({ text: "x" }),
    signal: controller.signal, log: value => entries.push(value), openStore: () => f.store, wait: fastWait,
    createTransport: () => ({ start: async cb => { receive = cb; }, close() {}, send: async () => {} }),
  });
  await eventually(() => Boolean(receive));
  f.db.exec("BEGIN IMMEDIATE");
  try { await assert.rejects(receive(message("secret", "locked")), /storage_busy/); }
  finally { f.db.exec("ROLLBACK"); }
  assert.ok(JSON.stringify(entries).includes("storage_busy"));
  f.store.acceptFeishuText = () => { throw Error("database-corruption-secret"); };
  await assert.rejects(receive(message("secret", "fatal")), /storage_failure/);
  assert.deepEqual(await running, { exitCode: 1, drained: true });
  assert.ok(!JSON.stringify(entries).includes("secret"));
});

test("drain timeout returns failure without closing database still used by Agent", async t => {
  const f = await fixture(t);
  f.accept();
  const controller = new AbortController();
  let release!: (value: { text: string }) => void;
  const running = serveFeishu({
    config: { ...scope, appSecret: "secret", statePath: f.path },
    agent: () => new Promise(resolve => { release = resolve; }), signal: controller.signal, log,
    openStore: () => f.store, wait: fastWait, drainTimeoutMs: 10,
    createTransport: () => ({ start: async () => {}, close() {}, send: async () => {} }),
  });
  await eventually(() => Boolean(release));
  controller.abort();
  assert.deepEqual(await running, { exitCode: 1, drained: false });
  assert.equal(f.store.listFeishuConversations(scope).length, 1); // still open
  release({ text: "late" });
  await eventually(() => f.db.prepare("SELECT state FROM turns").get()?.state === "answered");
});
