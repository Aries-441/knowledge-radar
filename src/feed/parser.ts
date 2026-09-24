import { lookup as dnsLookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import Parser from "rss-parser";

export type FeedCache = { etag: string | null; lastModified: string | null };
export type FeedLookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;
export type FeedFetchOptions = {
  sourceId?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  lookup?: FeedLookup;
};

export type NormalizedFeedItem = {
  identityKey: string;
  canonicalUrl: string | null;
  title: string;
  summary: string;
  author: string | null;
  publishedAt: number | null;
};

export type ParsedFeed = {
  finalUrl: string;
  etag: string | null;
  lastModified: string | null;
  notModified: boolean;
  title: string | null;
  siteUrl: string | null;
  items: NormalizedFeedItem[];
};

export type FeedErrorCode =
  | "feed_url_blocked"
  | "feed_redirect_limit"
  | "feed_timeout"
  | "feed_too_large"
  | "feed_invalid_content"
  | "feed_http_error"
  | "feed_unavailable"
  | "feed_parse_failed";

export class FeedFetchError extends Error {
  constructor(readonly code: FeedErrorCode, readonly retryable: boolean, readonly status?: number) {
    super(code);
    this.name = "FeedFetchError";
  }
}

const parser = new Parser({
  customFields: {
    item: [
      ["content:encoded", "contentEncoded"],
      ["dc:creator", "creator"],
    ],
  },
});

function text(value: unknown, limit = 4_000): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

export function normalizeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch { return null; }
}

function privateIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

function privateIp(value: string): boolean {
  const lower = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(lower) === 4) return privateIpv4(lower);
  if (isIP(lower) === 6) {
    return lower === "::1" || lower === "::" || lower.startsWith("fe80:")
      || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("::ffff:10.")
      || lower.startsWith("::ffff:192.168.") || lower.startsWith("::ffff:127.")
      || lower.startsWith("::ffff:169.254.") || lower.startsWith("::ffff:100.64.");
  }
  return false;
}

export async function assertPublicUrl(value: string, lookup: FeedLookup = dnsLookup): Promise<URL> {
  let url: URL;
  try { url = new URL(value); } catch { throw new FeedFetchError("feed_url_blocked", false); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new FeedFetchError("feed_url_blocked", false);
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || privateIp(hostname)) {
    throw new FeedFetchError("feed_url_blocked", false);
  }
  let addresses;
  try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
  catch { throw new FeedFetchError("feed_unavailable", true); }
  if (!addresses.length) throw new FeedFetchError("feed_unavailable", true);
  if (addresses.some(address => privateIp(address.address))) throw new FeedFetchError("feed_url_blocked", false);
  return url;
}

async function readBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new FeedFetchError("feed_too_large", false);
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof FeedFetchError) throw error;
    throw new FeedFetchError("feed_unavailable", true);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8");
}

function abortableSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  return { signal: controller.signal, close: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } };
}

