## Why

当前摘要调度只有全局每日一次，`github_trending` 的 `period: weekly` 只控制 GitHub 榜单窗口，无法表达“GitHub 每周推送一次、每四周再汇总一次”。同时，摘要成功后会把条目标记为已通知，四周汇总不能继续依赖未通知候选查询。现在需要把轮询周期、通知周期和历史汇总窗口明确分开，避免错过调度或重启后重复发送。

## What Changes

- 新增可配置的 digest schedules，每个 schedule 独立定义来源、发送频率、发送时间、最大条数和摘要模式。
- 支持 `daily`、`weekly` 和 `every_n_weeks` 三种通知频率；`every_n_weeks` 使用明确的 `anchorDate` 和 `intervalWeeks` 计算 28 天窗口。
- 为 GitHub Trending 提供“趋势快照周报”模式，允许每周重复展示当前榜单，即使仓库已经在上一周发送过。
- 为 GitHub 提供四周汇总模式，读取最近四个成功周报的冻结快照，按规范化仓库 URL 去重后生成汇总。
- 为每个 schedule 使用独立的周期键和幂等键；不同 schedule 在同一天可以并行创建任务，失败重试沿用同一任务。
- 保留没有 `schedules` 配置时的旧每日摘要行为，现有 RSS/Atom 订阅无需修改即可继续每日发送。
- 更新配置校验、运行文档、摘要卡片标题和测试，明确 `connectorConfig.period` 仍然只表示榜单窗口。

## Capabilities

### New Capabilities

- `periodic-digest-schedules`: 定义来源级摘要调度、周期快照、四周历史汇总和独立幂等行为。

### Modified Capabilities

- 无。当前 `openspec/specs/` 没有可修改的主规格；本变更新增完整能力规格。

## Impact

- 修改 `src/feed/config.ts`、`src/feed/digest-scheduler.ts`、`src/feed/digest.ts`、`src/feed/digest-worker.ts` 和 `src/runtime/feishu-service.ts`。
- 扩展 `src/runtime/store.ts`、`src/runtime/types.ts` 和 SQLite schema，使摘要任务保存 schedule、时间窗口和可复用的冻结快照。
- 更新 RSS/GitHub 摘要测试、配置示例、部署文档和 README。
- 不新增外部依赖，不改变 RSS/GitHub 轮询间隔，不把 GitHub 认证信息写入配置。
