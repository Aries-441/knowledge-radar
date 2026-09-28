## 1. 来源类型与 connector registry

- [x] 1.1 定义统一 `SourceConfig`、`SourceKind`、标准化快照和 connector 错误类型，并实现显式 registry；用类型测试和 RSS connector contract 测试验证未知类型不会静默回退
- [x] 1.2 将现有 RSS/Atom HTTP 获取与解析包装为 `rss` connector，保持条件请求、SSRF 防护、超时、响应大小、重定向和错误分类；运行现有 parser/worker 测试确认行为不变

## 2. 配置与持久化来源状态

- [x] 2.1 扩展 Feed 配置解析，支持规范化的 `sources` 入口，将旧 `feeds` 规范化为 `kind: rss`，拒绝同时配置两个入口、未知类型、凭据 URL 和非法 connector 配置；补充配置单元测试
- [x] 2.2 将 `FeedSource` 状态扩展为来源类型和受控 connector 配置，增加 schema v6 前向迁移、序列化和高版本拒绝测试；验证旧 RSS 来源自动填充 `rss` 与空配置且不丢失文章和 Job
- [x] 2.3 更新来源同步逻辑，保留 `syncFeedSources` 等兼容包装；当来源类型或 connector 配置变化时清除旧缓存和基线并保持来源条目隔离；用 SQLite 测试验证 URL/类型变更和禁用来源语义

## 3. 调度、worker 与摘要兼容

- [x] 3.1 让 scheduler 和 store 以来源 ID 创建版本 2 `feed_poll` payload，同时写入兼容的 `feedId`；worker 读取新旧两种 payload，验证幂等键、租约、恢复和 token fencing 不变
- [x] 3.2 让 feed worker 通过 registry 调用 connector，并把标准化快照提交到现有 baseline/candidate/去重状态；用假 RSS connector 测试成功、304、失败重试、未知类型永久失败和混合 Job 隔离
- [x] 3.3 更新 `serve-feishu`、每日摘要 scheduler、预览入口和现有 Feed 文档使用规范化 sources，同时保留旧 feeds 配置运行；验证摘要卡片、预览和候选通知回归测试通过

## 4. 文档与部署兼容

- [x] 4.1 更新 README、Feed 配置、部署和回滚文档，说明 `sources`、RSS connector registry、schema v6 备份恢复和后续 GitHub/微信等 connector 的扩展边界；确认现有 Compose overlay 和状态 volume 配置不变

## 5. 验收

- [x] 5.1 运行 `npm test`、`npm run check`、`npm run build` 和 `openspec validate add-source-connectors --strict`，确认所有配置、迁移、connector、轮询和兼容测试通过
- [x] 5.2 在本地 SQLite、伪造 RSS connector 和 Docker Compose 配置下完成“旧 feeds 配置 → RSS connector → baseline/candidate → digest”以及“新 sources 配置 → registry 分发 → 重启恢复”两条端到端验收