function parseDate(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function boundedHeader(headers: Headers, name: string, limit: number, fallback: string | null = null): string | null {
  const value = headers.get(name);
  if (value === null) return fallback;
  return value.length <= limit ? value : null;
}

function itemIdentity(sourceId: string, raw: Record<string, unknown>, canonicalUrl: string | null, title: string, publishedAt: number | null): string {
  const id = text(raw.guid) || text(raw.id);
  if (id) return `id:${id.slice(0, 500)}`;
  if (canonicalUrl && canonicalUrl.length <= 2_044) return `url:${canonicalUrl}`;
  return `hash:${createHash("sha256").update(`${sourceId}\0${title}\0${publishedAt ?? ""}`).digest("hex")}`;
}

export async function parseFeed(sourceId: string, finalUrl: string, xml: string, headers: Headers): Promise<ParsedFeed> {
  let parsed: { title?: unknown; link?: unknown; items?: unknown[] };
  try { parsed = await parser.parseString(xml) as unknown as { title?: unknown; link?: unknown; items?: unknown[] }; }
  catch { throw new FeedFetchError("feed_parse_failed", false); }
  const items: NormalizedFeedItem[] = [];
  for (const raw of (parsed.items ?? []) as Record<string, unknown>[]) {
    const title = text(raw.title, 1_024) || "Untitled item";
    const normalizedUrl = normalizeUrl(text(raw.link) || text(raw.url));
    const canonicalUrl = normalizedUrl && normalizedUrl.length <= 2_048 ? normalizedUrl : null;
    const publishedAt = parseDate(raw.isoDate ?? raw.pubDate ?? raw.published ?? raw.updated);
    const summary = text(raw.contentSnippet ?? raw.contentEncoded ?? raw.content ?? raw.summary ?? raw.description, 8_192);
    const author = text(raw.creator ?? raw.author, 512) || null;
    const identityKey = itemIdentity(sourceId, raw, canonicalUrl, title, publishedAt);
    items.push({ identityKey, canonicalUrl, title, summary, author, publishedAt });
  }
  const unique = new Map<string, NormalizedFeedItem>();
  for (const item of items) {
    if (!unique.has(item.identityKey)) {
      unique.set(item.identityKey, item);
      continue;
    }
    // Some generated feeds reuse a placeholder GUID for every entry. If a
    // canonical URL is available, keep the entry under its URL identity.
    if (item.canonicalUrl) {
      const urlIdentity = `url:${item.canonicalUrl}`;
      if (!unique.has(urlIdentity)) unique.set(urlIdentity, { ...item, identityKey: urlIdentity });
    }
  }
  return {
    finalUrl,
    etag: boundedHeader(headers, "etag", 1_024),
    lastModified: boundedHeader(headers, "last-modified", 256),
    notModified: false,
    title: text(parsed.title) || null,
    siteUrl: normalizeUrl(text(parsed.link)) ,
    items: [...unique.values()],
  };
}

export async function fetchFeed(url: string, cache: FeedCache, options: FeedFetchOptions = {}): Promise<ParsedFeed> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookup = options.lookup ?? dnsLookup;
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 20_000;
  let current = url;
  let response: Response | undefined;
  const requestHeaders = new Headers({ accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/plain;q=0.8" });
  if (cache.etag) requestHeaders.set("if-none-match", cache.etag);
  if (cache.lastModified) requestHeaders.set("if-modified-since", cache.lastModified);
  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    const target = await assertPublicUrl(current, lookup);
    const control = abortableSignal(options.signal, timeoutMs);
    try {
      response = await fetchImpl(target, { redirect: "manual", headers: requestHeaders, signal: control.signal });
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        const location = response.headers.get("location");
        if (!location) throw new FeedFetchError("feed_http_error", false, response.status);
        if (redirect === maxRedirects) throw new FeedFetchError("feed_redirect_limit", false, response.status);
        current = new URL(location, target).toString();
        continue;
      }
      if (response.status === 304) {
        return { finalUrl: current, etag: boundedHeader(response.headers, "etag", 1_024, cache.etag), lastModified: boundedHeader(response.headers, "last-modified", 256, cache.lastModified), notModified: true, title: null, siteUrl: null, items: [] };
      }
      if (!response.ok) throw new FeedFetchError("feed_http_error", response.status === 408 || response.status === 429 || response.status >= 500, response.status);
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (contentType && !/(xml|rss|atom|text\/plain)/.test(contentType)) throw new FeedFetchError("feed_invalid_content", false, response.status);
      const body = await readBody(response, maxBytes);
      return await parseFeed(options.sourceId ?? url, current, body, response.headers);
    } catch (error) {
      if (control.signal.aborted) throw new FeedFetchError("feed_timeout", true);
      if (error instanceof FeedFetchError) throw error;
      throw new FeedFetchError("feed_unavailable", true);
    } finally { control.close(); }
  }
  throw new FeedFetchError("feed_redirect_limit", false);
}
