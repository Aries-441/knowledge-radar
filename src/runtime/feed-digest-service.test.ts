import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseFeedConfig } from "../feed/config.js";
import { serveFeishu } from "./feishu-service.js";
import { openRuntimeStore } from "./store.js";

const scope = { appId: "cli_0000000000000001", tenantKey: "tenant", ownerOpenId: "ou_owner" };
const feedConfig = parseFeedConfig({ timezone: "Asia/Shanghai", pollIntervalMinutes: 30,
  digest: { enabled: true, time: "09:00", maxItems: 20 }, feeds: [{ id: "one", name: "One",
    url: "https://example.com/one.xml" }] });

async function eventually(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(2); }
  assert.fail("condition did not become true");
}

test("service runs the digest loop and sends the proactive message", async () => {
  const clock = { now: Date.parse("2026-09-24T02:00:00Z") };
  const store = openRuntimeStore({ path: ":memory:", now: () => clock.now });
  store.syncFeedSources(feedConfig.feeds);
  const first = store.ensureFeedPollJobs(60_000)[0];
  const claim = store.claimJob(10_000, "feed_poll")!;
  store.commitFeedPoll(first.id, claim.runToken!, { finalUrl: first.id, etag: null, lastModified: null,
    notModified: false, title: "One", siteUrl: "https://example.com", items: [{ identityKey: "id:old",
      canonicalUrl: "https://example.com/old", title: "Old", summary: "old", author: null, publishedAt: 1 }] });
  // A later poll makes one candidate for the daily digest.
  clock.now += 2;
  const second = store.ensureFeedPollJobs(1)[0];
  const secondClaim = store.claimJob(10_000, "feed_poll")!;
  store.commitFeedPoll(second.id, secondClaim.runToken!, { finalUrl: second.id, etag: null, lastModified: null,
    notModified: false, title: "One", siteUrl: "https://example.com", items: [{ identityKey: "id:new",
      canonicalUrl: "https://example.com/new", title: "New", summary: "new", author: null, publishedAt: 2 }] });
  const sent: string[] = [];
  const controller = new AbortController();
  const running = serveFeishu({ config: { ...scope, appSecret: "secret", statePath: ":memory:" },
    feedConfig, agent: async () => ({ text: "unused" }), signal: controller.signal, log: () => {}, now: () => clock.now,
    openStore: () => store, probeArchive: async () => false, wait: signal => delay(2, undefined, { signal }).catch(() => {}),
    createTransport: () => ({ start: async () => {}, close() {}, send: async () => {},
      sendText: async (_receiveId, text) => { sent.push(text); return { messageId: "om_digest_text" }; },
      sendInteractive: async (_receiveId, card) => { sent.push(card); return { messageId: "om_digest" }; } }),
  });
  try {
    await eventually(() => sent.length === 1);
    assert.match(sent[0], /"schema":"2.0"/);
    assert.match(sent[0], /New/);
    assert.ok(store.listFeedItems("one").some(item => item.identityKey === "id:new" && item.notifiedAt !== null));
  } finally {
    controller.abort();
    assert.deepEqual(await running, { exitCode: 0, drained: true });
    store.close();
  }
});
