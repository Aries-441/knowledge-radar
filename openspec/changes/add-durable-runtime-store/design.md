## Context

公开文章采集目前由 CLI 在内存中顺序调用浏览、摘要和归档；`src/` 还没有应用运行状态库。会话运行时设计已确认 `radar.db` 是唯一的可恢复状态来源，而 Pi `AgentHarness` 的 SQLite backend 不能与 Radar 的 Job/Outbox 事务组合。详见 [proposal.md](proposal.md) 与 [会话运行时与可恢复状态机](../../../docs/conversation-runtime.md)。

本 Change 只实现运行状态的最小底座，不接入飞书、Agent 或任何真实外部副作用。

## Goals / Non-Goals

**Goals:**

- 在一个应用拥有的 SQLite 文件中持久化 Conversation、Turn、Job 和 Outbox，并在重启后恢复。
- 为三类可领取记录固化原子领取、`run_token`、租约、`available_at` 与持久化的 `max_attempts` 规则。
- 让时间、随机令牌和数据库路径可注入，以无网络、无模型的确定性测试验证并发与恢复行为。
- 在同一事务中完成一个已领取 Turn 并创建其唯一的最终 Outbox 意图。

**Non-Goals:**

- 不实现飞书入站去重、当前话题指针、登录 Profile、Agent 上下文、真实 Job 执行器或通知发送器。
- 不将现有 `captureArticle` 改为后台 Job，不处理 Markdown 与 SQLite 的归档补偿。
- 不实现状态卡、消息 revision、可替代的状态更新或多条 Outbox 通道。
- 不引入 ORM、连接池、工作流引擎、分布式锁或新的 npm 依赖。

## Decisions

### 使用 Node 内置 SQLite 与唯一状态库

状态层直接使用 `node:sqlite`，由 Radar 打开一个 `radar.db`。每次打开连接都启用外键并设置有限的 SQLite busy timeout；所有改写都使用短 `BEGIN IMMEDIATE` 事务，事务内不执行网络、模型或文件 I/O。

超过 busy timeout 仍遇到 `SQLITE_BUSY` 时，状态层返回可识别、可重试的存储忙错误，不把它误报为“没有可领取记录”。调用方可重试该操作。无论竞争者得到空结果还是该错误，同一记录最多只能被一个 Runner 成功领取。

不使用 Pi Session Backend，也不创建第二个 SQLite 文件。技术验证已表明，Harness backend 会以独立连接开启自己的写事务，无法与 Radar 的 Turn/Job/Outbox 写入原子组合。

### 用 `PRAGMA user_version` 管理前向迁移

状态层维护按整数排序的迁移列表。初始化时读取 `PRAGMA user_version`，在一个事务内顺序应用未执行迁移并写入目标版本；数据库版本高于当前程序支持范围时，必须拒绝打开且不得写入。

v1 创建以下最小表和索引；时间字段均使用可比较的 epoch 毫秒整数。

| 表 | 最小字段与约束 |
| --- | --- |
| `conversations` | `id`、`kind`、`title`、`status`、`created_at`、`updated_at`；仅作为 Turn 的父实体。 |
| `turns` | `id`、`conversation_id`、`sequence`、`source`、`content`、`state`、`available_at`、`run_token`、`lease_expires_at`、`attempts`、`max_attempts`、`error_code`、时间戳；唯一 `(conversation_id, sequence)`。 |
| `jobs` | `id`、可空 `origin_turn_id`、`kind`、`payload_json`、`idempotency_key`、`result_json`、`error_code`、`state`、`available_at`、`run_token`、`lease_expires_at`、`attempts`、`max_attempts`、时间戳；唯一 `idempotency_key`。 |
| `outbox` | `id`、`turn_id`、`kind`、`payload_json`、`state`、`available_at`、`run_token`、`lease_expires_at`、`attempts`、`max_attempts`、`error_code`、时间戳；唯一 `(turn_id, kind)`。 |

`turns.conversation_id`、`jobs.origin_turn_id` 与 `outbox.turn_id` 受外键约束；`origin_turn_id` 可以为 `NULL`。为 `turns(conversation_id, sequence)`、`jobs(state, available_at)`、`outbox(state, available_at)` 及其领取查询建立必要索引。v1 不创建 `chat_contexts`、`inbound_messages`、`archive_entries`、`auth_profiles` 或 Agent 上下文字段。

### 领取、令牌与租约使用条件更新

