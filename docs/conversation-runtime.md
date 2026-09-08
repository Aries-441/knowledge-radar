# 会话运行时与可恢复状态机

- 状态：Revised（运行时选择已验证）
- 日期：2026-09-08
- 适用变更：`add-topic-aware-agent-runtime`、飞书入口、登录态浏览

## 0. Pi 技术验证结论

第一版采用 **Direct Agent + Radar 自己的 SQLite 状态机**，不将 `AgentHarness` 或 Pi 的 SQLite Session Backend 放入生产路径。

验证保留在 [`src/pi-harness-spike.test.ts`](../src/pi-harness-spike.test.ts)，不读取密钥、不请求模型网络：

1. `AgentHarness` 与官方 `SqliteSessionRepo` 能在关闭并重开后恢复同一条 Lane 的消息，持久化能力本身有效。
2. 当 Radar 在同一个 `.sqlite` 文件中持有 `BEGIN IMMEDIATE` 事务时，Harness 的一次消息写入约五秒后以 `HarnessFault` 失败，根因是 `database is locked`。
3. 原因是官方 backend 自行打开 `DatabaseSync` 连接，并在内部提交时启动自己的 `BEGIN IMMEDIATE`。它没有把应用事务或连接暴露给调用者，因此无法把 Turn、Job、Outbox 与 Pi 写入合成一笔提交。

Harness 的分支、工具状态和会话恢复能力在将来可能有价值；届时必须先引入可组合的存储适配器，或接受两个独立提交及其补偿逻辑。当前单机项目没有这个真实需求，不增加第二个状态机。

## 1. 目标与边界

Knowledge Radar 的飞书窗口不是一个会话。用户可以同时讨论多篇文章、项目设计和临时问题；每个独立话题必须拥有自己的上下文、任务和归档去向。

本设计的目标是：

1. 在 Docker 重启、模型调用失败、飞书断连或登录过期后恢复可恢复的工作。
2. 避免同一条飞书消息重复建任务、同一抓取重复归档，或不同话题串上下文。
3. 让用户只看到稳定、可解释的状态，而不是模型输出的半截流式文本。
4. 保持单机单 `radar` 进程和单个 SQLite 数据库，不建立分布式队列、事件溯源系统或多工作节点。

本设计不承诺在第三方模型 API 或飞书 API 上实现端到端 exactly-once。系统保证本地状态与副作用可重试；对外投递采用可去重的 at-least-once 策略。

## 2. 基本原则

### 2.1 四类状态不能混用

| 实体 | 含义 | 状态示例 | 不应承担的职责 |
| --- | --- | --- | --- |
| Conversation | 一个长期话题 | `active`、`archived` | 不记录单次抓取是否失败 |
| Turn | 一条用户输入或内部通知的处理 | `queued`、`running`、`answered`、`failed` | 不直接等待人工登录 |
| Job | 可重试的外部工作 | `pending`、`running`、`waiting_auth`、`succeeded`、`retry_wait`、`failed` | 不决定话题上下文 |
| Outbox | 要发送或更新的飞书内容 | `pending`、`sending`、`sent` | 不保存业务结果本身 |

`waiting_auth` 只能是 Job 状态。一个文章抓取等待登录时，所属 Conversation 仍是 `active`，用户可以继续讨论或切换到其他话题。

### 2.2 Agent 的内存不是事实来源

Pi 的 `AgentHarness` 可以持久化 Lane，但其提交不能与 Radar 的业务事务原子组合（见第 0 节）。因此第一版的 Direct Agent 不持有跨进程运行态：每次处理 Turn 时，由应用从 `radar.db` 重建模型上下文；仅在最终业务事务中保存下一次所需的安全上下文投影。

不保存或不传入模型：

- Cookie、Local Storage、密码、验证码和浏览器 Profile。
- 未完成的流式文本、未验证的工具参数和浏览器控制句柄。
- 完整第三方原文。会话只关联 `captureId`、URL、标题、已归档摘要和受限摘录。

