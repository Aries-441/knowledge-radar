import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { openRuntimeStore, StorageBusyError } from "./store.js";
import { processConversationOnce } from "./turn-worker.js";
import type { TopicAgentRuntime } from "../agent/topic-runtime.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "radar-turn-worker-"));
  const path = join(directory, "radar.db");
  const clock = { value: 1_000 };
  const now = () => clock.value;
  const store = openRuntimeStore({ path, now, busyTimeoutMs: 0 });
  const db = new DatabaseSync(path);
  t.after(async () => { db.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  store.createConversation({ id: "topic", kind: "general", title: "主题" });
  const turn = (content = "问题", maxAttempts = 2, conversationId = "topic") =>
    store.createTurn({ conversationId, content, source: "test", maxAttempts });
  const run = (agent: TopicAgentRuntime, conversationId = "topic") =>
    processConversationOnce(conversationId, { store, agent, now });
  return { path, clock, now, store, db, turn, run };
}

test("history selects the latest six eligible pairs and survives reopen", async (t) => {
  const f = await fixture(t);
  function answer(content: string, payload: unknown, kind = "final_message", topic = "topic") {
    const turn = f.turn(content, 2, topic);
    const claimed = f.store.claimTurn(topic, 120_000)!;
    const outbox = f.store.completeTurnWithOutbox(turn.id, claimed.runToken!, { kind, payload, maxAttempts: 3 })!;
    return { turn, outbox };
  }
  for (let i = 0; i < 7; i++) answer(`user-${i}`, { text: `reply-${i}`, cookie: "not context" });
  answer("x".repeat(3_999), { text: "a" }); // exact 4,000 boundary
  answer("x".repeat(4_000), { text: "b" });
  answer("wrong type", { text: 42 });
  answer("wrong kind", { text: "skip" }, "status");
  const corrupt = answer("corrupt JSON", {});
  f.db.prepare("UPDATE outbox SET payload_json = ? WHERE id = ?").run("{", corrupt.outbox.id);
  for (const state of ["failed", "queued", "running"]) {
    const record = answer(state, { text: "must not appear" });
    f.db.prepare("UPDATE turns SET state = ? WHERE id = ?").run(state, record.turn.id);
    // Later fixture inserts use the API; remove this artificial FIFO blocker afterwards.
    assert.ok(!f.store.getCompletedHistory("topic", 100).some((pair) => pair.content === state));
    f.db.prepare("UPDATE turns SET state = 'failed' WHERE id = ?").run(record.turn.id);
  }
  f.store.createConversation({ id: "other", kind: "general", title: "other" });
  answer("other private", { text: "private" }, "final_message", "other");
  const current = answer("current", { text: "exclude current" });
  answer("future", { text: "exclude future" });
  const reopened = openRuntimeStore({ path: f.path });
  try {
    const history = reopened.getCompletedHistory("topic", current.turn.sequence);
    assert.deepEqual(history.map((pair) => pair.content), ["user-2", "user-3", "user-4", "user-5", "user-6", "x".repeat(3_999)]);
    assert.ok(history.every((pair) => Object.keys(pair).sort().join() === "content,text"));
  } finally { reopened.close(); }
});

test("worker projects only safe history, atomically commits one final reply and leaves the next Turn queued", async (t) => {
  const f = await fixture(t);
  const old = f.turn("previous");
  const claim = f.store.claimTurn("topic", 120_000)!;
  f.store.completeTurnWithOutbox(old.id, claim.runToken!, { kind: "final_message", payload: { text: "answer", cookie: "secret" }, maxAttempts: 3 });
  const current = f.turn("current");
  const next = f.turn("next");
  let calls = 0;
  assert.deepEqual(await f.run(async (input) => {
    calls++;
    assert.deepEqual(input, { title: "主题", history: [{ content: "previous", text: "answer" }], content: "current" });
    assert.equal(f.store.getTurn(current.id)?.leaseExpiresAt, 121_000);
    return { text: " final " };
  }), { outcome: "answered" });
  assert.equal(calls, 1);
  assert.equal(f.store.getTurn(next.id)?.state, "queued");
  assert.equal(f.store.getTurn(current.id)?.state, "answered");
  const rows = f.db.prepare("SELECT * FROM outbox WHERE turn_id = ?").all(current.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "pending");
  assert.equal(rows[0].max_attempts, 3);
  assert.equal(rows[0].payload_json, '{"text":"final"}');
});

test("empty, running and future queued heads return idle without invoking Agent", async (t) => {
  const f = await fixture(t);
  const noCall: TopicAgentRuntime = async () => { assert.fail("Agent must not run"); };
  assert.deepEqual(await f.run(noCall), { outcome: "idle" });
  const turn = f.turn();
  f.turn("later");
  const claim = f.store.claimTurn("topic", 100)!;
  assert.deepEqual(await f.run(noCall), { outcome: "idle" });
  f.store.retryTurn(turn.id, claim.runToken!, 2_000, "temporary");
  assert.deepEqual(await f.run(noCall), { outcome: "idle" });
  assert.equal(f.store.getTurn(turn.id)?.attempts, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM outbox").get()?.n, 0);
});

test("Agent failure retries after 30 seconds and terminal attempts survive reopen", async (t) => {
  const f = await fixture(t);
  const turn = f.turn();
  assert.deepEqual(await f.run(async () => { throw new Error("API key secret"); }), { outcome: "retry_scheduled" });
  assert.equal(f.store.getTurn(turn.id)?.availableAt, 31_000);
  assert.equal(f.store.getTurn(turn.id)?.errorCode, "agent_provider_failure");
  f.clock.value = 30_999;
  assert.deepEqual(await f.run(async () => { assert.fail(); }), { outcome: "idle" });
  f.clock.value = 31_000;
  assert.deepEqual(await f.run(async () => ({ text: " " })), { outcome: "failed" });
  const reopened = openRuntimeStore({ path: f.path, now: f.now });
  try {
    assert.equal(reopened.getTurn(turn.id)?.state, "failed");
    assert.equal(reopened.getTurn(turn.id)?.errorCode, "agent_invalid_response");
    assert.equal(reopened.getTurn(turn.id)?.runToken, null);
    assert.equal(reopened.claimTurn("topic", 100), null);
  } finally { reopened.close(); }
});

test("next run recovers only expired target Turns and respects exhausted attempts", async (t) => {
  const f = await fixture(t);
  const current = f.turn();
  f.store.claimTurn("topic", 10);
  f.store.createConversation({ id: "other", title: "other", kind: "general" });
  const other = f.turn("other", 2, "other");
  f.store.claimTurn("other", 10);
  const job = f.store.enqueueJob({ kind: "test", payload: {}, idempotencyKey: "test", maxAttempts: 2 });
  f.store.claimJob(10);
  const outbox = f.store.enqueueOutbox({ turnId: other.id, kind: "final_message", payload: {}, maxAttempts: 2 });
  f.store.claimOutbox(10);
  f.clock.value = 1_010;
  const reopened = openRuntimeStore({ path: f.path, now: f.now });
  try { assert.deepEqual(await processConversationOnce("topic", { store: reopened, now: f.now, agent: async () => ({ text: "recovered" }) }), { outcome: "answered" }); }
  finally { reopened.close(); }
  assert.equal(f.store.getTurn(current.id)?.attempts, 2);
  assert.equal(f.store.getTurn(other.id)?.state, "running");
  assert.equal(f.store.getJob(job.id)?.state, "running");
  assert.equal(f.store.getOutbox(outbox.id)?.state, "sending");
  const exhausted = f.turn("exhausted", 1);
  f.store.claimTurn("topic", 10);
  f.clock.value += 10;
  assert.deepEqual(await f.run(async () => { assert.fail(); }), { outcome: "idle" });
  assert.equal(f.store.getTurn(exhausted.id)?.state, "failed");
  assert.equal(f.store.getTurn(exhausted.id)?.runToken, null);
});

for (const failure of [false, true]) {
  for (const takeover of [false, true]) {
    test(`expired ${failure ? "failure" : "success"} write returns lost_lease; takeover=${takeover}`, async (t) => {
      const f = await fixture(t);
      const turn = f.turn();
      const other = openRuntimeStore({ path: f.path, now: f.now });
      try {
        assert.deepEqual(await f.run(async () => {
          f.clock.value += 120_000;
          if (takeover) { other.recoverExpiredTurns("topic"); other.claimTurn("topic", 120_000); }
          if (failure) throw new Error("secret");
          return { text: "late answer" };
        }), { outcome: "lost_lease" });
        assert.equal(f.store.getTurn(turn.id)?.state, "running");
        assert.equal(f.store.getTurn(turn.id)?.attempts, takeover ? 2 : 1);
        assert.equal(f.db.prepare("SELECT count(*) AS n FROM outbox").get()?.n, 0);
      } finally { other.close(); }
    });
  }
}

test("oversized current Turn fails without invoking Agent; failed fencing returns lost_lease", async (t) => {
  const f = await fixture(t);
  const oversized = f.turn("a".repeat(4_001));
  assert.deepEqual(await f.run(async () => { assert.fail(); }), { outcome: "failed" });
  assert.equal(f.store.getTurn(oversized.id)?.errorCode, "turn_too_large");
  const next = f.turn("b".repeat(4_001));
  const fail = f.store.failTurn.bind(f.store);
  t.mock.method(f.store, "failTurn", (...args: Parameters<typeof fail>) => { f.clock.value += 120_000; return fail(...args); });
  assert.deepEqual(await f.run(async () => { assert.fail(); }), { outcome: "lost_lease" });
  assert.equal(f.store.getTurn(next.id)?.state, "running");
});

test("a database failure during final commit rolls back without scheduling Agent retry", async (t) => {
  const f = await fixture(t);
  const turn = f.turn();
  f.db.exec("CREATE TRIGGER reject_final BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'test_commit_failure'); END");
  await assert.rejects(f.run(async () => ({ text: "answer" })), /test_commit_failure/);
  assert.equal(f.store.getTurn(turn.id)?.state, "running");
  assert.equal(f.store.getTurn(turn.id)?.errorCode, null);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM outbox").get()?.n, 0);
});

test("storage busy before claim and after generation never masquerades as Agent failure", async (t) => {
  const f = await fixture(t);
  const turn = f.turn();
  f.db.exec("BEGIN IMMEDIATE");
  try { await assert.rejects(f.run(async () => { assert.fail(); }), StorageBusyError); }
  finally { f.db.exec("ROLLBACK"); }
  assert.equal(f.store.getTurn(turn.id)?.attempts, 0);
  f.db.exec("BEGIN EXCLUSIVE");
  try { await assert.rejects(f.run(async () => { assert.fail(); }), StorageBusyError); }
  finally { f.db.exec("ROLLBACK"); }
  try {
    await assert.rejects(f.run(async () => { f.db.exec("BEGIN IMMEDIATE"); return { text: "answer" }; }), StorageBusyError);
  } finally { f.db.exec("ROLLBACK"); }
  assert.equal(f.store.getTurn(turn.id)?.state, "running");
  assert.equal(f.store.getTurn(turn.id)?.errorCode, null);
});
