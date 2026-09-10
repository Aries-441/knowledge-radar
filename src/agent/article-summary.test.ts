import assert from "node:assert/strict";
import test from "node:test";

import type { Article } from "../article/model.js";
import { type AgentRuntime, parseSummary, SummaryError } from "./article-summary.js";
import { summarizeWithPi } from "./article-summary.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createCheckpoint, validateCaptureSummary } from "../article/durable-archive.js";

const article: Article = {
  title: "An article",
  body: "Article body",
  sourceUrl: "https://example.com/article",
};

test("capture Pi forwards AbortSignal, disables tools/retries and keeps legacy summary compatible", async () => {
  const controller = new AbortController();
  const response = await summarizeWithPi(article, { capture: true, signal: controller.signal, timeoutMs: 50_000,
    complete: async (_model, context, options) => {
      assert.deepEqual(context.tools, []);
      assert.equal(options?.toolChoice, "none");
      assert.equal(options?.maxRetries, 0);
      assert.equal(options?.signal, controller.signal);
      assert.equal(options?.timeoutMs, 50_000);
      return fauxAssistantMessage(JSON.stringify({ summary: "summary", keyPoints: ["point"] }));
    } });
  assert.equal(response.summary, "summary");
  const legacy = parseSummary(JSON.stringify({ summary: "x".repeat(1_200), keyPoints: Array(8).fill("y".repeat(300)) }));
  assert.equal(legacy.keyPoints.length, 8);
  assert.throws(() => validateCaptureSummary(legacy), { code: "capture_summary_failed" });
  const limits = { summary: "x".repeat(800), keyPoints: Array(5).fill("y".repeat(200)) };
  const cp = createCheckpoint("job", article.sourceUrl, { ...article, title: "z".repeat(1_000) }, limits, new Date(0), new Date(0));
  assert.ok(cp.replyText.length <= 2_800);
  assert.ok(Buffer.byteLength(JSON.stringify({ text: cp.replyText })) <= 20_000);
  assert.match(cp.replyText, /…/);
  for (const invalid of [{ ...limits, summary: "x".repeat(801) }, { ...limits, keyPoints: ["x".repeat(201)] }, { ...limits, keyPoints: Array(6).fill("x") }, { summary: "", keyPoints: [] }]) {
    assert.throws(() => validateCaptureSummary(invalid), { code: "capture_summary_failed" });
  }
  for (const response of [fauxAssistantMessage("bad"), fauxAssistantMessage("", { stopReason: "error", errorMessage: "secret" }),
    fauxAssistantMessage([fauxToolCall("shell", {})], { stopReason: "toolUse" })]) {
    await assert.rejects(summarizeWithPi(article, { capture: true, complete: async () => response }), { message: "capture_summary_failed" });
  }
  await assert.rejects(summarizeWithPi(article, { capture: true, complete: async () => { throw Error("No API key for provider: example"); } }), { code: "capture_configuration", permanent: true });
});

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
