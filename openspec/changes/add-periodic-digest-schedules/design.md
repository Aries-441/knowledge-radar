## Context

现有实现只有一个全局每日摘要配置。`scheduleFeedDigestOnce` 按本地日期创建 `feed_digest` 任务，`RuntimeStore.listFeedDigestCandidates` 只返回未通知的 `candidate`，成功发送后更新 `notified_at`。这套语义适合博客新文章，但无法重复展示每周趋势榜，也无法从已发送的周报恢复四周历史。

## Goals / Non-Goals

**Goals:**

- 在一个服务进程中运行多个互不阻塞的摘要 schedule。
- 支持 GitHub 周报的当前榜单快照和每四周历史汇总。
- 为每个周期提供可计算、可恢复的 period key 和幂等键。
- 保留旧 YAML 的每日摘要行为，并兼容旧版本任务 payload。
- 让摘要卡片和反馈回调继续使用同一套 item ID 语义。

**Non-Goals:**

- 不改变 RSS/GitHub 轮询间隔和 connector 抓取协议。
- 不在本变更中记录每一次轮询的完整 rank 时间序列；需要排名变化统计时另开 observations 变更。
- 不增加评论、个性化排序或新的飞书回调 action。
- 不把“每四周”解释成自然月；周期固定按 anchorDate 加 `intervalWeeks * 7` 天计算。

## Decisions

### 1. 在 digest 下增加显式 schedules，并保留旧配置归一化

新增的规范化 schedule 类型包含 `id`、`mode`、`frequency`、`time`、`maxItems`、`sourceIds`，以及 weekly 的 `weekday` 或 every-n-weeks 的 `anchorDate`/`intervalWeeks`。`period_summary` 使用 `sourceScheduleId` 指向要汇总的 trend snapshot schedule，避免凭来源 ID 猜测历史来源。

没有 `digest.schedules` 时，把旧字段归一化为 `default-daily`、`mode: new_items` 的 schedule。存在显式 schedules 时由它们完全控制通知范围，避免旧的全局 schedule 与新 schedule 重复发送。

### 2. 将榜单窗口和通知周期分开

保留 `github_trending.connectorConfig.period` 作为抓取页面的 daily/weekly/monthly 参数。`weekly` schedule 只决定何时发送和如何选择快照，不能改变 connector 的请求路径。

### 3. 使用三种摘要模式

- `new_items`：复用现有 candidate 查询和 `notified_at`，用于兼容博客每日摘要。
- `trend_snapshot`：从配置来源中选择最近一次成功轮询的完整条目，按 rank 和现有摘要排序规则构建快照，不受 `notified_at` 限制。
- `period_summary`：读取引用 schedule 的成功 job payload 中冻结的快照，在时间窗口内按 canonical URL 去重，再构建摘要。

这样四周汇总不会因为周报已经标记条目为已通知而变成空摘要，也不需要依赖当前榜单是否仍包含已经消失的仓库。

### 4. 把 schedule 和周期窗口冻结到 job payload

将摘要 payload 升级到新版本，增加 `scheduleId`、`periodKey`、`periodStart`、`periodEnd`、`mode` 和 bounded `snapshot`。`itemIds`、`canonicalUrls`、文本和卡片仍然冻结在任务中，发送失败时重试同一个 payload。四周汇总只读取成功的 trend snapshot jobs，并使用其 payload 快照，不重新读取会变化的 feed row。

SQLite 不新增历史表：现有 jobs payload 已经是持久化的、受幂等键保护的历史记录，JSON1 查询可按 schedule 和成功状态筛选。快照条目沿用现有字段边界和卡片 20KB 限制，避免不受控增长。

### 5. 独立 schedule 的幂等与并行

周期键按全局时区计算：daily 为本地日期，weekly 为 ISO 年周，every-n-weeks 为相对于 anchorDate 的窗口序号和起止日期。幂等键为 `feed_digest:<scopeHash>:<scheduleId>:<periodKey>`。取消现有“同 scope 任意 pending/running digest 互斥”检查，改为同一 schedule 互斥；博客每日和 GitHub 周报可在同一日期各自排队。

服务重启后只补建当前周期的 due schedule，不回放无限期的历史窗口。每四周 schedule 会使用已经存在的成功周报，允许窗口内周报数量不足四个并如实汇总可用历史。

### 6. 卡片标题沿用现有结构并增加周期上下文

`buildFeedDigest` 接收 schedule label 和 period 文本，顶层标题显示“GitHub 周报”或“GitHub 四周汇总”及窗口日期。文章按钮仍位于可被现有 `updateDigestCardInterest` 扫描的顶层 body elements 中，反馈 action 不改名、不改变目标状态切换。

## Risks / Trade-offs

- **快照增加 jobs payload 体积** → 每个 schedule 受 `maxItems`、字段裁剪和现有 20KB 卡片限制；超过限制时沿用现有逐条截断。
- **仅保留周报快照，不能计算精确的四周排名变化** → 先保证可读汇总；排名观察历史另开独立变更。
- **旧数据库包含旧版本 payload** → worker 保留 v1/v2 文本任务解析，新的 v3 只在新镜像创建；部署前沿用现有备份和回滚流程。
- **跨周同一仓库重复出现** → 这是趋势快照的有意行为；四周汇总按 canonical URL 去重，展示一次并保留最新快照信息。

## Migration Plan

1. 先备份现有 `radar.db`，部署包含 schedule 解析和 payload 兼容的镜像。
2. 将 `feeds.yaml` 增加 GitHub source 以及 weekly/four-week schedules；博客若需每日发送则显式增加 `blogs-daily` schedule。
3. 重启 Compose，检查配置校验、首次 GitHub baseline 和 `feed_poll` 日志；baseline 不会立即产生周报。
4. 等待一个成功的 GitHub 快照后，用预览或测试时间注入验证 weekly job，再验证四周窗口聚合。
5. 回滚时停止服务并同时恢复旧镜像和备份数据库，避免旧版本读取未支持的 schedule payload。
