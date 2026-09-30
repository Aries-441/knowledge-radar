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

function cardButton(card: { body: { elements: Array<Record<string, any>> } }, elementId: string): Record<string, any> | undefined {
  for (const element of card.body.elements) {
    if (element.element_id === elementId && element.tag === "button") return element;
    if (element.tag === "column_set" && Array.isArray(element.columns)) {
      for (const column of element.columns) {
        const button = column.elements?.find((action: Record<string, any>) => action.element_id === elementId);
        if (button) return button;
      }
    }
  }
  return undefined;
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

test("digest puts valid connector ranks first while preserving RSS ordering", () => {
  const result = buildFeedDigest([
    item({ id: "rss-new", title: "RSS newer", publishedAt: 9_000 }),
    item({ id: "github-2", title: "GitHub second", publishedAt: 1_000, metadata: { provider: "github_trending", rank: 2 } }),
    item({ id: "github-1", title: "GitHub first", publishedAt: 1_000, metadata: { provider: "github_trending", rank: 1 } }),
    item({ id: "bad-rank", title: "Bad rank", publishedAt: 8_000, metadata: { rank: 0 } }),
  ], "2026-09-24", 10);
  assert.ok(result);
  assert.deepEqual(result.itemIds, ["github-1", "github-2", "rss-new", "bad-rank"]);
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
  assert.ok(cardButton(card, "open_1")?.behaviors?.[0]?.type === "open_url");
  const interest = cardButton(card, "interest_1");
  assert.ok(interest);
  assert.deepEqual(interest?.text, { tag: "plain_text", content: DIGEST_STAR_UNSELECTED });
  assert.deepEqual(interest?.behaviors, [{ type: "callback", value: { action: DIGEST_INTEREST_ACTION, item_id: "card-1", target_interested: true } }]);
  assert.ok(Buffer.byteLength(result.card, "utf8") <= DIGEST_CARD_MAX_BYTES);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= DIGEST_MAX_BYTES);
});

test("digest renders GitHub trend metadata and keeps RSS fallback unchanged", () => {
  const github = buildFeedDigestCard([item({ id: "github", metadata: {
    provider: "github_trending", language: "TypeScript", starsPeriod: "this week", starsDelta: 1234,
  } })], "2026-09-24", 10);
  assert.ok(github);
  const article = JSON.parse(github.card).body.elements.find((element: Record<string, unknown>) => element.element_id === "article_1");
  assert.match(String(article.content), /GitHub/);
  assert.match(String(article.content), /TypeScript/);
  assert.match(String(article.content), /\+1,234 stars/);
  const interest = cardButton(JSON.parse(github.card), "interest_1");
  assert.ok(interest);
  assert.equal(interest.behaviors[0].value.item_id, "github");
  const rss = buildFeedDigestCard([item({ id: "rss" })], "2026-09-24", 10);
  assert.ok(rss);
  const rssArticle = JSON.parse(rss.card).body.elements.find((element: Record<string, unknown>) => element.element_id === "article_1");
  assert.doesNotMatch(String(rssArticle.content), /GitHub/);
});

test("card groups mixed sources with distinct themes and keeps actions together", () => {
  const result = buildFeedDigestCard([
    item({ id: "blog", canonicalUrl: "https://example.com/blog", sourceKind: "rss", sourceName: "Anthropic Engineering", title: "Blog update" }),
    item({ id: "trend", sourceKind: "github_trending", sourceName: "GitHub Trending", title: "owner/repo",
      metadata: { provider: "github_trending", rank: 1, starsPeriod: "this week", starsDelta: 42 } }),
  ], "2026-09-24", 10);
  assert.ok(result);
  const card = JSON.parse(result.card) as { header: { template: string }; body: { elements: Array<Record<string, any>> } };
  assert.equal(card.header.template, "blue");
  const groups = card.body.elements.filter(element => element.element_id?.startsWith("source_group_"));
  assert.deepEqual(groups.map(group => group.background_style), ["indigo-50", "turquoise-50"]);
  assert.equal(card.body.elements.filter(element => element.element_id?.startsWith("actions_")).length, 2);
  assert.ok(cardButton(card, "interest_1"));
  assert.ok(cardButton(card, "open_2"));
});

test("card digest renders selected star state and updates one controlled action", () => {
  const result = buildFeedDigestCard([item({ id: "selected", title: "Selected" })], "2026-09-24", 10, new Map([["selected", true]]));
  assert.ok(result);
  const card = JSON.parse(result.card) as { body: { elements: Array<Record<string, any>> } };
  const interest = cardButton(card, "interest_1");
  assert.deepEqual(interest?.text, { tag: "plain_text", content: DIGEST_STAR_SELECTED });
  assert.deepEqual(interest?.behaviors, [{ type: "callback", value: { action: DIGEST_INTEREST_ACTION, item_id: "selected", target_interested: false } }]);

  const updated = updateDigestCardInterest(result.card, "selected", false);
  assert.ok(updated);
  const updatedCard = JSON.parse(updated) as { body: { elements: Array<Record<string, any>> } };
  const updatedInterest = cardButton(updatedCard, "interest_1");
  assert.deepEqual(updatedInterest?.text, { tag: "plain_text", content: DIGEST_STAR_UNSELECTED });
  assert.deepEqual(updatedInterest?.behaviors, [{ type: "callback", value: { action: DIGEST_INTEREST_ACTION, item_id: "selected", target_interested: true } }]);
  assert.equal((updatedCard.body.elements.find(element => element.element_id === "article_1")?.content as string).includes("Selected"), true);
});

test("card interest update rejects missing or ambiguous controlled actions", () => {
  const result = buildFeedDigestCard([item({ id: "one" })], "2026-09-24", 10);
  assert.ok(result);
  assert.equal(updateDigestCardInterest(result.card, "missing", true), null);
  const card = JSON.parse(result.card) as { body: { elements: Array<Record<string, any>> } };
  const action = card.body.elements.find(element => element.element_id === "actions_1");
  assert.ok(action && Array.isArray(action.columns));
  action.columns[0].elements.push({ ...cardButton(card, "interest_1") });
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
  const card = JSON.parse(result.card);
  for (const [index, itemId] of result.itemIds.entries()) {
    const interest = cardButton(card, `interest_${index + 1}`);
    assert.ok(interest);
    assert.equal(interest.behaviors?.[0]?.value?.action, DIGEST_INTEREST_ACTION);
    assert.equal(interest.behaviors?.[0]?.value?.item_id, itemId);
  }
});
