## Purpose

为每个 Conversation 保存按序处理的 Turn，使多个 Runner 或重启恢复不会并发处理同一轮，也不会让后续输入越过未完成的前序输入。

## ADDED Requirements

### Requirement: 为 Conversation 按序持久化 Turn
系统 SHALL 为已存在的 Conversation 创建带单调递增序号、`available_at` 和持久化 `max_attempts` 的 Turn。新建 Turn 初始状态 MUST 为 `queued`，且 MUST 在当前时间可领取；同一 Conversation 内不得存在重复序号。

#### Scenario: 连续创建两条 Turn
- **WHEN** 系统在同一 Conversation 中连续创建两条 Turn
- **THEN** 后创建的 Turn SHALL 获得更大的序号，并保持 `queued` 状态

### Requirement: 原子领取最早可处理的 Turn
系统 SHALL 只允许领取一个 Conversation 中最早的非终态、状态为 `queued`、`available_at` 不晚于当前时间且未达到 `max_attempts` 的 Turn。领取成功时，系统 MUST 将该 Turn 标记为 `running`、增加尝试次数、分配不可预测的 `run_token`，并记录未来的租约到期时间。

#### Scenario: 两个 Runner 竞争领取同一 Turn
- **WHEN** 两个 Runner 同时领取同一 Conversation 的最早 `queued` Turn
- **THEN** 至多一个 Runner SHALL 获得 Turn 和 `run_token`；另一个 Runner SHALL 得到无可领取 Turn 或可重试的存储忙错误

#### Scenario: 前序 Turn 未终态
- **WHEN** 一个 Conversation 的最早 Turn 为 `running`，或为尚未到达 `available_at` 的 `queued`
- **THEN** 系统 MUST 不领取该 Conversation 的后续 Turn

### Requirement: 使用租约令牌变更已领取 Turn
系统 SHALL 仅允许持有当前 `run_token`、租约未失效且 Turn 仍为 `running` 的 Runner 完成、失败、续租或安排重试其 Turn。离开 `running` 时，系统 MUST 在同一变更中清除 `run_token` 和租约。令牌不匹配、租约已失效或状态不为 `running` 的操作 MUST 不改变 Turn 状态。

#### Scenario: 旧 Runner 在租约失效后写回
- **WHEN** 一个 Turn 已被重新领取，旧 Runner 使用旧 `run_token` 完成该 Turn
- **THEN** 系统 MUST 拒绝该写回并保留新 Runner 的状态

### Requirement: 延迟重试或终止 Turn
系统 SHALL 仅允许当前有效 Runner 为失败的 Turn 设置未来 `available_at`。未达到 `max_attempts` 时，系统 MUST 将 Turn 直接恢复为 `queued`；达到 `max_attempts` 时，系统 MUST 将其标记为 `failed`，且不得再次领取。

#### Scenario: Turn 在延迟时间前不可再次领取
- **WHEN** 当前 Runner 为未耗尽尝试次数的 Turn 安排未来重试
- **THEN** Turn SHALL 保持 `queued`，并在 `available_at` 前不可再次领取

#### Scenario: Turn 尝试次数耗尽
- **WHEN** 当前 Runner 为已达到 `max_attempts` 的 Turn 安排重试
- **THEN** Turn SHALL 变为 `failed`，且不得再次被领取

### Requirement: 恢复过期的 Turn 租约
系统 SHALL 将租约已过期且仍为 `running` 的 Turn 恢复为 `queued` 或 `failed`，并清除旧 `run_token` 与租约。恢复时，未达到 `max_attempts` 的 Turn SHALL 变为当前可领取的 `queued`；已达到 `max_attempts` 的 Turn SHALL 变为 `failed`。未过期的租约 MUST 保持不变。

#### Scenario: 应用在 Turn 运行期间重启
- **WHEN** 一个 `running` Turn 的租约已过期
- **THEN** 恢复操作 SHALL 使其再次可被一个 Runner 领取
