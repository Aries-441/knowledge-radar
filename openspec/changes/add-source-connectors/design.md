## Context

当前 `FeedConfig` 只有 `feeds`，`feed_sources` 只保存 URL 与 RSS 缓存字段，`feed_poll` worker 直接调用 RSS parser。摘要和通知已经依赖 `feed_items` 的统一条目模型，因此扩展来源时应保留现有状态链路，只替换“如何取得标准化快照”这一段。

## Goals / Non-Goals

**Goals:**

- 用一个明确的来源配置和 connector registry 承载不同来源类型。
- 将现有 RSS/Atom parser 包装为第一个 connector，保持现有轮询和安全行为。
- 让配置、SQLite 状态和 Job payload 可以从 `feeds` 平滑过渡到来源模型。
- 让后续 connector 只需实现快照获取，不重复实现去重、基线、重试、摘要和通知。

**Non-Goals:**

- 本 change 不实现 GitHub、微信公众号、Newsletter 或 arXiv 的外部 API 访问。
- 不引入动态 npm 插件、独立进程、消息队列或新的数据库。
- 不改变每日摘要的排序、Card 2.0、预览或飞书发送语义。

## Decisions

### 1. 用标准化快照隔离来源差异

新增来源类型和快照类型。connector 只负责把外部响应转换为快照；快照中的条目字段继续使用现有 `NormalizedFeedItem` 形状。这样 RSS、GitHub repository、Newsletter 条目和 arXiv 论文都可以进入同一张 `feed_items` 表，由后续 change 增加自己的元数据或摘要展示。

connector 不直接拿 `RuntimeStore`，也不在事务内执行网络请求。worker 负责 connector 调用、租约处理和快照提交，保留现有“外部 I/O 在事务外、状态提交在短事务内”的边界。

备选方案是为每个来源建立独立表和独立 worker；这会复制候选、幂等和恢复逻辑，因此不采用。

### 2. `sources` 是新入口，`feeds` 是显式兼容别名

配置解析器新增 `sources`，当前只接受已注册的 `rss` 类型。旧 `feeds` 条目在解析阶段补上 `kind: rss` 和空 connector 配置。返回的运行时配置同时提供规范化的 `sources` 和兼容用的 `feeds` 别名，现有调用方可以逐步迁移。

同一文件同时使用两个入口直接报错；不做隐式合并，避免重复 ID、优先级覆盖和禁用状态不一致。后续 connector 只扩展来源 union 和 registry，不再扩展 `feeds` 专用字段。

### 3. 保留 `feed_sources` 表名，增加 connector 元数据

现有状态库已经使用 `feed_sources` 和 `feed_items`，本 change 不改表名。schema v6 为 `feed_sources` 增加：

- `kind TEXT NOT NULL DEFAULT 'rss'`；
- `connector_config_json TEXT NOT NULL DEFAULT '{}'`，只保存经过配置校验的非机密选项。

`url` 继续保存来源的公开入口或 API endpoint，已有 ETag、Last-Modified、基线和检查时间继续复用。`FeedSource` 运行时对象增加 `kind` 和解码后的 `connectorConfig`。

来源 ID 的 `kind` 或 connector 配置改变时，`syncSources` 清除该来源的缓存标记、基线游标和已有条目，沿用 URL 变化时的重新基线行为；这样不会把旧 connector 的身份误判为新 connector 的候选。

备选方案是把 connector 配置编码进 URL；这会污染 URL 去重、日志和安全检查，无法维护，因此不采用。

### 4. Registry 显式注册 connector

registry 使用 `Map<SourceKind, SourceConnector>`，启动配置校验和 worker 获取阶段都通过同一 registry。当前注册 `rss` connector，内部复用现有受控 HTTP、SSRF 检查、响应大小、超时、重定向、条件请求和 RSS/Atom parser。

未注册的来源类型是配置错误；如果状态库中出现已移除类型，则只把对应轮询 Job 标记为永久失败并记录安全错误，不影响其他来源。registry 不加载任意本地模块，避免配置文件获得代码执行能力。

### 5. Job payload 采用可回滚的双读格式

新调度 Job 使用版本 2 payload `{ version: 2, sourceId }`，幂等键仍为 `feed_poll:<sourceId>:<slot>`。worker 和 store 读取时优先使用 `sourceId`，没有时回退到旧 payload 的 `feedId`。这样旧版本创建的 pending/running Job 可以由新版本恢复，回滚到旧版本时新版本的 payload 仍保留可读的 `feedId` 兼容字段，避免改变旧 worker 的读取契约。

实际写入时同时保存 `sourceId` 和 `feedId` 两个相同值，直到后续独立 change 删除旧字段；这让一次迁移的回滚窗口保持简单。

### 6. 兼容旧运行时 API，逐步改名

新增 `syncSources`、`listSources` 等面向来源的内部入口；现有 `syncFeedSources`、`listFeedSources` 在本 change 保留为薄包装，避免一次改动触及所有测试和服务调用。新代码优先使用来源命名，旧包装不再增加新行为。

## Risks / Trade-offs

- **RSS 兼容字段与来源字段并存** → 解析阶段只保留一份规范化数组，`feeds` 仅是同一数组的兼容别名；测试覆盖两种入口和同时配置时的拒绝。
- **schema v6 无法被旧程序打开** → 按现有前向版本规则拒绝旧程序直接打开；部署前备份 v5 数据库，回滚时恢复数据库和旧镜像配对，不删除状态 volume。
- **connector 配置可能包含秘密** → schema 只允许受控 JSON 字段；认证信息使用未来 connector 的环境变量引用，不写入 `connector_config_json`、错误信息或结构化日志。
- **不同来源的条目语义不同** → connector 只能返回统一标题、摘要、URL、时间和身份；GitHub 趋势分数、公众号作者等专用字段留给后续 metadata change，不把任意外部 JSON 写入现有摘要字段。
- **来源类型缺失或已移除** → 启动配置错误和运行时永久失败分别处理，错误只包含来源 ID、类型和安全错误码。

## Migration Plan

1. 先运行现有测试，新增 connector contract、配置别名和 migration 测试。
2. 发布 schema v6 migration：为已有 `feed_sources` 填充 `kind = 'rss'`、`connector_config_json = '{}'`，不重建或删除文章和 Job 表。
3. 保持现有 `feeds.yaml` 启动方式，验证 RSS baseline、candidate、digest 和 preview 不变；再允许使用等价的 `sources` 配置。
4. 检查混合 Job、重启恢复和高版本数据库拒绝路径。
5. 回滚时停止新程序，恢复 v5 数据库备份和旧镜像；不让旧程序直接打开 v6 状态库。
