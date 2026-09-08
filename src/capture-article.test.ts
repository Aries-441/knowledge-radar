import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentRuntime } from "./agent-runtime.js";
import type { ArticleLoader } from "./article.js";
import { captureArticle } from "./capture-article.js";

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
