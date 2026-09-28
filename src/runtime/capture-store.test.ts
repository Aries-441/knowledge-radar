import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openRuntimeStore } from "./store.js";
import { createCheckpoint } from "../article/durable-archive.js";
import { processConversationOnce } from "./turn-worker.js";
import { feishuReplyRequest } from "../channels/feishu/adapter.js";

const scope = { appId: "app", tenantKey: "tenant", ownerOpenId: "owner" };
const url = "https://example.com/article";
const makeCp = (id: string) => createCheckpoint(id, url, { title: "Title", sourceUrl: url, body: "body" }, { summary: "Summary", keyPoints: ["Point"] }, new Date(2_000), new Date(1_000));
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "radar-capture-store-"));
  const path = join(directory, "radar.db");
  let time = 1_000;
  const now = () => time;
  let store = openRuntimeStore({ path, now, busyTimeoutMs: 0 });
  const db = new DatabaseSync(path);
  t.after(async () => { store.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  let next = 0;
  const accept = (text = url, identity = scope, chatId = "chat") => {
    const result = store.acceptFeishuText({ ...identity, text, chatId, messageId: `m${++next}` });
    if (result.outcome === "ignored") throw Error("ignored");
    return result;
  };
  const handoff = () => {
    const input = accept();
    const turn = store.claimTurn(input.conversationId, 120_000)!;
    const job = store.acceptCaptureTurn(turn.id, turn.runToken!, scope, true)!;
    assert.ok("originTurnId" in job);
    return { input, turn, job };
  };
  return { get store() { return store; }, db, path, now, advance: (ms = 120_000) => { time += ms; }, accept, handoff,
    reopen: () => { store.close(); store = openRuntimeStore({ path, now, busyTimeoutMs: 0 }); } };
}

test("v2 migration preserves old classification and every queue lease; conflicts roll back", async t => {
  const f = await fixture(t);
  const accepted = f.accept();
  f.db.prepare("UPDATE turns SET source = 'feishu' WHERE id = ?").run(accepted.turnId);
  const turn = f.store.claimTurn(accepted.conversationId, 120_000)!;
  const job = f.store.enqueueJob({ originTurnId: turn.id, kind: "capture_article", payload: {}, idempotencyKey: "legacy", maxAttempts: 3 });
  const running = f.store.claimJob(120_000)!;
  const outbox = f.store.enqueueOutbox({ turnId: turn.id, kind: "final_message", payload: { text: "old" }, maxAttempts: 3 });
  const sending = f.store.claimOutbox(60_000)!;
  f.store.close();
  f.db.exec("DROP TABLE feed_items; DROP TABLE feed_sources; DROP TABLE article_captures; DROP INDEX capture_origin_unique; PRAGMA user_version = 2");
  f.db.prepare("INSERT INTO jobs SELECT 'duplicate', origin_turn_id, kind, payload_json, 'duplicate-key', result_json, error_code, state, available_at, run_token, lease_expires_at, attempts, max_attempts, created_at, updated_at FROM jobs WHERE id = ?").run(job.id);
  assert.throws(() => openRuntimeStore({ path: f.path }));
  assert.equal(f.db.prepare("PRAGMA user_version").get()?.user_version, 2);
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='article_captures'").get(), undefined);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM jobs").get()?.n, 2);
  f.db.exec("DELETE FROM jobs WHERE id = 'duplicate'");
  f.reopen();
  assert.equal(f.db.prepare("PRAGMA user_version").get()?.user_version, 6);
  assert.deepEqual(f.store.getTurn(turn.id), turn);
  assert.deepEqual(f.store.getJob(job.id), running);
  assert.deepEqual(f.store.getOutbox(outbox.id), sending);
  const replay = f.store.acceptFeishuText({ ...scope, text: "总结 " + url, chatId: "chat", messageId: "m1" });
  assert.equal(replay.outcome, "duplicate");
  assert.equal(f.store.getTurn(turn.id)?.source, "feishu");
  f.reopen();
  assert.equal(f.db.prepare("PRAGMA user_version").get()?.user_version, 6);
  assert.throws(() => f.db.prepare("INSERT INTO article_captures VALUES (?, ?)").run(job.id, "bad-json"));
});

