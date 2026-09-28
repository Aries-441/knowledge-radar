import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFeedConfig } from "./config.js";
import { scheduleFeedPollsOnce } from "./scheduler.js";
import { processFeedDigestOnce } from "./digest-worker.js";
import { processFeedPollOnce } from "./worker.js";
import { openRuntimeStore } from "../runtime/store.js";

const lookup = async (_hostname: string, _options: { all: true; verbatim: true }) => [{ address: "93.184.216.34", family: 4 }];
const rss = (id: string, title: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Radar</title><item><guid>${id}</guid><title>${title}</title><link>https://example.com/${id}</link><description>summary</description></item></channel></rss>`;

test("legacy feeds and new sources share baseline, candidate, digest and restart state", async t => {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-radar-source-e2e-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "radar.db");
  const clock = { now: 1_000 };
  const oldConfig = parseFeedConfig({
    pollIntervalMinutes: 1,
    feeds: [{ id: "blog", name: "Blog", url: "https://example.com/feed.xml" }],
    digest: { enabled: true, time: "00:00", maxItems: 20 },
  });
  const newConfig = parseFeedConfig({
    pollIntervalMinutes: 1,
    sources: [{ id: "blog", name: "Blog", kind: "rss", url: "https://example.com/feed.xml" }],
    digest: { enabled: true, time: "00:00", maxItems: 20 },
  });
  const scope = { appId: "app", tenantKey: "tenant", ownerOpenId: "owner" };
  let store = openRuntimeStore({ path, now: () => clock.now });
  try {
    let body = rss("baseline", "Baseline");
    assert.equal(scheduleFeedPollsOnce({ store, config: oldConfig, now: () => clock.now }), 1);
    assert.equal((await processFeedPollOnce({ store, config: oldConfig, now: () => clock.now, fetchOptions: { lookup, fetchImpl: async () => new Response(body, { headers: { "content-type": "application/rss+xml" } }) } })).outcome, "succeeded");

    store.close();
    store = openRuntimeStore({ path, now: () => clock.now });
    clock.now += 60_001;
    body = rss("candidate", "Candidate");
    assert.equal(scheduleFeedPollsOnce({ store, config: newConfig, now: () => clock.now }), 1);
    assert.equal((await processFeedPollOnce({ store, config: newConfig, now: () => clock.now, fetchOptions: { lookup, fetchImpl: async () => new Response(body, { headers: { "content-type": "application/rss+xml" } }) } })).outcome, "succeeded");
    assert.deepEqual(store.listFeedItems("blog").map(item => item.state), ["baseline", "candidate"]);

    const digestJob = store.ensureFeedDigestJob(scope, "2030-01-01", 20);
    assert.ok(digestJob);
    const digest = await processFeedDigestOnce({
      store,
      config: newConfig,
      scope,
      send: async () => ({ messageId: "text-message" }),
      sendInteractive: async () => ({ messageId: "card-message" }),
      now: () => clock.now,
    });
    assert.equal(digest.outcome, "succeeded");
    assert.equal(store.listFeedDigestCandidates(scope).length, 0);

    store.close();
    store = openRuntimeStore({ path, now: () => clock.now });
    const restored = store.getSource("blog");
    assert.equal(restored?.kind, "rss");
    assert.deepEqual(restored?.connectorConfig, {});
    assert.equal(store.listFeedItems("blog").length, 2);
  } finally {
    store.close();
  }
});
