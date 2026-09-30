## Context

现有 `src/feed/source.ts` 使用显式 registry，目前只有 RSS connector；`src/feed/parser.ts` 已经承担 HTTP 超时、响应大小、重定向、DNS/SSRF 和条件请求边界，但输出模型只包含通用 Feed item 字段。运行时数据库当前为 schema v7，摘要排序主要依赖发布时间和来源优先级。

本变更需要让 GitHub 趋势信息进入同一条 baseline/candidate/digest 流程，同时保留排名、语言和 star 增长这些 RSS 没有的字段。详细行为约束以 `specs/github-trending-source/spec.md` 为准。

## Goals / Non-Goals

**Goals:**

- 在不引入登录态和必需 token 的前提下读取公开 GitHub Trending 页面。
- 以可测试的纯解析器把 HTML 转换为统一的 `ParsedFeed`，并复用现有轮询、去重、重试和摘要流程。
- 保存有界的 connector metadata，使摘要能够稳定展示排名、语言和趋势 star 信息，并让相同来源按排名输出。
- 保持现有 RSS 配置、旧数据库和 `feeds` 兼容入口可升级。

**Non-Goals:**

- GitHub OAuth、私有仓库、用户个性化推荐和 GitHub GraphQL/API token 管理。
- 本变更不增加每周摘要调度；周摘要 cadence 由后续变更负责。
- 本变更不增加评论、收藏列表或新的飞书回调 action；GitHub 条目复用现有 digest interest 语义。

## Decisions

### 1. 使用公开 Trending HTML，而不是 GitHub Search API

GitHub Search API 能按 star 数排序，但不能直接提供 Trending 页面展示的周期性 star 增长值；公开 Trending 页面同时包含排名、语言、描述和周期信息。connector 使用受限的 HTTP 请求读取页面，解析逻辑与网络逻辑分离。

替代方案是要求用户配置 GitHub token 并自行计算快照差值。该方案增加凭据生命周期和 API 限流复杂度，且第一版无法覆盖页面上的趋势字段，因此暂不采用。

### 2. 将 connector 配置限制在来源 URL、周期和单语言

来源仍使用现有 `url` 字段，默认值为 `https://github.com/trending`；`connectorConfig.period` 默认 `weekly`，`connectorConfig.language` 默认 `all`。语言值只作为 GitHub Trending 路径片段使用，并在配置阶段拒绝空白、路径分隔符和未支持的选项。

不在第一版支持多个语言并行抓取。多语言会引入同一仓库跨请求去重、配额放大和排序合并问题，等单一来源稳定后再单独设计。

### 3. 为 Feed item 增加有界 connector metadata

在 `NormalizedFeedItem` 和 `FeedItem` 增加可选 metadata 对象，并在 SQLite `feed_items` 增加 `metadata_json`，schema 从 v7 迁移到 v8；旧行默认 `{}`。GitHub item metadata 只允许有限字段：`provider`、`rank`、`language`、`starsPeriod`、`starsDelta`，每个字符串和数字都要经过大小及类型限制。

RSS item 写入空对象，现有序列化和摘要行为保持不变。摘要排序在 metadata 包含合法 `rank` 时优先按 rank，否则继续使用原有发布时间、来源优先级和 identity 规则。卡片展示使用一个小型 metadata formatter，解析失败时回退到普通标题、来源和摘要。

### 4. 复用并抽取现有 HTTP 安全边界

从 RSS parser 抽取共享的有界 HTTP 请求辅助函数，GitHub connector 复用相同的超时、最大响应字节数、重定向限制、DNS/私网地址拦截、AbortSignal 和 `etag` / `last-modified` 处理。connector 额外校验最终 URL 仍属于允许的 GitHub Trending 主机，避免通过重定向访问任意站点。

解析器只接受 HTML 文本，并将单个项目数量限制在来源 `itemLimit` 以内。HTML 页面成功但没有有效仓库时返回不可重试的 parse error，防止空页面被误当成一次成功的空基线。

### 5. 通过 fixture 和 connector contract 测试固定外部协议

新增包含 daily、weekly、monthly 结构及页面结构变化的本地 HTML fixture。测试覆盖配置标准化、稳定 identity、metadata 边界、rank 顺序、304、超限、重定向/SSRF、解析失败和 worker 的 baseline/candidate 提交；测试网络只使用注入的 fetch 实现，不连接实时 GitHub。

## Risks / Trade-offs

- **[GitHub 调整 Trending HTML 结构]** → 将选择器集中在独立解析器，fixture 发现结构变化后返回明确 parse error，不写入部分结果。
- **[公开页面被限流或短暂不可用]** → 复用条件请求和现有指数退避；单来源失败只影响自己的 Job。
- **[metadata 迁移扩大数据库变更面]** → v8 migration 使用默认空 JSON，旧条目无需回填；部署前备份数据库，回滚同时恢复旧代码和 v7 数据库。
- **[趋势字段在页面上缺失或格式变化]** → 项目仍可作为普通条目保存，缺失字段只记录为 null；只有没有任何有效仓库时才判定解析失败。
- **[解析 HTML 引入较重运行时开销]** → 限制响应大小和项目数量，解析只保留必要 DOM 节点，不启动浏览器。

## Migration Plan

1. 停止服务并备份当前 v7 SQLite 数据库。
2. 部署包含 v8 migration 和 connector 的版本；启动时将旧 `metadata_json` 初始化为空对象。
3. 在 YAML 中新增一个 `github_trending` 来源，先将 `enabled` 设为 false 完成配置校验，再启用并手动运行一次轮询/预览。
4. 确认首次成功响应建立 baseline、不会立即发送历史项目；第二次 fixture 或真实轮询出现新 identity 后再验证摘要和星标反馈。
5. 回滚时停止服务，恢复之前的镜像和 v7 数据库；旧代码不得打开 v8 数据库。
