## Why

Feed 抓取已经能够建立 baseline 并保存新的 `candidate` 文章，但这些候选目前只存在于 SQLite 中，用户仍需要手动查询数据库才能看到更新。Knowledge Radar 的下一步需要把候选文章按天汇总，并通过现有飞书机器人主动发送给配置的用户。

## What Changes

- 增加按 IANA 时区运行的每日 Feed 摘要调度。
- 将当天尚未发送的 `candidate` 文章按来源去重、排序并生成有界的纯文本摘要。
- 通过现有 Feishu 应用以主动单聊消息发送摘要到 `FEISHU_ALLOWED_OPEN_ID`。
- 为摘要创建可恢复、可重试且幂等的持久化 Job；服务重启或发送失败不会丢失候选文章。
- 发送成功后记录候选文章的通知状态，避免重复出现在后续摘要中。
- 增加消息长度限制、空摘要跳过、发送失败分类和安全日志。
- 更新 Feed 配置、Feishu 权限、部署与验证文档。

## Capabilities

### New Capabilities

- `feed-digest-feishu`: 将 Feed 候选文章按日汇总，并通过 Feishu 机器人主动发送给配置用户。

### Modified Capabilities

- 无。当前 `openspec/specs/` 没有已发布的 Feed 摘要或主动通知能力规范。

## Impact

- **运行时**：扩展 Feed 配置、SQLite schema、Feed scheduler/worker 和 `serve-feishu` 生命周期。
- **飞书适配器**：在保留现有回复消息行为的同时，增加以 `open_id` 为目标的主动文本消息发送。
- **数据状态**：为候选文章增加通知状态，并为每日摘要增加持久化 Job 与幂等键；需要向前迁移现有 v4 数据库。
- **配置与权限**：复用现有 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_TENANT_KEY` 和 `FEISHU_ALLOWED_OPEN_ID`，应用需要具备发送机器人消息的权限。
- **范围**：本变更先发送 Feed 元数据和 RSS 摘要，不批量抓取文章正文，也不引入模型生成摘要。