for (const point of ["jobs", "turns", "outbox"] as const) test(`handoff rollback at ${point}, strict token and idempotency`, async t => {
  const f = await fixture(t);
  const input = f.accept();
  assert.equal(f.store.getTurn(input.turnId)?.source, "feishu_url_capture");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM jobs").get()?.n, 0);
  const turn = f.store.claimTurn(input.conversationId, 120_000)!;
  f.db.exec(`CREATE TRIGGER inject BEFORE ${point === "turns" ? "UPDATE" : "INSERT"} ON ${point} BEGIN SELECT RAISE(ABORT, 'injected'); END`);
  assert.throws(() => f.store.acceptCaptureTurn(turn.id, turn.runToken!, scope, true));
  assert.deepEqual(f.store.getTurn(turn.id), turn);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM jobs").get()?.n, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM outbox").get()?.n, 0);
  f.db.exec("DROP TRIGGER inject");
  assert.equal(f.store.acceptCaptureTurn(turn.id, "old", scope, true), null);
  assert.equal(f.store.acceptCaptureTurn(turn.id, turn.runToken!, { ...scope, appId: "wrong" }, true), null);
  const job = f.store.acceptCaptureTurn(turn.id, turn.runToken!, scope, true)!;
  assert.equal(f.store.acceptCaptureTurn(turn.id, turn.runToken!, scope, true), null);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM jobs").get()?.n, 1);
  assert.equal(f.store.getTurn(turn.id)?.state, "answered");
  assert.deepEqual(JSON.parse(String(f.db.prepare("SELECT payload_json FROM outbox").get()?.payload_json)), { text: "已接收，正在采集。" });
  assert.ok("originTurnId" in job);
  assert.equal(job.originTurnId, turn.id);
  assert.throws(() => f.store.enqueueJob({ originTurnId: turn.id, kind: "capture_article", payload: {}, idempotencyKey: "another", maxAttempts: 3 }));
});

test("idempotency conflict and expired handoff cannot silently change request", async t => {
  const f = await fixture(t);
  const input = f.accept();
  const turn = f.store.claimTurn(input.conversationId, 120_000)!;
  f.store.enqueueJob({ kind: "wrong", payload: {}, idempotencyKey: `capture_article:${turn.id}`, maxAttempts: 3 });
  assert.throws(() => f.store.acceptCaptureTurn(turn.id, turn.runToken!, scope, true), /capture_idempotency_conflict/);
  f.advance();
  assert.equal(f.store.acceptCaptureTurn(turn.id, turn.runToken!, scope, true), null);
  assert.equal(f.store.getTurn(turn.id)?.state, "running");
});

test("explicit rejection bypasses chat and oversized branch; prehandoff exhaustion backfills only once", async t => {
  const f = await fixture(t);
  for (const text of ["总结", "file:///secret", url + "x".repeat(4_000), url]) {
    const input = f.accept(text);
    assert.deepEqual(await processConversationOnce(input.conversationId, { store: f.store, now: f.now,
      agent: async () => assert.fail("no model"), feishu: { scope, captureAvailable: false } }), { outcome: "answered" });
  }
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM jobs").get()?.n, 0);
  const input = f.accept();
  for (let i = 0; i < 3; i++) { f.store.claimTurn(input.conversationId, 120_000); f.advance(); f.store.recoverExpiredTurns(input.conversationId); }
  f.reopen();
  assert.equal(f.store.backfillCaptureRejections(scope), 1);
  assert.equal(f.store.backfillCaptureRejections(scope), 0);
  const chat = f.accept("ordinary");
  const turn = f.store.claimTurn(chat.conversationId, 120_000)!;
  f.store.failTurn(turn.id, turn.runToken!, "failed");
  assert.equal(f.store.backfillCaptureRejections(scope), 0);
});

