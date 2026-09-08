import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentRuntime, Summary } from "./agent-runtime.js";
import type { Article, ArticleLoader } from "./article.js";

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
  const article = await options.renderArticle(url);
  const summary = await options.summarize(article);
  const archivePath = await archiveSummary(article, summary, options.archiveDir, options.now?.() ?? new Date());

  return {
    title: article.title,
    sourceUrl: article.sourceUrl,
    archivePath,
  };
}

async function archiveSummary(article: Article, summary: Summary, archiveDir: string, capturedAt: Date): Promise<string> {
  await mkdir(archiveDir, { recursive: true });

  const filename = createArchiveFilename(article, capturedAt);
  const finalPath = join(archiveDir, filename);
  const temporaryPath = join(archiveDir, `.${filename}.${randomUUID()}.tmp`);

  try {
    await writeFile(temporaryPath, renderMarkdown(article, summary, capturedAt), { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, finalPath);
    return filename;
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function createArchiveFilename(article: Article, capturedAt: Date): string {
  const date = capturedAt.toISOString().slice(0, 10);
  const slug = article.title
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const sourceHash = createHash("sha256").update(article.sourceUrl).digest("hex").slice(0, 8);

  return `${date}-${slug || "article"}-${sourceHash}-${randomUUID().slice(0, 8)}.md`;
}

function renderMarkdown(article: Article, summary: Summary, capturedAt: Date): string {
  const points = summary.keyPoints.map((point) => `- ${point}`).join("\n");
  return `# ${article.title}

- 来源：${article.sourceUrl}
- 采集时间：${capturedAt.toISOString()}

## 摘要

${summary.summary}

## 要点

${points}
`;
}
