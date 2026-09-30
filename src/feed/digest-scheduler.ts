import type { FeedConfig } from "./config.js";
import { getDigestSchedules } from "./config.js";
import { getDigestPeriod, isDigestScheduleDue } from "./digest-period.js";
import type { FeishuScope } from "../runtime/types.js";
import type { RuntimeStore } from "../runtime/store.js";

/** Creates the current due job for each independent digest schedule. */
export function scheduleFeedDigestOnce({ store, config, scope, now = Date.now }: {
  store: RuntimeStore; config: FeedConfig; scope: FeishuScope; now?: () => number;
}): boolean {
  if (!config.digest?.enabled || !config.sources.some(source => source.enabled)) return false;
  const timestamp = now();
  let created = false;
  for (const schedule of getDigestSchedules(config)) {
    if (!isDigestScheduleDue(schedule, timestamp, config.timezone)) continue;
    const period = getDigestPeriod(schedule, timestamp, config.timezone);
    created = Boolean(store.ensureScheduledFeedDigestJob(scope, schedule, period)) || created;
  }
  return created;
}
