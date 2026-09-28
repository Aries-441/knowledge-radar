import type { FeedItem, FeishuScope } from "../runtime/types.js";

export const DIGEST_MAX_BYTES = 5_500;
export const DIGEST_CARD_MAX_BYTES = 20_000;

export type DigestCandidate = FeedItem & { sourceName: string; priority: number };
export type DigestPayload = {
  version: 1 | 2;
  scope: FeishuScope;
  date: string;
  itemIds: string[];
  canonicalUrls: string[];
  text: string;
  card?: string;
};

export type DigestArtifact = Pick<DigestPayload, "itemIds" | "canonicalUrls" | "text" | "card"> & {
  card: string;
};

type DigestEntry = {
  items: DigestCandidate[];
  first: DigestCandidate;
  sources: string;
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

function orderedGroups(candidates: DigestCandidate[]): DigestCandidate[][] {
  const groups = new Map<string, DigestCandidate[]>();
  const sorted = [...candidates].sort((a, b) =>
    (b.publishedAt ?? b.firstSeenAt) - (a.publishedAt ?? a.firstSeenAt)
    || a.priority - b.priority
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
  };
}

function textFor(entries: DigestEntry[], date: string): string {
  const header = `Knowledge Radar · ${date}\n新文章 ${entries.length} 篇\n（摘录来自 RSS，点击链接阅读全文）\n`;
  const blocks = entries.map((entry, index) => {
    const first = entry.first;
    return `\n${index + 1}. ${clip(plain(first.title), 450)}\n来源：${entry.sources}\n${first.canonicalUrl ?? "（来源未提供文章链接）"}`
      + (first.summary ? `\n${clip(plain(first.summary), 600)}` : "") + "\n";
  });
  return header + blocks.join("");
}

function cardFor(entries: DigestEntry[], date: string, preview: boolean): string {
  const elements: Record<string, unknown>[] = [{
    tag: "markdown",
    element_id: "digest_intro",
    content: `${preview ? "**预览**\n" : ""}**新文章 ${entries.length} 篇**\n摘录来自 RSS，点击按钮阅读全文。`,
  }];
  entries.forEach((entry, index) => {
    const first = entry.first;
    const content = `**${index + 1}. ${markdown(clip(first.title, 450))}**\n来源：${markdown(entry.sources)}`
      + (first.summary ? `\n${markdown(clip(first.summary, 600))}` : "");
    elements.push({ tag: "markdown", element_id: `article_${index + 1}`, content });
    if (first.canonicalUrl) {
      elements.push({
        tag: "button",
        element_id: `open_${index + 1}`,
        text: { tag: "plain_text", content: "阅读全文" },
        type: "primary",
        behaviors: [{ type: "open_url", default_url: first.canonicalUrl }],
      });
    }
    if (index < entries.length - 1) elements.push({ tag: "hr", element_id: `rule_${index + 1}` });
  });
  return JSON.stringify({
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: `Knowledge Radar · ${preview ? "预览 · " : ""}${date}` },
      icon: { tag: "standard_icon", token: "lark-logo_colorful" },
    },
    body: { elements },
  });
}

function buildArtifact(candidates: DigestCandidate[], date: string, maxItems: number, preview: boolean): DigestArtifact | null {
  const limit = Math.max(0, Math.floor(maxItems));
  if (limit === 0) return null;
  const entries: DigestEntry[] = [];
  for (const group of orderedGroups(candidates)) {
    if (entries.length >= limit) break;
    const next = [...entries, entryFor(group)];
    const text = textFor(next, date);
    const card = cardFor(next, date, preview);
    if (Buffer.byteLength(text, "utf8") > DIGEST_MAX_BYTES || Buffer.byteLength(card, "utf8") > DIGEST_CARD_MAX_BYTES) break;
    entries.push(next[next.length - 1]);
  }
  if (!entries.length) return null;
  const itemIds = entries.flatMap(entry => entry.items.map(item => item.id));
  const canonicalUrls = entries.flatMap(entry => entry.first.canonicalUrl ? [entry.first.canonicalUrl] : []);
  return { itemIds, canonicalUrls, text: textFor(entries, date), card: cardFor(entries, date, preview) };
}

export function buildFeedDigest(candidates: DigestCandidate[], date: string, maxItems: number): DigestArtifact | null {
  return buildArtifact(candidates, date, maxItems, false);
}

export function buildFeedDigestCard(candidates: DigestCandidate[], date: string, maxItems: number): DigestArtifact | null {
  return buildArtifact(candidates, date, maxItems, true);
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
