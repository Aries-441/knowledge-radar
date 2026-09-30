import { JSDOM } from "jsdom";
import type { FeedSource } from "../runtime/types.js";
import {
  FeedFetchError,
  fetchBoundedResource,
  normalizeUrl,
  type FeedFetchOptions,
  type ParsedFeed,
} from "./parser.js";

export type GithubTrendingPeriod = "daily" | "weekly" | "monthly";

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const MAX_ITEMS = 100;

function text(value: string | null | undefined, limit: number): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function periodLabel(value: string): GithubTrendingPeriod | null {
  if (value === "daily" || value === "weekly" || value === "monthly") return value;
  return null;
}

function parseStarGrowth(value: string): { starsDelta: number | null; starsPeriod: string | null } {
  const match = /([+]?\d[\d,]*(?:\.\d+)?)\s+stars?\s+(today|this week|this month)\b/i.exec(value);
  if (!match) return { starsDelta: null, starsPeriod: null };
  const starsDelta = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(starsDelta) && starsDelta >= 0 && starsDelta <= 1_000_000_000
    ? { starsDelta, starsPeriod: match[2].toLowerCase() }
    : { starsDelta: null, starsPeriod: null };
}

function repositoryUrl(href: string): { owner: string; repository: string; canonicalUrl: string } | null {
  let url: URL;
  try { url = new URL(href, "https://github.com"); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part))) return null;
  const owner = parts[0];
  const repository = parts[1].replace(/\.git$/i, "");
  if (!repository) return null;
  return { owner, repository, canonicalUrl: `https://github.com/${owner}/${repository}` };
}

export function parseGithubTrending(
  finalUrl: string,
  html: string,
  headers: Headers,
  period: GithubTrendingPeriod,
): ParsedFeed {
  let document: Document;
  try { document = new JSDOM(html).window.document; }
  catch { throw new FeedFetchError("feed_parse_failed", false); }

  const articles = [...document.querySelectorAll("article.Box-row")].slice(0, MAX_ITEMS);
  const items = [] as ParsedFeed["items"];
  for (const [index, article] of articles.entries()) {
    // The page puts the login/star link before the repository heading. Prefer
    // the heading so an auxiliary link cannot be mistaken for a repository.
    const anchor = article.querySelector<HTMLAnchorElement>("h2 a[href]")
      ?? article.querySelector<HTMLAnchorElement>("a[href^='/']");
    const repository = anchor ? repositoryUrl(anchor.getAttribute("href") ?? "") : null;
    if (!repository) throw new FeedFetchError("feed_parse_failed", false);
    const title = `${repository.owner}/${repository.repository}`;
    const summary = text(article.querySelector("p")?.textContent, 8_192);
    const language = text(article.querySelector("[itemprop='programmingLanguage']")?.textContent, 80) || null;
    const growth = parseStarGrowth(article.textContent ?? "");
    const rank = index + 1;
    items.push({
      identityKey: `github:${repository.owner.toLowerCase()}/${repository.repository.toLowerCase()}`,
      canonicalUrl: repository.canonicalUrl,
      title,
      summary,
      author: repository.owner,
      publishedAt: null,
      metadata: {
        provider: "github_trending",
        rank,
        language,
        starsPeriod: growth.starsPeriod,
        starsDelta: growth.starsDelta,
      },
    });
  }
  if (items.length === 0) throw new FeedFetchError("feed_parse_failed", false);
  const unique = new Map(items.map(item => [item.identityKey, item]));
  return {
    finalUrl,
    etag: headers.get("etag")?.slice(0, 1_024) ?? null,
    lastModified: headers.get("last-modified")?.slice(0, 256) ?? null,
    notModified: false,
    title: `GitHub Trending (${period})`,
    siteUrl: "https://github.com/trending",
    items: [...unique.values()],
  };
}

export async function fetchGithubTrending(
  source: FeedSource,
  options: { signal?: AbortSignal; fetchOptions?: Omit<FeedFetchOptions, "signal"> } = {},
): Promise<ParsedFeed> {
  if (!githubTrendingUrl(source.url)) throw new FeedFetchError("feed_url_blocked", false);
  const period = periodLabel(String(source.connectorConfig.period ?? "weekly"));
  if (!period) throw new FeedFetchError("feed_invalid_content", false);
  const language = source.connectorConfig.language === undefined || source.connectorConfig.language === "all"
    ? null : String(source.connectorConfig.language);
  const base = new URL(source.url);
  const path = language ? `/trending/${encodeURIComponent(language)}` : "/trending";
  const request = new URL(path, `${base.protocol}//${base.host}`);
  request.searchParams.set("since", period);
  const result = await fetchBoundedResource(request.toString(), {
    etag: source.etag,
    lastModified: source.lastModified,
  }, {
    ...options.fetchOptions,
    accept: "text/html, application/xhtml+xml;q=0.9",
    sourceId: source.id,
    signal: options.signal,
  });
  const final = new URL(result.finalUrl);
  if (!GITHUB_HOSTS.has(final.hostname.toLowerCase()) || !/^\/trending(?:\/|$)/.test(final.pathname)) {
    throw new FeedFetchError("feed_redirect_limit", false);
  }
  if (result.notModified) {
    return { finalUrl: result.finalUrl, etag: result.etag, lastModified: result.lastModified, notModified: true, title: null, siteUrl: null, items: [] };
  }
  const contentType = (result.response?.headers.get("content-type") ?? "").toLowerCase();
  if (contentType && !contentType.includes("text/html")) throw new FeedFetchError("feed_invalid_content", false, result.response?.status);
  return parseGithubTrending(result.finalUrl, result.body, result.response?.headers ?? new Headers(), period);
}

export function githubTrendingUrl(value: string): string | null {
  const normalized = normalizeUrl(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" && !url.username && !url.password
      && GITHUB_HOSTS.has(url.hostname.toLowerCase()) && /^\/trending\/?$/.test(url.pathname) && !url.search
      ? `https://github.com/trending` : null;
  } catch { return null; }
}
