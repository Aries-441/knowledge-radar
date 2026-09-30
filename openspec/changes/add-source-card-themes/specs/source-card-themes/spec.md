## Purpose

让同一张摘要卡片能够清楚区分不同来源，同时建立稳定的标题、来源、摘要和操作层级，使新增 connector 可以复用视觉规则而不需要重新设计整张卡片。

## ADDED Requirements

### Requirement: 来源主题必须由来源类型决定

系统 SHALL 根据来源类型或 connector provider 解析有限的主题定义，主题至少包含抬头模板、来源徽标文本、徽标颜色和无障碍文本。主题解析 MUST 优先使用结构化来源类型，不得根据具体 source ID 或展示名称写死样式。

#### Scenario: RSS 与 GitHub 使用不同主题

- **WHEN** 摘要同时包含 RSS/Atom 条目和 GitHub Trending 条目
- **THEN** 系统为两类条目显示不同的来源徽标和主题颜色，并保留各自的来源名称

#### Scenario: 未知来源使用稳定 fallback

- **WHEN** 摘要包含未注册主题的来源类型或旧 payload 没有来源类型
- **THEN** 系统使用中性 fallback 主题，继续显示来源名称，不阻止整张卡片生成

### Requirement: 卡片必须提供清晰的信息层级

摘要卡片 SHALL 将摘要周期和总条目数放在抬头或摘要区，将来源主题放在来源分组或条目元数据区，将标题放在摘要前面，将操作按钮放在每个条目的统一操作区。混合来源卡片 MUST 能在不依赖颜色的情况下通过文字或图标识别来源。

#### Scenario: GitHub 周报展示趋势信息

- **WHEN** 系统生成 GitHub `trend_snapshot` 周报
- **THEN** 卡片显示周报周期、GitHub 来源徽标、仓库标题、语言、趋势周期和 star 增长信息，并将文章操作放在同一行或同一操作组

#### Scenario: 博客 daily 摘要展示文章信息

- **WHEN** 系统生成 RSS/Atom `new_items` daily 摘要
- **THEN** 卡片显示博客来源徽标、文章标题、摘要和阅读全文操作，且不显示空的 GitHub 趋势字段

### Requirement: 视觉改造必须保持交互和兼容性

系统 MUST 保持 `digest_interest` action 名称、`item_id` 和 `target_interested` 字段不变。星标按钮 MUST 继续根据当前状态显示选中或未选中图标，点击后只更新对应条目的按钮状态。旧版 v1/v2 payload 和无主题字段的历史卡片 MUST 能继续发送或处理回调。

#### Scenario: 星标切换不受主题影响

- **WHEN** 用户点击任一来源条目的星标按钮
- **THEN** 系统发送现有 `digest_interest` 回调并只切换该条目的星标状态，来源主题和其他条目保持不变

#### Scenario: 历史 payload 继续发送

- **WHEN** worker 读取没有来源主题字段的旧摘要 payload
- **THEN** 系统使用 fallback 主题生成兼容卡片或文本，不因主题缺失而使任务失败

### Requirement: 卡片必须受大小和内容边界约束

系统 SHALL 对标题、摘要、来源徽标、趋势元数据和按钮文本执行现有长度限制，并在生成和更新卡片后继续满足 20KB UTF-8 限制。超出限制时系统 MUST 按稳定顺序截断条目内容，不得截断 action payload 或破坏 JSON 结构。

#### Scenario: 多来源卡片接近大小上限

- **WHEN** 多个来源的摘要内容使卡片接近 20KB
- **THEN** 系统保留已选条目的标题、来源徽标和可用操作，优先截断摘要文本，并生成不超过 20KB 的有效卡片
