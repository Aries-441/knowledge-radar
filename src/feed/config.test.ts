import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_FEED_ITEM_LIMIT,
  DEFAULT_FEED_TIMEZONE,
  DEFAULT_POLL_INTERVAL_MINUTES,
  FeedConfigError,
  loadFeedConfig,
  parseFeedConfig,
  getDigestSchedules,
} from "./config.js";
import { getDigestPeriod, isDigestScheduleDue } from "./digest-period.js";

const goodFeed = { id: "sample", name: "Sample", url: "https://example.com/feed.xml" };

test("uses safe defaults for omitted global and per-feed optional fields", () => {
  const expectedSource = { ...goodFeed, kind: "rss", connectorConfig: {}, enabled: true, priority: 0, tags: [], itemLimit: DEFAULT_FEED_ITEM_LIMIT };
  assert.deepEqual(parseFeedConfig({ feeds: [goodFeed] }), {
    timezone: DEFAULT_FEED_TIMEZONE,
    pollIntervalMinutes: DEFAULT_POLL_INTERVAL_MINUTES,
    sources: [expectedSource],
    feeds: [expectedSource],
  });
  assert.deepEqual(parseFeedConfig({}).sources, []);
});
test("normalizes the sources entry and rejects ambiguous or unsupported connector configuration", () => {
  const config = parseFeedConfig({ sources: [{ ...goodFeed, kind: "rss" }] });
  assert.equal(config.sources[0]?.kind, "rss");
  assert.deepEqual(config.sources[0]?.connectorConfig, {});
  assert.strictEqual(config.feeds, config.sources);
  assert.throws(() => parseFeedConfig({ feeds: [goodFeed], sources: [{ ...goodFeed, kind: "rss" }] }), FeedConfigError);
  assert.throws(() => parseFeedConfig({ sources: [{ ...goodFeed, kind: "github" }] }), FeedConfigError);
  assert.throws(() => parseFeedConfig({ sources: [{ ...goodFeed, kind: "rss", connectorConfig: { tokenEnv: "TOKEN" } }] }), FeedConfigError);
});

test("normalizes GitHub Trending sources with a weekly default and rejects unsafe options", () => {
  const config = parseFeedConfig({ sources: [{ id: "github", name: "GitHub Trending", url: "https://github.com/trending", kind: "github_trending" }] });
  assert.deepEqual(config.sources[0], {
    id: "github", name: "GitHub Trending", url: "https://github.com/trending", kind: "github_trending",
    connectorConfig: { period: "weekly", language: "all" }, enabled: true, priority: 0, tags: [], itemLimit: DEFAULT_FEED_ITEM_LIMIT,
  });
  assert.throws(() => parseFeedConfig({ sources: [{ id: "github", name: "GitHub", url: "http://github.com/trending", kind: "github_trending" }] }), FeedConfigError);
  assert.throws(() => parseFeedConfig({ sources: [{ id: "github", name: "GitHub", url: "https://user:secret@github.com/trending", kind: "github_trending" }] }), FeedConfigError);
  assert.throws(() => parseFeedConfig({ sources: [{ id: "github", name: "GitHub", url: "https://github.com/trending", kind: "github_trending", connectorConfig: { period: "yearly" } }] }), FeedConfigError);
  assert.throws(() => parseFeedConfig({ sources: [{ id: "github", name: "GitHub", url: "https://github.com/trending", kind: "github_trending", connectorConfig: { token: "secret" } }] }), FeedConfigError);
  assert.throws(() => parseFeedConfig({ sources: [{ id: "github", name: "GitHub", url: "https://github.com/trending", kind: "github_trending", connectorConfig: { language: "../secret" } }] }), FeedConfigError);
});

test("parses optional daily digest configuration and validates its bounds", () => {
  assert.deepEqual(parseFeedConfig({ digest: { enabled: true, time: "09:30", maxItems: 20 } }).digest,
    { enabled: true, time: "09:30", maxItems: 20 });
  for (const value of ["9:30", "24:00", "09:60"]) {
    assert.throws(() => parseFeedConfig({ digest: { enabled: true, time: value, maxItems: 20 } }), FeedConfigError);
  }
  for (const value of [0, 51]) {
    assert.throws(() => parseFeedConfig({ digest: { enabled: true, time: "09:00", maxItems: value } }), FeedConfigError);
  }
});

test("normalizes legacy digest and validates periodic schedule references", () => {
  const config = parseFeedConfig({ sources: [{ ...goodFeed, kind: "rss" }], digest: { enabled: true, time: "09:00", maxItems: 10 } });
  assert.deepEqual(getDigestSchedules(config)[0], { id: "default-daily", mode: "new_items", frequency: "daily", time: "09:00", maxItems: 10, sourceIds: ["sample"] });
  const scheduled = parseFeedConfig({ sources: [{ ...goodFeed, kind: "rss" }], digest: { schedules: [{ id: "daily", mode: "new_items", frequency: "daily", time: "09:00", maxItems: 10, sourceIds: ["sample"] }] } });
  assert.equal(scheduled.digest?.schedules?.[0]?.id, "daily");
  assert.throws(() => parseFeedConfig({ sources: [{ ...goodFeed, kind: "rss" }], digest: { schedules: [{ id: "x", mode: "new_items", frequency: "weekly", time: "09:00", maxItems: 1, sourceIds: ["missing"], weekday: 1 }] } }), FeedConfigError);
});

