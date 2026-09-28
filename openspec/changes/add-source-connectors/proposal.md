## Why

当前订阅链路把来源、配置、抓取和 RSS/Atom 解析绑定在 `FeedSourceConfig`、`feed_sources` 和 `feed_poll` worker 中。接入 GitHub 热点、微信公众号、Newsletter 和 arXiv 时，如果继续为每种来源复制一套轮询、去重、基线和摘要逻辑，代码会产生多条难以维护的状态链路。

现在先建立统一的来源模型和 connector registry，可以让所有来源复用同一套候选文章、幂等 Job、重试、摘要和飞书通知语义，同时保持现有 RSS/Atom 配置和数据继续可用。

## What Changes

- 增加统一的 `SourceConfig`、`SourceKind`、标准化来源快照和 connector 接口。
- 增加 connector registry；本 change 注册并迁移现有 RSS/Atom connector，保持解析、条件请求、SSRF 防护和失败分类不变。
- 配置支持新的 `sources` 入口，并将现有 `feeds` 作为兼容别名规范化为相同的来源配置；同一配置文件不允许同时使用两个入口。
- 为来源记录持久化 connector 类型和受控的 connector 配置，现有 RSS 来源默认迁移为 `rss`。
- 让轮询调度、worker、候选存储和摘要读取统一面向来源 ID，保留旧 `feed_poll` Job payload 的读取兼容。
- 增加来源类型、配置校验、registry 分发、迁移和旧配置回归测试。
- 更新 Feed 文档，说明 `sources` 配置和后续 connector 的扩展方式。

本 change 不实现 GitHub、微信公众号、Newsletter 或 arXiv 的具体 connector；这些 connector 在统一接口稳定后分别推进。

## Capabilities

### New Capabilities

- `source-connectors`: 统一来源配置、connector registry、标准化快照、RSS/Atom 兼容迁移和来源轮询边界。

### Modified Capabilities

- 无。现有 RSS/Atom 的外部行为保持不变，本 change 只增加兼容配置入口和内部扩展边界。

## Impact

- 影响 `src/feed/config.ts`、`src/feed/parser.ts`、`src/feed/worker.ts`、`src/feed/scheduler.ts` 和 `src/runtime/store.ts`。
- 影响 SQLite schema 版本和来源序列化；需要可回滚的迁移，不删除现有状态 volume。
- 不新增第三方依赖；GitHub 和其他外部来源的认证、限流和 API 依赖留给后续 connector change。
- 现有 `feeds.yaml`、Compose overlay、每日摘要和预览命令继续可用。
