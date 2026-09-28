## Why

当前每日 Feed 摘要仍以纯文本发送，文章标题、来源、摘要和原文链接缺少清晰的视觉层级。刚才的卡片只能通过临时脚本发送，无法验证生产摘要内容，也无法在等待定时发送前主动查看结果。

## What Changes

- 将每日 Feed 摘要改为飞书 Interactive Card 2.0，展示摘要标题、文章条目、来源、摘录和“阅读原文”按钮。
- 保留现有日期幂等、候选去重、通知标记、失败重试和 token fencing 行为。
- 增加手动预览摘要入口，只读取当前未通知候选，不创建 `feed_digest` Job，也不标记文章已通知。
- 预览和定时发送复用同一套有界卡片构建器，保证内容、排序、去重和长度限制一致。
- 当没有候选文章时返回明确的空结果，不发送空卡片。
- 增加 Card 2.0 payload 校验、发送错误分类和伪造 Feishu transport 测试。

## Capabilities

### New Capabilities

- `feed-digest-cards`: 生成、预览并通过飞书发送 Feed 摘要卡片。

### Modified Capabilities

<!-- 当前 Feed 摘要规范仍位于未归档的 add-feed-digest-feishu change 中，尚无可修改的主规范。 -->

## Impact

- **运行时**：扩展现有摘要 worker 和 Feishu transport，加入 Card 2.0 内容构建与预览路径。
- **飞书消息**：定时摘要从 `text` 消息变为 `interactive` 消息，需要机器人具备主动发送消息权限。
- **CLI/入口**：增加一个只读的预览命令或等价服务入口，目标用户仍为 `FEISHU_ALLOWED_OPEN_ID`。
- **状态库**：不新增迁移；预览不得改变候选、Job 或通知状态。
- **依赖**：优先复用现有 SDK、SQLite 和 Feed 摘要排序逻辑，不引入新的卡片或模板依赖。
