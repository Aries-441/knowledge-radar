import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openRuntimeStore, StorageBusyError } from "./store.js";
import { processCaptureJobOnce, type CaptureDependencies } from "./capture-worker.js";
import { processFeishuTurnsOnce, deliverFeishuOnce, serveFeishu } from "./feishu-service.js";
import { createCheckpoint, publishCheckpoint } from "../article/durable-archive.js";
import { CaptureError, CaptureCleanupError } from "../article/capture-error.js";
import { feishuReplyRequest } from "../channels/feishu/adapter.js";

const scope = { appId: "app", tenantKey: "tenant", ownerOpenId: "owner" };
const url = "https://example.com/article";
const article = { title: "Public article", sourceUrl: url, body: "Private full body" };
const summary = { summary: "Structured summary", keyPoints: ["One", "Two"] };
const noop = () => {};
const alive = new AbortController().signal;

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "radar-capture-worker-"));
  const path = join(directory, "radar.db");
  let time = 1_000;
  const now = () => time;
  let store = openRuntimeStore({ path, now, busyTimeoutMs: 0 });
  const db = new DatabaseSync(path);
  t.after(async () => { store.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  let sequence = 0;
  const accept = (text = url) => {
    const result = store.acceptFeishuText({ ...scope, text, chatId: "chat", messageId: `m${++sequence}` });
    if (result.outcome === "ignored") throw Error("ignored");
    return result;
  };
  const count = { page: 0, model: 0, files: 0 };
  const dependencies: CaptureDependencies = {
    render: async () => { count.page++; return article; },
    summarize: async () => { count.model++; return summary; },
    publish: async (...args) => { count.files++; await publishCheckpoint(...args); },
  };
  const turn = (agent = async () => ({ text: "chat reply" }), available = true) => processFeishuTurnsOnce({ store, scope, agent, now, log: noop, signal: alive, captureAvailable: available });
  const job = (overrides: CaptureDependencies = {}) => processCaptureJobOnce({ store, scope, archiveDir: directory, now, dependencies: { ...dependencies, ...overrides } });
  return { get store() { return store; }, db, path, directory, now, dependencies, count, accept, turn, job,
    advance: (ms = 120_000) => { time += ms; }, reopen: () => { store.close(); store = openRuntimeStore({ path, now, busyTimeoutMs: 0 }); } };
}

test("real temporary DB/files + fake providers: accept, ACK, background chat, result, follow-up and send replay", async t => {
  const f = await fixture(t);
  const origin = f.accept();
  await f.turn(async () => assert.fail("URL must not chat"));
  const requests: unknown[] = [];
  const send = async (id: string, outbox: Parameters<typeof feishuReplyRequest>[1]) => { requests.push(feishuReplyRequest(id, outbox)); };
  await deliverFeishuOnce({ store: f.store, scope, now: f.now, send });
  let release!: () => void;
  const waitModel = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = f.job({ summarize: async () => { f.count.model++; started(); await waitModel; return summary; } });
  await ready;
  f.accept("unrelated");
  await f.turn();
  await deliverFeishuOnce({ store: f.store, scope, now: f.now, send });
  assert.equal(requests.length, 2);
  release();
  const result = await pending;
  assert.equal(result.outcome, "succeeded");
  const cp = JSON.parse(String(f.db.prepare("SELECT result_json FROM article_captures").get()?.result_json));
  assert.equal(cp.taskCreatedAt, new Date(Number(f.db.prepare("SELECT created_at FROM jobs").get()?.created_at)).toISOString());
  assert.equal(cp.capturedAt, new Date(f.now()).toISOString());
  assert.deepEqual(JSON.parse(String(f.db.prepare("SELECT payload_json FROM outbox WHERE kind='final_message' AND turn_id=?").get(origin.turnId)?.payload_json)), { text: "已接收，正在采集。" });
  assert.equal(await readFile(join(f.directory, cp.filename), "utf8"), cp.markdown);
  assert.ok(!cp.markdown.includes(article.body));
  assert.equal((await readdir(f.directory)).filter(name => name.endsWith(".md")).length, 1);
  f.db.exec("CREATE TRIGGER sent_fail BEFORE UPDATE ON outbox WHEN NEW.state='sent' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  await assert.rejects(deliverFeishuOnce({ store: f.store, scope, now: f.now, send }));
  const firstResult = requests[2];
  f.db.exec("DROP TRIGGER sent_fail");
  f.advance(); f.reopen();
  await deliverFeishuOnce({ store: f.store, scope, now: f.now, send });
  assert.deepEqual(requests[3], firstResult);
  assert.deepEqual(f.count, { page: 1, model: 1, files: 1 });
  f.accept("文章重点是什么？");
  await processFeishuTurnsOnce({ store: f.store, scope, now: f.now, signal: alive, log: noop, captureAvailable: true,
    agent: async input => {
      assert.equal(input.captureContext?.results[0].summary, summary.summary);
      assert.equal(input.captureContext?.results[0].originSequence, 1);
      assert.ok(!JSON.stringify(input).includes(article.body));
      return { text: "根据摘要，重点是……" };
    } });
  assert.equal(f.store.getTurn(origin.turnId)?.state, "answered");
});

for (const crash of ["before_checkpoint", "after_checkpoint", "after_file"] as const) test(`restart recovery ${crash} reuses only committed work`, async t => {
  const f = await fixture(t);
  f.accept(); await f.turn();
  const originalSave = f.store.saveCaptureCheckpoint.bind(f.store);
  const originalComplete = f.store.completeCaptureJob.bind(f.store);
  if (crash === "before_checkpoint") f.store.saveCaptureCheckpoint = () => { throw new StorageBusyError("injected"); };
  if (crash === "after_file") f.store.completeCaptureJob = () => { throw new StorageBusyError("injected"); };
  await assert.rejects(f.job(crash === "after_checkpoint" ? { publish: async () => { throw new StorageBusyError("injected"); } } : {}), StorageBusyError);
  f.store.saveCaptureCheckpoint = originalSave;
  f.store.completeCaptureJob = originalComplete;
  f.advance(); f.reopen();
  assert.equal((await f.job()).outcome, "succeeded");
  assert.equal(f.count.model, crash === "before_checkpoint" ? 2 : 1);
  assert.equal((await readdir(f.directory)).filter(name => name.endsWith(".md")).length, 1);
});

test("disabled capture does not claim pending jobs, still expires final attempt and sends failure", async t => {
  const f = await fixture(t);
  f.accept(); await f.turn();
  const id = String(f.db.prepare("SELECT id FROM jobs").get()?.id);
  await processCaptureJobOnce({ store: f.store, scope, now: f.now });
  assert.equal(f.store.getJob(id)?.attempts, 0);
  for (let i = 0; i < 3; i++) {
    f.store.claimCaptureJob(scope); f.advance();
    await processCaptureJobOnce({ store: f.store, scope, now: f.now });
  }
  assert.equal(f.store.getJob(id)?.state, "failed");
  assert.equal(f.store.getJob(id)?.attempts, 3);
  const sent: string[] = [];
  for (let i = 0; i < 2; i++) await deliverFeishuOnce({ store: f.store, scope, now: f.now, send: async (_, outbox) => { sent.push(outbox.kind); } });
  assert.deepEqual(sent, ["final_message", "job_result"]);
  f.accept(); await f.turn(async () => assert.fail(), false);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM jobs").get()?.n, 1);
});

test("page timeout actually aborts; uncooperative cleanup is fatal instead of another job", async t => {
  const f = await fixture(t);
  f.accept(); await f.turn();
  const budgets = { page: 5, model: 5, persist: 5, cleanup: 5 };
  let cancelled = false;
  assert.equal((await f.job({ budgets, render: async (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { cancelled = true; reject(new CaptureError("capture_timeout")); }, { once: true });
  }) })).outcome, "retry_scheduled");
  assert.equal(cancelled, true);
  f.advance(30_000);
  await assert.rejects(f.job({ budgets, render: async () => new Promise(() => {}) }), CaptureCleanupError);
  assert.equal(f.db.prepare("SELECT state FROM jobs").get()?.state, "running");
});

