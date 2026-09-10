## Purpose

为未来通知适配器保存每个 Turn 的不可变最终消息及其投递状态，使消息发送失败或进程中断不会造成待投递结果丢失或同一业务意图被重复创建。

## ADDED Requirements

### Requirement: 持久化唯一的最终 Outbox 意图
系统 SHALL 为 Outbox 记录保存所属 Turn、种类、载荷、`available_at` 和持久化 `max_attempts`。v1 Outbox MUST 仅表示不可变的最终消息，不支持状态卡、投递通道或 revision。相同 `(turn_id, kind)` 的重复创建 MUST 返回既有 Outbox 记录。

#### Scenario: 重复创建同一最终消息
- **WHEN** 系统两次为同一 Turn 和种类创建 Outbox 记录
- **THEN** 系统 SHALL 保留一条 Outbox 记录，且不得重复产生投递意图

### Requirement: 有序领取最终消息
系统 SHALL 按所属 Turn 的 Conversation 和序号领取待投递的最终消息。较早的非终态最终消息存在时，系统 MUST 不领取较晚的最终消息；较早的 `sent` 或 `failed` 最终消息 MUST 不阻塞后续消息。

#### Scenario: 两条最终消息等待投递
- **WHEN** 同一 Conversation 中较早和较晚 Turn 都有待投递的 `message` 记录
- **THEN** 系统 SHALL 先领取较早 Turn 的记录

#### Scenario: 较早最终消息已终止失败
- **WHEN** 一个 Conversation 中较早的最终消息已为 `failed`
- **THEN** 系统 SHALL 允许领取满足其他条件的后续最终消息

### Requirement: 使用租约令牌投递或重试
系统 SHALL 只领取状态为 `pending`、`available_at` 不晚于当前时间且未达到 `max_attempts` 的 Outbox，并在领取时分配 `run_token` 和租约。只有持有当前 `run_token`、租约未失效且记录仍为 `sending` 的 Runner 才能将记录标记为 `sent` 或安排重试。离开 `sending` 时，系统 MUST 在同一变更中清除 `run_token` 和租约；过期、不匹配或非 `sending` 的写回 MUST 不改变记录。

#### Scenario: 投递失败后延迟重试
- **WHEN** 当前 Runner 为 Outbox 记录安排未来重试
- **THEN** 未达到 `max_attempts` 的记录 SHALL 保持 `pending`，并在 `available_at` 前不可再次领取；达到上限的记录 SHALL 变为 `failed`

### Requirement: 恢复过期的 Outbox 租约
系统 SHALL 将租约已过期且仍为 `sending` 的 Outbox 记录恢复为 `pending` 或 `failed`，并清除旧令牌和租约。未达到 `max_attempts` 的记录 SHALL 恢复为当前可领取的 `pending`；已达到上限的记录 SHALL 变为 `failed`，并保留原有投递意图。

#### Scenario: 发送器在响应前退出
- **WHEN** 一个 Outbox 记录为 `sending` 且其租约到期
- **THEN** 恢复操作 SHALL 允许后续发送器重新领取该记录