### 2.3 会话路由由程序决定

模型不决定一条飞书消息属于哪个话题。显式命令优先级最高；其余路由优先级固定：

1. `/new <title>` 创建普通 Conversation；`/use <id>` 或消息卡片动作切换当前 Conversation。
2. 回复机器人历史消息时，使用该消息关联的 Conversation。
3. 新 URL 默认创建新的文章 Conversation。
4. 普通文本进入当前 Conversation；没有当前 Conversation 时，要求用户选择或新建。

每个用户、每个飞书聊天范围内维护一个 `current_conversation_id`。切换当前话题不会取消正在运行的其他 Job。

## 3. 持久化模型

第一版使用一个 `radar.db`，它是全部可恢复运行状态的唯一真相来源。Pi 的通用 SQLite Session Backend 不接入生产路径，原因见第 0 节。

| 表 | 核心字段 | 约束与说明 |
| --- | --- | --- |
| `conversations` | `id`、`owner_open_id`、`chat_id`、`kind`、`title`、`status`、`memory_summary`、`agent_context_json`、`runtime_version` | `agent_context_json` 只含已完成的、可安全重放的上下文投影；不含凭据、完整原文、未验证工具参数或进行中的流 |
| `chat_contexts` | `owner_open_id`、`chat_id`、`current_conversation_id`、`updated_at` | `(owner_open_id, chat_id)` 唯一，持久化当前话题指针 |
| `turns` | `id`、`conversation_id`、`sequence`、`source`、`content`、`status`、`run_token`、`lease_expires_at`、`attempts` | `(conversation_id, sequence)` 唯一；领取必须条件更新，防止两个 Runner 同时执行 |
| `jobs` | `id`、`turn_id`、`kind`、`state`、`idempotency_key`、`available_at`、`run_token`、`lease_expires_at`、`attempts`、`result_json`、`error_code` | `idempotency_key` 唯一；所有外部副作用先写 Job 意图，长操作不阻塞 Agent |
| `archive_entries` | `id`、`capture_id`、`archive_path`、`content_hash`、`state`、`job_id` | 路径由稳定 ID 推导；DB 记录归档意图，文件写入是可重试 Job |
| `outbox` | `id`、`conversation_id`、`turn_id`、`lane`、`sequence`、`kind`、`revision`、`available_at`、`run_token`、`lease_expires_at`、`payload_json`、`state` | `(turn_id, kind, revision)` 唯一；`status` 与 `message` 两条投递通道互不阻塞 |
| `inbound_messages` | `provider_event_id`、`source_message_id`、`received_at`、`turn_id` | `provider_event_id` 唯一，先去重再建 Turn；源消息 ID 只作关联 |

`agent_context_json` 由程序投影生成，不能直接序列化任意 Pi 内部对象。模型、工具定义和系统提示词由版本化配置重新创建；会话记录保存 `runtime_version`，它包含 `prompt_version`、模型标识和工具 schema 版本。版本变更后允许进行一次受控重建或摘要压缩，不静默混用旧上下文。

## 4. 状态机

### 4.1 Turn

```text
received -> queued -> running -> answered
                       |          |
                       |          -> failed
                       -> retry_wait -> queued
```

一条 Turn 对应一次可恢复的 Agent 处理。用户在同一 Conversation 连续发送多条消息时，后续 Turn 保持 `queued`，直到前一 Turn 到达终态。不同 Conversation 可以各自排队。

Runner 必须用单条条件更新领取，而不是“先查再改”：`UPDATE turns ... WHERE id = ? AND status = 'queued' AND lease_expires_at <= now`。更新同时写入新的 `run_token` 与租约时间；后续完成、失败或续租必须携带这个 token。这样即使未来误启动两个进程，也不会重复运行同一 Turn。

### 4.2 Job

```text
pending -> running -> succeeded
                 |-> retry_wait -> pending
                 |-> waiting_auth -> pending
                 -> failed
```

