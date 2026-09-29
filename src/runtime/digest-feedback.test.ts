import assert from "node:assert/strict";
import test from "node:test";

import { openRuntimeStore, RuntimeStoreError } from "./store.js";
import type { FeishuScope } from "./types.js";

const scope: FeishuScope = { appId: "cli_0000000000000001", tenantKey: "tenant", ownerOpenId: "ou_owner" };

function addCandidate(store: ReturnType<typeof openRuntimeStore>, clock: { now: number }): string {
  store.syncSources([{
    id: "source", name: "Source", kind: "rss", url: "https://example.com/feed", enabled: true,
    priority: 0, tags: [], itemLimit: 10,
  }]);
  const first = store.ensureFeedPollJobs(60_000)[0];
  assert.ok(first);
  const firstClaim = store.claimJob(1_000, "feed_poll");
  assert.ok(firstClaim?.runToken);
  assert.ok(store.commitFeedPoll(first.id, firstClaim.runToken, {
    finalUrl: "https://example.com/feed", etag: null, lastModified: null, notModified: false,
    title: "Source", siteUrl: "https://example.com", items: [{
      identityKey: "first", canonicalUrl: "https://example.com/first", title: "First", summary: "First", author: null,
      publishedAt: 1_000,
    }],
  }));

  clock.now = 61_000;
  const second = store.ensureFeedPollJobs(60_000)[0];
  assert.ok(second);
  const secondClaim = store.claimJob(1_000, "feed_poll");
  assert.ok(secondClaim?.runToken);
  assert.ok(store.commitFeedPoll(second.id, secondClaim.runToken, {
    finalUrl: "https://example.com/feed", etag: null, lastModified: null, notModified: false,
    title: "Source", siteUrl: "https://example.com", items: [{
      identityKey: "first", canonicalUrl: "https://example.com/first", title: "First", summary: "First", author: null,
      publishedAt: 1_000,
    }, {
      identityKey: "candidate", canonicalUrl: "https://example.com/candidate", title: "Candidate", summary: "Candidate", author: null,
      publishedAt: 2_000,
    }],
  }));
  const candidate = store.listFeedItems().find(item => item.identityKey === "candidate");
  assert.ok(candidate);
  return candidate.id;
}

test("digest message registration is scoped and idempotent", () => {
  const clock = { now: 1_000 };
  const store = openRuntimeStore({ path: ":memory:", now: () => clock.now });
  try {
    const itemId = addCandidate(store, clock);
    const message = store.recordDigestMessage(scope, "om_message", '{"schema":"2.0"}', [itemId]);
    assert.deepEqual(message.itemIds, [itemId]);
    assert.equal(store.recordDigestMessage(scope, "om_message", '{"schema":"2.0"}', [itemId]).messageId, "om_message");
    assert.equal(store.getDigestMessage({ ...scope, ownerOpenId: "ou_other" }, "om_message"), null);
    assert.throws(() => store.recordDigestMessage(scope, "om_message", '{"schema":"2.0"}', ["other"]), /digest_message_conflict/);
  } finally { store.close(); }
});

test("digest feedback toggles by target state and deduplicates event retries", () => {
  const clock = { now: 1_000 };
  const store = openRuntimeStore({ path: ":memory:", now: () => clock.now });
  try {
    const itemId = addCandidate(store, clock);
    store.recordDigestMessage(scope, "om_message", '{"schema":"2.0"}', [itemId]);
    assert.deepEqual(store.applyDigestFeedback({ scope, eventId: "evt-1", messageId: "om_message", feedItemId: itemId, targetInterested: true }), {
      outcome: "applied", interested: true,
    });
    assert.deepEqual(store.applyDigestFeedback({ scope, eventId: "evt-1", messageId: "om_message", feedItemId: itemId, targetInterested: true }), {
      outcome: "duplicate", interested: true,
    });
    assert.equal(store.listDigestFeedbackStates(scope).get(itemId), true);
    assert.deepEqual(store.applyDigestFeedback({ scope, eventId: "evt-2", messageId: "om_message", feedItemId: itemId, targetInterested: false }), {
      outcome: "applied", interested: false,
    });
    assert.equal(store.listDigestFeedbackStates(scope).get(itemId), false);
    assert.throws(() => store.applyDigestFeedback({
      scope, eventId: "evt-1", messageId: "om_message", feedItemId: itemId, targetInterested: false,
    }), /digest_feedback_event_conflict/);
  } finally { store.close(); }
});

test("digest feedback rejects unknown messages and items", () => {
  const clock = { now: 1_000 };
  const store = openRuntimeStore({ path: ":memory:", now: () => clock.now });
  try {
    const itemId = addCandidate(store, clock);
    assert.throws(() => store.applyDigestFeedback({
      scope, eventId: "evt-1", messageId: "missing", feedItemId: itemId, targetInterested: true,
    }), RuntimeStoreError);
    store.recordDigestMessage(scope, "om_message", '{"schema":"2.0"}', [itemId]);
    assert.throws(() => store.applyDigestFeedback({
      scope, eventId: "evt-2", messageId: "om_message", feedItemId: "missing", targetInterested: true,
    }), /digest_feedback_item_not_in_message/);
  } finally { store.close(); }
});
