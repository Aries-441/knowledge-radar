import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { openRuntimeStore, RuntimeStoreError, StorageBusyError } from "./store.js";

type Fixture = {
  path: string;
  store: ReturnType<typeof openRuntimeStore>;
  clock: { now: number };
};

async function createFixture(t: TestContext): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-radar-runtime-"));
  const clock = { now: 1_000 };
  let token = 0;
  const store = openRuntimeStore({
    path: join(directory, "radar.db"),
    now: () => clock.now,
    createToken: () => `token-${++token}`,
  });

  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  return { path: join(directory, "radar.db"), store, clock };
}

function createConversation(fixture: Fixture, id = "conversation-1") {
  return fixture.store.createConversation({ id, kind: "general", title: "A conversation" });
}

test("migrates, persists records, and rejects a future database version", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-radar-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "radar.db");

  const first = openRuntimeStore({ path, now: () => 1_000 });
  first.createConversation({ id: "conversation-1", kind: "general", title: "Persisted" });
  first.close();

  const reopened = openRuntimeStore({ path, now: () => 2_000 });
  assert.equal(reopened.getConversation("conversation-1")?.title, "Persisted");
  reopened.close();

  const futurePath = join(directory, "future.db");
  const future = new DatabaseSync(futurePath);
  future.exec("PRAGMA user_version = 6");
  future.close();
  assert.throws(() => openRuntimeStore({ path: futurePath }), RuntimeStoreError);
});

test("claims only the earliest due Turn once across two runners", async (t) => {
  const fixture = await createFixture(t);
  createConversation(fixture);
  assert.throws(
    () =>
      fixture.store.createTurn({
        conversationId: "conversation-1",
        source: "test",
        content: "invalid",
        maxAttempts: 0,
      }),
    RangeError,
  );
  const firstTurn = fixture.store.createTurn({
    id: "turn-1",
    conversationId: "conversation-1",
    source: "test",
    content: "first",
    maxAttempts: 2,
  });
  fixture.store.createTurn({
    id: "turn-2",
    conversationId: "conversation-1",
    source: "test",
    content: "second",
    maxAttempts: 2,
  });

  const secondRunner = openRuntimeStore({ path: fixture.path, now: () => fixture.clock.now, createToken: () => "runner-2" });
  try {
    const claimed = secondRunner.claimTurn("conversation-1", 100);

    assert.equal(claimed?.id, firstTurn.id);
    assert.equal(fixture.store.claimTurn("conversation-1", 100), null);
    assert.equal(fixture.store.failTurn(firstTurn.id, claimed?.runToken ?? "", "terminal"), true);
    assert.equal(fixture.store.claimTurn("conversation-1", 100)?.id, "turn-2");
  } finally {
    secondRunner.close();
  }
});

test("maps a busy database to a retryable error", async (t) => {
  const fixture = await createFixture(t);
  const lock = new DatabaseSync(fixture.path);
  lock.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(
      () => fixture.store.createConversation({ id: "blocked", kind: "general", title: "Blocked" }),
      StorageBusyError,
    );
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
});

