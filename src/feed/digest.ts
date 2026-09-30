import type { FeedItem, FeishuScope } from "../runtime/types.js";
import { resolveSourceCardTheme, type SourceCardTheme } from "./card-themes.js";

export const DIGEST_MAX_BYTES = 5_500;
export const DIGEST_CARD_MAX_BYTES = 20_000;
export const DIGEST_INTEREST_ACTION = "digest_interest" as const;
// Feishu's standard icon list does not provide a portable star token. These
// Unicode glyphs render consistently on mobile and desktop clients.
export const DIGEST_STAR_UNSELECTED = "☆" as const;
export const DIGEST_STAR_SELECTED = "★" as const;

export type DigestCandidate = FeedItem & { sourceName: string; priority: number; sourceKind?: string };
export type DigestInterestAction = {
  action: typeof DIGEST_INTEREST_ACTION;
  item_id: string;
  target_interested: boolean;
};
export type DigestInterestStates = ReadonlyMap<string, boolean>;
export type DigestScheduleMode = "new_items" | "trend_snapshot" | "period_summary";
export type DigestPayload = {
  version: 1 | 2 | 3;
  scope: FeishuScope;
  date: string;
  itemIds: string[];
  canonicalUrls: string[];
  text: string;
  card?: string;
  scheduleId?: string;
  periodKey?: string;
  periodStart?: string;
  periodEnd?: string;
  mode?: DigestScheduleMode;
  snapshot?: DigestCandidate[];
};

export type DigestArtifact = Pick<DigestPayload, "itemIds" | "canonicalUrls" | "text" | "card"> & {
  card: string;
  snapshot: DigestCandidate[];
};

export type DigestDisplay = { label?: string; period?: string };

type DigestEntry = {
  items: DigestCandidate[];
  first: DigestCandidate;
  sources: string;
  theme: SourceCardTheme;
};

function plain(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_match, entity: string) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[entity]!)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > Math.max(0, maxBytes - 3)) break;
    result += char;
    bytes += charBytes;
  }
  return `${result}...`;
}

