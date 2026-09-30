import assert from "node:assert/strict";
import test from "node:test";
import { openRuntimeStore } from "./store.js";

function setup() {
  const clock = { now: 1_000 };
  const store = openRuntimeStore({ path: ":memory:", now: () => clock.now, createToken: (() => { let n = 0; return () => `token-${++n}`; })() });
  return { store, clock };
}

const feeds = [
  { id: "one", name: "One", url: "https://example.com/one.xml", enabled: true, priority: 1, tags: ["a"], itemLimit: 20 },
  { id: "off", name: "Off", url: "https://example.com/off.xml", enabled: false, priority: 2, tags: [], itemLimit: 20 },
];

function parsed(items: { identityKey: string; canonicalUrl: string | null; title: string; summary: string; author: string | null; publishedAt: number | null; metadata?: Record<string, string | number | boolean | null> }[]) {
  return { finalUrl: "https://example.com/one.xml", etag: "v1", lastModified: null, notModified: false, title: "One", siteUrl: "https://example.com", items };
}

test("syncs sources without resetting cache state and only schedules enabled sources", () => {
  const { store } = setup();
  try {
    assert.equal(store.syncFeedSources(feeds).length, 2);
    assert.equal(store.listFeedSources(true).map(source => source.id).join(), "one");
    const jobs = store.ensureFeedPollJobs(60_000);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].kind, "feed_poll");
    assert.deepEqual(jobs[0].payload, { version: 2, sourceId: "one", feedId: "one" });
    assert.equal(store.getSource("one")?.kind, "rss");
    assert.deepEqual(store.getSource("one")?.connectorConfig, {});
    store.syncFeedSources([{ ...feeds[0], name: "Renamed", tags: ["b"] }, feeds[1]]);
    assert.equal(store.getFeedSource("one")?.etag, null);
    assert.equal(store.getFeedSource("one")?.name, "Renamed");
    assert.equal(store.claimJob(100, "capture_article"), null);
    assert.equal(store.claimJob(100, "feed_poll")?.kind, "feed_poll");
  } finally { store.close(); }
});

test("source kind changes reset connector cache, baseline and items while omitted sources are disabled", () => {
  const { store } = setup();
  try {
    const source = { ...feeds[0], kind: "rss" as const, connectorConfig: {} };
    store.syncSources([source]);
    const job = store.ensureFeedPollJobs(60_000)[0];
    const claim = store.claimJob(10_000, "feed_poll")!;
    store.commitFeedPoll(job.id, claim.runToken!, parsed([{ identityKey: "id:a", canonicalUrl: "https://example.com/a", title: "A", summary: "A", author: null, publishedAt: 1 }]));
    assert.equal(store.getSource("one")?.baselineAt, 1_000);

    const database = (store as unknown as { database: { prepare(sql: string): { run(...values: unknown[]): unknown } } }).database;
    database.prepare("UPDATE feed_sources SET kind = 'retired', connector_config_json = '{\"version\":1}' WHERE id = 'one'").run();
    store.syncSources([source]);
    assert.equal(store.getSource("one")?.kind, "rss");
    assert.equal(store.getSource("one")?.baselineAt, null);
    assert.equal(store.getSource("one")?.etag, null);
    assert.deepEqual(store.listFeedItems("one"), []);

    store.syncSources([{ ...source, enabled: false }]);
    assert.deepEqual(store.listSources(true), []);
  } finally { store.close(); }
});

