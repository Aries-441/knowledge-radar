import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import { sourceConnectorRegistry, type SourceConfig, type SourceKind } from "./source.js";
import { githubTrendingUrl } from "./github-trending.js";

/** Legacy shape accepted by callers that still construct feeds in memory. */
export type FeedSourceConfig = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  priority: number;
  tags: string[];
  itemLimit: number;
  kind?: SourceKind;
  connectorConfig?: Record<string, unknown>;
};

export type FeedConfig = {
  timezone: string;
  pollIntervalMinutes: number;
  sources: SourceConfig[];
  feeds: FeedSourceConfig[];
  digest?: {
    enabled: boolean;
    time: string;
    maxItems: number;
    schedules?: DigestSchedule[];
  };
};

export type DigestScheduleMode = "new_items" | "trend_snapshot" | "period_summary";
export type DigestScheduleFrequency = "daily" | "weekly" | "every_n_weeks";
export type DigestSchedule = {
  id: string;
  mode: DigestScheduleMode;
  frequency: DigestScheduleFrequency;
  time: string;
  maxItems: number;
  sourceIds: string[];
  weekday?: number;
  anchorDate?: string;
  intervalWeeks?: number;
  sourceScheduleId?: string;
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

const rawSourceSchema = rawFeedSchema.extend({
  kind: z.string().trim().min(1),
  connectorConfig: z.record(z.string(), z.unknown()).default({}),
});

const rawConfigSchema = z.object({
  timezone: z.string().trim().min(1).default(DEFAULT_FEED_TIMEZONE),
  pollIntervalMinutes: z.number().int().min(1).max(7 * 24).default(DEFAULT_POLL_INTERVAL_MINUTES),
  poll: z.object({
    interval: z.union([z.string(), z.number()]).optional(),
    maxItemsPerFeed: z.number().int().min(1).max(500).optional(),
  }).optional(),
  feeds: z.array(rawFeedSchema).max(200).optional(),
  sources: z.array(rawSourceSchema).max(200).optional(),
  digest: z.object({
    enabled: z.boolean().optional(),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
    maxItems: z.number().int().min(1).max(50).optional(),
    schedules: z.array(z.unknown()).max(100).optional(),
  }).optional(),
});

const scheduleId = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const rawScheduleSchema = z.object({
  id: scheduleId,
  mode: z.enum(["new_items", "trend_snapshot", "period_summary"]),
  frequency: z.enum(["daily", "weekly", "every_n_weeks"]),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  maxItems: z.number().int().min(1).max(50),
  sourceIds: z.array(z.string().trim().min(1)).default([]),
  weekday: z.number().int().min(1).max(7).optional(),
  anchorDate: z.string().optional(),
  intervalWeeks: z.number().int().min(1).max(52).optional(),
  sourceScheduleId: scheduleId.optional(),
}).strict();

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

function normalizeSource(feed: z.infer<typeof rawFeedSchema>, sourceKind: string, connectorConfig: Record<string, unknown> | undefined, itemLimit: number, entryName: string): SourceConfig {
  if (!sourceConnectorRegistry.has(sourceKind)) throw new FeedConfigError(`${entryName}.kind is not registered`);
  if (sourceKind === "rss" && connectorConfig && Object.keys(connectorConfig).length > 0) {
    throw new FeedConfigError(`${entryName}.connectorConfig is not supported for rss`);
  }
  let normalizedUrl = validateUrl(feed.url);
  let normalizedConnectorConfig = connectorConfig ?? {};
  if (sourceKind === "github_trending") {
    const githubUrl = githubTrendingUrl(normalizedUrl);
    if (!githubUrl) throw new FeedConfigError(`${entryName}.url must be https://github.com/trending`);
    normalizedUrl = githubUrl;
    const config = connectorConfig ?? {};
    const unknown = Object.keys(config).filter(key => key !== "period" && key !== "language");
    if (unknown.length > 0) throw new FeedConfigError(`${entryName}.connectorConfig contains unknown options`);
    const period = config.period ?? "weekly";
    if (period !== "daily" && period !== "weekly" && period !== "monthly") {
      throw new FeedConfigError(`${entryName}.connectorConfig.period must be daily, weekly or monthly`);
    }
    const language = config.language ?? "all";
    if (typeof language !== "string" || language.length < 1 || language.length > 50
      || (language !== "all" && !/^[A-Za-z0-9][A-Za-z0-9+#.-]*$/.test(language))) {
      throw new FeedConfigError(`${entryName}.connectorConfig.language is invalid`);
    }
    normalizedConnectorConfig = { period, language };
  }
  const name = feed.name ?? feed.title;
  if (!name) throw new FeedConfigError(`${entryName}.name is required`);
  return {
    id: feed.id,
    name,
    kind: sourceKind as SourceKind,
    url: normalizedUrl,
    enabled: feed.enabled,
    priority: feed.priority,
    tags: [...new Set(feed.tags)],
    itemLimit: feed.itemLimit ?? itemLimit,
    connectorConfig: normalizedConnectorConfig,
  };
}

export function normalizeSourceConfig(source: FeedSourceConfig): SourceConfig {
  return normalizeSource(source, source.kind ?? "rss", source.connectorConfig, source.itemLimit, `sources.${source.id}`);
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ");
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function normalizeDigestSchedules(raw: z.infer<typeof rawConfigSchema>, sourceIds: Set<string>): DigestSchedule[] | undefined {
  const digest = raw.digest;
  if (!digest) return undefined;
  if (digest.schedules === undefined) return undefined;
  const schedules: DigestSchedule[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < digest.schedules.length; index += 1) {
    const parsed = rawScheduleSchema.safeParse(digest.schedules[index]);
    if (!parsed.success) throw new FeedConfigError(`digest.schedules.${index}: ${formatIssues(parsed.error)}`);
    const schedule = parsed.data;
    if (ids.has(schedule.id)) throw new FeedConfigError(`duplicate digest schedule id: ${schedule.id}`);
    ids.add(schedule.id);
    if (schedule.mode === "period_summary") {
      if (!schedule.sourceScheduleId) throw new FeedConfigError(`digest.schedules.${index}.sourceScheduleId is required`);
      if (schedule.sourceIds.length > 0) throw new FeedConfigError(`digest.schedules.${index}.sourceIds must be empty for period_summary`);
    } else if (schedule.sourceIds.length === 0) {
      throw new FeedConfigError(`digest.schedules.${index}.sourceIds must not be empty`);
    }
    for (const sourceId of schedule.sourceIds) {
      if (!sourceIds.has(sourceId)) throw new FeedConfigError(`digest.schedules.${index}.sourceIds references unknown source: ${sourceId}`);
    }
    if (schedule.frequency === "weekly" && schedule.weekday === undefined) {
      throw new FeedConfigError(`digest.schedules.${index}.weekday is required for weekly schedules`);
    }
    if (schedule.frequency !== "weekly" && schedule.weekday !== undefined) {
      throw new FeedConfigError(`digest.schedules.${index}.weekday is only valid for weekly schedules`);
    }
    if (schedule.frequency === "every_n_weeks") {
      if (!schedule.anchorDate || !validIsoDate(schedule.anchorDate)) {
        throw new FeedConfigError(`digest.schedules.${index}.anchorDate must be an ISO date`);
      }
      if (schedule.intervalWeeks === undefined) throw new FeedConfigError(`digest.schedules.${index}.intervalWeeks is required`);
    } else if (schedule.anchorDate !== undefined || schedule.intervalWeeks !== undefined) {
      throw new FeedConfigError(`digest.schedules.${index}.anchorDate and intervalWeeks are only valid for every_n_weeks`);
    }
    schedules.push({ ...schedule, sourceIds: [...new Set(schedule.sourceIds)] });
  }
  for (const schedule of schedules) {
    if (schedule.mode === "period_summary" && (!ids.has(schedule.sourceScheduleId!) || schedules.find(item => item.id === schedule.sourceScheduleId)?.mode !== "trend_snapshot")) {
      throw new FeedConfigError(`digest schedule ${schedule.id} references an invalid sourceScheduleId`);
    }
  }
  return schedules;
}

/** Returns normalized schedules, including the legacy single daily digest. */
export function getDigestSchedules(config: FeedConfig): DigestSchedule[] {
  if (config.digest?.schedules) return config.digest.schedules;
  const digest = config.digest;
  if (!digest?.enabled) return [];
  return [{ id: "default-daily", mode: "new_items", frequency: "daily", time: digest.time, maxItems: digest.maxItems, sourceIds: config.sources.filter(source => source.enabled).map(source => source.id) }];
}

export function parseFeedConfig(value: unknown): FeedConfig {
  const parsedConfig = rawConfigSchema.safeParse(value);
  if (!parsedConfig.success) throw new FeedConfigError(formatIssues(parsedConfig.error));
  const raw = parsedConfig.data;
  if (raw.feeds !== undefined && raw.sources !== undefined) {
    throw new FeedConfigError("config cannot define both feeds and sources");
  }
  validateTimezone(raw.timezone);
  const pollIntervalMinutes = raw.poll?.interval === undefined
    ? raw.pollIntervalMinutes
    : Math.round(parseInterval(raw.poll.interval) / 60_000);
  const itemLimit = raw.poll?.maxItemsPerFeed ?? DEFAULT_FEED_ITEM_LIMIT;
  const ids = new Set<string>();
  const sources = raw.sources !== undefined
    ? raw.sources.map(feed => {
      if (ids.has(feed.id)) throw new FeedConfigError(`duplicate source id: ${feed.id}`);
      ids.add(feed.id);
      return normalizeSource(feed, feed.kind, feed.connectorConfig, itemLimit, `sources.${feed.id}`);
    })
    : (raw.feeds ?? []).map(feed => {
      if (ids.has(feed.id)) throw new FeedConfigError(`duplicate feed id: ${feed.id}`);
      ids.add(feed.id);
      return normalizeSource(feed, "rss", {}, itemLimit, `feeds.${feed.id}`);
    });
  const result: FeedConfig = {
    timezone: raw.timezone,
    pollIntervalMinutes,
    sources,
    feeds: sources,
  };
  if (raw.digest) {
    const digest = {
      enabled: raw.digest.enabled ?? (raw.digest.schedules !== undefined && raw.digest.schedules.length > 0),
      time: raw.digest.time ?? "09:00",
      maxItems: raw.digest.maxItems ?? 20,
    };
    const schedules = normalizeDigestSchedules(raw, ids);
    result.digest = schedules ? { ...digest, schedules } : digest;
  }
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
