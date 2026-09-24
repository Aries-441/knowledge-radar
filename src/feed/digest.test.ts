import assert from "node:assert/strict";
import test from "node:test";
import { buildFeedDigest, digestLocalTime, DIGEST_MAX_BYTES, type DigestCandidate } from "./digest.js";

function item(overrides: Partial<DigestCandidate> = {}): DigestCandidate {
  return { id: "item", feedId: "feed", identityKey: "id:item", canonicalUrl: "https://example.com/item",
    title: "Title", summary: "Summary", author: null, publishedAt: 1_000, firstSeenAt: 1_000,
    state: "candidate", notifiedAt: null, errorCode: null, createdAt: 1_000, updatedAt: 1_000,
    sourceName: "Example", priority: 0, ...overrides };
}

test("digest uses local timezone and deduplicates canonical URLs", () => {
  assert.deepEqual(digestLocalTime(Date.parse("2026-09-24T01:00:00Z"), "Asia/Shanghai"), { date: "2026-09-24", time: "09:00" });
  const result = buildFeedDigest([
    item({ id: "a", title: "A", canonicalUrl: "https://example.com/same", publishedAt: 3_000, sourceName: "A source" }),
    item({ id: "b", title: "Duplicate", canonicalUrl: "https://example.com/same", publishedAt: 2_000, sourceName: "B source" }),
    item({ id: "c", title: "C", canonicalUrl: "https://example.com/c", publishedAt: 1_000 }),
  ], "2026-09-24", 10);
  assert.ok(result);
  assert.deepEqual(result.itemIds, ["a", "b", "c"]);
  assert.equal(result.canonicalUrls.length, 2);
  assert.match(result.text, /A source \/ B source/);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= DIGEST_MAX_BYTES);
});

test("digest enforces item and byte limits without losing unselected IDs", () => {
  const items = Array.from({ length: 5 }, (_, index) => item({ id: `item-${index}`, identityKey: `id:${index}`,
    canonicalUrl: `https://example.com/${index}`, title: "x".repeat(500), summary: "y".repeat(900), publishedAt: 10_000 - index }));
  const result = buildFeedDigest(items, "2026-09-24", 2);
  assert.ok(result);
  assert.equal(result.itemIds.length, 2);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= DIGEST_MAX_BYTES);
});
