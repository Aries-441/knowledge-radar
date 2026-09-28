## Purpose

为 RSS 订阅提供可读、可点击且可在发送前验证的飞书摘要卡片，让每日推送和人工预览使用同一份有界内容，同时保持现有去重、重试和通知状态语义。

## ADDED Requirements

### Requirement: Scheduled digest SHALL be rendered as a Feishu card

当每日摘要到达发送时间且存在未通知候选文章时，系统 SHALL 生成并发送一张 Feishu Interactive Card 2.0。卡片 MUST 包含摘要日期、文章数量、每篇文章的标题、来源、可用摘录和原文链接按钮；卡片 MUST 使用 `open_url` 行为打开经过 Feed 校验的文章链接。

#### Scenario: Send a card for new candidates

- **WHEN** 当天摘要 Job 被领取且包含未通知候选文章
- **THEN** 系统发送一张 Interactive Card 2.0，文章顺序、canonical URL 去重、来源优先级和最大文章数与现有摘要规则一致

#### Scenario: Skip an empty digest

- **WHEN** 摘要调度到达发送时间但没有未通知候选文章
- **THEN** 系统不创建发送 Job，也不发送空卡片

#### Scenario: Bound card content

- **WHEN** 候选文章的标题或摘录使卡片内容达到配置的文章数或字节上限
- **THEN** 系统只保留能够放入上限的完整文章条目，并保持卡片 JSON 可解析；被截断的候选仍保持未通知状态

### Requirement: Card delivery SHALL preserve notification guarantees

定时卡片发送 MUST 复用现有摘要 Job 的日期幂等、租约、重试和 token fencing。只有 Feishu API 成功返回消息 ID 后，系统 SHALL 标记本次卡片包含的候选文章为已通知；发送失败或提交失去租约时，候选文章 MUST 保持可再次发送。

#### Scenario: Mark candidates after successful card delivery

- **WHEN** Feishu API 成功返回消息 ID，且 Job 提交仍持有有效 run token
- **THEN** 系统原子记录消息结果并标记卡片中的候选文章为已通知

#### Scenario: Retain candidates after a failed card delivery

- **WHEN** Feishu API 超时、限流、权限失败或目标不可用
- **THEN** 系统不标记候选文章为已通知，并按错误类型执行现有重试或永久失败规则

### Requirement: Manual digest preview SHALL be read-only

系统 SHALL 提供 `preview-feed-digest` 手动入口，读取当前配置用户范围内的未通知候选文章，并使用与定时发送相同的卡片构建规则发送一张预览卡片或返回明确的空结果。预览 MUST 不创建 `feed_digest` Job、不改变候选文章的 `notified_at`，也不改变 Feed poll 状态。

#### Scenario: Preview available candidates

- **WHEN** 用户执行 `preview-feed-digest` 且存在未通知候选文章
- **THEN** 系统向 `FEISHU_ALLOWED_OPEN_ID` 发送一张标记为“预览”的摘要卡片，并输出消息 ID；候选文章仍可出现在下一次正式摘要中

#### Scenario: Preview with no candidates

- **WHEN** 用户执行 `preview-feed-digest` 且没有未通知候选文章
- **THEN** 系统不发送消息，输出可机器读取的 `empty` 结果，并以成功状态结束

#### Scenario: Preview send failure

- **WHEN** 预览卡片构建成功但 Feishu 发送失败
- **THEN** 系统输出安全错误码并以失败状态结束，且不创建 Job、不修改通知状态
