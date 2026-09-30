## 1. 配置模型与周期计算

- [x] 1.1 扩展 `FeedConfig` 的 digest schedule 类型、默认归一化和字段校验；配置测试覆盖 daily、weekly、every_n_weeks、来源引用以及非法日期、weekday 和 ID。
- [x] 1.2 实现基于时区的 daily、ISO weekly 和 anchor-relative every_n_weeks 周期计算；边界测试覆盖跨月、跨年、夏令时和错过发送时间。

## 2. 摘要快照与持久化任务

- [x] 2.1 扩展摘要 payload 和反序列化类型，保存 schedule、period、mode、冻结快照并兼容 v1/v2 payload；用 round-trip 测试验证字段边界。
- [x] 2.2 在 RuntimeStore 中增加按来源查询新候选、趋势快照和成功历史快照的路径；验证已通知条目可进入 trend snapshot，四周窗口按 canonical URL 去重且不读取其他 scope。
- [x] 2.3 将摘要幂等键改为 schedule + scope + period，并将 pending/running 互斥范围收窄到同一 schedule；并行 schedule、重启恢复和重复调度测试验证不会重复建 job。

## 3. 调度与发送

- [x] 3.1 重写 digest scheduler，使每个 due schedule 独立补建当前周期任务，并让 period summary 读取引用 schedule 的成功快照；调度测试覆盖周报、四周汇总、空历史和错过时间窗口。
- [x] 3.2 更新 digest worker 处理新 payload、冻结快照和失败重试，同时保留旧文本任务；worker 测试验证同一 job 重试只发送一次并正确提交 notified 状态。
- [x] 3.3 更新 Feishu service 启动多个 schedule 循环并保持 feed poll 循环不变；service 集成测试验证博客 daily 与 GitHub weekly 在同一天都能创建和发送。

## 4. 卡片与反馈

- [x] 4.1 为 daily、weekly、period summary 生成带周期标题的文本和 Card 2.0 内容，并保持 item、canonical URL 和 star 回调值冻结；摘要卡片测试验证标题、历史条目和 20KB 限制。
- [x] 4.2 验证现有 `digest_interest` 回调在周报和四周汇总卡片上继续切换状态；Feishu service 回调测试覆盖重启后读取历史消息和重复事件。

## 5. 配置、文档与端到端验证

- [x] 5.1 更新 feeds.yaml 示例、feed ingestion/deployment/README 文档，说明 GitHub source、weekly 和 every_n_weeks schedule 的配置以及 `connectorConfig.period` 的独立语义；用文档示例配置解析命令验证。
- [x] 5.2 增加本地 e2e fixture，验证 GitHub baseline、连续周报快照、四周汇总和空历史行为；运行 `npm test`、`npm run check` 和 `npm run build`。
- [x] 5.3 运行 `openspec validate add-periodic-digest-schedules --strict`，并用 Compose 重新构建后检查 `feed_poll`、`feed_digest` 日志和容器重启恢复。