只有 Job 可以进入 `waiting_auth`。人工登录成功只改变匹配 Profile 的等待 Job 为 `pending`，不直接伪造抓取成功。Job 领取和恢复也使用 `run_token`、租约、`available_at` 与递增的 `attempts`；启动时只回收租约过期的 `running` Job。

登录相关 Job 必须记录 `profile_id` 和提交时看到的 `auth_generation`。Profile 完成一次人工登录后递增 generation；重试时重新检查 Profile 的健康状态与 generation，不能因为一张过期的“已登录”判断而误恢复。

### 4.3 Outbox

```text
pending -> sending -> sent
              |
              -> retry_wait -> pending
```

最终消息通道按 Conversation 的 `sequence` 投递，避免回答乱序。状态通道只投递同一状态卡的最高 `revision`，可被后续状态替代，不能阻塞最终消息。发送器崩溃在远端成功响应之后但本地未标记时，可能重复发送；投递适配器应优先使用第三方提供的幂等标识。若没有该能力，保留重复而不丢失的语义。

## 5. 处理与回复流程

### 5.1 入站消息

```text
飞书事件
-> 事务：去重 provider_event_id、Conversation 路由、Turn(queued)、状态 Outbox
-> 立即确认飞书已收到事件
-> Conversation Runner 以 run_token 领取最早的 queued Turn
-> Direct Agent 与短工具完成一轮
-> 事务：保存安全上下文投影、Turn(answered)、最终 Outbox
-> Outbox Sender 发送状态或最终回答
```

事件处理器必须在上述本地事务提交后尽快确认飞书，不等待抓取或模型调用。状态消息只在持久化状态变化时更新：已收到、处理中、等待登录、已完成、失败待重试。不要把模型 token 流逐字发送到飞书。

### 5.2 短工具与长工具

短工具在当前 Agent Turn 内完成，例如：

```text
get_current_article()
search_archived_articles(query)
get_auth_status(site)
```

长工具只创建 Job 并立刻返回 `pending`，例如：

```text
request_capture(url)
request_login(site, profileId)
```

抓取、人工登录和重试不能让一个 Agent 循环在内存中等待数十秒或数小时。请求长工具时，工具只能在同一事务内创建带稳定 `idempotency_key` 的 Job；真正的副作用由 Job Worker 在提交后执行。Job 完成后，系统向对应 Conversation 追加一条内部通知 Turn；下一轮 Agent 根据结果组织用户回复。

### 5.3 正常完成时的提交顺序

1. 入站事务只保存用户 Turn 与状态 Outbox；不要预先把当前 Turn 写进 `agent_context_json`。
2. Runner 原子领取 Turn，以“上次已完成上下文 + 当前 Turn”重建 Direct Agent，并只调用一次 prompt。重启时，未终态 Turn 会从相同的已完成上下文重新开始，不调用 Pi `continue()`。
3. Agent 到达稳定结束后，在一个事务中保存最终消息、安全上下文投影、Turn 终态、必要的 Job 意图与最终 Outbox。
4. 事务提交后，Archive Worker、Job Worker 和 Outbox Sender 才允许产生文件、网络或飞书副作用。

这保证了“已回复”一定有本地记录，“已归档”一定能在稍后补发通知。

## 6. 断点与重连

| 断点 | 重启后的处理 | 用户可见结果 |
| --- | --- | --- |
| 飞书事件重复投递 | `provider_event_id` 唯一约束拒绝重复建 Turn | 不重复归档或回答 |
| 进程在模型流式中退出 | 租约过期后 Turn 回到 `queued`，从上次已完成的上下文重新执行 | 可能换一种措辞，不发送半句话 |
| 进程在抓取后、通知前退出 | 已完成 Job 与归档意图保留，Outbox 重试发送 | 最终仍收到归档结果 |
| 进程在工具调用前退出 | 重跑 Agent；尚未产生外部副作用 | 正常继续 |
| 进程在工具调用后退出 | 依赖已提交 Job 的幂等键读取既有结果，不重复创建工作 | 不重复归档 |
| 浏览器发现登录失效 | Job 留在 `waiting_auth` | 收到一次明确的登录提示 |
| 飞书连接断开 | 传输层重连，Outbox 继续投递 | 未发送的状态与结果补发 |

