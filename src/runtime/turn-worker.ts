import { TopicAgentError, validateTopicReply, type TopicAgentRuntime } from "../agent/topic-runtime.js";
import { RuntimeStore, RuntimeStoreError } from "./store.js";
import type { FeishuScope } from "./types.js";

export type TurnOutcome = "idle" | "answered" | "retry_scheduled" | "failed" | "lost_lease";

export async function processConversationOnce(
  conversationId: string,
  { store, agent, now = Date.now, feishu }: { store: RuntimeStore; agent: TopicAgentRuntime; now?: () => number;
    feishu?: { scope: FeishuScope; captureAvailable: boolean } },
): Promise<{ outcome: TurnOutcome }> {
  const conversation = store.getConversation(conversationId);
  if (!conversation) throw new RuntimeStoreError("conversation_not_found");
  store.recoverExpiredTurns(conversationId);
  const turn = store.claimTurn(conversationId, 120_000);
  if (!turn) return { outcome: "idle" };
  const token = turn.runToken!;
  if (feishu && turn.source === "feishu_url_capture") {
    const accepted = store.acceptCaptureTurn(turn.id, token, feishu.scope, feishu.captureAvailable);
    return { outcome: accepted ? "answered" : "lost_lease" };
  }
  if (turn.content.length > 4_000) {
    return { outcome: store.failTurn(turn.id, token, "turn_too_large") ? "failed" : "lost_lease" };
  }
  const context = feishu ? store.getFeishuContext(conversationId, turn.sequence, feishu.scope)
    : { history: store.getCompletedHistory(conversationId, turn.sequence) };
  let reply: { text: string };
  try {
    reply = validateTopicReply(await agent({ title: conversation.title, ...context, content: turn.content }));
  } catch (error) {
    const code = error instanceof TopicAgentError ? error.code : "agent_provider_failure";
    if (!store.retryTurn(turn.id, token, now() + 30_000, code)) return { outcome: "lost_lease" };
    return { outcome: turn.attempts >= turn.maxAttempts ? "failed" : "retry_scheduled" };
  }
  // Keep database errors outside the Agent catch: failed commits are not Agent failures.
  const outbox = store.completeTurnWithOutbox(turn.id, token, {
    kind: "final_message", payload: reply, maxAttempts: 3,
  });
  return { outcome: outbox ? "answered" : "lost_lease" };
}
