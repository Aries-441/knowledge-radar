import type { Article } from "../article/model.js";
import type { Summary } from "../agent/article-summary.js";
import { summarizeWithPi } from "../agent/article-summary.js";
import { renderPublicArticle } from "../article/render.js";
import { createCheckpoint, publishCheckpoint } from "../article/durable-archive.js";
import { CaptureError, CaptureCleanupError } from "../article/capture-error.js";
import { isPublicUrl } from "../article/request.js";
import { RuntimeStore, RuntimeStoreError, StorageBusyError } from "./store.js";
import type { FeishuScope } from "./types.js";
import type { SafeLog } from "../channels/feishu/adapter.js";

type PhaseOptions = { signal: AbortSignal; timeoutMs: number };
export type CaptureDependencies = {
  render?: (url: string, options: PhaseOptions) => Promise<Article>;
  summarize?: (article: Article, options: PhaseOptions) => Promise<Summary>;
  publish?: typeof publishCheckpoint;
  // Short budgets allow cancellation tests without waiting real production deadlines.
  budgets?: { page: number; model: number; persist: number; cleanup: number };
};

class LostCaptureLease extends Error {}

export async function processCaptureJobOnce({ store, scope, archiveDir, now = Date.now, log = () => {}, dependencies = {} }: {
  store: RuntimeStore; scope: FeishuScope; archiveDir?: string; now?: () => number; log?: SafeLog;
  dependencies?: CaptureDependencies;
}): Promise<{ outcome: "idle" | "succeeded" | "failed" | "retry_scheduled" | "lost_lease"; jobId?: string }> {
  for (const job of store.recoverCaptureJobs(scope)) log({ event: "job_recovered", job_id: job.id, outcome: job.state });
  if (!archiveDir) return { outcome: "idle" };
  const job = store.claimCaptureJob(scope);
  if (!job) return { outcome: "idle" };
  const token = job.runToken!;
  const budget = dependencies.budgets ?? { page: 20_000, model: 50_000, persist: 5_000, cleanup: 5_000 };
  const deadline = now() + budget.page + budget.model + budget.persist;
  const cleanupDeadline = deadline + budget.cleanup;

  const assertExecution = () => {
    if (now() >= deadline) throw new CaptureError("capture_timeout");
    if (!store.readCaptureCheckpoint(job.id, token, scope)) throw new LostCaptureLease();
  };
  const phase = async <T>(limit: number, operation: (options: PhaseOptions) => Promise<T>): Promise<T> => {
    const timeoutMs = Math.min(limit, deadline - now());
    if (timeoutMs <= 0) throw new CaptureError("capture_timeout");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve().then(() => operation({ signal: controller.signal, timeoutMs }));
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new CaptureError("capture_timeout")); }, timeoutMs);
      })]);
    } finally {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([work.then(() => {}, () => {}), new Promise<never>((_, reject) => {
            cleanupTimer = setTimeout(() => reject(new CaptureCleanupError()), Math.max(0, Math.min(budget.cleanup, cleanupDeadline - now())));
          })]);
        } finally { clearTimeout(cleanupTimer); }
      }
    }
  };

  let failure: CaptureError | undefined;
  let lost = false;
  try {
    const stored = store.readCaptureCheckpoint(job.id, token, scope);
    if (!stored) throw new LostCaptureLease();
    let checkpoint = stored.checkpoint;
    if (!checkpoint) {
      const payload = job.payload as { version?: unknown; url?: unknown };
      if (payload?.version !== 1 || typeof payload.url !== "string" || !isPublicUrl(payload.url)) throw new CaptureError("capture_invalid_url", true);
      const article = await phase(budget.page, options => (dependencies.render ?? ((url, opts) => renderPublicArticle(url, { ...opts, publicOnly: true })))(payload.url as string, options));
      const summary = await phase(budget.model, options => (dependencies.summarize ?? ((input, opts) => summarizeWithPi(input, { ...opts, capture: true })))(article, options));
      checkpoint = createCheckpoint(job.id, payload.url, article, summary, new Date(now()), new Date(job.createdAt));
    }
    await phase(budget.persist, async ({ signal, timeoutMs }) => {
      const persistDeadline = now() + timeoutMs;
      assertExecution();
      const committed = store.saveCaptureCheckpoint(job.id, token, scope, checkpoint);
      if (!committed) throw new LostCaptureLease();
      const fence = () => { if (signal.aborted || now() >= persistDeadline) throw new CaptureError("capture_timeout"); assertExecution(); };
      await (dependencies.publish ?? publishCheckpoint)(archiveDir, committed, fence);
      fence();
      // Keep this storage transaction outside the provider-specific error mapping.
      if (!store.completeCaptureJob(job.id, token, scope)) throw new LostCaptureLease();
    });
  } catch (error) {
    if (error instanceof CaptureCleanupError || error instanceof StorageBusyError || error instanceof RuntimeStoreError) throw error;
    if (error instanceof LostCaptureLease) lost = true;
    else if (error instanceof CaptureError) failure = error;
    else throw error; // Unexpected/storage failures stop the service, never become provider retries.
  }
  const outcome = lost ? "lost_lease" : failure
    ? store.retryCaptureJob(job.id, token, scope, failure.code, failure.permanent, failure.retryAfterMs) : "succeeded";
  log({ event: "job", job_id: job.id, turn_id: job.originTurnId ?? undefined, outcome, error_code: failure?.code });
  return { outcome, jobId: job.id };
}
