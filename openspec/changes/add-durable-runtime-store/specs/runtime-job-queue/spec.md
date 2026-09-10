## Purpose

为需要在提交后执行的后台工作保存幂等意图、租约和可重试状态，使执行器可以在失败或重启后安全地继续调度而不依赖内存队列。

## ADDED Requirements

### Requirement: 持久化幂等 Job 意图
系统 SHALL 为 Job 保存可选的 `origin_turn_id`、种类、载荷、`available_at`、`max_attempts` 和全局唯一的 `idempotency_key`。Job MUST 不要求存在来源 Turn。相同 `idempotency_key` 的重复入队 MUST 返回既有 Job，且不得创建第二条记录。

#### Scenario: 重复创建同一 Job
- **WHEN** 系统两次以同一个 `idempotency_key` 创建 Job
- **THEN** 系统 SHALL 返回同一 Job，且库中只存在一条对应记录

### Requirement: 领取已到期的 Job
系统 SHALL 只领取状态为 `pending`、`available_at` 不晚于当前时间且未达到 `max_attempts` 的 Job。领取成功时，系统 MUST 将 Job 标记为 `running`、增加尝试次数、分配 `run_token` 并设置租约到期时间。

#### Scenario: Job 尚未到达重试时间
- **WHEN** 一个 Job 处于 `pending`，且其 `available_at` 在未来
- **THEN** 系统 MUST 不领取该 Job

#### Scenario: Job 到达重试时间
- **WHEN** 一个 Job 的 `available_at` 已到达且仍为 `pending`
- **THEN** 系统 SHALL 允许一个 Runner 领取该 Job

### Requirement: 安排 Job 重试或终止
系统 SHALL 仅允许持有当前 `run_token`、租约未失效且 Job 仍为 `running` 的 Runner 使 Job 成功、失败或安排重试。离开 `running` 时，系统 MUST 在同一变更中清除 `run_token` 和租约。未达到已持久化 `max_attempts` 时，重试 MUST 直接将 Job 恢复为 `pending` 并保存未来的 `available_at` 与可操作错误信息；达到上限时，系统 MUST 标记 Job 为 `failed`。

#### Scenario: 可重试失败
- **WHEN** 当前 Runner 为一次失败安排未来重试，且尚未达到最大尝试次数
- **THEN** Job SHALL 保持 `pending`，并在 `available_at` 之前不可领取

#### Scenario: 超过最大尝试次数
- **WHEN** 当前 Runner 安排重试时已达到最大尝试次数
- **THEN** Job SHALL 变为 `failed`，且不得再次被领取

### Requirement: 恢复过期的 Job 租约
系统 SHALL 将租约已过期的 `running` Job 恢复为 `pending` 或 `failed`，并清除其旧令牌和租约。未达到 `max_attempts` 的 Job SHALL 恢复为当前可领取的 `pending`；已达到上限的 Job SHALL 变为 `failed`。恢复后的 Job SHALL 保留原有 `idempotency_key`、来源 Turn 与尝试次数。

#### Scenario: Job Worker 异常退出
- **WHEN** Job 保持 `running` 且其租约到期
- **THEN** 恢复操作 SHALL 使该 Job 可由新 Runner 领取
