## Context

当前 `src/feed/digest.ts` 生成单一蓝色 Card 2.0 卡片。条目只有来源文字、摘要、星标按钮和阅读全文按钮；`DigestCandidate` 从 SQLite 查询时包含 `sourceName` 和 `priority`，但没有统一的来源类型字段。GitHub 目前通过 `metadata.provider` 提供趋势信息，旧 RSS payload 可能没有 provider。

## Goals / Non-Goals

**Goals:**

- 建立来源类型到 Card 2.0 主题的纯函数映射。
- 让单来源和混合来源卡片都有稳定的抬头、来源徽标、摘要层级和操作布局。
- 保留现有摘要文本、预览、星标回调、历史 payload 和 20KB 限制。
- 让未来 connector 只需注册来源类型主题即可复用卡片布局。

**Non-Goals:**

- 不引入图片下载、远程 logo 或新的运行时依赖。
- 不改变 Feishu 回调事件、数据库 schema 或摘要调度逻辑。
- 不在本变更中实现个性化排序、评论或新的来源 connector。

## Decisions

### 1. 用结构化来源类型解析主题

为摘要候选增加可选的 `sourceKind`（例如 `rss`、`github_trending`），由来源查询补充；旧 snapshot 缺失该字段时从 `metadata.provider` 推断，再退回 `rss`/中性主题。主题 resolver 返回有限的不可变定义：

- RSS/Atom：青绿色，徽标为“博客”。
- GitHub Trending：靛蓝色，徽标为“GitHub 热点”。
- GitHub Releases：紫色，徽标为“GitHub Releases”。
- arXiv：紫色系，徽标为“arXiv”。
- Newsletter：橙色，徽标为“Newsletter”。
- 微信公众号：绿色，徽标为“公众号”。
- 未知类型：灰色，徽标为来源名称或“其他来源”。

来源 ID 和来源展示名称只作为内容，不参与颜色选择。这样改名或复制 source 配置不会产生新的视觉分支。

### 2. 混合来源使用单张卡片加来源分组

卡片抬头继续表达摘要模式和周期；条目按主题/来源分组，每组显示来源徽标和条目数。单张卡片避免每天收到多张消息，同时来源徽标和文字保证不依赖颜色也能识别来源。

每个条目的布局固定为：标题、来源与趋势元数据、短摘要、横向操作组。操作组包含星标和阅读全文两个按钮；星标 callback 的 value 完全沿用当前结构。

### 3. 把视觉映射与卡片组装分离

新增小型主题模块负责来源推断、主题定义和边界清理；`digest.ts` 只负责排序、分组、大小限制和 Card 2.0 组装。主题模块使用纯函数测试，卡片测试继续验证最终 JSON、action payload 和 UTF-8 字节数。

### 4. 兼容历史数据并保持大小预算

`sourceKind` 作为可选字段写入候选和快照，不要求迁移旧数据库。旧 payload 走 fallback 主题。条目摘要预算从固定长文本改为“标题/来源/操作优先，摘要可截断”，生成卡片和星标更新都复用 20KB 校验。

## Risks / Trade-offs

- [Card 2.0 主题颜色有限] → 只使用 Feishu 支持的 header/tag 颜色，并通过徽标文字和图标保证颜色失效时仍可读。
- [混合来源分组增加卡片结构] → 统一条目模板和摘要截断，先控制每条内容长度，再做总字节预算。
- [旧 snapshot 缺少 sourceKind] → 保留 provider 推断和中性 fallback，不让历史任务因为新字段缺失而失败。
- [横向按钮在窄屏折行] → 操作区使用短文本和星标图标，移动端视觉验证覆盖窄屏展示。

## Migration Plan

1. 先增加主题 resolver、来源类型补充和纯函数测试。
2. 更新卡片组装与现有 digest 测试，验证博客、GitHub、混合来源和旧 payload。
3. 在本地生成预览卡片并通过 Compose 发送一张博客卡片和一张 GitHub 卡片。
4. 若线上客户端对某个 Card 2.0 元素兼容性不足，回退到 markdown 来源徽标和纵向按钮，不改变回调 payload。

## Open Questions

无。颜色映射和条目操作布局已固定为可实现的默认方案，未来新增 connector 只需增加主题定义和对应测试。