test("Job scope, stable due selection, backoff, archived conversation and immutable fenced checkpoints", async t => {
  const f = await fixture(t);
  const a = f.handoff();
  const b = f.handoff();
  const outsider = f.accept(url, { ...scope, appId: "other" }, "other");
  const outsideTurn = f.store.claimTurn(outsider.conversationId, 120_000)!;
  const outsideJob = f.store.acceptCaptureTurn(outsideTurn.id, outsideTurn.runToken!, { ...scope, appId: "other" }, true)!;
  const other = f.store.enqueueJob({ originTurnId: a.turn.id, kind: "other", payload: {}, idempotencyKey: "other", maxAttempts: 3 });
  const noOrigin = f.store.enqueueJob({ kind: "capture_article", payload: {}, idempotencyKey: "no-origin", maxAttempts: 3 });
  const expected = [a.job, b.job].sort((x, y) => x.id.localeCompare(y.id))[0];
  const first = f.store.claimCaptureJob(scope)!;
  assert.equal(first.id, expected.id);
  assert.equal(first.leaseExpiresAt, f.now() + 120_000);
  const cp = makeCp(first.id);
  assert.throws(() => f.store.saveCaptureCheckpoint(first.id, first.runToken!, scope,
    createCheckpoint(first.id, url, { title: "Title", sourceUrl: url, body: "" }, cp, new Date(2_000), new Date(0))), /capture_checkpoint_mismatch/);
  f.db.exec("CREATE TRIGGER checkpoint_fail BEFORE INSERT ON article_captures BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => f.store.saveCaptureCheckpoint(first.id, first.runToken!, scope, cp));
  f.db.exec("DROP TRIGGER checkpoint_fail");
  assert.equal(f.store.saveCaptureCheckpoint(first.id, a.turn.runToken!, scope, cp), null);
  assert.deepEqual(f.store.saveCaptureCheckpoint(first.id, first.runToken!, scope, cp), cp);
  assert.deepEqual(f.store.saveCaptureCheckpoint(first.id, first.runToken!, scope, { ...cp, title: "ignored overwrite" }), cp);
  assert.equal(f.store.getJob(first.id)?.state, "running");
  assert.equal(f.store.retryCaptureJob(first.id, first.runToken!, scope, "capture_fetch_failed", false, 60_000), "retry_scheduled");
  assert.equal(f.store.getJob(first.id)?.availableAt, f.now() + 60_000);
  f.db.prepare("UPDATE conversations SET status='archived' WHERE id=?").run(a.turn.conversationId);
  const second = f.store.claimCaptureJob(scope)!;
  assert.notEqual(second.id, first.id);
  assert.deepEqual(f.store.getJob(other.id), other);
  assert.deepEqual(f.store.getJob(noOrigin.id), noOrigin);
  assert.equal(f.store.getJob(outsideJob.id)?.attempts, 0);
  f.advance();
  f.store.recoverCaptureJobs(scope);
  assert.equal(f.store.readCaptureCheckpoint(second.id, second.runToken!, scope), null);
  assert.equal(f.store.saveCaptureCheckpoint(first.id, first.runToken!, scope, cp), null);
});

test("Job terminal + result rollback, exhausted recovery notification, and stale writes", async t => {
  const f = await fixture(t);
  const { job, turn } = f.handoff();
  let running = f.store.claimCaptureJob(scope)!;
  const cp = makeCp(job.id);
  f.store.saveCaptureCheckpoint(job.id, running.runToken!, scope, cp);
  f.db.exec("CREATE TRIGGER result_fail BEFORE INSERT ON outbox WHEN NEW.kind='job_result' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => f.store.completeCaptureJob(job.id, running.runToken!, scope));
  assert.throws(() => f.store.retryCaptureJob(job.id, running.runToken!, scope, "capture_access_blocked", true));
  assert.equal(f.store.getJob(job.id)?.state, "running");
  f.db.exec("DROP TRIGGER result_fail");
  for (let i = 1; i < 3; i++) { f.advance(); f.store.recoverCaptureJobs(scope); running = f.store.claimCaptureJob(scope)!; }
  f.advance();
  f.db.exec("CREATE TRIGGER result_fail BEFORE INSERT ON outbox WHEN NEW.kind='job_result' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => f.store.recoverCaptureJobs(scope));
  assert.equal(f.store.getJob(job.id)?.state, "running");
  f.db.exec("DROP TRIGGER result_fail");
  assert.deepEqual(f.store.recoverCaptureJobs(scope), [{ id: job.id, state: "failed" }]);
  assert.deepEqual(f.store.recoverCaptureJobs(scope), []);
  assert.equal(f.store.claimCaptureJob(scope), null);
  assert.equal(f.store.getJob(job.id)?.attempts, 3);
  assert.equal(f.store.getTurn(turn.id)?.state, "answered");
  const text = String(f.db.prepare("SELECT payload_json FROM outbox WHERE kind='job_result'").get()?.payload_json);
  assert.match(text, /未能确认完成/);
  assert.match(text, /可能已留下/);
  assert.equal(f.store.completeCaptureJob(job.id, running.runToken!, scope), false);
  for (const permanent of [true, false]) assert.equal(f.store.retryCaptureJob(job.id, running.runToken!, scope, "capture_timeout", permanent), "lost_lease");
});

test("outbox ACK causality, different stable UUIDs, result backoff never blocks chat", async t => {
  const f = await fixture(t);
  const a = f.handoff();
  const running = f.store.claimCaptureJob(scope)!;
  f.store.saveCaptureCheckpoint(running.id, running.runToken!, scope, makeCp(running.id));
  assert.equal(f.store.completeCaptureJob(running.id, running.runToken!, scope), true);
  const ack = f.store.claimOutbox(60_000, scope)!;
  assert.equal(ack.kind, "final_message");
  assert.equal(f.store.claimOutbox(60_000, scope), null);
  f.store.failOutbox(ack.id, ack.runToken!, "forbidden");
  const result = f.store.claimOutbox(60_000, scope)!;
  assert.equal(result.kind, "job_result");
  assert.equal(result.turnId, a.turn.id);
  const message = f.store.getFeishuReplyTarget(a.turn.id, scope)!;
  assert.notEqual(feishuReplyRequest(message, ack).data.uuid, feishuReplyRequest(message, result).data.uuid);
  const request = feishuReplyRequest(message, result);
  f.store.retryOutbox(result.id, result.runToken!, f.now() + 30_000, "timeout");
  const chat = f.accept("unrelated chat");
  await processConversationOnce(chat.conversationId, { store: f.store, now: f.now, agent: async () => ({ text: "answer" }), feishu: { scope, captureAvailable: true } });
  const chatReply = f.store.claimOutbox(60_000, scope)!;
  assert.equal(chatReply.turnId, chat.turnId);
  f.store.markOutboxSent(chatReply.id, chatReply.runToken!);
  f.advance(30_000);
  const retry = f.store.claimOutbox(60_000, scope)!;
  assert.equal(retry.id, result.id);
  assert.deepEqual(feishuReplyRequest(message, retry), request);
  f.advance(60_000);
  f.store.recoverFeishuOutbox(scope);
  const again = f.store.claimOutbox(60_000, scope)!;
  assert.equal(again.id, result.id);
  assert.equal(f.store.markOutboxSent(again.id, retry.runToken!), false);
});

test("snapshot has only committed successes, freezes across awaits and separates pending tasks", async t => {
  const f = await fixture(t);
  const a = f.handoff();
  const running = f.store.claimCaptureJob(scope)!;
  f.store.saveCaptureCheckpoint(running.id, running.runToken!, scope, makeCp(running.id));
  const b = f.handoff();
  const question = f.accept("A 和 B 怎么样？");
  const snapshot = f.store.getFeishuContext(question.conversationId, 4, scope);
  assert.deepEqual(snapshot.captureContext.results, []);
  assert.equal(snapshot.captureContext.statuses.length, 2);
  assert.equal(f.store.completeCaptureJob(running.id, running.runToken!, scope), true);
  assert.deepEqual(snapshot.captureContext.results, []);
  const fresh = f.store.getFeishuContext(question.conversationId, 4, scope);
  assert.equal(fresh.captureContext.results[0].jobId, a.job.id);
  assert.equal(fresh.captureContext.statuses[0].jobId, b.job.id);
  assert.ok(!JSON.stringify(fresh.captureContext).includes("sent"));
  assert.deepEqual(f.store.getFeishuContext(question.conversationId, 1, scope).captureContext, { results: [], statuses: [] });
  assert.deepEqual(f.store.getFeishuContext(question.conversationId, 4, { ...scope, appId: "other" }).captureContext, { results: [], statuses: [] });
  assert.equal(fresh.history.length, 2);
  assert.match(fresh.history[0].text, /已接收/);
});

test("context filters before latest-three, bounds JSON and never exposes cross-conversation data", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) {
    const { job } = f.handoff();
    const running = f.store.claimCaptureJob(scope)!;
    const cp = createCheckpoint(job.id, url, { title: "Title", sourceUrl: url, body: "" },
      { summary: "\0".repeat(i === 3 ? 800 : 420), keyPoints: Array(5).fill("x".repeat(200)) }, new Date(f.now()), new Date(job.createdAt));
    f.store.saveCaptureCheckpoint(job.id, running.runToken!, scope, cp);
    f.store.completeCaptureJob(job.id, running.runToken!, scope);
    f.advance(1);
  }
  const latestIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const input = f.accept();
    const turn = f.store.claimTurn(input.conversationId, 120_000)!;
    const id = `status-${i}-` + "x".repeat(i === 3 ? 600 : 390);
    f.store.enqueueJob({ id, originTurnId: turn.id, kind: "capture_article", payload: { version: 1, url }, idempotencyKey: `capture_article:${turn.id}`, maxAttempts: 3 });
    f.store.acceptCaptureTurn(turn.id, turn.runToken!, scope, true);
    if (i < 3) latestIds.push(id);
  }
  const query = f.accept("follow-up");
  const context = f.store.getFeishuContext(query.conversationId, 9, scope).captureContext;
  assert.ok(JSON.stringify(context).length <= 12_000);
  assert.ok(context.results.every(item => JSON.stringify(item).length <= 4_000));
  assert.ok(context.statuses.every(item => JSON.stringify(item).length <= 500));
  assert.equal(context.results.some(item => item.originSequence === 4), false);
  assert.deepEqual(context.statuses.map(item => item.jobId), latestIds);
  assert.ok(context.results.length < 3, "oldest summary is removed to fit total; statuses retained");
  assert.equal(context.results.at(-1)?.originSequence, 3);
  const other = f.accept("other chat", scope, "other-chat");
  assert.deepEqual(f.store.getFeishuContext(other.conversationId, 100, scope).captureContext, { results: [], statuses: [] });
  assert.deepEqual(f.store.getFeishuContext(query.conversationId, 9, { ...scope, appId: "wrong" }).history, []);
});