test("rejects an expired Turn token and atomically creates the final Outbox", async (t) => {
  const fixture = await createFixture(t);
  createConversation(fixture);
  const turn = fixture.store.createTurn({
    id: "turn-1",
    conversationId: "conversation-1",
    source: "test",
    content: "question",
    maxAttempts: 2,
  });
  const firstClaim = fixture.store.claimTurn(turn.conversationId, 10);
  assert.ok(firstClaim?.runToken);
  assert.equal(fixture.store.renewTurn(turn.id, firstClaim.runToken, 20), true);

  fixture.clock.now = 1_011;
  assert.equal(fixture.store.recoverExpiredLeases().turns, 0);
  fixture.clock.now = 1_021;
  assert.equal(fixture.store.recoverExpiredLeases().turns, 1);
  const secondClaim = fixture.store.claimTurn(turn.conversationId, 10);
  assert.ok(secondClaim?.runToken);
  assert.notEqual(secondClaim.runToken, firstClaim.runToken);
  assert.equal(
    fixture.store.completeTurnWithOutbox(turn.id, firstClaim.runToken, {
      id: "outbox-1",
      kind: "final_message",
      payload: { text: "old answer" },
      maxAttempts: 2,
    }),
    null,
  );

  const outbox = fixture.store.completeTurnWithOutbox(turn.id, secondClaim.runToken, {
    id: "outbox-1",
    kind: "final_message",
    payload: { text: "answer" },
    maxAttempts: 2,
  });
  assert.equal(outbox?.turnId, turn.id);
  assert.equal(fixture.store.getTurn(turn.id)?.state, "answered");
  assert.equal(fixture.store.getTurn(turn.id)?.runToken, null);
  assert.equal(fixture.store.getTurn(turn.id)?.leaseExpiresAt, null);
});

test("rolls back Turn completion when final Outbox creation fails", async (t) => {
  const fixture = await createFixture(t);
  createConversation(fixture);
  const first = fixture.store.createTurn({
    id: "turn-1",
    conversationId: "conversation-1",
    source: "test",
    content: "first",
    maxAttempts: 2,
  });
  const second = fixture.store.createTurn({
    id: "turn-2",
    conversationId: "conversation-1",
    source: "test",
    content: "second",
    maxAttempts: 2,
  });
  fixture.store.enqueueOutbox({
    id: "outbox-collision",
    turnId: second.id,
    kind: "final_message",
    payload: { text: "existing" },
    maxAttempts: 2,
  });
  const claim = fixture.store.claimTurn(first.conversationId, 100);
  const token = claim?.runToken;
  assert.ok(token);

  assert.throws(
    () =>
      fixture.store.completeTurnWithOutbox(first.id, token, {
        id: "outbox-collision",
        kind: "final_message",
        payload: { text: "new" },
        maxAttempts: 2,
      }),
    /UNIQUE constraint failed/,
  );
  assert.equal(fixture.store.getTurn(first.id)?.state, "running");
});

test("keeps Job retry limits and optional source Turn across a restart", async (t) => {
  const fixture = await createFixture(t);
  const job = fixture.store.enqueueJob({
    id: "job-1",
    kind: "capture",
    payload: { url: "https://example.com" },
    idempotencyKey: "capture:https://example.com",
    maxAttempts: 2,
    availableAt: 1_100,
  });
  assert.equal(job.originTurnId, null);
  assert.equal(
    fixture.store.enqueueJob({
      id: "ignored-id",
      kind: "capture",
      payload: { url: "https://example.com" },
      idempotencyKey: job.idempotencyKey,
      maxAttempts: 9,
    }).id,
    job.id,
  );
  assert.equal(fixture.store.claimJob(100), null);

  fixture.clock.now = 1_100;
  const firstClaim = fixture.store.claimJob(100);
  const firstToken = firstClaim?.runToken;
  assert.ok(firstToken);
  assert.equal(fixture.store.retryJob(job.id, firstToken, 1_200, "temporary"), true);
  assert.equal(fixture.store.getJob(job.id)?.state, "pending");
  assert.equal(fixture.store.claimJob(100), null);

  fixture.clock.now = 1_200;
  const secondClaim = fixture.store.claimJob(100);
  const secondToken = secondClaim?.runToken;
  assert.ok(secondToken);
  assert.equal(fixture.store.retryJob(job.id, secondToken, 1_300, "temporary"), true);
  const exhausted = fixture.store.getJob(job.id);
  assert.equal(exhausted?.state, "failed");
  assert.equal(exhausted?.attempts, 2);
  assert.equal(exhausted?.maxAttempts, 2);

  fixture.store.close();
  const reopened = openRuntimeStore({ path: fixture.path, now: () => fixture.clock.now });
  try {
    assert.equal(reopened.getJob(job.id)?.maxAttempts, 2);
    assert.equal(reopened.getJob(job.id)?.state, "failed");
  } finally {
    reopened.close();
  }
});