启动恢复规则：只将租约已过期的 `running` Turn、Job 与 Outbox 重新排入可领取状态；保留 `waiting_auth`；保留未过期的租约，避免重启窗口内重复执行。当前部署目标仍是一个 `radar` 副本；租约是防御性正确性约束，不意味着支持多 Worker 扩展。

## 7. Pi Agent 恢复与上下文压缩

每个活跃 Conversation 在内存中最多持有一个 Direct Agent。启动或首次访问时：

1. 从 `conversations` 读取 `memory_summary`、已提交的 `agent_context_json` 和关联 Capture 元数据。
2. 按当前 `prompt_version`、模型和受限工具重新创建 Agent。
3. 设置保存的已完成消息，再处理最早的 queued Turn。

当上下文超过项目配置上限时，先产生并持久化一段 `memory_summary`，再只保留最近若干完整轮次。压缩必须作为一次普通 Turn 的最终事务的一部分，不能先删除旧上下文再异步写入摘要。压缩前的用户和助手消息仍保留在 `turns` 和 Markdown 归档中；模型不应假装记得未放入当前上下文的细节。

工具结果必须是受限的结构化数据。浏览器工具绝不返回 Cookie 或 Profile 路径；文章工具默认返回标题、来源、摘要和有限摘录，而不是完整第三方正文。

## 8. 归档规则

- `article` Conversation 的问答由 Archive Writer 追加到关联文章 Markdown 的“对话”区块。
- `general` Conversation 在结束时归档到 `Private/Conversations/`，不混入任意文章。
- Archive Writer 由程序调用；Agent 只能返回结构化回答，不能指定路径或写文件。
- SQLite 与文件系统不能构成一笔原子事务。因此先在 `archive_entries` 中写入归档意图和稳定路径，再由 Archive Job 写临时文件并原子替换；文件必须带可验证的归档 ID/内容哈希，重试时先检查目标文件是否已满足意图，再更新数据库状态。
- 归档文件名必须由 `capture_id` 或 `archive_entry.id` 稳定推导，不能依赖随机 UUID。现有公开文章 MVP 的随机文件名在接入任务状态机时必须替换。
- SQLite 被删除不应删除已完成的 Markdown 资产，但会失去运行队列和短期会话恢复能力。

## 9. 实现验收场景

在连接真实飞书前，必须通过可重复的本地测试：

1. 两个 Conversation 交替入队时，第二个话题看不到第一个话题的上下文。
2. 同一 `provider_event_id` 重放两次，只产生一个 Turn 和一个 Capture Job，并在本地提交后立即确认事件。
3. 两个 Runner 同时领取同一 Turn 时，只有一个获得 `run_token`。
4. 模拟模型流式中断后，重启只重跑未完成 Turn，不发送半截回答，也不重复追加当前用户 prompt。
5. 抓取成功、归档文件写入后模拟进程退出；重启能识别同一归档意图，不重复写 Markdown，并投递同一个归档结果。
6. Job 进入 `waiting_auth` 后重启，状态仍保留；Profile generation 变化后仅重跑原 Job。
7. Outbox 首次发送失败后重试；旧状态 revision 不阻塞最终消息，最终消息按 Conversation 顺序到达。

## 10. 明确延后

- 通用工作流引擎、Redis、Kafka、事件溯源和多 Worker 调度。
- 让 Agent 直接访问 Shell、文件系统、CDP、Cookie 或 Docker Socket。
- 将完整第三方原文、密码或验证码写入 Agent 会话历史。
- 依赖模型自动判断话题切换。
- 端到端 exactly-once 的不现实承诺。