每个领取操作在一个短 `BEGIN IMMEDIATE` 事务内选择候选记录，再以状态和可用时间为条件更新为运行态；只有更新成功才返回记录。领取时递增 `attempts`、生成不可预测的 `run_token` 并写入未来 `lease_expires_at`。

- Turn 只选择某 Conversation 最早的非终态 Turn，且它必须为已到期的 `queued` 状态并且 `attempts < max_attempts`。
- Job 只选择已到期的 `pending` Job，且 `attempts < max_attempts`；Job 不受 Conversation FIFO 约束。
- Outbox 只选择已到期的 `pending` 最终消息，且 `attempts < max_attempts`。它通过所属 Turn 的 Conversation 与 `sequence` 排序；更早的非终态 Outbox 阻塞同一 Conversation 的较晚 Outbox，`sent` 与 `failed` 不阻塞。

完成、终止、安排重试和续租均使用 `WHERE id = ? AND state = <运行态> AND run_token = ? AND lease_expires_at > now`。影响行数为零即表示失去租约或令牌，不得写回。任何离开 `running` 或 `sending` 的状态变更必须在同一更新中清除 `run_token` 和 `lease_expires_at`。

### 用 `available_at` 表示延迟，不引入 `retry_wait`

创建记录时调用方提供一个合法的 `max_attempts` 并由状态层持久化，后续重开、恢复与重试不得丢失该值。重试策略和退避公式由调用方决定，状态层只执行给定的未来 `available_at`：

- 当前尝试未耗尽时，Turn 直接回到 `queued`，Job/Outbox 直接回到 `pending`，并保留未来 `available_at`。
- 当前尝试已达到 `max_attempts` 时，记录转为终态 `failed`。
- 启动恢复只处理过期的运行租约：仍有尝试次数的记录回到当前可领取状态；已耗尽的记录转为 `failed`。两种情况都清除旧令牌和租约。

这避免单独的延迟状态缺少“何时重新可领取”的转换规则，也让领取查询只需检查状态与 `available_at`。

### Outbox v1 只保存不可变最终消息

v1 的每个 Outbox 都从一个 Turn 派生，且只表达该 Turn 的一种不可变最终消息。重复创建相同 `(turn_id, kind)` 必须返回既有记录。Outbox 不保存 `conversation_id`、`sequence`、`lane`、`revision` 或状态卡内容；顺序由 join 到 Turn 的 Conversation 和 `sequence` 推导。

飞书状态卡、同一消息的 revision 与可替代更新由未来飞书入口 Change 定义并迁移。本 Change 不为它们预留半成品语义。

### 最小 API 与事务边界

实现暴露的操作贴近四份能力规格：打开/升级/关闭状态库、创建 Conversation 与 Turn、入队或幂等获取 Job、领取/续租/结算/重试/恢复各类记录，以及“完成已领取 Turn 并创建最终 Outbox”。

最后一项是本 Change 唯一跨实体业务事务：它必须校验 Turn 的有效运行令牌，在同一提交中将 Turn 标记为 `answered` 并创建最终 Outbox。既不创建入站状态 Outbox，也不持久化 Agent 记忆投影。测试通过临时数据库、固定时钟与确定性令牌工厂直接覆盖该语义。

## Risks / Trade-offs

- [同步 SQLite 调用会阻塞事件循环] => 事务仅包含少量状态行，绝不在事务内执行网络、模型或文件 I/O。
- [并发写入可能暂时忙] => 设置有限 busy timeout，并将超时后的 `SQLITE_BUSY` 转为调用方可重试的明确错误；不以牺牲单次领取正确性换取吞掉错误。
- [租约无法撤销失联 Runner 已发起的外部副作用] => 本 Change 不执行副作用；后续执行器必须用 Job 的 `idempotency_key` 实现去重。
- [SQLite 不支持自动向下迁移] => 迁移只前进；发布前备份状态卷，旧程序遇到未来 schema 明确失败。
- [运行状态 API 过早扩大] => v1 只覆盖四种实体；飞书、认证、归档和 Agent 上下文在接入时各自引入迁移。

## Migration Plan

1. 首次部署时在状态卷创建 `radar.db` 并应用 v1 迁移。
2. 现有公开文章 CLI 不打开状态库，因此输出行为保持不变。
3. 发布前运行临时数据库测试、类型检查和现有采集测试；并覆盖竞争领取、存储忙、令牌失效、重试、尝试耗尽和重启恢复。
4. 如需回滚代码，保留数据库文件；旧版本遇到未来 schema 版本时明确失败，不尝试破坏性降级。
