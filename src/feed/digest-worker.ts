import { createHash } from "node:crypto";
import type { FeedConfig } from "./config.js";
import type { FeishuScope } from "../runtime/types.js";
import type { RuntimeStore } from "../runtime/store.js";
import { FeishuError } from "../channels/feishu/adapter.js";

export type DigestSend = (receiveId: string, text: string, uuid: string) => Promise<{ messageId: string }>;
export type DigestWorkerLog = (record: { event: string; [key: string]: string | number | undefined }) => void;

export async function processFeedDigestOnce({ store, config, scope, send, now = Date.now, log = () => {} }: {
  store: RuntimeStore; config: FeedConfig; scope: FeishuScope; send: DigestSend; now?: () => number; log?: DigestWorkerLog;
}): Promise<{ outcome: "idle" | "succeeded" | "retry_scheduled" | "failed" | "lost_lease"; jobId?: string }> {
  store.recoverFeedDigestJobs(scope);
  const job = store.claimJob(120_000, "feed_digest", scope);
  if (!job) return { outcome: "idle" };
  const token = job.runToken!;
  const payload = job.payload;
  const valid = payload && typeof payload === "object" && "scope" in payload && "text" in payload
    && "itemIds" in payload && Array.isArray(payload.itemIds) && typeof payload.text === "string"
    && typeof payload.scope === "object" && payload.scope !== null;
  if (!valid) {
    const changed = store.failJob(job.id, token, "feed_digest_payload_invalid");
    return { outcome: changed ? "failed" : "lost_lease", jobId: job.id };
  }
  const digest = payload as { scope: FeishuScope; text: string };
  try {
    const uuid = createHash("sha256").update(`feed-digest:${job.id}`).digest("hex").slice(0, 40);
    const response = await send(digest.scope.ownerOpenId, digest.text, uuid);
    const committed = store.commitFeedDigest(job.id, token, scope, response.messageId);
    const outcome = committed ? "succeeded" : "lost_lease";
    log({ event: "feed_digest", phase: "commit", outcome, job_id: job.id });
    return { outcome, jobId: job.id };
  } catch (error) {
    const failure = error instanceof FeishuError ? error : new FeishuError("feishu_unavailable");
    const retryable = !failure.permanent;
    const retryAt = now() + Math.max(30_000, failure.retryAfterMs || 30_000 * 2 ** Math.max(0, job.attempts - 1));
    const changed = retryable && job.attempts < job.maxAttempts
      ? store.retryJob(job.id, token, retryAt, failure.code)
      : store.failJob(job.id, token, failure.code);
    const outcome = !changed ? "lost_lease" : retryable && job.attempts < job.maxAttempts ? "retry_scheduled" : "failed";
    log({ event: "feed_digest", phase: "send", outcome, job_id: job.id, error_code: failure.code });
    return { outcome, jobId: job.id };
  }
}