test("computes timezone-aware daily, ISO weekly, and anchored windows", () => {
  const base = new Date("2024-01-01T12:00:00Z");
  const daily = getDigestPeriod({ id: "d", mode: "new_items", frequency: "daily", time: "09:00", maxItems: 1, sourceIds: ["sample"] }, base, "America/New_York");
  assert.equal(daily.key, "2024-01-01");
  const weekly = getDigestPeriod({ id: "w", mode: "trend_snapshot", frequency: "weekly", weekday: 1, time: "09:00", maxItems: 1, sourceIds: ["sample"] }, new Date("2024-01-08T15:00:00Z"), "UTC");
  assert.equal(weekly.key, "2024-W02");
  const four = getDigestPeriod({ id: "f", mode: "period_summary", frequency: "every_n_weeks", anchorDate: "2024-01-01", intervalWeeks: 4, time: "09:00", maxItems: 1, sourceIds: [] }, new Date("2024-01-29T01:00:00Z"), "UTC");
  assert.equal(four.key, "2024-01-01/2024-01-28");
});

test("only marks the configured weekly and anchored windows as due", () => {
  const weekly = { id: "w", mode: "trend_snapshot" as const, frequency: "weekly" as const,
    weekday: 1, time: "09:00", maxItems: 1, sourceIds: ["sample"] };
  assert.equal(isDigestScheduleDue(weekly, new Date("2024-01-08T08:59:00Z"), "UTC"), false);
  assert.equal(isDigestScheduleDue(weekly, new Date("2024-01-08T09:00:00Z"), "UTC"), true);
  assert.equal(isDigestScheduleDue(weekly, new Date("2024-01-09T09:00:00Z"), "UTC"), false);
  const four = { id: "f", mode: "period_summary" as const, frequency: "every_n_weeks" as const,
    anchorDate: "2024-01-29", intervalWeeks: 4, time: "09:00", maxItems: 1, sourceIds: [] };
  assert.equal(isDigestScheduleDue(four, new Date("2024-01-28T09:00:00Z"), "UTC"), false);
  assert.equal(isDigestScheduleDue(four, new Date("2024-01-29T09:00:00Z"), "UTC"), true);
  assert.equal(isDigestScheduleDue(four, new Date("2024-02-26T09:00:00Z"), "UTC"), true);
});

test("rejects duplicate IDs", () => {
  assert.throws(() => parseFeedConfig({ feeds: [goodFeed, { ...goodFeed, name: "Other" }] }), FeedConfigError);
});

test("rejects non-HTTP URL schemes and malformed URLs", () => {
  for (const url of ["file:///tmp/feed.xml", "ftp://example.com/feed", "not a URL"]) {
    assert.throws(() => parseFeedConfig({ feeds: [{ ...goodFeed, url }] }), FeedConfigError);
  }
});

test("rejects credentials in URLs without exposing them in the error", () => {
  const secretUrl = "https://alice:secret@example.com/feed";
  assert.throws(() => parseFeedConfig({ feeds: [{ ...goodFeed, url: secretUrl }] }), (error: unknown) => {
    assert.ok(error instanceof FeedConfigError);
    assert.match(error.message, /credentials/);
    assert.ok(!error.message.includes("alice"));
    assert.ok(!error.message.includes("secret"));
    return true;
  });
});

test("rejects invalid timezone and non-positive polling values", () => {
  assert.throws(() => parseFeedConfig({ timezone: "Mars/Olympus" }), FeedConfigError);
  for (const pollIntervalMinutes of [0, -1, "60", Number.NaN]) {
    assert.throws(() => parseFeedConfig({ pollIntervalMinutes }), FeedConfigError);
  }
});

test("rejects malformed feed and optional field values", () => {
  const cases: unknown[] = [
    null,
    { feeds: "feed" },
    { feeds: [{ ...goodFeed, enabled: "yes" }] },
    { feeds: [{ ...goodFeed, priority: "high" }] },
    { feeds: [{ ...goodFeed, tags: ["ok", 2] }] },
    { feeds: [{ ...goodFeed, itemLimit: 0 }] },
    { feeds: [{ id: " ", name: "name", url: goodFeed.url }] },
  ];
  for (const value of cases) assert.throws(() => parseFeedConfig(value), FeedConfigError);
});

test("loads YAML and treats an unset or missing config path as empty configuration", async (t) => {
  assert.deepEqual(await loadFeedConfig(undefined), parseFeedConfig({}));
  const directory = await mkdtemp(join(tmpdir(), "radar-feed-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await loadFeedConfig(join(directory, "missing.yaml")), parseFeedConfig({}));
  const configPath = join(directory, "feeds.yaml");
  await writeFile(configPath, "timezone: America/New_York\nfeeds:\n  - id: yaml\n    name: YAML Feed\n    url: https://example.com/rss\n");
  const loaded = await loadFeedConfig(configPath);
  assert.equal(loaded.timezone, "America/New_York");
  assert.equal(loaded.feeds[0]?.id, "yaml");
});
