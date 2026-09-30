import assert from "node:assert/strict";
import test from "node:test";
import { parseFeedConfig } from "./config.js";
import { scheduleFeedDigestOnce } from "./digest-scheduler.js";
import { processFeedDigestOnce } from "./digest-worker.js";
import { openRuntimeStore } from "../runtime/store.js";

const scope = { appId: "app", tenantKey: "tenant", ownerOpenId: "owner" };

const config = parseFeedConfig({
  timezone: "UTC",
  pollIntervalMinutes: 1,
  sources: [{ id: "github", name: "GitHub", kind: "github_trending", url: "https://github.com/trending" }],
  digest: {
    enabled: true,
    schedules: [
      { id: "github-weekly", mode: "trend_snapshot", frequency: "weekly", weekday: 1, time: "09:00", maxItems: 20, sourceIds: ["github"] },
      { id: "github-four-week", mode: "period_summary", frequency: "every_n_weeks", anchorDate: "2024-01-29", intervalWeeks: 4, time: "09:00", maxItems: 20, sourceIds: [], sourceScheduleId: "github-weekly" },
    ],
  },
});

function poll(store: ReturnType<typeof openRuntimeStore>, now: number, title = "Repository") {
  const job = store.ensureFeedPollJobs(1)[0];
  assert.ok(job);
  const claim = store.claimJob(10_000, "feed_poll");
  assert.ok(claim);
  store.commitFeedPoll(job.id, claim.runToken!, {
    finalUrl: "https://github.com/trending",
    etag: null,
    lastModified: null,
    notModified: false,
    title: "GitHub Trending",
    siteUrl: "https://github.com/trending",
    items: [{ identityKey: "github:owner/repository", canonicalUrl: "https://github.com/owner/repository",
      title, summary: "A repository", author: null, publishedAt: now,
      metadata: { provider: "github_trending", rank: 1, starsPeriod: "this week", starsDelta: 42 } }],
  });
}

async function sendOne(store: ReturnType<typeof openRuntimeStore>, now: () => number) {
  return processFeedDigestOnce({ store, config, scope, now,
    send: async () => ({ messageId: `text-${now()}` }),
    sendInteractive: async (_receiveId, card) => ({ messageId: `card-${card.length}-${now()}` }),
  });
}

test("weekly trend snapshots can repeat notified repositories", async () => {
  const clock = { now: Date.parse("2024-01-01T09:00:00Z") };
  const store = openRuntimeStore({ path: ":memory:", now: () => clock.now });
  try {
    store.syncFeedSources(config.feeds);
    poll(store, clock.now);
    clock.now = Date.parse("2024-01-08T09:00:00Z");
    assert.equal(scheduleFeedDigestOnce({ store, config, scope, now: () => clock.now }), true);
    assert.equal((await sendOne(store, () => clock.now)).outcome, "succeeded");
    clock.now = Date.parse("2024-01-15T09:00:00Z");
    assert.equal(scheduleFeedDigestOnce({ store, config, scope, now: () => clock.now }), true);
    assert.equal((await sendOne(store, () => clock.now)).outcome, "succeeded");
  } finally { store.close(); }
});

test("four-week summary reads frozen weekly history after weekly sends", async () => {
  const clock = { now: Date.parse("2024-01-01T09:00:00Z") };
  const store = openRuntimeStore({ path: ":memory:", now: () => clock.now });
  try {
    store.syncFeedSources(config.feeds);
    poll(store, clock.now);
    for (const date of ["2024-01-08", "2024-01-15", "2024-01-22"]) {
      clock.now = Date.parse(`${date}T09:00:00Z`);
      assert.equal(scheduleFeedDigestOnce({ store, config, scope, now: () => clock.now }), true);
      assert.equal((await sendOne(store, () => clock.now)).outcome, "succeeded");
    }
    clock.now = Date.parse("2024-01-29T09:00:00Z");
    assert.equal(scheduleFeedDigestOnce({ store, config, scope, now: () => clock.now }), true);
    const first = await sendOne(store, () => clock.now);
    assert.equal(first.outcome, "succeeded");
    const second = await sendOne(store, () => clock.now);
    assert.equal(second.outcome, "succeeded");
  } finally { store.close(); }
});
