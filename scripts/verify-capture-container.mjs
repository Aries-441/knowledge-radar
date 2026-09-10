// Offline verification only: run with disposable Compose state/archive resources.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { openRuntimeStore } from "../dist/runtime/store.js";
import { processCaptureJobOnce } from "../dist/runtime/capture-worker.js";
import { createCheckpoint, publishCheckpoint, probeArchive } from "../dist/article/durable-archive.js";

assert.notEqual(process.getuid(), 0);
const phase = process.argv[2];
assert.ok(["base", "seed", "recover"].includes(phase));
const scope = { appId: "offline-app", tenantKey: "offline-tenant", ownerOpenId: "offline-owner" };
const input = { ...scope, chatId: "chat", messageId: "message", text: "https://example.com/article" };
const now = () => phase === "recover" ? 200_000 : 1_000;
const store = openRuntimeStore({ path: process.env.KNOWLEDGE_RADAR_STATE_PATH, now });
try {
  if (phase === "base") {
    assert.equal(process.env.KNOWLEDGE_RADAR_ARCHIVE_DIR, "");
    assert.equal(await probeArchive(process.env.KNOWLEDGE_RADAR_ARCHIVE_DIR), false);
    store.createConversation({ id: "base-proof", kind: "local", title: "Preserved across containers" });
  } else {
    const archive = process.env.KNOWLEDGE_RADAR_ARCHIVE_DIR;
    assert.equal(await probeArchive(archive), true);
    assert.ok(store.getConversation("base-proof"));
    const accepted = store.acceptFeishuText(input);
    assert.notEqual(accepted.outcome, "ignored");
    if (phase === "seed") {
      assert.equal(accepted.outcome, "accepted");
      const turn = store.claimTurn(accepted.conversationId, 120_000);
      const job = store.acceptCaptureTurn(turn.id, turn.runToken, scope, true);
      const running = store.claimCaptureJob(scope);
      assert.equal(job.id, running.id);
      const checkpoint = createCheckpoint(job.id, input.text, { title: "Offline article", sourceUrl: input.text, body: "DO_NOT_SAVE" },
        { summary: "Persisted summary", keyPoints: ["Point"] }, new Date(now()), new Date(job.createdAt));
      store.saveCaptureCheckpoint(job.id, running.runToken, scope, checkpoint);
      await publishCheckpoint(archive, checkpoint, () => {});
      assert.equal(store.getJob(job.id).state, "running"); // Deliberate process exit before terminal commit.
    } else {
      assert.equal(accepted.outcome, "duplicate");
      const result = await processCaptureJobOnce({ store, scope, archiveDir: archive, now, dependencies: {
        render: async () => assert.fail("must reuse checkpoint"), summarize: async () => assert.fail("must not call model"),
      } });
      assert.equal(result.outcome, "succeeded");
      const files = (await readdir(archive)).filter(name => name.endsWith(".md"));
      assert.equal(files.length, 1);
      assert.match(await readFile(join(archive, files[0]), "utf8"), /Persisted summary/);
      assert.ok(!(await readFile(join(archive, files[0]), "utf8")).includes("DO_NOT_SAVE"));
      const ack = store.claimOutbox(60_000, scope);
      assert.equal(ack.kind, "final_message"); store.markOutboxSent(ack.id, ack.runToken);
      const outbox = store.claimOutbox(60_000, scope);
      assert.equal(outbox.kind, "job_result"); store.markOutboxSent(outbox.id, outbox.runToken);
      assert.equal(store.getFeishuContext(accepted.conversationId, 2, scope).captureContext.results.length, 1);
      assert.equal(store.claimCaptureJob(scope), null);
    }
  }
  console.log(JSON.stringify({ phase, outcome: "passed", uid: process.getuid() }));
} finally { store.close(); }