function markdown(value: string): string {
  return plain(value).replace(/[\\`*_{}\[\]()#+\-.!|>]/g, "\\$&");
}

function githubTrendLine(item: DigestCandidate): string | null {
  if (item.metadata?.provider !== "github_trending") return null;
  const language = typeof item.metadata.language === "string" && item.metadata.language ? item.metadata.language : "Unknown language";
  const period = typeof item.metadata.starsPeriod === "string" && item.metadata.starsPeriod ? item.metadata.starsPeriod : "trend";
  const delta = typeof item.metadata.starsDelta === "number" && Number.isFinite(item.metadata.starsDelta)
    ? ` · +${Math.round(item.metadata.starsDelta).toLocaleString("en-US")} stars` : "";
  return `GitHub · ${language} · ${period}${delta}`;
}

function trendRank(item: DigestCandidate): number | null {
  const rank = item.metadata?.rank;
  return typeof rank === "number" && Number.isSafeInteger(rank) && rank >= 1 && rank <= 500 ? rank : null;
}

function orderedGroups(candidates: DigestCandidate[]): DigestCandidate[][] {
  const groups = new Map<string, DigestCandidate[]>();
  const sorted = [...candidates].sort((a, b) => {
    const aRank = trendRank(a);
    const bRank = trendRank(b);
    if (aRank !== null || bRank !== null) {
      if (aRank === null) return 1;
      if (bRank === null) return -1;
      if (aRank !== bRank) return aRank - bRank;
    }
    return (b.publishedAt ?? b.firstSeenAt) - (a.publishedAt ?? a.firstSeenAt)
      || a.priority - b.priority
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  for (const item of sorted) {
    const key = item.canonicalUrl ? `url:${item.canonicalUrl}` : `item:${item.id}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()];
}

function entryFor(group: DigestCandidate[]): DigestEntry {
  return {
    items: group,
    first: group[0],
    sources: clip([...new Set(group.map(item => plain(item.sourceName)))].join(" / "), 700),
    theme: resolveSourceCardTheme(group[0]),
  };
}

function digestTitle(date: string, display?: DigestDisplay): string {
  return ["Knowledge Radar", display?.label, display?.period, date].filter(Boolean).join(" · ");
}

type DigestThemeGroup = { theme: SourceCardTheme; entries: DigestEntry[] };

function groupedByTheme(entries: DigestEntry[]): DigestThemeGroup[] {
  const groups = new Map<string, DigestThemeGroup>();
  for (const entry of entries) {
    const key = entry.theme.kind;
    const group = groups.get(key);
    if (group) group.entries.push(entry);
    else groups.set(key, { theme: entry.theme, entries: [entry] });
  }
  return [...groups.values()];
}

function textFor(entries: DigestEntry[], date: string, display?: DigestDisplay): string {
  const prefix = display?.label || display?.period
    ? `${[display.label, display.period].filter(Boolean).join(" · ")}\n`
    : "";
  const header = `Knowledge Radar · ${date}\n新文章 ${entries.length} 篇\n（摘要来自订阅源，点击链接阅读全文）\n`;
  const blocks = entries.map((entry, index) => {
    const first = entry.first;
    const trend = githubTrendLine(first);
    return `\n${index + 1}. ${clip(plain(first.title), 450)}\n来源：${entry.sources}\n${first.canonicalUrl ?? "（来源未提供文章链接）"}`
      + (trend ? `\n${trend}` : "")
      + (first.summary ? `\n${clip(plain(first.summary), 600)}` : "") + "\n";
  });
  return prefix + header + blocks.join("");
}

function cardFor(entries: DigestEntry[], date: string, preview: boolean, interestStates?: DigestInterestStates, display?: DigestDisplay): string {
  const themeGroups = groupedByTheme(entries);
  const scheduleElement = display?.label || display?.period ? [{
    tag: "markdown",
    element_id: "digest_schedule",
    content: `**${markdown(display.label ?? "摘要")}**${display.period ? `\n${markdown(display.period)}` : ""}`,
  }] : [];
  const elements: Record<string, unknown>[] = [...scheduleElement, {
    tag: "markdown",
    element_id: "digest_intro",
    content: `${preview ? "**预览**\n" : ""}**新文章 ${entries.length} 篇 · ${themeGroups.length} 个来源**\n摘要来自订阅源，点击按钮阅读全文。`,
  }];
  let index = 0;
  for (const [groupIndex, group] of themeGroups.entries()) {
    elements.push({
      tag: "column_set",
      element_id: `source_group_${groupIndex + 1}`,
      flex_mode: "none",
      background_style: group.theme.sectionBackground,
      columns: [{
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "center",
        elements: [{
          tag: "div",
          text: { tag: "plain_text", content: `${group.theme.badgeText}  ·  ${group.entries.length} 条` },
        }],
      }],
    });
    for (const entry of group.entries) {
      index += 1;
      const first = entry.first;
      const trend = githubTrendLine(first);
      const content = `**${index}. ${markdown(clip(first.title, 280))}**\n${markdown(entry.theme.badgeText)} · ${markdown(entry.sources)}`
        + (trend ? `\n${markdown(trend)}` : "")
        + (first.summary ? `\n${markdown(clip(first.summary, 360))}` : "");
      elements.push({ tag: "markdown", element_id: `article_${index}`, content });
      const interested = interestStates?.get(first.id) === true;
      const interestAction: DigestInterestAction = {
        action: DIGEST_INTEREST_ACTION,
        item_id: first.id,
        target_interested: !interested,
      };
      const actionButtons: Record<string, unknown>[] = [];
      if (first.canonicalUrl) {
        actionButtons.push({
          tag: "button",
          element_id: `open_${index}`,
          text: { tag: "plain_text", content: "阅读全文" },
          type: "primary_filled",
          behaviors: [{ type: "open_url", default_url: first.canonicalUrl }],
        });
      }
      actionButtons.push({
        tag: "button",
        element_id: `interest_${index}`,
        text: { tag: "plain_text", content: interested ? DIGEST_STAR_SELECTED : DIGEST_STAR_UNSELECTED },
        type: "default",
        behaviors: [{ type: "callback", value: interestAction }],
      });
      elements.push({
        tag: "column_set",
        element_id: `actions_${index}`,
        flex_mode: "none",
        horizontal_spacing: "small",
        columns: actionButtons.map((button, buttonIndex) => ({
          tag: "column",
          width: "weighted",
          weight: buttonIndex === 0 && actionButtons.length > 1 ? 1 : 2,
          vertical_align: "center",
          elements: [button],
        })),
      });
    }
  }
  return JSON.stringify({
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      template: themeGroups.length === 1 ? themeGroups[0].theme.headerTemplate : "blue",
      title: { tag: "plain_text", content: `${preview ? "预览 · " : ""}${digestTitle(date, display)}` },
      icon: { tag: "standard_icon", token: "lark-logo_colorful" },
    },
    body: { direction: "vertical", padding: "12px 12px 20px 12px", vertical_spacing: "medium", elements },
  });
}

