import assert from "node:assert/strict";
import test from "node:test";
import { scheduleFeedPollsOnce } from "./scheduler.js";
import { processFeedPollOnce } from "./worker.js";
import type { FeedConfig } from "./config.js";
import { openRuntimeStore } from "../runtime/store.js";

const config: FeedConfig = {
  timezone: "Asia/Shanghai",
  pollIntervalMinutes: 1,
  feeds: [{ id: "sample", name: "Sample", url: "https://example.com/feed.xml", enabled: true, priority: 0, tags: [], itemLimit: 10 }],
};
const lookup = async (_hostname: string, _options: { all: true; verbatim: true }) => [{ address: "93.184.216.34", family: 4 }];
const feed = (title: string, id: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Sample</title><item><guid>${id}</guid><title>${title}</title><link>https://example.com/${id}</link><description>summary</description></item></channel></rss>`;

test("worker performs baseline, candidate, dedupe and safe structured logging", async () => {
  const clock = { now: 1_000 };
  const store = openRuntimeStore({ path: ":memory:", now: () => clock.now });
  const entries: unknown[] = [];
  let body = feed("First", "a");
  try {
    assert.equal(scheduleFeedPollsOnce({ store, config, now: () => clock.now }), 1);
    const first = await processFeedPollOnce({ store, config, now: () => clock.now, log: entry => entries.push(entry), fetchOptions: { lookup, fetchImpl: async () => new Response(body, { headers: { "content-type": "application/rss+xml" } }) } });
    assert.equal(first.outcome, "succeeded");
    assert.deepEqual(store.listFeedItems("sample").map(item => item.state), ["baseline"]);
    clock.now += 60_001;
    body = feed("Second", "b");
    assert.equal(scheduleFeedPollsOnce({ store, config, now: () => clock.now }), 1);
    const second = await processFeedPollOnce({ store, config, now: () => clock.now, log: entry => entries.push(entry), fetchOptions: { lookup, fetchImpl: async () => new Response(body, { headers: { "content-type": "application/rss+xml" } }) } });
    assert.equal(second.outcome, "succeeded");
    assert.deepEqual(store.listFeedItems("sample").map(item => item.state), ["baseline", "candidate"]);
    assert.equal(store.listFeedItems("sample").length, 2);
    const serialized = JSON.stringify(entries);
    assert.ok(serialized.includes('"feed_id":"sample"'));
    assert.ok(!serialized.includes("summary"));
  } finally { store.close(); }
});

test("worker records retryable fetch failures without stopping other work", async () => {
  const clock = { now: 1_000 };
  const store = openRuntimeStore({ path: ":memory:", now: () => clock.now });
  try {
    scheduleFeedPollsOnce({ store, config, now: () => clock.now });
    const result = await processFeedPollOnce({ store, config, now: () => clock.now, fetchOptions: { lookup, fetchImpl: async () => new Response("nope", { status: 503 }) } });
    assert.equal(result.outcome, "retry_scheduled");
    const job = store.getJob(result.jobId!);
    assert.equal(job?.state, "pending");
    assert.equal(store.getFeedSource("sample")?.errorCode, "feed_http_error");
  } finally { store.close(); }
});
