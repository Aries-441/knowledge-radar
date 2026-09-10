import assert from "node:assert/strict";
import test from "node:test";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxThinking,
  createAssistantMessageEventStream, type Context, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createPiTopicRuntime, replyWithPi, TopicAgentError, validateTopicReply } from "./topic-runtime.js";

const request = { title: "技术话题", history: [{ content: "问题一", text: "回答一" }], content: "问题二" };

test("captureContext is labeled untrusted, bounded summary data and never grants tools", async () => {
  const faux = fauxProvider();
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("answer")]);
  const runtime = createPiTopicRuntime(faux.getModel(), (model, context, options) => {
    assert.deepEqual(context.tools, []);
    assert.match(context.systemPrompt ?? "", /不可信数据/);
    assert.match(context.systemPrompt ?? "", /不声称读取全文/);
    assert.match(context.systemPrompt ?? "", /job-A/);
    assert.match(context.systemPrompt ?? "", /job-B/);
    assert.equal(options?.toolChoice, "none");
    return models.streamSimple(model, context, options);
  });
  await runtime({ ...request, captureContext: { results: [{ jobId: "job-A", originSequence: 1, title: "A", summary: "A summary", keyPoints: ["point"], filename: "a.md" }],
    statuses: [{ jobId: "job-B", originSequence: 2, state: "running" }] } });
});

test("Pi rebuilds roles, bounds provider options and uses a fresh Agent on each call", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const calls: { context: Context; options?: SimpleStreamOptions }[] = [];
  faux.setResponses([fauxAssistantMessage(" 回答二 "), fauxAssistantMessage("回答三")]);
  const runtime = createPiTopicRuntime(faux.getModel(), (model, context, options) => {
    calls.push({ context, options });
    return models.streamSimple(model, context, options);
  });
  assert.deepEqual(await runtime(request), { text: "回答二" });
  assert.deepEqual(await runtime(request), { text: "回答三" });
  assert.equal(calls.length, 2);
  for (const { context, options } of calls) {
    assert.deepEqual(context.tools, []);
    assert.deepEqual(context.messages.map(({ role }) => role), ["user", "assistant", "user"]);
    assert.equal(context.messages[0].content, "问题一");
    assert.deepEqual(context.messages[1].content, [{ type: "text", text: "回答一" }]);
    assert.equal(context.messages[2].content, "问题二");
    assert.equal(options?.toolChoice, "none");
    assert.equal(options?.timeoutMs, 60_000);
    assert.equal(options?.maxRetries, 0);
  }
});

for (const [name, response, code] of [
  ["tool call", fauxAssistantMessage([fauxToolCall("shell", { command: "secret" })], { stopReason: "toolUse" }), "agent_invalid_response"],
  ["truncation", fauxAssistantMessage("partial", { stopReason: "length" }), "agent_invalid_response"],
  ["provider error", fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "secret" }), "agent_provider_failure"],
  ["abort", fauxAssistantMessage("partial", { stopReason: "aborted" }), "agent_provider_failure"],
  ["thinking", fauxAssistantMessage([fauxThinking("private"), { type: "text", text: "answer" }]), "agent_invalid_response"],
  ["blank", fauxAssistantMessage("  "), "agent_invalid_response"],
  ["too long", fauxAssistantMessage("a".repeat(6_001)), "agent_invalid_response"],
] as const) {
  test(`Pi rejects ${name} without exposing provider content or making a second call`, async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([response, fauxAssistantMessage("must not run")]);
    const runtime = createPiTopicRuntime(faux.getModel(), models.streamSimple.bind(models));
    await assert.rejects(runtime(request), { name: "TopicAgentError", message: code });
    assert.equal(faux.state.callCount, 1);
  });
}

test("Pi enforces an overall deadline and aborts a stalled stream", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const faux = fauxProvider();
  let signal: AbortSignal | undefined;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const runtime = createPiTopicRuntime(faux.getModel(), (_model, _context, options) => {
    signal = options?.signal;
    const stream = createAssistantMessageEventStream();
    signal?.addEventListener("abort", () => {
      const error = fauxAssistantMessage("", { stopReason: "aborted" });
      stream.push({ type: "error", reason: "aborted", error });
    }, { once: true });
    started();
    return stream;
  });
  const pending = assert.rejects(runtime(request), { message: "agent_timeout" });
  await ready;
  t.mock.timers.tick(60_000);
  await pending;
  assert.equal(signal?.aborted, true);
});

test("runtime sanitizes thrown failures and invalid model references", async (t) => {
  const faux = fauxProvider();
  const runtime = createPiTopicRuntime(faux.getModel(), () => { throw new Error("secret"); });
  await assert.rejects(runtime(request), { message: "agent_provider_failure" });
  const previous = process.env.KNOWLEDGE_RADAR_MODEL;
  t.after(() => { if (previous === undefined) delete process.env.KNOWLEDGE_RADAR_MODEL; else process.env.KNOWLEDGE_RADAR_MODEL = previous; });
  process.env.KNOWLEDGE_RADAR_MODEL = "invalid";
  await assert.rejects(replyWithPi(request), { message: "agent_configuration" });
});

test("reply validation rejects malformed runtime values and accepts the exact length boundary", () => {
  for (const value of [null, {}, { text: 2 }, { text: " " }, { text: "x".repeat(6_001) }]) {
    assert.throws(() => validateTopicReply(value), TopicAgentError);
  }
  assert.equal(validateTopicReply({ text: "x".repeat(6_000) }).text.length, 6_000);
});