test("recovers expired Job and Outbox leases, then enforces their retry limits", async (t) => {
  const fixture = await createFixture(t);
  createConversation(fixture);
  const turn = fixture.store.createTurn({
    id: "turn-1",
    conversationId: "conversation-1",
    source: "test",
    content: "question",
    maxAttempts: 2,
  });
  const job = fixture.store.enqueueJob({
    id: "job-1",
    kind: "capture",
    payload: {},
    idempotencyKey: "job-1",
    maxAttempts: 2,
  });
  const outbox = fixture.store.enqueueOutbox({
    id: "outbox-1",
    turnId: turn.id,
    kind: "final_message",
    payload: {},
    maxAttempts: 2,
  });
  const firstJob = fixture.store.claimJob(10);
  const firstOutbox = fixture.store.claimOutbox(10);
  assert.ok(firstJob?.runToken);
  assert.ok(firstOutbox?.runToken);

  fixture.clock.now = 1_011;
  assert.deepEqual(fixture.store.recoverExpiredLeases(), { turns: 0, jobs: 1, outbox: 1 });
  assert.equal(fixture.store.completeJob(job.id, firstJob.runToken, {}), false);
  assert.equal(fixture.store.markOutboxSent(outbox.id, firstOutbox.runToken), false);

  const secondJob = fixture.store.claimJob(10);
  const secondOutbox = fixture.store.claimOutbox(10);
  assert.ok(secondJob?.runToken);
  assert.ok(secondOutbox?.runToken);
  fixture.clock.now = 1_022;
  assert.deepEqual(fixture.store.recoverExpiredLeases(), { turns: 0, jobs: 1, outbox: 1 });
  assert.equal(fixture.store.getJob(job.id)?.state, "failed");
  assert.equal(fixture.store.getOutbox(outbox.id)?.state, "failed");
});

test("delivers final Outbox records in Turn order without blocking after failure", async (t) => {
  const fixture = await createFixture(t);
  createConversation(fixture);
  const first = fixture.store.createTurn({
    id: "turn-1",
    conversationId: "conversation-1",
    source: "test",
    content: "first",
    maxAttempts: 2,
  });
  const second = fixture.store.createTurn({
    id: "turn-2",
    conversationId: "conversation-1",
    source: "test",
    content: "second",
    maxAttempts: 2,
  });
  fixture.store.enqueueOutbox({ id: "outbox-1", turnId: first.id, kind: "final_message", payload: {}, maxAttempts: 2 });
  fixture.store.enqueueOutbox({ id: "outbox-2", turnId: second.id, kind: "final_message", payload: {}, maxAttempts: 2 });

  const firstOutbox = fixture.store.claimOutbox(100);
  assert.equal(firstOutbox?.turnId, first.id);
  assert.equal(fixture.store.claimOutbox(100), null);
  assert.equal(fixture.store.failOutbox(firstOutbox?.id ?? "", firstOutbox?.runToken ?? "", "provider_error"), true);
  const secondOutbox = fixture.store.claimOutbox(100);
  assert.equal(secondOutbox?.turnId, second.id);
  assert.equal(
    fixture.store.retryOutbox(secondOutbox?.id ?? "", secondOutbox?.runToken ?? "", 1_100, "temporary"),
    true,
  );
  assert.equal(fixture.store.claimOutbox(100), null);

  fixture.clock.now = 1_100;
  const retriedOutbox = fixture.store.claimOutbox(100);
  assert.ok(retriedOutbox?.runToken);
  assert.equal(fixture.store.markOutboxSent(retriedOutbox.id, retriedOutbox.runToken), true);
  assert.equal(fixture.store.getOutbox(retriedOutbox.id)?.state, "sent");
  assert.equal(fixture.store.getOutbox(retriedOutbox.id)?.runToken, null);
});
