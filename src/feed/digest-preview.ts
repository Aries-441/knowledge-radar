import { createHash } from "node:crypto";
import type { FeishuSendInteractive } from "../channels/feishu/adapter.js";
import type { FeedConfig } from "./config.js";
import { buildFeedDigestCard, digestLocalTime } from "./digest.js";
import type { RuntimeStore } from "../runtime/store.js";
import type { FeishuScope } from "../runtime/types.js";

export async function previewFeedDigestOnce({ store, config, scope, send, now = Date.now }: {
  store: RuntimeStore;
  config: FeedConfig;
  scope: FeishuScope;
  send: FeishuSendInteractive;
  now?: () => number;
}): Promise<{ outcome: "empty" } | { outcome: "sent"; messageId: string; date: string; itemCount: number }> {
  const { date } = digestLocalTime(now(), config.timezone);
  const candidates = store.listFeedDigestCandidates(scope);
  const digest = buildFeedDigestCard(candidates, date, config.digest?.maxItems ?? 20,
    store.listDigestFeedbackStates(scope, candidates.map(item => item.id)));
  if (!digest) return { outcome: "empty" };
  const uuid = createHash("sha256")
    .update(`feed-digest-preview:${scope.appId}:${scope.tenantKey}:${scope.ownerOpenId}:${date}:${digest.itemIds.join(",")}`)
    .digest("hex")
    .slice(0, 40);
  const response = await send(scope.ownerOpenId, digest.card, uuid);
  store.recordDigestMessage(scope, response.messageId, digest.card, digest.itemIds);
  return { outcome: "sent", messageId: response.messageId, date, itemCount: digest.itemIds.length };
}
