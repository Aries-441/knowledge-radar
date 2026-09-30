import type { FeedSource } from "../runtime/types.js";
import { fetchGithubTrending } from "./github-trending.js";
import { fetchFeed, type FeedFetchOptions, type ParsedFeed } from "./parser.js";

/** Source kinds are intentionally closed until a connector is implemented and tested. */
export const SOURCE_KINDS = ["rss", "github_trending"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export type SourceConfig = {
  id: string;
  name: string;
  kind: SourceKind;
  url: string;
  enabled: boolean;
  priority: number;
  tags: string[];
  itemLimit: number;
  connectorConfig: Record<string, unknown>;
};

export type SourceConnectorOptions = {
  signal?: AbortSignal;
  fetchOptions?: Omit<FeedFetchOptions, "signal">;
};

export type SourceConnector = {
  kind: SourceKind;
  fetch(source: FeedSource, options?: SourceConnectorOptions): Promise<ParsedFeed>;
};

export class SourceConnectorError extends Error {
  constructor(readonly code: "source_connector_unregistered" | "source_connector_invalid_config", readonly retryable = false) {
    super(code);
    this.name = "SourceConnectorError";
  }
}

const rssConnector: SourceConnector = {
  kind: "rss",
  fetch(source, options = {}) {
    return fetchFeed(source.url, { etag: source.etag, lastModified: source.lastModified }, {
      ...options.fetchOptions,
      sourceId: source.id,
      signal: options.signal,
    });
  },
};

const githubTrendingConnector: SourceConnector = {
  kind: "github_trending",
  fetch(source, options = {}) {
    return fetchGithubTrending(source, options);
  },
};

/** Explicit registry: configuration never selects arbitrary modules or URL heuristics. */
export const sourceConnectorRegistry: ReadonlyMap<string, SourceConnector> = new Map([
  [rssConnector.kind, rssConnector],
  [githubTrendingConnector.kind, githubTrendingConnector],
]);

export function getSourceConnector(kind: string): SourceConnector {
  const connector = sourceConnectorRegistry.get(kind);
  if (!connector) throw new SourceConnectorError("source_connector_unregistered");
  return connector;
}
