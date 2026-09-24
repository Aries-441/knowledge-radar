import type { TopicAgentRuntime } from "../agent/topic-runtime.js";
import type { FeishuConfig } from "../channels/feishu/adapter.js";
import { openRuntimeStore, StorageBusyError } from "../runtime/store.js";
import { processConversationOnce } from "../runtime/turn-worker.js";
import type { FeedConfig } from "../feed/config.js";

export async function runCli(args: string[], dependencies: {
  agent: TopicAgentRuntime;
  capture: (url: string) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  openStore?: typeof openRuntimeStore;
  now?: () => number;
  serveFeishu?: (config: FeishuConfig, feedConfig?: FeedConfig) => Promise<number>;
}): Promise<number> {
  const { agent, capture, env = process.env, stdout = console.log, stderr = console.error,
    openStore = openRuntimeStore, now = Date.now } = dependencies;
  if (args[0] === "serve-feishu") {
    try {
      const { readFeishuConfig } = await import("../channels/feishu/adapter.js");
      const { loadFeedConfig } = await import("../feed/config.js");
      if (args.length !== 1 || !dependencies.serveFeishu) throw new Error("configuration");
      const config = readFeishuConfig(env);
      const feedConfig = await loadFeedConfig(env.KNOWLEDGE_RADAR_FEEDS_CONFIG);
      return await dependencies.serveFeishu(config, feedConfig);
    } catch {
      stderr(JSON.stringify({ event: "service_failed", error_code: "feishu_configuration_or_startup" }));
      return 1;
    }
  }
  if (args[0] !== "run-once") {
    if (!args[0]) { stderr("用法: knowledge-radar <公开文章 URL> | run-once <conversation-id>"); return 1; }
    try { stdout(JSON.stringify(await capture(args[0]))); return 0; }
    catch (error) { stderr(error instanceof Error ? error.message : "文章归档失败"); return 1; }
  }
  if (args.length !== 2 || !args[1].trim()) { stderr("用法: knowledge-radar run-once <conversation-id>"); return 1; }
  const path = env.KNOWLEDGE_RADAR_STATE_PATH;
  if (!path?.trim()) { stderr("必须设置 KNOWLEDGE_RADAR_STATE_PATH"); return 1; }
  let store: ReturnType<typeof openRuntimeStore> | undefined;
  try {
    store = openStore({ path, now });
    if (store.getConversation(args[1])?.kind === "feishu_private") {
      stdout(JSON.stringify({ outcome: "unsupported_conversation" }));
      return 1;
    }
    const result = await processConversationOnce(args[1], { store, agent, now });
    stdout(JSON.stringify(result));
    return result.outcome === "failed" ? 1 : 0;
  } catch (error) {
    if (error instanceof StorageBusyError) stdout(JSON.stringify({ outcome: "storage_busy" }));
    else stderr("运行失败：请检查会话 ID、状态库路径和访问权限。");
    return 1;
  } finally {
    store?.close();
  }
}
