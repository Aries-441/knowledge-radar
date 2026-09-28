import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { runCli } from "./command.js";
import { openRuntimeStore } from "../runtime/store.js";
import type { TopicAgentRuntime } from "../agent/topic-runtime.js";

test("run-once rejects Feishu before recovery or claims, including expired leases", async () => {
  let clock = 1_000;
  const store = openRuntimeStore({ path: ":memory:", now: () => clock });
  try {
    const accepted = store.acceptFeishuText({ appId: "app", tenantKey: "tenant", ownerOpenId: "owner",
      chatId: "chat", messageId: "message", text: "https://example.com" });
    assert.notEqual(accepted.outcome, "ignored");
    if (accepted.outcome === "ignored") return;
    const turn = store.claimTurn(accepted.conversationId, 100)!;
    const job = store.enqueueJob({ kind: "unrelated", payload: {}, maxAttempts: 3, idempotencyKey: "job" });
    const close = store.close.bind(store);
    store.close = () => {
      assert.deepEqual(store.getTurn(turn.id), turn);
      assert.deepEqual(store.getJob(job.id), job);
      store.close = close;
      close();
    };
    const output: string[] = [];
    clock += 1_000;
    assert.equal(await runCli(["run-once", accepted.conversationId], { openStore: () => store,
      env: { KNOWLEDGE_RADAR_STATE_PATH: ":memory:" }, stdout: line => output.push(line),
      stderr: () => assert.fail(), agent: async () => assert.fail(), capture: async () => assert.fail(),
      now: () => clock }), 1);
    assert.deepEqual(output, ['{"outcome":"unsupported_conversation"}']);
  } finally { store.close(); }
});

test("serve-feishu CLI injects fake service, validates configuration and leaves stdout empty", async () => {
  const env = { FEISHU_APP_ID: "cli_0000000000000001", FEISHU_APP_SECRET: "never-log",
    FEISHU_TENANT_KEY: "tenant", FEISHU_ALLOWED_OPEN_ID: "ou_owner", KNOWLEDGE_RADAR_STATE_PATH: ":memory:" };
  const output: string[] = [], errors: string[] = [];
  let calls = 0;
  const deps = { env, stdout: (line: string) => output.push(line), stderr: (line: string) => errors.push(line),
    capture: async () => assert.fail("not a URL"), agent: async () => assert.fail("not a model call"),
    serveFeishu: async (config: { ownerOpenId: string }) => { assert.equal(config.ownerOpenId, "ou_owner"); calls++; return 0; } };
  assert.equal(await runCli(["serve-feishu"], deps), 0);
  assert.equal(calls, 1);
  assert.equal(await runCli(["serve-feishu", "extra"], deps), 1);
  assert.equal(await runCli(["serve-feishu"], { ...deps, env: { ...env, FEISHU_ALLOWED_OPEN_ID: "" } }), 1);
  assert.equal(calls, 1);
  assert.deepEqual(output, []);
  assert.ok(errors.every(line => JSON.parse(line).event === "service_failed"));
  assert.ok(!errors.join("").includes("never-log"));
});

test("preview-feed-digest emits a machine-readable result and validates configuration", async () => {
  const env = { FEISHU_APP_ID: "cli_0000000000000001", FEISHU_APP_SECRET: "never-log",
    FEISHU_TENANT_KEY: "tenant", FEISHU_ALLOWED_OPEN_ID: "ou_owner", KNOWLEDGE_RADAR_STATE_PATH: ":memory:" };
  const output: string[] = [], errors: string[] = [];
  let calls = 0;
  const deps = { env, stdout: (line: string) => output.push(line), stderr: (line: string) => errors.push(line),
    capture: async () => assert.fail("not a URL"), agent: async () => assert.fail("not a model call"),
    previewFeedDigest: async (config: { ownerOpenId: string }) => { assert.equal(config.ownerOpenId, "ou_owner"); calls++; return { outcome: "empty" }; } };
  assert.equal(await runCli(["preview-feed-digest"], deps), 0);
  assert.deepEqual(output, ['{"outcome":"empty"}']);
  assert.equal(await runCli(["preview-feed-digest", "extra"], deps), 1);
  assert.equal(await runCli(["preview-feed-digest"], { ...deps, env: { ...env, FEISHU_ALLOWED_OPEN_ID: "" } }), 1);
  assert.equal(calls, 1);
  assert.ok(errors.every(line => JSON.parse(line).outcome === "failed"));
  assert.ok(!errors.join("").includes("never-log"));
});

