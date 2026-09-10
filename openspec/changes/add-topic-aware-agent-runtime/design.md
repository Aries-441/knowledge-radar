## Context

`add-durable-runtime-store` 已提供应用拥有的 `radar.db`、Conversation FIFO Turn 领取、租约令牌、延迟重试和“完成 Turn + 创建最终 Outbox”的原子提交。它刻意没有 Agent、历史读取 API 或 CLI Worker。Pi Harness 的 SQLite backend 不能参与这笔业务事务，因此本 Change 继续采用 Direct Agent；详见 [proposal.md](proposal.md) 与 [会话运行时与可恢复状态机](../../../docs/conversation-runtime.md)。

当前已有 `src/agent/article-summary.ts`，但它只把一篇 Article 发送给 `pi-ai` 的一次性摘要接口，不能处理 Conversation Turn，也不能作为可恢复的对话运行时。

## Goals / Non-Goals

**Goals:**

- 以已提交的 Turn 和最终 Outbox 作为唯一上下文来源，在重启后得到相同的候选历史。
- 使用每次调用新建的无工具 Direct Agent 生成单一文本回复。
- 把一次领取、Agent 调用后的成功、重试、终止和失租结果映射到现有 Turn 状态机。
- 用本地命令和 Fake Agent 覆盖整个闭环，无需飞书或真实模型网络。

**Non-Goals:**

- 不新增 SQLite 表、迁移、Agent transcript、摘要记忆、Prompt 版本、流式回复或多 Agent。
- 不接入飞书、状态卡、Outbox Sender、归档、浏览器、登录 Profile、Shell、文件或网络工具。
- 不实现常驻轮询器、并行 Worker、全局 Conversation 调度或自动创建 Conversation/Turn 的 CLI。
- 不改变公开文章采集的渲染、摘要和 Markdown 归档路径。

## Decisions

### 用已完成 Turn 与最终 Outbox 重建历史

`RuntimeStore` 新增只读历史查询：给定 Conversation 和当前 Turn 序号，返回此前 `answered` Turn 与关联 `final_message` Outbox 的 `{ text: string }` 载荷。查询按 Turn 序号筛选，不读取 `queued`、`running`、`failed` 或未来 Turn；它不依赖 Outbox 是否已发送，因为生成回复与渠道投递是独立状态。

运行时先排除无法解析为 `{ text: string }` 或用户输入与回复合计超过 4,000 个字符的候选轮次。随后从最新候选向前收集至多六个完整轮次，再按升序交给模型；不截断单个轮次。这样最新轮次本身过长时会被自身排除，而不是借由丢弃更早轮次来掩盖超限。

这避免在 v1 schema 中提前增加 `agent_context_json`，同时让重启、测试和未来飞书重放都从同一数据库事实重建。替代方案是持久化 Pi transcript 或 Agent 内部对象，但它们不能和 Turn/Outbox 原子提交，也会耦合上游 SDK 格式。

### 用窄接口包装无工具 Pi `Agent`

新增 `TopicAgentRuntime` 函数类型，输入为 Conversation 标题、已完成历史和当前 Turn，输出为 `{ text: string }`。Fake Agent 直接实现该函数，用于所有业务测试。调用前当前 Turn 的 `content` 不得超过 4,000 个字符；超限 Turn 由 Worker 以不调用模型的终态失败处理。

默认 Pi 适配器在每次调用时创建新的 `pi-agent-core` `Agent`，在初始状态提供固定系统提示、重建后的消息序列和空工具列表。它以 `models.streamSimple` 作为 `streamFn`，固定注入 `toolChoice: "none"` 与 `timeoutMs: 60_000`，并以 `shouldStopAfterTurn` 强制一次调用最多产生一次 Provider 请求。适配器只接受 `stop` 的无 tool call 纯文本 Assistant 结果，去除首尾空白后验证非空且最长 6,000 字符；超时、Provider/认证失败、非 `stop`、tool call 与无效文本都以不含原始异常或 Provider 响应的安全 Agent 错误返回 Worker。模型按既有 `KNOWLEDGE_RADAR_MODEL` 的 `provider/model` 解析规则选择。

适配器既不接收 `RuntimeStore`、Outbox Sender 或浏览器对象，也不暴露 Shell、文件、HTTP、CDP 或 Cookie 能力。`Direct Agent` 在本文仅指这种短生命周期、由 Radar 重建消息并直接调用 Pi `Agent` 的适配方式，而不是 Pi 的独立类名。

选择 Direct Agent 而不是 `AgentHarness` 是因为状态提交边界已经验证不可组合。选择函数接口而不是可插拔工具框架是为了让 Worker 与模型 SDK、Fake Agent 和未来模型适配器保持解耦，而不引入单实现的容器或注册表。

