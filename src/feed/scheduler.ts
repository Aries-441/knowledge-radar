import type { FeedConfig } from "./config.js";
import type { RuntimeStore } from "../runtime/store.js";
import { Cron } from "croner";

export function scheduleFeedPollsOnce({ store, config, now = Date.now }: {
  store: RuntimeStore;
  config: FeedConfig;
  now?: () => number;
}): number {
  // Croner performs the IANA timezone calculation without starting a timer.
  // The actual cadence is persisted per source so missed ticks are recovered.
  const clock = now();
  const calendar = new Cron("* * * * *", { timezone: config.timezone, paused: true });
  calendar.nextRun(new Date(clock));
  calendar.stop();
  store.syncSources(config.sources);
  return store.ensureFeedPollJobs(config.pollIntervalMinutes * 60_000).length;
}
