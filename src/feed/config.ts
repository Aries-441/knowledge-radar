import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import YAML from "yaml";
import { z } from "zod";

export type FeedSourceConfig = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  priority: number;
  tags: string[];
  itemLimit: number;
};

export type FeedConfig = {
  timezone: string;
  pollIntervalMinutes: number;
  feeds: FeedSourceConfig[];
  digest?: { enabled: boolean; time: string; maxItems: number };
};

export const DEFAULT_FEED_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_POLL_INTERVAL_MINUTES = 30;
export const DEFAULT_FEED_ITEM_LIMIT = 100;

export class FeedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedConfigError";
  }
}

const rawFeedSchema = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  name: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  url: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(-100).max(100).default(0),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  itemLimit: z.number().int().min(1).max(500).optional(),
});

const rawConfigSchema = z.object({
  timezone: z.string().trim().min(1).default(DEFAULT_FEED_TIMEZONE),
  pollIntervalMinutes: z.number().int().min(1).max(7 * 24).default(DEFAULT_POLL_INTERVAL_MINUTES),
  poll: z.object({
    interval: z.union([z.string(), z.number()]).optional(),
    maxItemsPerFeed: z.number().int().min(1).max(500).optional(),
  }).optional(),
  feeds: z.array(rawFeedSchema).max(200).default([]),
  digest: z.object({
    enabled: z.boolean().default(false),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default("09:00"),
    maxItems: z.number().int().min(1).max(50).default(20),
  }).optional(),
});

function parseInterval(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 60_000 || value > 7 * 24 * 60 * 60 * 1_000) {
      throw new FeedConfigError("poll.interval must be between 1 minute and 7 days");
    }
    return value;
  }
  const match = /^(\d+)(s|m|h|d)$/.exec(value.trim());
  if (!match) throw new FeedConfigError("poll.interval must use a duration such as 30m or 2h");
  const amount = Number(match[1]);
  const multiplier = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 60_000 || milliseconds > 7 * 24 * 60 * 60 * 1_000) {
    throw new FeedConfigError("poll.interval must be between 1 minute and 7 days");
  }
  return milliseconds;
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new FeedConfigError(`invalid timezone: ${timezone}`);
  }
}

function validateUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new FeedConfigError("feed URL is invalid"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new FeedConfigError("feed URL must use http or https");
  if (parsed.username || parsed.password) throw new FeedConfigError("feed URL must not contain credentials");
  return parsed.toString();
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ");
}

export function parseFeedConfig(value: unknown): FeedConfig {
  const parsedConfig = rawConfigSchema.safeParse(value);
  if (!parsedConfig.success) throw new FeedConfigError(formatIssues(parsedConfig.error));
  const raw = parsedConfig.data;
  validateTimezone(raw.timezone);
  const pollIntervalMinutes = raw.poll?.interval === undefined
    ? raw.pollIntervalMinutes
    : Math.round(parseInterval(raw.poll.interval) / 60_000);
  const itemLimit = raw.poll?.maxItemsPerFeed ?? DEFAULT_FEED_ITEM_LIMIT;
  const ids = new Set<string>();
  const feeds = raw.feeds.map(feed => {
    if (ids.has(feed.id)) throw new FeedConfigError(`duplicate feed id: ${feed.id}`);
    ids.add(feed.id);
    const name = feed.name ?? feed.title;
    if (!name) throw new FeedConfigError(`feeds.${feed.id}.name is required`);
    return {
      id: feed.id,
      name,
      url: validateUrl(feed.url),
      enabled: feed.enabled,
      priority: feed.priority,
      tags: [...new Set(feed.tags)],
      itemLimit: feed.itemLimit ?? itemLimit,
    };
  });
  const result: FeedConfig = {
    timezone: raw.timezone,
    pollIntervalMinutes,
    feeds,
  };
  if (raw.digest) result.digest = raw.digest;
  return result;
}

export async function loadFeedConfig(path?: string): Promise<FeedConfig> {
  if (!path?.trim()) return parseFeedConfig({});
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseFeedConfig({});
    throw new FeedConfigError("feed config could not be read");
  }
  try { return parseFeedConfig(YAML.parse(text)); }
  catch (error) { throw error instanceof FeedConfigError ? error : new FeedConfigError("feed config could not be parsed"); }
}
