## Why

当前摘要卡片只有统一的蓝色抬头，博客、GitHub Trending 和未来的其他来源在视觉上难以区分；文章标题、来源信息、趋势元数据和操作按钮也没有形成稳定的信息层级。现在订阅来源已经开始增多，应先建立可复用的来源主题和卡片布局，降低阅读成本并为后续 connector 留出扩展边界。

## What Changes

- 为摘要卡片建立按来源类型解析的主题系统，区分 RSS/Atom 博客、GitHub Trending，并为 GitHub Releases、arXiv、Newsletter 和微信公众号保留明确的 fallback 扩展位。
- 将来源主题应用到卡片抬头、来源徽标、摘要周期和趋势元数据展示，不按具体 source ID 写死样式。
- 重排文章条目布局，突出标题、来源和摘要，把星标与“阅读全文”操作放入同一组横向操作区域。
- 限制标题、摘要、来源徽标和元数据的长度，保持 Card 2.0 的 20KB 上限和现有回调 payload 不变。
- 保持旧版摘要 payload、文本摘要、预览命令和 `digest_interest` 星标切换兼容。

## Capabilities

### New Capabilities

- `source-card-themes`: 定义来源主题解析、卡片视觉层级、来源徽标和可扩展的 fallback 行为。

### Modified Capabilities

<!-- No existing main capability spec is present in this repository. -->

## Impact

- 主要影响 `src/feed/digest.ts` 及其 Card 2.0 测试。
- 可能扩展 `DigestCandidate` 的来源类型信息，使主题解析不依赖 source ID 或展示名称。
- 更新 feed ingestion、Feishu 使用文档和卡片截图/验收记录。
- 不新增运行时依赖，不改变 SQLite schema，不改变 Feishu 回调事件名称和 action payload 结构。
