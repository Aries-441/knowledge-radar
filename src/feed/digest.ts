import type { FeedItem, FeishuScope } from "../runtime/types.js";

export const DIGEST_MAX_BYTES = 5_500;
export type DigestCandidate = FeedItem & { sourceName: string; priority: number };
export type DigestPayload = {
  version: 1;
  scope: FeishuScope;
  date: string;
  itemIds: string[];
  canonicalUrls: string[];
  text: string;
};

function plain(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&(amp|lt|gt|quot|apos|nbsp);/g,
    (_match, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[entity]!)
    .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function clip(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "", bytes = 0;
  for (const char of value) {
    bytes += Buffer.byteLength(char, "utf8");
    if (bytes > maxBytes - 3) break;
    result += char;
  }
  return result + "…";
}

export function buildFeedDigest(candidates: DigestCandidate[], date: string, maxItems: number):
  Pick<DigestPayload, "itemIds" | "canonicalUrls" | "text"> | null {
  const groups = new Map<string, DigestCandidate[]>();
  const sorted = [...candidates].sort((a, b) => (b.publishedAt ?? b.firstSeenAt) - (a.publishedAt ?? a.firstSeenAt)
    || a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const item of sorted) {
    const key = item.canonicalUrl ? `url:${item.canonicalUrl}` : `item:${item.id}`;
    const group = groups.get(key);
    if (group) group.push(item); else groups.set(key, [item]);
  }
  const blocks: string[] = [], itemIds: string[] = [], canonicalUrls: string[] = [];
  const header = (count: number) => `Knowledge Radar · ${date}\n新文章 ${count} 篇\n（摘录来自 RSS，点击链接阅读全文）\n`;
  for (const group of groups.values()) {
    if (blocks.length >= maxItems) break;
    const first = group[0];
    const sources = clip([...new Set(group.map(item => plain(item.sourceName)))].join(" / "), 700);
    const block = `\n${blocks.length + 1}. ${clip(plain(first.title), 450)}\n来源：${sources}\n${first.canonicalUrl ?? "（来源未提供文章链接）"}`
      + (first.summary ? `\n${clip(plain(first.summary), 600)}` : "") + "\n";
    if (Buffer.byteLength(header(blocks.length + 1) + blocks.join("") + block, "utf8") > DIGEST_MAX_BYTES) break;
    blocks.push(block);
    itemIds.push(...group.map(item => item.id));
    if (first.canonicalUrl) canonicalUrls.push(first.canonicalUrl);
  }
  return blocks.length ? { text: header(blocks.length) + blocks.join(""), itemIds, canonicalUrls } : null;
}

export function digestLocalTime(timestamp: number, timezone: string): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(timestamp).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
