import assert from "node:assert/strict";
import test from "node:test";
import { parseFeedConfig } from "./config.js";
import { scheduleFeedPollsOnce } from "./scheduler.js";
import { openRuntimeStore } from "../runtime/store.js";

test("scheduler callback only synchronizes sources and creates one due job", () => {
  const config = parseFeedConfig({
    timezone: "America/New_York",
    pollIntervalMinutes: 30,
    feeds: [{ id: "one", name: "One", url: "https://example.com/feed.xml" }],
  });
  const store = openRuntimeStore({ path: ":memory:", now: () => 1_000 });
  try {
    assert.equal(scheduleFeedPollsOnce({ store, config, now: () => 1_000 }), 1);
    assert.equal(scheduleFeedPollsOnce({ store, config, now: () => 1_000 }), 0);
    assert.equal(store.listFeedItems().length, 0);
    assert.equal(store.getJob("missing"), null);
  } finally { store.close(); }
});
