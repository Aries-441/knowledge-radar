## Why

Knowledge Radar 当前已经能接收用户主动发送的文章链接，但还没有实现项目最初定位中的“技术信息雷达”：持续读取关注的博客更新、记录新增文章并形成后续摘要的候选集合。没有持久化的 Feed 状态、首次基线和去重，后续每日摘要会产生历史文章轰炸、重复文章和重启后重复处理。

本变更先建立可靠的 Feed 摄取底座。它让 RSS/Atom 来源可以由本地配置管理，轮询结果可以在进程重启后继续使用，并为后续每日摘要变更提供稳定的候选文章数据。

## What Changes

- 增加本地 YAML Feed 配置及启动时校验；首版修改配置后重启生效，不增加飞书内订阅管理。
- 增加 RSS 2.0 和 Atom Feed 的受控获取、解析、字段归一化与安全错误分类。
- 将 Feed 来源、HTTP 缓存标记、最近检查状态和 Feed 文章元数据持久化到现有 SQLite 状态库。
- 增加首次成功同步的基线语义：历史文章只建立基线，不进入通知候选。
- 增加按 Feed 文章身份去重，并保留 canonical URL 供后续跨 Feed 去重。
- 增加轮询 Job 的幂等键、租约、重试、过期恢复和按 `kind` 隔离领取。
- 将 Feed 轮询接入现有 `serve-feishu` 进程生命周期；服务启动后执行一次到期检查，之后按配置间隔调度。
- 对 Feed URL、重定向、响应大小、超时和解析失败建立明确的可重试/不可重试结果；日志不记录正文或敏感配置。
- 增加 v4 状态库迁移和离线验收，保留现有会话、文章采集 Job、回复 Outbox 及其恢复语义。

本变更明确不包含：每日摘要生成、模型筛选、正文批量抓取、飞书主动消息投递、Markdown 归档、通过飞书管理订阅、需要认证的 Feed 和 Web 管理页面。这些能力依赖本变更产出的 Feed 候选数据，由后续变更实现。

## Capabilities

### New Capabilities

- `feed-ingestion`: 本地 Feed 配置、RSS/Atom 轮询、首次基线、文章去重、持久化 Feed 状态和可恢复轮询 Job。

### Modified Capabilities

- 无。当前 `openspec/specs/` 中没有已发布的 Feed 能力规范；现有飞书和 runtime 约束属于此前变更的规范与实现基线，本变更通过设计和迁移保持其行为。

## Impact

- **运行时**：扩展 `src/runtime/schema.ts`、`src/runtime/store.ts` 和 `src/runtime/feishu-service.ts`，加入 Feed 表、轮询 Job kind 隔离、Feed worker 与 scheduler loop。
- **内容层**：新增 Feed 配置、解析、规范化和受控 HTTP 模块；预期使用 `rss-parser`，调度器是否引入 Croner 在设计中确定，不能让内存定时器承担幂等。
- **配置与部署**：增加配置文件路径和 Compose 只读挂载；没有 Feed 配置时保持现有飞书聊天和文章采集行为。
- **数据库**：schema 从 v3 升级到 v4，只新增 Feed 相关表和索引，不重建或放宽现有会话回复 Outbox 的约束。
- **测试与文档**：增加解析、基线、去重、HTTP 缓存、迁移、重启恢复和混合 Job 队列测试，并更新使用、部署和路线图文档。