test("shared remaining deadline cancels model, loss of lease fences success/permanent/retry", async t => {
  const f = await fixture(t);
  f.accept(); await f.turn();
  let cancelled = false;
  assert.equal((await f.job({ budgets: { page: 10, model: 10, persist: 10, cleanup: 10 },
    render: async () => { f.advance(25); return article; },
    summarize: async (_, { signal, timeoutMs }) => { assert.equal(timeoutMs, 5); return new Promise((_, reject) => {
      signal.addEventListener("abort", () => { cancelled = true; reject(new CaptureError("capture_timeout")); });
    }); } })).outcome, "retry_scheduled");
  assert.equal(cancelled, true);
  for (const failure of [undefined, new CaptureError("capture_fetch_failed"), new CaptureError("capture_access_blocked", true)]) {
    f.accept(); await f.turn();
    f.advance(120_000);
    const outcome = await f.job({ summarize: async () => { f.advance(); if (failure) throw failure; return summary; } });
    assert.equal(outcome.outcome, "lost_lease");
  }
});

test("service stops nonzero on cleanup failure without closing DB used by late work", async t => {
  const f = await fixture(t);
  f.accept(); await f.turn();
  const records: unknown[] = [];
  const result = await serveFeishu({ config: { ...scope, statePath: f.path, appSecret: "secret", archiveDir: f.directory },
    agent: async () => ({ text: "chat" }), signal: alive, log: r => records.push(r), probeArchive: async () => true,
    openStore: () => f.store, now: f.now, drainTimeoutMs: 50,
    createTransport: () => ({ start: async () => {}, close() {}, send: async () => {} }),
    capture: { budgets: { page: 5, model: 5, persist: 5, cleanup: 5 }, render: async () => new Promise(() => {}) } });
  assert.deepEqual(result, { exitCode: 1, drained: false });
  assert.equal(f.db.prepare("SELECT attempts FROM jobs").get()?.attempts, 1);
  assert.equal(f.store.getConversation(String(f.db.prepare("SELECT id FROM conversations").get()?.id))?.kind, "feishu_private");
  assert.match(JSON.stringify(records), /capture_cleanup_failed/);
  assert.ok(!JSON.stringify(records).includes("secret"));
});

