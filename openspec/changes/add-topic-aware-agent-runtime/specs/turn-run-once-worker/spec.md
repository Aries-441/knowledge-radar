## Purpose

将一个指定 Conversation 中可处理的 Turn 安全地交给话题 Agent，并把成功、失败和租约竞争全部转换为已有 SQLite 状态机中的可恢复状态。

## ADDED Requirements

### Requirement: 本地单次处理指定 Conversation
系统 SHALL 提供本地 `run-once <conversation-id>` 操作。该操作 MUST 在领取前只恢复指定 Conversation 中租约已过期的 `running` Turn，且不得改变其他 Conversation、Job 或 Outbox；随后尝试领取该 Conversation 最早的可处理 Turn，并且一次调用至多处理一个 Turn。没有可领取 Turn 时，操作 MUST 返回明确的 `idle` 结果，且不得调用 Agent 或创建 Outbox。

现有以公开 URL 作为唯一 CLI 参数的采集行为 MUST 保持兼容。

#### Scenario: 指定 Conversation 没有可处理 Turn
- **WHEN** `run-once` 的目标 Conversation 没有状态为可领取的 Turn
- **THEN** 操作 SHALL 返回 `idle`，且状态库中不得新增或修改 Outbox

#### Scenario: 指定 Conversation 有多个排队 Turn
- **WHEN** 一个 Conversation 有多个可处理或等待前序处理的 Turn
- **THEN** 一次 `run-once` 调用 SHALL 最多领取并处理其中最早的一个 Turn

#### Scenario: 上一次运行在 Agent 调用中退出
- **WHEN** 最早的 `running` Turn 的租约已经过期
- **THEN** 下一次该 Conversation 的 `run-once` MUST 先将其按现有上限语义恢复为 `queued` 或 `failed`；仅在恢复为 `queued` 时才可由本次调用重新领取

### Requirement: 原子持久化最终回复
当 Agent 为已领取 Turn 返回有效回复时，系统 SHALL 创建 `kind = "final_message"`、`max_attempts = 3` 的唯一 Outbox，其 JSON 载荷 MUST 为 `{ "text": string }`，并通过同一原子提交将该 Turn 标记为 `answered`。提交成功后 Turn 与最终 Outbox MUST 同时可见；提交失败或令牌失效时，两者 MUST 不留下部分完成状态。

#### Scenario: 成功处理一个 Turn
- **WHEN** Agent 为持有有效租约的 Turn 返回有效回复，且原子提交成功
- **THEN** Turn SHALL 变为 `answered`，并且恰好存在一个带相同 Turn 标识的 `final_message` Outbox

#### Scenario: 旧 Runner 在回复后失去租约
- **WHEN** Agent 返回后，该 Turn 已被恢复并由另一个 Runner 领取
- **THEN** 旧 Runner MUST 返回 `lost_lease`，且不得创建、修改或重试最终 Outbox

### Requirement: 将 Agent 失败转换为可恢复 Turn 状态
系统 SHALL 将 Agent 调用异常或无效回复作为可重试失败处理：在当前租约仍有效时，使用未来的 `available_at` 直接将 Turn 重新排为 `queued`，并记录不含敏感内容的错误代码。达到该 Turn 的 `max_attempts` 时，系统 MUST 让现有状态机将 Turn 转为 `failed`。

#### Scenario: Agent 临时失败
- **WHEN** Agent 在当前有效租约内抛出异常，且 Turn 尚未达到 `max_attempts`
- **THEN** 操作 SHALL 返回 `retry_scheduled`，Turn SHALL 保持 `queued`，并在未来 `available_at` 前不可再次领取

#### Scenario: Agent 在最后一次尝试失败
- **WHEN** Agent 调用失败且该 Turn 的尝试次数已达到 `max_attempts`
- **THEN** 操作 SHALL 返回 `failed`，且 Turn MUST 变为 `failed` 并且不得再次领取

#### Scenario: Agent 失败后旧 Runner 失去租约
- **WHEN** Agent 调用失败后，`retryTurn` 因令牌或租约失效返回 `false`
- **THEN** 操作 MUST 返回 `lost_lease`，且不得重新读取该 Turn 来归类结果、不得再写回 Turn 或 Outbox

#### Scenario: 当前 Turn 输入超长
- **WHEN** 已领取 Turn 的 `content` 超过 4,000 个字符
- **THEN** 操作 MUST 不调用 Agent；在当前租约有效时以 `turn_too_large` 将 Turn 标记为 `failed`，否则返回 `lost_lease`

### Requirement: 本地 CLI 结果可区分存储忙
`run-once` CLI MUST 为正常 Worker 结果输出仅含 `outcome` 的 JSON 对象。`failed` 必须以非零状态退出；`idle`、`answered`、`retry_scheduled` 与 `lost_lease` 必须以零状态退出。发生 `StorageBusyError` 时，CLI MUST 输出 `{ "outcome": "storage_busy" }` 并以非零状态退出，且不得把该错误报告为 `idle`。若存储忙发生在成功领取前，不得调用 Agent 或增加尝试次数；此前已独立提交的目标会话租约恢复可以保留。若发生在领取后的写回，不得伪造完成结果，失败事务不得留下部分写入。

#### Scenario: SQLite 被其他短事务占用
- **WHEN** `run-once` 在打开、恢复或领取状态库时收到 `StorageBusyError`
- **THEN** CLI SHALL 输出 `storage_busy` 并以非零状态退出，且 Agent 调用次数与 Turn 尝试次数均不得增加

### Requirement: 运行时不产生渠道或工具副作用
本 Change 的 `run-once` 操作 MUST 不接入飞书、不发送 Outbox、不执行浏览器、归档、Shell、文件写入或其他 Agent 工具副作用。它的唯一持久化副作用 MUST 是现有状态库中的 Turn 与最终 Outbox 状态变更。

#### Scenario: 成功处理后存在待发送最终消息
- **WHEN** `run-once` 成功处理一个 Turn
- **THEN** 系统 SHALL 仅创建状态为 `pending` 的最终 Outbox，且不得尝试向任何外部渠道发送它
