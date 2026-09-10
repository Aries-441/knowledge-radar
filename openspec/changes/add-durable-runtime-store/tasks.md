## 1. SQLite 状态库基础

- [x] 1.1 新增应用拥有的 `radar.db` 打开、关闭与 `PRAGMA user_version` 迁移模块，创建 v1 的 `conversations`、`turns`、`jobs`、`outbox` 表、外键和领取索引；通过临时数据库测试首次创建、重开保留记录、升级与未来版本拒绝。
- [x] 1.2 建立最小记录类型、JSON 载荷编解码、可注入时钟和令牌工厂，以及短 `BEGIN IMMEDIATE` 事务辅助；配置有限 busy timeout，并将超时后的 `SQLITE_BUSY` 映射为可重试的存储忙错误。
- [x] 1.3 通过竞争测试验证：两个 Runner 争抢一条记录时，至多一个领取成功；另一个仅得到无候选或可重试的存储忙错误。

## 2. Conversation 与 Turn 队列

- [x] 2.1 实现创建 Conversation 与按递增序号创建 Turn，持久化 `available_at`、`attempts` 和 `max_attempts`；验证同一 Conversation 序号唯一，以及非法重试上限被拒绝。
- [x] 2.2 实现 Conversation 内 FIFO 的 Turn 原子领取：只领取最早的已到期 `queued` Turn，写入 `running`、`run_token`、租约并递增尝试次数；验证前序 `running` 或未来 `queued` Turn 阻塞后续 Turn。
- [x] 2.3 实现带令牌与有效租约校验的 Turn 完成、失败、续租、延迟重试和过期恢复；离开 `running` 时清除令牌与租约，并验证旧令牌、失效租约与耗尽尝试次数均不能产生错误写回。
- [x] 2.4 实现“完成已领取 Turn 并创建唯一最终 Outbox”的单一事务；验证提交失败不留下部分状态，且重复调用不会创建第二条最终 Outbox。

## 3. Job 队列

- [x] 3.1 实现带可空 `origin_turn_id` 和唯一 `idempotency_key` 的 Job 入队/既有记录返回语义；验证 Job 可以没有来源 Turn，重复请求只保留一条记录。
- [x] 3.2 实现 Job 的已到期 `pending` 原子领取、令牌校验完成、延迟重试和尝试耗尽失败；验证未来 `available_at` 前不可领取，且 `max_attempts` 在重开数据库后仍生效。
- [x] 3.3 实现过期 `running` Job 恢复：未耗尽时恢复为当前可领取的 `pending`，耗尽时变为 `failed`；两种路径均清除旧令牌和租约并保留幂等键、来源 Turn 与尝试次数。

## 4. 最终消息 Outbox 队列

- [x] 4.1 实现只含不可变最终消息的 Outbox 入队，使用 `(turn_id, kind)` 唯一约束返回既有记录；不实现 `lane`、`revision`、状态卡或冗余 Conversation/序号字段。
- [x] 4.2 实现通过 Turn 的 Conversation 和序号推导的 Outbox 有序原子领取；验证同一 Conversation 内较早的非终态 Outbox 阻塞较晚记录，已 `sent` 或 `failed` 的较早记录不阻塞。
- [x] 4.3 实现带令牌与有效租约校验的 Outbox `sent`、延迟重试、失败和续租；离开 `sending` 时清除令牌与租约，并验证旧令牌无法写回。
- [x] 4.4 实现过期 `sending` Outbox 的恢复：未耗尽时恢复为当前可领取的 `pending`，耗尽时变为 `failed`；验证恢复后可由新 Runner 领取。

## 5. 变更验收

- [x] 5.1 运行新增状态库测试和现有采集测试，执行 `npm test`、`npm run check`、`npm run build`；确认本 Change 未改变公开文章 CLI 的现有行为。
- [x] 5.2 运行 `openspec validate add-durable-runtime-store --strict`，并人工检查 proposal、design、tasks、四份 capability specs 与会话状态机文档对 v1 边界、状态名和原子事务边界的描述一致。
