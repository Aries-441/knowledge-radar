import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FeedFetchError } from "./parser.js";
import { fetchGithubTrending, parseGithubTrending } from "./github-trending.js";
import type { FeedSource } from "../runtime/types.js";

const fixture = async (name: string) => readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
const source = (config: Record<string, unknown> = {}): FeedSource => ({
  id: "github", name: "GitHub", kind: "github_trending", connectorConfig: config,
  url: "https://github.com/trending", enabled: true, priority: 0, tags: [], etag: "old", lastModified: null,
  baselineAt: null, lastCheckedAt: null, lastSuccessAt: null, errorCode: null, createdAt: 1, updatedAt: 1,
});
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("parses daily, weekly and monthly GitHub Trending fixtures in page order", async () => {
  for (const [name, period, expected, identity] of [
    ["github-trending-daily.html", "daily", 1_234, "github:octo/fast-repo"],
    ["github-trending-weekly.html", "weekly", 9_001, "github:week/first-repo"],
    ["github-trending-monthly.html", "monthly", 12_345, "github:month/month-repo"],
  ] as const) {
    const parsed = parseGithubTrending("https://github.com/trending", await fixture(name), new Headers(), period);
    assert.equal(parsed.items[0].identityKey, identity);
    assert.equal(parsed.items[0].metadata?.rank, 1);
    assert.equal(parsed.items[0].metadata?.starsDelta, expected);
    assert.equal(parsed.items[0].metadata?.starsPeriod, period === "daily" ? "today" : `this ${period === "weekly" ? "week" : "month"}`);
    assert.equal(parsed.items[0].canonicalUrl?.startsWith("https://github.com/"), true);
  }
});

test("missing trend fields degrade to bounded null metadata and malformed pages fail closed", async () => {
  const html = `<article class="Box-row"><h2><a href="/owner/repo">owner / repo</a></h2><p>desc</p></article>`;
  const parsed = parseGithubTrending("https://github.com/trending", html, new Headers(), "weekly");
  assert.deepEqual(parsed.items[0].metadata, { provider: "github_trending", rank: 1, language: null, starsPeriod: null, starsDelta: null });
  assert.throws(() => parseGithubTrending("https://github.com/trending", "<html><body><p>changed</p></body></html>", new Headers(), "weekly"),
    (error: unknown) => error instanceof FeedFetchError && error.code === "feed_parse_failed");
  assert.throws(() => parseGithubTrending("https://github.com/trending", `<article class="Box-row"><h2><a href="/owner">repo</a></h2></article>`, new Headers(), "weekly"),
    (error: unknown) => error instanceof FeedFetchError && error.code === "feed_parse_failed");
  const withStarLink = parseGithubTrending("https://github.com/trending",
    `<article class="Box-row"><a href="/login">Star</a><h2><a href="/owner/repo">owner / repo</a></h2></article>`,
    new Headers(), "weekly");
  assert.equal(withStarLink.items[0]?.identityKey, "github:owner/repo");
});

test("connector sends period and conditional headers, and rejects unsafe redirects or oversized responses", async () => {
  let requestUrl = "";
  let requestHeaders: Headers | undefined;
  const html = await fixture("github-trending-weekly.html");
  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    return new Response(html, { status: 200, headers: { "content-type": "text/html", etag: "new" } });
  };
  const parsed = await fetchGithubTrending(source({ period: "weekly", language: "all" }), { fetchOptions: { fetchImpl, lookup: publicLookup } });
  assert.equal(parsed.items.length, 2);
  assert.equal(new URL(requestUrl).searchParams.get("since"), "weekly");
  assert.equal(requestHeaders?.get("if-none-match"), "old");
  assert.match(requestHeaders?.get("accept") ?? "", /text\/html/);

  const redirectFetch: typeof fetch = async () => new Response(null, { status: 302, headers: { location: "https://example.com/out" } });
  await assert.rejects(() => fetchGithubTrending(source(), { fetchOptions: { fetchImpl: redirectFetch, lookup: publicLookup } }),
    (error: unknown) => error instanceof FeedFetchError && error.code === "feed_redirect_limit");
  const largeFetch: typeof fetch = async () => new Response("x".repeat(100), { status: 200, headers: { "content-type": "text/html" } });
  await assert.rejects(() => fetchGithubTrending(source(), { fetchOptions: { fetchImpl: largeFetch, lookup: publicLookup, maxBytes: 20 } }),
    (error: unknown) => error instanceof FeedFetchError && error.code === "feed_too_large");
  const unavailableFetch: typeof fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(() => fetchGithubTrending(source(), { fetchOptions: { fetchImpl: unavailableFetch, lookup: publicLookup } }),
    (error: unknown) => error instanceof FeedFetchError && error.code === "feed_http_error" && error.retryable === true);
});

test("304 preserves source cache without parsing a page", async () => {
  const fetchImpl: typeof fetch = async () => new Response(null, { status: 304, headers: { etag: "same" } });
  const parsed = await fetchGithubTrending(source(), { fetchOptions: { fetchImpl, lookup: publicLookup } });
  assert.equal(parsed.notModified, true);
  assert.equal(parsed.etag, "same");
  assert.deepEqual(parsed.items, []);
});
