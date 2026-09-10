import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentRuntime, Summary } from "../agent/article-summary.js";
import type { Article, ArticleLoader } from "./model.js";

export type CaptureResult = {
  title: string;
  sourceUrl: string;
  archivePath: string;
};

type CaptureOptions = {
  archiveDir: string;
  renderArticle: ArticleLoader;
  summarize: AgentRuntime;
  now?: () => Date;
};

export async function captureArticle(url: string, options: CaptureOptions): Promise<CaptureResult> {
  const task = { id: randomUUID(), createdAt: options.now?.() ?? new Date() };
  const article = await options.renderArticle(url);
  const summary = await options.summarize(article);
  const archivePath = await archiveSummary(article, summary, options.archiveDir, options.now?.() ?? new Date(), task);

  return {
    title: article.title,
    sourceUrl: article.sourceUrl,
    archivePath,
  };
}

async function archiveSummary(article: Article, summary: Summary, archiveDir: string, capturedAt: Date, task: ArchiveTask): Promise<string> {
  await mkdir(archiveDir, { recursive: true });

  const filename = createArchiveFilename(task.id, article.title);
  const finalPath = join(archiveDir, filename);
  const temporaryPath = join(archiveDir, `.${filename}.${randomUUID()}.tmp`);

  try {
    await writeFile(temporaryPath, renderMarkdown(article, summary, capturedAt, task), { encoding: "utf8", flag: "wx" });
    await link(temporaryPath, finalPath);
    await rm(temporaryPath);
    return filename;
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

type ArchiveTask = { id: string; createdAt: Date };
export const shortTaskId = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 8);

export function createArchiveFilename(taskId: string, title: string): string {
  let clean = title.normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-").replace(/\s+/gu, " ").trim();
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(clean)) clean = "_" + clean;
  let stem = "";
  // Leave room for the suffix and exclusive temporary filename on Windows/Linux.
  for (const character of clean) {
    if (Buffer.byteLength(stem + character, "utf8") > 160) break;
    stem += character;
  }
  stem = stem.replace(/[ .]+$/g, "");
  return `${stem || "article"}--${shortTaskId(taskId)}.md`;
}

export function renderMarkdown(article: Pick<Article, "title" | "sourceUrl">, summary: Summary, capturedAt: Date, task: ArchiveTask): string {
  const points = summary.keyPoints.map((point) => `- ${point}`).join("\n");
  return `# ${article.title}

- 来源：${article.sourceUrl}
- 任务创建时间：${task.createdAt.toISOString()}
- 摘要生成时间：${capturedAt.toISOString()}
- 任务 ID：${task.id}

## 摘要

${summary.summary}

## 要点

${points}
`;
}