### 单次 Worker 只处理一个指定 Conversation

新增 `processConversationOnce(conversationId)`：

1. 在领取前只恢复指定 Conversation 中租约已过期的 `running` Turn；不恢复其他 Conversation、Job 或 Outbox。随后以 120 秒租约领取最早的可处理 Turn；没有记录时返回 `idle`。
2. 若当前 Turn 的 `content` 超过 4,000 个字符，以 `turn_too_large` 调用 `failTurn`，不调用 Agent；条件写回失败时返回 `lost_lease`，成功时返回 `failed`。
3. 读取当前 Turn 前的受限历史，调用 `TopicAgentRuntime`。
4. 成功时调用 `completeTurnWithOutbox`，以 `kind = "final_message"`、`{ text }` 和固定 `maxAttempts = 3` 原子提交。
5. 若提交返回空值，说明令牌或租约已经失效，返回 `lost_lease`，不再尝试写回。
6. Agent 抛出异常或返回无效文本时，以安全错误代码调用 `retryTurn`，使用固定 30 秒延迟。若 `retryTurn` 返回 `false`，立即返回 `lost_lease`，不再读取或写回该 Turn；成功时仅根据已领取 Turn 的 `attempts` 与 `max_attempts` 返回 `retry_scheduled` 或 `failed`。

模型调用没有首版心跳续租。适配器使用 60 秒总截止时间并调用 `agent.abort()`，同时传入 `timeoutMs: 60_000` 和 `maxRetries: 0`，避免 SDK 内部重试放大一次 Turn 尝试。60 秒小于 120 秒租约；若进程暂停仍导致失租，条件写回会拒绝旧结果。这里只保证最多调用一次 Provider stream 接口，不承诺第三方请求的端到端 exactly-once。

长度按 JavaScript `String.length`（UTF-16 code units）计数。Agent 错误只记录 `agent_configuration`、`agent_timeout`、`agent_provider_failure` 或 `agent_invalid_response`；原始错误和模型内部消息不会写入 Turn 或 CLI 输出。

`run-once <conversation-id>` 是该 Worker 的薄 CLI 适配器。它必须显式从 `KNOWLEDGE_RADAR_STATE_PATH` 打开状态库，并为正常 Worker 结果输出 `{ "outcome": "idle" | "answered" | "retry_scheduled" | "failed" | "lost_lease" }`；`failed` 以非零状态退出，其他结果正常退出。`StorageBusyError` 不是 `idle`：CLI 输出 `{ "outcome": "storage_busy" }` 并以非零状态退出。若它发生在成功领取前，Agent 不得被调用且 Turn 尝试次数不得增加；若发生在领取后的写回，Worker 不得伪造完成结果，后续租约恢复会重新处理该 Turn。CLI 解析与组装采用可注入的命令处理函数，测试注入 Fake Agent，生产入口才创建 Pi 适配器。已有 `knowledge-radar <公开 URL>` 继续走采集闭环，不重新解释 URL 参数。

### 不在本 Change 投递 Outbox

Worker 的成功边界是 `pending` 最终 Outbox 已被原子记录，而不是消息已到达用户。这样 Agent 不持有飞书凭据，也不会出现“模型回复成功但 HTTP 发送失败”与 Turn 完成混在一个错误路径中的情况。未来飞书 Change 只需领取这类最终 Outbox 并发送。

## Risks / Trade-offs

- [只保留六个完成轮次会丢失较早上下文] → 这是首版确定性上限；实际遇到上下文不足后，再通过独立迁移引入受控 `memory_summary`。
- [Outbox 旧载荷无法用于话题历史] → 只接受本 Change 定义的 `{ text }`；不猜测或执行未知 JSON，旧记录安全地不参与历史。
- [模型调用可能超过租约] → 模型超时小于租约，且失租写回被状态库拒绝；需要更长调用时再增加续租机制和专门测试。
- [同一失败会在手动多次 `run-once` 中重复尝试] → 使用未来 `available_at` 和持久化 `max_attempts`，不靠进程内计数器。
- [CLI 不能直接创建 Turn] → 首版只验证消费边界；飞书入口或后续专用开发命令才负责创建与路由 Turn。

## Migration Plan

1. 不执行 schema 迁移；新增的历史查询仅读取 v1 已有表。
2. 部署后只有显式执行 `run-once <conversation-id>` 才会调用模型或改变 Turn。
3. 回滚时移除新代码即可；未处理 Turn 保持 `queued`，已完成 Turn 和最终 Outbox 仍由既有状态库安全保存。
