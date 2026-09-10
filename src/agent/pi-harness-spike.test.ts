import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { AgentHarness, BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { builtinModels, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
  createNodeSqliteFactory,
  SqliteSessionRepo,
} from "@earendil-works/pi-session-backend-sqlite-node";

const context = BACKGROUND_CONTEXT;
const model = getBuiltinModel("deepseek", "deepseek-v4-flash");

function isDatabaseLockError(error: unknown): boolean {
  return error instanceof Error && /SQLITE_BUSY|database is locked/i.test(String(error.cause ?? error));
}

async function createHarness(databasePath: string) {
  const repository = new SqliteSessionRepo({
    directory: join(tmpdir(), "knowledge-radar-pi-sessions"),
    databasePath,
    databaseFactory: createNodeSqliteFactory(),
  });
  const session = await repository.create({ id: "spike-session" }, context);
  const { harness } = await AgentHarness.create(
    { session, models: builtinModels(), model, systemPrompt: "Technical spike only." },
    context,
  );

  return { harness, lane: await harness.lane("main", context), repository, session };
}

test("AgentHarness restores a durable lane after reopening its SQLite session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-radar-pi-spike-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const databasePath = join(directory, "radar.db");

  const first = await createHarness(databasePath);
  const metadata = first.session.metadata;
  await first.lane.appendMessage(
    { role: "user", content: "persist across restart", timestamp: 1 },
    context,
  );
  await first.harness.close(context);
  await first.repository.close(context);

  const repository = new SqliteSessionRepo({
    directory,
    databasePath,
    databaseFactory: createNodeSqliteFactory(),
  });
  const session = await repository.open(metadata, context);
  const { harness } = await AgentHarness.create(
    { session, models: builtinModels(), model, systemPrompt: "Technical spike only." },
    context,
  );
  const lane = await harness.lane("main", context);
  const entries = await lane.findEntries({ order: "oldestFirst" }, context);

  assert.deepEqual(entries.find((entry) => entry.type === "message")?.message, {
    role: "user",
    content: "persist across restart",
    timestamp: 1,
  });

  await harness.close(context);
  await repository.close(context);
});

test("AgentHarness cannot join an application-owned SQLite transaction", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-radar-pi-spike-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const databasePath = join(directory, "radar.db");
  const spike = await createHarness(databasePath);
  const metadata = spike.session.metadata;
  const radarDatabase = new DatabaseSync(databasePath);

  try {
    radarDatabase.exec("CREATE TABLE radar_jobs (id TEXT PRIMARY KEY)");
    radarDatabase.exec("BEGIN IMMEDIATE");
    radarDatabase.prepare("INSERT INTO radar_jobs (id) VALUES (?)").run("job-1");

    await assert.rejects(
      spike.lane.appendMessage(
        { role: "user", content: "must share the transaction", timestamp: 2 },
        context,
      ),
      isDatabaseLockError,
    );
  } finally {
    radarDatabase.exec("ROLLBACK");
    radarDatabase.close();
    await spike.harness.close(context);
    await spike.repository.close(context);
  }

  const repository = new SqliteSessionRepo({
    directory,
    databasePath,
    databaseFactory: createNodeSqliteFactory(),
  });
  const session = await repository.open(metadata, context);
  const entries = await session.findEntries({ type: "message" }, context);

  assert.equal(entries.length, 0);

  await session.close(context);
  await repository.close(context);
});
