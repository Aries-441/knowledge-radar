import assert from "node:assert/strict";
import test from "node:test";
import { parseFeedConfig } from "./config.js";
import { previewFeedDigestOnce } from "./digest-preview.js";
import { openRuntimeStore } from "../runtime/store.js";

const scope = { appId: "cli_0000000000000001", tenantKey: "tenant", ownerOpenId: "ou_owner" };
const config = parseFeedConfig({ timezone: "Asia/Shanghai", feeds: [{ id: "one", name: "One", url: "https://example.com/one.xml" }] });

test("preview sends a card without creating a digest job or changing candidate state", async () => {
  const clock = { now: Date.parse("2026-09-24T02:00:00Z") };
  const store = openRuntimeStore({ path: ":memory:", now: () => clock.now });
  try {
    store.syncFeedSources(config.feeds);
    const poll = store.ensureFeedPollJobs(60_000)[0];
    const claim = store.claimJob(10_000, "feed_poll")!;
    store.commitFeedPoll(poll.id, claim.runToken!, { finalUrl: "https://example.com/one.xml", etag: null,
      lastModified: null, notModified: false, title: "One", siteUrl: "https://example.com",
      items: [{ identityKey: "id:old", canonicalUrl: "https://example.com/old", title: "Old", summary: "old", author: null, publishedAt: 1_000 }] });
    clock.now += 2;
    const nextPoll = store.ensureFeedPollJobs(1)[0];
    const nextClaim = store.claimJob(10_000, "feed_poll")!;
    store.commitFeedPoll(nextPoll.id, nextClaim.runToken!, { finalUrl: "https://example.com/one.xml", etag: null,
      lastModified: null, notModified: false, title: "One", siteUrl: "https://example.com",
      items: [{ identityKey: "id:new", canonicalUrl: "https://example.com/new", title: "New", summary: "summary", author: null, publishedAt: 2_000 }] });
    const before = store.listFeedItems("one").find(item => item.identityKey === "id:new");
    assert.ok(before);
    const sent: { receiveId: string; card: string; uuid: string }[] = [];
    const result = await previewFeedDigestOnce({ store, config, scope, now: () => clock.now,
      send: async (receiveId, card, uuid) => { sent.push({ receiveId, card, uuid }); return { messageId: "om_preview" }; } });
    assert.equal(result.outcome, "sent");
    assert.equal(result.messageId, "om_preview");
    assert.equal(sent[0].receiveId, scope.ownerOpenId);
    assert.equal(JSON.parse(sent[0].card).schema, "2.0");
    assert.equal(store.listFeedItems("one").find(item => item.identityKey === "id:new")?.notifiedAt, null);
    const job = store.ensureFeedDigestJob(scope, "2026-09-24", 20);
    assert.ok(job);
    assert.equal(job.state, "pending");
    assert.equal((job.payload as { version: number }).version, 2);
    assert.equal(typeof (job.payload as { card?: unknown }).card, "string");
  } finally { store.close(); }
});

test("preview reports empty without sending", async () => {
  const store = openRuntimeStore({ path: ":memory:" });
  try {
    let sends = 0;
    const result = await previewFeedDigestOnce({ store, config, scope,
      send: async () => { sends++; return { messageId: "unexpected" }; } });
    assert.deepEqual(result, { outcome: "empty" });
    assert.equal(sends, 0);
  } finally { store.close(); }
});
