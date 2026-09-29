import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFeedDigest, buildFeedDigestCard, digestLocalTime, DIGEST_CARD_MAX_BYTES, DIGEST_MAX_BYTES,
  DIGEST_INTEREST_ACTION, DIGEST_STAR_SELECTED, DIGEST_STAR_UNSELECTED, updateDigestCardInterest,
  type DigestCandidate,
} from "./digest.js";

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

test("card digest contains a preview marker, article metadata, and open-url behavior", () => {
  const result = buildFeedDigestCard([item({ id: "card-1", title: "A <strong>title</strong>", summary: "A summary", sourceName: "Source" })], "2026-09-24", 10);
  assert.ok(result);
  const card = JSON.parse(result.card) as { schema: string; header: { title: { content: string } }; body: { elements: Array<Record<string, any>> } };
  assert.equal(card.schema, "2.0");
  assert.match(card.header.title.content, /预览/);
  assert.ok(card.body.elements.some(element => element.tag === "markdown" && String(element.content).includes("title")));
  assert.ok(card.body.elements.some(element => element.tag === "button" && element.behaviors?.[0]?.type === "open_url"));
  const interest = card.body.elements.find(element => element.tag === "button" && element.element_id === "interest_1");
  assert.deepEqual(interest?.text, { tag: "plain_text", content: DIGEST_STAR_UNSELECTED });
  assert.deepEqual(interest?.behaviors, [{ type: "callback", value: { action: DIGEST_INTEREST_ACTION, item_id: "card-1", target_interested: true } }]);
  assert.ok(Buffer.byteLength(result.card, "utf8") <= DIGEST_CARD_MAX_BYTES);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= DIGEST_MAX_BYTES);
});

test("card digest renders selected star state and updates one controlled action", () => {
  const result = buildFeedDigestCard([item({ id: "selected", title: "Selected" })], "2026-09-24", 10, new Map([["selected", true]]));
  assert.ok(result);
  const card = JSON.parse(result.card) as { body: { elements: Array<Record<string, any>> } };
  const interest = card.body.elements.find(element => element.element_id === "interest_1");
  assert.deepEqual(interest?.text, { tag: "plain_text", content: DIGEST_STAR_SELECTED });
  assert.deepEqual(interest?.behaviors, [{ type: "callback", value: { action: DIGEST_INTEREST_ACTION, item_id: "selected", target_interested: false } }]);

  const updated = updateDigestCardInterest(result.card, "selected", false);
  assert.ok(updated);
  const updatedCard = JSON.parse(updated) as { body: { elements: Array<Record<string, any>> } };
  const updatedInterest = updatedCard.body.elements.find(element => element.element_id === "interest_1");
  assert.deepEqual(updatedInterest?.text, { tag: "plain_text", content: DIGEST_STAR_UNSELECTED });
  assert.deepEqual(updatedInterest?.behaviors, [{ type: "callback", value: { action: DIGEST_INTEREST_ACTION, item_id: "selected", target_interested: true } }]);
  assert.equal((updatedCard.body.elements.find(element => element.element_id === "article_1")?.content as string).includes("Selected"), true);
});

test("card interest update rejects missing or ambiguous controlled actions", () => {
  const result = buildFeedDigestCard([item({ id: "one" })], "2026-09-24", 10);
  assert.ok(result);
  assert.equal(updateDigestCardInterest(result.card, "missing", true), null);
  const card = JSON.parse(result.card) as { body: { elements: Array<Record<string, any>> } };
  card.body.elements.push({ ...card.body.elements.find(element => element.element_id === "interest_1") });
  assert.equal(updateDigestCardInterest(JSON.stringify(card), "one", true), null);
});

test("card digest keeps shared ordering and truncates before the byte limit", () => {
  const items = Array.from({ length: 20 }, (_, index) => item({
    id: `card-${index}`,
    identityKey: `card:${index}`,
    canonicalUrl: `https://example.com/card/${index}`,
    title: "x".repeat(500),
    summary: "y".repeat(900),
    publishedAt: 20_000 - index,
  }));
  const result = buildFeedDigestCard(items, "2026-09-24", 20);
  assert.ok(result);
  assert.deepEqual(result.itemIds.slice(0, 2), ["card-0", "card-1"]);
  assert.ok(result.itemIds.length < items.length);
  assert.ok(Buffer.byteLength(result.card, "utf8") <= DIGEST_CARD_MAX_BYTES);
});
