import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentRuntime } from "../agent/article-summary.js";
import type { ArticleLoader } from "./model.js";
import { captureArticle } from "./capture.js";

const renderArticle: ArticleLoader = async () => ({
  title: "Test article",
  body: "This body must never appear in the archive.",
  sourceUrl: "https://example.com/article",
});

const summarize: AgentRuntime = async () => ({
  summary: "A test summary.",
  keyPoints: ["First point", "Second point"],
});

test("captures an article and archives only its summary", async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), "knowledge-radar-"));

  try {
    const result = await captureArticle("https://example.com/article", {
      archiveDir,
      renderArticle,
      summarize,
      now: () => new Date("2026-09-08T12:00:00.000Z"),
    });
    const markdown = await readFile(join(archiveDir, result.archivePath), "utf8");

    assert.equal(result.title, "Test article");
    assert.equal(result.sourceUrl, "https://example.com/article");
    assert.match(markdown, /# Test article/);
    assert.match(result.archivePath, /^Test article--[a-f0-9]{8}\.md$/);
    assert.match(markdown, /任务创建时间：2026-09-08T12:00:00.000Z/);
    assert.match(markdown, /摘要生成时间：2026-09-08T12:00:00.000Z/);
    assert.match(markdown, /任务 ID：[a-f0-9-]{36}/);
    assert.match(markdown, /A test summary/);
    assert.match(markdown, /First point/);
    assert.doesNotMatch(markdown, /This body must never appear/);
  } finally {
    await rm(archiveDir, { recursive: true, force: true });
  }
});

test("does not create a Markdown file when summary generation fails", async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), "knowledge-radar-"));
  const failingRuntime: AgentRuntime = async () => {
    throw new Error("model unavailable");
  };

  try {
    await assert.rejects(
      () => captureArticle("https://example.com/article", { archiveDir, renderArticle, summarize: failingRuntime }),
      /model unavailable/,
    );
    assert.deepEqual(await readdir(archiveDir), []);
  } finally {
    await rm(archiveDir, { recursive: true, force: true });
  }
});

test("cleans temporary data after an archive write failure", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "knowledge-radar-"));
  const archivePath = join(rootDir, "not-a-directory");
  await writeFile(archivePath, "file blocks archive directory");

  try {
    await assert.rejects(
      () => captureArticle("https://example.com/article", { archiveDir: archivePath, renderArticle, summarize }),
      /EEXIST|ENOTDIR/,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
