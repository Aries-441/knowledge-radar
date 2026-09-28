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
} from "./config.js";

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