test("commits first successful feed as baseline and later identities as candidates", () => {
  const { store, clock } = setup();
  try {
    store.syncFeedSources([feeds[0]]);
    const firstJob = store.ensureFeedPollJobs(60_000)[0];
    const firstClaim = store.claimJob(10_000, "feed_poll")!;
    const first = parsed([
      { identityKey: "id:a", canonicalUrl: "https://example.com/a", title: "A", summary: "A", author: null, publishedAt: 1 },
      { identityKey: "id:b", canonicalUrl: "https://example.com/b", title: "B", summary: "B", author: "author", publishedAt: 2 },
    ]);
    const result = store.commitFeedPoll(firstJob.id, firstClaim.runToken!, first);
    assert.deepEqual(result && { baseline: result.baseline, newItems: result.newItems }, { baseline: true, newItems: 2 });
    assert.deepEqual(store.listFeedItems("one").map(item => item.state), ["baseline", "baseline"]);
    assert.deepEqual(store.listFeedItems("one").map(item => item.metadata), [{}, {}]);
    const firstSeen = store.listFeedItems("one")[0].firstSeenAt;

    clock.now += 60_001;
    const secondJob = store.ensureFeedPollJobs(60_000)[0];
    const secondClaim = store.claimJob(10_000, "feed_poll")!;
    const second = parsed([
      { identityKey: "id:a", canonicalUrl: "https://example.com/a-new", title: "A updated", summary: "A2", author: null, publishedAt: 3 },
      { identityKey: "id:c", canonicalUrl: "https://example.com/c", title: "C", summary: "C", author: null, publishedAt: 4 },
    ]);
    second.etag = "v2";
    const secondResult = store.commitFeedPoll(secondJob.id, secondClaim.runToken!, second);
    assert.equal(secondResult?.baseline, false);
    assert.equal(secondResult?.newItems, 1);
    const items = store.listFeedItems("one");
    assert.equal(items.length, 3);
    assert.equal(items.find(item => item.identityKey === "id:a")?.firstSeenAt, firstSeen);
    assert.equal(items.find(item => item.identityKey === "id:a")?.state, "baseline");
    assert.equal(items.find(item => item.identityKey === "id:a")?.canonicalUrl, "https://example.com/a-new");
    assert.equal(items.find(item => item.identityKey === "id:c")?.state, "candidate");
    assert.deepEqual(items.find(item => item.identityKey === "id:c")?.metadata, {});
    assert.equal(store.getJob(secondJob.id)?.state, "succeeded");
  } finally { store.close(); }
});

test("persists bounded connector metadata and rejects oversized metadata", () => {
  const { store } = setup();
  try {
    store.syncFeedSources([feeds[0]]);
    const job = store.ensureFeedPollJobs(60_000)[0];
    const claim = store.claimJob(10_000, "feed_poll")!;
    store.commitFeedPoll(job.id, claim.runToken!, parsed([{
      identityKey: "github:owner/repo", canonicalUrl: "https://github.com/owner/repo", title: "owner/repo",
      summary: "A repo", author: "owner", publishedAt: null,
      metadata: { provider: "github_trending", rank: 1, starsDelta: 120, starsPeriod: "this week" },
    }]));
    assert.deepEqual(store.listFeedItems("one")[0].metadata, {
      provider: "github_trending", rank: 1, starsDelta: 120, starsPeriod: "this week",
    });
    const secondJob = store.enqueueJob({ kind: "feed_poll", payload: { sourceId: "one" }, idempotencyKey: "oversized-metadata", maxAttempts: 1 });
    const secondClaim = store.claimJob(10_000, "feed_poll")!;
    assert.throws(() => store.commitFeedPoll(secondJob.id, secondClaim.runToken!, parsed([{
      identityKey: "id:large", canonicalUrl: null, title: "large", summary: "", author: null, publishedAt: null,
      metadata: { value: "x".repeat(513) },
    }])), /metadata value is too long/);
  } finally { store.close(); }
});

test("feed failure retry and lease recovery are fenced by token", () => {
  const { store, clock } = setup();
  try {
    store.syncFeedSources([feeds[0]]);
    const job = store.ensureFeedPollJobs(60_000)[0];
    const claim = store.claimJob(100)!;
    assert.ok(claim.runToken);
    clock.now += 101;
    assert.equal(store.recoverFeedPollJobs(), 1);
    assert.equal(store.recordFeedPollFailure(job.id, claim.runToken!, "feed_timeout", true, clock.now + 60_000), false);
    const recovered = store.claimJob(100, "feed_poll");
    assert.ok(recovered?.runToken);
    assert.equal(store.recordFeedPollFailure(job.id, "old-token", "feed_timeout", true, clock.now + 60_000), false);
    assert.equal(store.recordFeedPollFailure(job.id, recovered.runToken!, "feed_timeout", true, clock.now + 60_000), true);
    assert.equal(store.getJob(job.id)?.state, "pending");
  } finally { store.close(); }
});

test("commit accepts legacy feedId payloads without creating a second source", () => {
  const { store } = setup();
  try {
    store.syncFeedSources([feeds[0]]);
    const job = store.enqueueJob({ kind: "feed_poll", payload: { version: 1, feedId: "one" }, idempotencyKey: "legacy-feed-poll", maxAttempts: 2 });
    const claim = store.claimJob(10_000, "feed_poll")!;
    const result = store.commitFeedPoll(job.id, claim.runToken!, parsed([{ identityKey: "id:legacy", canonicalUrl: null, title: "Legacy", summary: "", author: null, publishedAt: null }]));
    assert.equal(result?.feedId, "one");
    assert.deepEqual(store.listFeedSources().map(source => source.id), ["one"]);
  } finally { store.close(); }
});
