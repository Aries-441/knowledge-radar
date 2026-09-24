import assert from "node:assert/strict";
import test from "node:test";
import { FeedFetchError, fetchFeed, parseFeed } from "./parser.js";

const publicLookup = async (_hostname: string, _options: { all: true; verbatim: true }) => [{ address: "93.184.216.34", family: 4 }];
const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Radar</title><link>https://example.com/</link><item><guid>a-1</guid><title>First</title><link>https://example.com/articles/1/</link><description> summary </description><pubDate>Tue, 01 Jan 2030 00:00:00 GMT</pubDate></item><item><title>No id</title><description>second</description></item></channel></rss>`;
const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><link href="https://example.com/atom"/><entry><id>tag:example.com,2030:one</id><title>Entry</title><link href="https://example.com/entry"/><updated>2030-01-01T00:00:00Z</updated><summary>hello</summary></entry></feed>`;

test("normalizes RSS and Atom entries with stable identities and bounded fields", async () => {
  const result = await parseFeed("sample", "https://example.com/feed.xml", rss, new Headers({ etag: "v1" }));
  assert.equal(result.title, "Radar");
  assert.equal(result.items[0].identityKey, "id:a-1");
  assert.equal(result.items[0].canonicalUrl, "https://example.com/articles/1");
  assert.equal(result.items[0].publishedAt, Date.parse("2030-01-01T00:00:00Z"));
  assert.equal(result.etag, "v1");
  const atomResult = await parseFeed("sample", "https://example.com/atom", atom, new Headers());
  assert.equal(atomResult.items[0].identityKey, "id:tag:example.com,2030:one");
  await assert.rejects(() => parseFeed("sample", "https://example.com/feed", "<rss>", new Headers()), (error: unknown) => error instanceof FeedFetchError && error.code === "feed_parse_failed");
});

test("falls back to canonical URLs when a generated feed repeats a placeholder GUID", async () => {
  const xml = `<rss version="2.0"><channel><item><guid>guid</guid><title>One</title><link>https://example.com/one</link></item><item><guid>guid</guid><title>Two</title><link>https://example.com/two</link></item></channel></rss>`;
  const result = await parseFeed("sample", "https://example.com/feed", xml, new Headers());
  assert.deepEqual(result.items.map(item => item.identityKey), ["id:guid", "url:https://example.com/two"]);
});

test("uses conditional requests, follows bounded redirects, and rejects unsafe targets", async () => {
  const requests: Request[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return new Response(rss, { status: 200, headers: { "content-type": "application/rss+xml", etag: "next" } });
  };
  const result = await fetchFeed("https://example.com/feed.xml", { etag: "old", lastModified: "yesterday" }, { fetchImpl, lookup: publicLookup });
  assert.equal(result.items.length, 2);
  assert.equal(requests[0].headers.get("if-none-match"), "old");
  assert.equal(requests[0].headers.get("if-modified-since"), "yesterday");

  const notModified = await fetchFeed("https://example.com/feed.xml", { etag: "old", lastModified: null }, {
    lookup: publicLookup,
    fetchImpl: async () => new Response(null, { status: 304, headers: { etag: "old" } }),
  });
  assert.equal(notModified.notModified, true);
  await assert.rejects(() => fetchFeed("https://example.com/feed.xml", { etag: null, lastModified: null }, {
    lookup: publicLookup,
    fetchImpl: async () => Response.redirect("http://127.0.0.1/private", 302),
  }), (error: unknown) => error instanceof FeedFetchError && error.code === "feed_url_blocked");
});

test("enforces response size and content type limits", async () => {
  await assert.rejects(() => fetchFeed("https://example.com/feed", { etag: null, lastModified: null }, {
    lookup: publicLookup,
    maxBytes: 10,
    fetchImpl: async () => new Response("01234567890", { headers: { "content-type": "application/xml" } }),
  }), (error: unknown) => error instanceof FeedFetchError && error.code === "feed_too_large");
  await assert.rejects(() => fetchFeed("https://example.com/feed", { etag: null, lastModified: null }, {
    lookup: publicLookup,
    fetchImpl: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
  }), (error: unknown) => error instanceof FeedFetchError && error.code === "feed_invalid_content");
});
