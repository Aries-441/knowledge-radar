import assert from "node:assert/strict";
import test from "node:test";
import { FeishuError } from "../channels/feishu/adapter.js";
import { parseFeedConfig } from "./config.js";
import { scheduleFeedDigestOnce } from "./digest-scheduler.js";
import { processFeedDigestOnce } from "./digest-worker.js";
import { openRuntimeStore } from "../runtime/store.js";

const scope = { appId: "cli_0000000000000001", tenantKey: "tenant", ownerOpenId: "ou_owner" };
const config = parseFeedConfig({ timezone: "Asia/Shanghai", pollIntervalMinutes: 30,
  digest: { enabled: true, time: "09:00", maxItems: 20 }, feeds: [{ id: "one", name: "One",
    url: "https://example.com/one.xml" }] });

function parsed(identityKey: string, url: string, title: string) {
  return { finalUrl: "https://example.com/one.xml", etag: null, lastModified: null, notModified: false,
    title: "One", siteUrl: "https://example.com", items: [{ identityKey, canonicalUrl: url, title,
      summary: "summary", author: null, publishedAt: 2_000 }] };
}

test("digest schedules, sends once, and marks candidates notified", async () => {
  const clock = { now: Date.parse("2026-09-24T02:00:00Z") };
  const store = openRuntimeStore({ path: ":memory:", now: () => clock.now });
  try {
    store.syncFeedSources(config.feeds);
    const first = store.ensureFeedPollJobs(60_000)[0];
    const firstClaim = store.claimJob(10_000, "feed_poll")!;
    store.commitFeedPoll(first.id, firstClaim.runToken!, parsed("id:old", "https://example.com/old", "Old"));
    clock.now += 60_001;
    const second = store.ensureFeedPollJobs(60_000)[0];
    const secondClaim = store.claimJob(10_000, "feed_poll")!;
    store.commitFeedPoll(second.id, secondClaim.runToken!, parsed("id:new", "https://example.com/new", "New"));
    assert.equal(scheduleFeedDigestOnce({ store, config, scope, now: () => clock.now }), true);
    assert.equal(scheduleFeedDigestOnce({ store, config, scope, now: () => clock.now }), false);
    const sent: { receiveId: string; text: string; uuid: string }[] = [];
    const result = await processFeedDigestOnce({ store, config, scope, now: () => clock.now,
      send: async (receiveId, text, uuid) => { sent.push({ receiveId, text, uuid }); return { messageId: "om_digest" }; } });
    assert.equal(result.outcome, "succeeded");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].receiveId, scope.ownerOpenId);
    assert.match(sent[0].text, /New/);
    assert.ok(store.listFeedItems("one").find(item => item.identityKey === "id:new")?.notifiedAt);
    assert.equal(scheduleFeedDigestOnce({ store, config, scope, now: () => clock.now }), false);
  } finally { store.close(); }
});

test("digest retry keeps candidate unnotified and uses the same job", async () => {
  const clock = { now: Date.parse("2026-09-24T02:00:00Z") };
  const store = openRuntimeStore({ path: ":memory:", now: () => clock.now });
  try {
    store.syncFeedSources(config.feeds);
    const firstPoll = store.ensureFeedPollJobs(60_000)[0];
    const firstClaim = store.claimJob(10_000, "feed_poll")!;
    store.commitFeedPoll(firstPoll.id, firstClaim.runToken!, parsed("id:old", "https://example.com/old", "Old"));
    clock.now += 60_001;
    const secondPoll = store.ensureFeedPollJobs(60_000)[0];
    const secondClaim = store.claimJob(10_000, "feed_poll")!;
    store.commitFeedPoll(secondPoll.id, secondClaim.runToken!, parsed("id:new", "https://example.com/new", "New"));
    clock.now += 30_000;
    assert.equal(scheduleFeedDigestOnce({ store, config, scope, now: () => clock.now }), true);
    const first = await processFeedDigestOnce({ store, config, scope, now: () => clock.now,
      send: async () => { throw new FeishuError("feishu_unavailable"); } });
    assert.equal(first.outcome, "retry_scheduled");
    assert.equal(store.listFeedItems("one")[0].notifiedAt, null);
    const job = store.getJob(first.jobId!);
    assert.equal(job?.state, "pending");
    assert.equal(scheduleFeedDigestOnce({ store, config, scope, now: () => clock.now }), false);
  } finally { store.close(); }
});

test("digest worker falls back to text for a legacy payload", async () => {
  const store = openRuntimeStore({ path: ":memory:" });
  try {
    store.enqueueJob({ kind: "feed_digest", idempotencyKey: "legacy-digest", maxAttempts: 3,
      payload: { version: 1, scope, date: "2026-09-24", itemIds: [], canonicalUrls: [], text: "legacy digest" } });
    const sent: string[] = [];
    const result = await processFeedDigestOnce({ store, config, scope,
      send: async (_receiveId, text) => { sent.push(text); return { messageId: "om_legacy" }; },
      sendInteractive: async () => { throw new Error("legacy payload must not use card sender"); } });
    assert.equal(result.outcome, "succeeded");
    assert.deepEqual(sent, ["legacy digest"]);
  } finally { store.close(); }
});

test("digest worker records the sent card only when the interactive sender succeeds", async () => {
  const store = openRuntimeStore({ path: ":memory:" });
  try {
    const card = JSON.stringify({ schema: "2.0", body: { elements: [] } });
    store.enqueueJob({ kind: "feed_digest", idempotencyKey: "card-digest", maxAttempts: 3,
      payload: { version: 2, scope, date: "2026-09-24", itemIds: ["item-1"], canonicalUrls: [], text: "text", card } });
    const result = await processFeedDigestOnce({ store, config, scope,
      send: async () => { throw new Error("text sender must not be used"); },
      sendInteractive: async () => ({ messageId: "om_card" }) });
    assert.equal(result.outcome, "succeeded");
    assert.equal(store.getDigestMessage(scope, "om_card")?.card, card);
  } finally { store.close(); }
});
