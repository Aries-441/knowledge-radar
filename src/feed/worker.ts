import type { FeedConfig } from "./config.js";
import { FeedFetchError, type FeedFetchOptions } from "./parser.js";
import { getSourceConnector, SourceConnectorError } from "./source.js";
import type { RuntimeStore } from "../runtime/store.js";

export type FeedWorkerLog = (record: { event: string; [key: string]: string | number | undefined }) => void;

export async function processFeedPollOnce({ store, config, now = Date.now, log = () => {}, signal, fetchOptions = {} }: {
  store: RuntimeStore;
  config: FeedConfig;
  now?: () => number;
  log?: FeedWorkerLog;
  signal?: AbortSignal;
  fetchOptions?: Omit<FeedFetchOptions, "signal">;
}): Promise<{ outcome: "idle" | "succeeded" | "retry_scheduled" | "failed" | "lost_lease"; jobId?: string }> {
  store.recoverFeedPollJobs();
  const job = store.claimJob(120_000, "feed_poll");
  if (!job) return { outcome: "idle" };
  const token = job.runToken!;
  const payload = job.payload;
  const feedId = payload && typeof payload === "object" && "sourceId" in payload && typeof payload.sourceId === "string"
    ? payload.sourceId
    : payload && typeof payload === "object" && "feedId" in payload && typeof payload.feedId === "string" ? payload.feedId : undefined;
  if (!feedId) {
    const changed = store.recordFeedPollFailure(job.id, token, "feed_payload_invalid", false, now());
    return { outcome: changed ? "failed" : "lost_lease", jobId: job.id };
  }
  const source = store.getSource(feedId);
  if (!source) {
    const changed = store.recordFeedPollFailure(job.id, token, "feed_source_missing", false, now());
    log({ event: "feed_poll", feed_id: feedId, phase: "lookup", outcome: changed ? "failed" : "lost_lease", error_code: "feed_source_missing" });
    return { outcome: changed ? "failed" : "lost_lease", jobId: job.id };
  }
  log({ event: "feed_poll", feed_id: feedId, phase: "fetch", outcome: "started" });
  try {
    const connector = getSourceConnector(source.kind);
    const parsed = await connector.fetch(source, { fetchOptions, signal });
    const configured = config.sources.find(feed => feed.id === feedId);
    const limited = configured && parsed.items.length > configured.itemLimit
      ? { ...parsed, items: parsed.items.slice(0, configured.itemLimit) }
      : parsed;
    const result = store.commitFeedPoll(job.id, token, limited);
    const outcome = result ? "succeeded" : "lost_lease";
    log({ event: "feed_poll", feed_id: feedId, phase: "commit", outcome, item_count: result?.totalItems, new_item_count: result?.newItems });
    return { outcome, jobId: job.id };
  } catch (error) {
    if (signal?.aborted) throw error;
    const failure = error instanceof FeedFetchError || error instanceof SourceConnectorError
      ? error
      : new FeedFetchError("feed_unavailable", true);
    const retryAt = now() + (failure.retryable ? Math.max(30_000, Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, job.attempts - 1))) : 0);
    const changed = store.recordFeedPollFailure(job.id, token, failure.code, failure.retryable, retryAt);
    const outcome = !changed ? "lost_lease" : failure.retryable && job.attempts < job.maxAttempts ? "retry_scheduled" : "failed";
    log({ event: "feed_poll", feed_id: feedId, phase: "fetch", outcome, error_code: failure.code, attempt: job.attempts, retry_at: failure.retryable ? retryAt : undefined });
    return { outcome, jobId: job.id };
  }
}