test("result is ineligible without own ACK; ready result can precede later chat", async t => {
  const f = await fixture(t);
  const a = f.handoff();
  const job = f.store.claimCaptureJob(scope)!;
  f.store.saveCaptureCheckpoint(job.id, job.runToken!, scope, makeCp(job.id));
  f.store.completeCaptureJob(job.id, job.runToken!, scope);
  const ack = f.store.claimOutbox(60_000, scope)!;
  f.store.markOutboxSent(ack.id, ack.runToken!);
  f.advance(1);
  const chat = f.accept("later chat");
  await processConversationOnce(chat.conversationId, { store: f.store, now: f.now, agent: async () => ({ text: "later" }), feishu: { scope, captureAvailable: true } });
  assert.equal(f.store.claimOutbox(60_000, scope)?.kind, "job_result");
  f.db.prepare("UPDATE outbox SET state='pending', run_token=NULL, lease_expires_at=NULL WHERE turn_id=? AND kind='job_result'").run(a.turn.id);
  f.db.prepare("DELETE FROM outbox WHERE id=?").run(ack.id);
  const next = f.store.claimOutbox(60_000, scope)!;
  assert.equal(next.turnId, chat.turnId);
  f.store.markOutboxSent(next.id, next.runToken!);
  assert.equal(f.store.claimOutbox(60_000, scope), null);
});

test("failed explicit Turn notification backfill is bounded to twenty and does not include old chat", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 21; i++) f.accept();
  f.accept("old chat");
  f.db.exec("UPDATE turns SET state='failed'");
  assert.equal(f.store.backfillCaptureRejections({ ...scope, appId: "other" }), 0);
  assert.equal(f.store.backfillCaptureRejections(scope), 20);
  const first = f.store.claimOutbox(60_000, scope)!;
  assert.equal(first.kind, "final_message");
  f.store.markOutboxSent(first.id, first.runToken!);
  assert.equal(f.store.backfillCaptureRejections(scope), 1);
  assert.equal(f.store.backfillCaptureRejections(scope), 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM outbox").get()?.n, 21);
});
