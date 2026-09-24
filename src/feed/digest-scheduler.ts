import type { FeedConfig } from "./config.js";
import { digestLocalTime } from "./digest.js";
import type { FeishuScope } from "../runtime/types.js";
import type { RuntimeStore } from "../runtime/store.js";

export function scheduleFeedDigestOnce({ store, config, scope, now = Date.now }: {
  store: RuntimeStore; config: FeedConfig; scope: FeishuScope; now?: () => number;
}): boolean {
  const digest = config.digest;
  if (!digest?.enabled || !config.feeds.some(feed => feed.enabled)) return false;
  const local = digestLocalTime(now(), config.timezone);
  if (local.time < digest.time) return false;
  return Boolean(store.ensureFeedDigestJob(scope, local.date, digest.maxItems));
}
