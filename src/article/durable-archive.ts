import { randomUUID } from "node:crypto";
import { link, lstat, readFile, unlink, open } from "node:fs/promises";
import { join } from "node:path";
import type { Article } from "./model.js";
import type { Summary } from "../agent/article-summary.js";
import { createArchiveFilename, renderMarkdown, shortTaskId } from "./capture.js";
import { CaptureError } from "./capture-error.js";
import { isPublicUrl } from "./request.js";

export type CaptureCheckpoint = Summary & {
  version: 2; requestedUrl: string; sourceUrl: string; title: string;
  taskId: string; taskCreatedAt: string; capturedAt: string; filename: string; markdown: string; replyText: string;
};
export const displayTitle = (title: string) => title.length <= 160 ? title : title.slice(0, 159) + "…";

export function createCheckpoint(jobId: string, requestedUrl: string, article: Article, summary: Summary, now: Date, taskCreatedAt: Date): CaptureCheckpoint {
  validateCaptureSummary(summary);
  if (!jobId.trim() || !Number.isFinite(now.getTime()) || !Number.isFinite(taskCreatedAt.getTime())) throw new CaptureError("capture_summary_failed");
  if (!article.title?.trim() || !isPublicUrl(requestedUrl) || !isPublicUrl(article.sourceUrl)) throw new CaptureError("capture_summary_failed");
  const filename = createArchiveFilename(jobId, article.title);
  const replyText = `${displayTitle(article.title)}\n\n摘要：${summary.summary}\n\n要点：\n${summary.keyPoints.map(p => `- ${p}`).join("\n")}\n\n归档：${filename}\n任务：${shortTaskId(jobId)}`;
  if (replyText.length > 2_800 || Buffer.byteLength(JSON.stringify({ text: replyText })) > 20_000) throw new CaptureError("capture_summary_failed");
  return { version: 2, requestedUrl, sourceUrl: article.sourceUrl, title: article.title, summary: summary.summary, keyPoints: [...summary.keyPoints],
    taskId: jobId, taskCreatedAt: taskCreatedAt.toISOString(), capturedAt: now.toISOString(), filename,
    markdown: renderMarkdown(article, summary, now, { id: jobId, createdAt: taskCreatedAt }), replyText };
}

export function validateCaptureSummary(value: unknown): asserts value is Summary {
  const data = value as Summary | null;
  if (!data || typeof data.summary !== "string" || !data.summary.trim() || data.summary.length > 800
    || !Array.isArray(data.keyPoints) || data.keyPoints.length < 1 || data.keyPoints.length > 5
    || data.keyPoints.some(p => typeof p !== "string" || !p.trim() || p.length > 200)) throw new CaptureError("capture_summary_failed");
}

export function validateCheckpoint(jobId: string, value: unknown): CaptureCheckpoint {
  const data = value as CaptureCheckpoint | null;
  if (!data || data.version !== 2 || data.taskId !== jobId || [data.requestedUrl, data.sourceUrl, data.title, data.taskCreatedAt, data.capturedAt, data.markdown, data.replyText]
    .some(v => typeof v !== "string" || !v.trim()) || data.filename !== createArchiveFilename(jobId, data.title)) throw new CaptureError("capture_summary_failed");
  const rebuilt = createCheckpoint(jobId, data.requestedUrl, { title: data.title, sourceUrl: data.sourceUrl, body: "" }, data, new Date(data.capturedAt), new Date(data.taskCreatedAt));
  if (rebuilt.markdown !== data.markdown || rebuilt.replyText !== data.replyText) throw new CaptureError("capture_summary_failed");
  return rebuilt;
}

function errorCode(error: unknown): string { return (error as NodeJS.ErrnoException)?.code ?? ""; }
const archiveIo = { link, lstat, readFile, unlink, open };

async function matches(path: string, bytes: Buffer, io = archiveIo): Promise<boolean> {
  try {
    const stat = await io.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !(await io.readFile(path)).equals(bytes)) throw new CaptureError("archive_conflict", true);
    return true;
  } catch (error) { if (errorCode(error) === "ENOENT") return false; throw error; }
}

export async function publishCheckpoint(directory: string, checkpoint: CaptureCheckpoint, assertExecution: () => void, io = archiveIo): Promise<void> {
  if (checkpoint.filename !== createArchiveFilename(checkpoint.taskId, checkpoint.title)) throw new CaptureError("archive_conflict", true);
  const final = join(directory, checkpoint.filename);
  const temporary = join(directory, `.${checkpoint.filename}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(checkpoint.markdown, "utf8");
  let ownTemporary = false;
  try {
    assertExecution();
    if (await matches(final, bytes, io)) return;
    assertExecution();
    const handle = await io.open(temporary, "wx");
    ownTemporary = true;
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    assertExecution();
    try { await io.link(temporary, final); }
    catch (error) { if (errorCode(error) !== "EEXIST" || !await matches(final, bytes, io)) throw error; }
  } catch (error) {
    if (error instanceof CaptureError || !errorCode(error)) throw error;
    throw new CaptureError("archive_write_failed", ["EACCES", "EPERM", "ENOSPC", "EROFS"].includes(errorCode(error)));
  } finally {
    if (ownTemporary) {
      try { await io.unlink(temporary); }
      catch (error) { throw new CaptureError("archive_write_failed", ["EACCES", "EPERM", "ENOSPC", "EROFS"].includes(errorCode(error))); }
    }
  }
}

export async function probeArchive(directory: string | undefined, io = archiveIo): Promise<boolean> {
  if (!directory?.trim()) return false;
  const source = join(directory, `.radar-probe-${randomUUID()}.tmp`);
  const target = source + ".link";
  let ownSource = false, ownTarget = false, supported = false;
  try {
    const handle = await io.open(source, "wx");
    ownSource = true;
    try { await handle.writeFile("probe"); } finally { await handle.close(); }
    await io.link(source, target);
    ownTarget = true;
    try { await io.link(source, target); }
    catch (error) { supported = errorCode(error) === "EEXIST" && await matches(target, Buffer.from("probe"), io); }
  } catch { supported = false; }
  finally {
    for (const path of [...(ownTarget ? [target] : []), ...(ownSource ? [source] : [])]) {
      try { await io.unlink(path); } catch { supported = false; }
    }
  }
  return supported;
}