test("all three service loops run concurrently and share one stop/drain boundary", async t => {
  const f = await fixture(t);
  f.accept(); await f.turn(); f.accept("chat while job runs");
  const started = [gate(), gate(), gate()], releases = [gate(), gate(), gate()];
  const stop = new AbortController();
  let receive!: (event: unknown) => Promise<unknown>;
  let closed = false;
  const pending = serveFeishu({ config: { ...scope, statePath: f.path, appSecret: "secret", archiveDir: f.directory },
    agent: async () => { started[0].resolve(); await releases[0].promise; return { text: "chat" }; },
    signal: stop.signal, log: noop, probeArchive: async () => true, openStore: () => f.store, now: f.now,
    createTransport: () => ({ start: async callback => { receive = callback; }, close: () => { closed = true; },
      send: async () => { started[2].resolve(); await releases[2].promise; } }),
    capture: { ...f.dependencies, render: async () => { started[1].resolve(); await releases[1].promise; return article; } } });
  await Promise.all(started.map(g => g.promise));
  stop.abort();
  assert.equal(closed, true);
  await assert.rejects(receive({}), /service_stopping/);
  releases[0].resolve(); releases[2].resolve();
  await Promise.resolve();
  assert.equal(f.store.getJob(String(f.db.prepare("SELECT id FROM jobs").get()?.id))?.state, "running");
  releases[1].resolve();
  assert.deepEqual(await pending, { exitCode: 0, drained: true });
  assert.equal(f.db.prepare("SELECT state FROM jobs").get()?.state, "succeeded");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM jobs").get()?.n, 1);
});
