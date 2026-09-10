## Why

当前公开文章采集闭环直接在命令进程中顺序执行，进程退出后无法知道一项工作是否已领取、应重试还是已产生待发送结果。飞书、连续对话和登录态接入前，需要先建立唯一、可恢复的本地运行状态来源，避免把可靠性规则分散到后续各适配器中。

## What Changes

- 使用 Node 内置 `node:sqlite` 创建并升级唯一的 `radar.db`，保存最小 Conversation、Turn、Job 和 Outbox 状态；不接入 Pi 的 Session Backend。
- 提供 Conversation 内 FIFO 的 Turn 入队与原子领取，使用 `run_token`、租约、`available_at` 和持久化的最大尝试次数防止重复处理或无限重试。
- 提供 Job 与最终消息 Outbox 的持久化入队、原子领取、令牌校验、延迟重试和过期租约恢复；Job 可选地关联来源 Turn。
- 用可控时钟、令牌工厂和临时 SQLite 文件验证竞争领取、旧令牌写回、重试时间、尝试耗尽与重启恢复。

本 Change 不接入飞书、Agent、Playwright 持久化 Profile、真实网络调用、真实消息投递或 Markdown 归档补偿，也不改变现有 CLI 的公开文章采集路径。飞书状态卡、消息 revision 和可替代状态更新将在飞书入口 Change 中迁移加入，不进入 v1 Outbox。

## Capabilities

### New Capabilities

- `runtime-state-store`: 初始化、升级和关闭应用唯一的 SQLite 运行状态库。
- `runtime-turn-queue`: 为单个 Conversation 持久化、按序领取、完成和延迟重试 Turn。
- `runtime-job-queue`: 持久化可选来源 Turn 的 Job，并以租约、可用时间和持久化重试上限执行可恢复的后台工作调度。
- `runtime-outbox-queue`: 持久化每个 Turn 的不可变最终消息，并以独立租约和重试状态支持未来的通知适配器。

### Modified Capabilities

- 无。

## Impact

- 新增 `src/` 中的 SQLite 状态模块及对应 Node Test Runner 测试；不新增 npm 依赖。
- `package.json` 的 Node 运行时要求继续满足 `node:sqlite`，数据库文件默认存放在容器状态卷而不是知识库目录。
- 后续飞书、Agent 和归档实现只能通过这些状态操作创建或领取工作，不能各自维护内存队列。