function buildArtifact(
  candidates: DigestCandidate[], date: string, maxItems: number, preview: boolean,
  interestStates?: DigestInterestStates, display?: DigestDisplay,
): DigestArtifact | null {
  const limit = Math.max(0, Math.floor(maxItems));
  if (limit === 0) return null;
  const entries: DigestEntry[] = [];
  for (const group of orderedGroups(candidates)) {
    if (entries.length >= limit) break;
    const next = [...entries, entryFor(group)];
    const text = textFor(next, date, display);
    const card = cardFor(next, date, preview, interestStates, display);
    if (Buffer.byteLength(text, "utf8") > DIGEST_MAX_BYTES || Buffer.byteLength(card, "utf8") > DIGEST_CARD_MAX_BYTES) break;
    entries.push(next[next.length - 1]);
  }
  if (!entries.length) return null;
  const itemIds = entries.flatMap(entry => entry.items.map(item => item.id));
  const canonicalUrls = entries.flatMap(entry => entry.first.canonicalUrl ? [entry.first.canonicalUrl] : []);
  return {
    itemIds,
    canonicalUrls,
    text: textFor(entries, date, display),
    card: cardFor(entries, date, preview, interestStates, display),
    snapshot: entries.flatMap(entry => entry.items),
  };
}

export function buildFeedDigest(
  candidates: DigestCandidate[], date: string, maxItems: number, interestStates?: DigestInterestStates,
  display?: DigestDisplay,
): DigestArtifact | null {
  return buildArtifact(candidates, date, maxItems, false, interestStates, display);
}

export function buildFeedDigestCard(
  candidates: DigestCandidate[], date: string, maxItems: number, interestStates?: DigestInterestStates,
  display?: DigestDisplay,
): DigestArtifact | null {
  return buildArtifact(candidates, date, maxItems, true, interestStates, display);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDigestInterestAction(value: unknown, itemId: string): value is DigestInterestAction {
  return isRecord(value)
    && value.action === DIGEST_INTEREST_ACTION
    && value.item_id === itemId
    && typeof value.target_interested === "boolean";
}

function digestInterestBehavior(element: unknown, itemId: string): { button: Record<string, unknown>; value: DigestInterestAction } | null {
  if (!isRecord(element)) return null;
  const buttons = element.tag === "column_set" && Array.isArray(element.columns)
    ? element.columns.flatMap(column => isRecord(column) && Array.isArray(column.elements)
      ? column.elements.filter(isRecord) : [])
    : [element];
  const matches = buttons.filter(candidate => candidate.tag === "button" && Array.isArray(candidate.behaviors)
    && (candidate.behaviors as unknown[]).some(value => isRecord(value) && value.type === "callback" && isDigestInterestAction(value.value, itemId)));
  if (matches.length !== 1 || !Array.isArray(matches[0].behaviors)) return null;
  const button = matches[0];
  const behavior = (button.behaviors as unknown[]).find(candidate =>
    isRecord(candidate) && candidate.type === "callback" && isDigestInterestAction(candidate.value, itemId));
  if (!isRecord(behavior) || !isDigestInterestAction(behavior.value, itemId)) return null;
  return { button, value: behavior.value };
}

/**
 * Updates one controlled interest button without rebuilding article content.
 * Returning null for an invalid or ambiguous card prevents a callback from
 * modifying a card that was not created by this application.
 */
export function updateDigestCardInterest(card: string, itemId: string, interested: boolean): string | null {
  if (!itemId.trim()) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(card); } catch { return null; }
  if (!isRecord(parsed) || parsed.schema !== "2.0" || !isRecord(parsed.body) || !Array.isArray(parsed.body.elements)) return null;
  const matches = parsed.body.elements
    .map(element => digestInterestBehavior(element, itemId))
    .filter((match): match is { button: Record<string, unknown>; value: DigestInterestAction } => match !== null);
  if (matches.length !== 1) return null;
  const { button, value } = matches[0];
  button.text = { tag: "plain_text", content: interested ? DIGEST_STAR_SELECTED : DIGEST_STAR_UNSELECTED };
  const behaviors = button.behaviors as unknown[];
  const behavior = behaviors.find(candidate =>
    isRecord(candidate) && candidate.type === "callback" && candidate.value === value) as Record<string, unknown> | undefined;
  if (!behavior) return null;
  behavior.value = { ...value, target_interested: !interested };
  const updated = JSON.stringify(parsed);
  return Buffer.byteLength(updated, "utf8") <= DIGEST_CARD_MAX_BYTES ? updated : null;
}

export function digestLocalTime(timestamp: number, timezone: string): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(timestamp).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
