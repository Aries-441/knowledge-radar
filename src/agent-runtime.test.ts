import assert from "node:assert/strict";
import test from "node:test";

import type { Article } from "./article.js";
import { type AgentRuntime, parseSummary, SummaryError } from "./agent-runtime.js";

const article: Article = {
  title: "An article",
  body: "Article body",
  sourceUrl: "https://example.com/article",
};

test("parses the required summary structure", () => {
  const summary = parseSummary('{"summary":"A concise summary.","keyPoints":["First point","Second point"]}');
  assert.deepEqual(summary, {
    summary: "A concise summary.",
    keyPoints: ["First point", "Second point"],
  });
});

test("accepts JSON returned in a fenced code block", () => {
  const summary = parseSummary('```json\n{"summary":"A concise summary.","keyPoints":["First point"]}\n```');
  assert.equal(summary.keyPoints[0], "First point");
});

test("rejects missing or empty required fields", () => {
  assert.throws(() => parseSummary('{"summary":"","keyPoints":[]}'), SummaryError);
  assert.throws(() => parseSummary('{"summary":"Valid", "keyPoints":"not an array"}'), SummaryError);
  assert.throws(() => parseSummary("not json"), SummaryError);
});

test("a Fake AgentRuntime can summarize without a model request", async () => {
  const fakeRuntime: AgentRuntime = async () => ({
    summary: "Fake summary",
    keyPoints: ["Fake point"],
  });

  assert.deepEqual(await fakeRuntime(article), {
    summary: "Fake summary",
    keyPoints: ["Fake point"],
  });
});