test("local run-once handler uses a Fake Agent and emits exact outcome JSON across retries", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "radar-cli-"));
  const path = join(directory, "radar.db");
  const clock = { value: 1_000 };
  const now = () => clock.value;
  const store = openRuntimeStore({ path, now });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  store.createConversation({ id: "topic", kind: "general", title: "Test" });
  const stdout: string[] = [];
  const stderr: string[] = [];
  let calls = 0;
  const run = (agent: TopicAgentRuntime) => runCli(["run-once", "topic"], {
    agent: async (input) => { calls++; return agent(input); },
    capture: async () => { assert.fail("capture must not run"); },
    env: { KNOWLEDGE_RADAR_STATE_PATH: path }, now,
    stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
  });
  const answer = async () => ({ text: "Fake reply" });
  assert.equal(await run(answer), 0);
  assert.equal(stdout.pop(), '{"outcome":"idle"}');
  assert.equal(calls, 0);
  const first = store.createTurn({ conversationId: "topic", content: "hello", source: "test", maxAttempts: 2 });
  assert.equal(await run(answer), 0);
  assert.equal(stdout.pop(), '{"outcome":"answered"}');
  assert.equal(store.getTurn(first.id)?.state, "answered");
  store.createTurn({ conversationId: "topic", content: "retry", source: "test", maxAttempts: 2 });
  const failure = async () => { throw new Error("sensitive provider details"); };
  assert.equal(await run(failure), 0);
  assert.equal(stdout.pop(), '{"outcome":"retry_scheduled"}');
  clock.value += 30_000;
  assert.equal(await run(failure), 1);
  assert.equal(stdout.pop(), '{"outcome":"failed"}');
  store.createTurn({ conversationId: "topic", content: "late", source: "test", maxAttempts: 2 });
  assert.equal(await run(async () => { clock.value += 120_000; return answer(); }), 0);
  assert.equal(stdout.pop(), '{"outcome":"lost_lease"}');
  const db = new DatabaseSync(path);
  db.exec("BEGIN IMMEDIATE");
  const previousCalls = calls;
  try {
    assert.equal(await run(answer), 1);
    assert.equal(stdout.pop(), '{"outcome":"storage_busy"}');
    assert.equal(calls, previousCalls);
  } finally { db.exec("ROLLBACK"); db.close(); }
  assert.deepEqual(stderr, []);
});

test("CLI validates arguments and path before opening a store, and preserves the URL entry", async () => {
  const errors: string[] = [];
  const output: string[] = [];
  const urls: string[] = [];
  const dependencies = {
    agent: async () => { assert.fail(); },
    capture: async (url: string) => { urls.push(url); return { path: "example.md" }; },
    env: {}, stdout: (line: string) => output.push(line), stderr: (line: string) => errors.push(line),
    openStore: () => { assert.fail("store must not open"); },
  };
  for (const args of [[], ["run-once"], ["run-once", " "], ["run-once", "id", "extra"], ["run-once", "id"]]) {
    assert.equal(await runCli(args, dependencies), 1);
  }
  assert.equal(errors.length, 5);
  assert.deepEqual(output, []);
  const url = "https://www.cnblogs.com/uniqueDong/p/22889846";
  assert.equal(await runCli([url], dependencies), 0);
  assert.deepEqual(urls, [url]);
  assert.deepEqual(output, ['{"path":"example.md"}']);
});

test("real CLI entry runs idle without model credentials and rejects an unknown conversation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "radar-cli-process-"));
  const path = join(directory, "radar.db");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = openRuntimeStore({ path });
  store.createConversation({ id: "empty", kind: "general", title: "Empty" });
  store.close();
  const env = { ...process.env, KNOWLEDGE_RADAR_STATE_PATH: path, KNOWLEDGE_RADAR_MODEL: "invalid" };
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "src/cli.ts", "run-once", "empty"], { env });
  assert.deepEqual(JSON.parse(result.stdout), { outcome: "idle" });
  await assert.rejects(promisify(execFile)(process.execPath, ["--import", "tsx", "src/cli.ts", "run-once", "missing"], { env }),
    (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /运行失败/);
      return true;
    });
});
