## 1. Feed 摘要配置

- [x] 1.1 扩展 Feed 配置模型，支持 `digest.enabled`、`digest.time` 和 `digest.maxItems`，保留无摘要配置时的现有行为，并用配置测试验证默认值、时区时间格式和边界值
- [x] 1.2 更新 `feeds.yaml`、`.env.example` 和 Feed 部署文档，提供启用每日 09:00（Asia/Shanghai）摘要的示例，并验证配置文件可被启动命令读取

## 2. 状态库与摘要 Job

- [x] 2.1 实现 schema v4 到 v5 的原子迁移，给 `feed_items` 增加可空 `notified_at` 和选择索引，并用迁移测试验证旧会话、Turn、Job、Feed 和 Outbox 全部保留
- [x] 2.2 扩展 RuntimeStore，提供未通知 candidate 读取、日期幂等的 `feed_digest` Job 创建、Job 领取/恢复以及成功后原子标记候选和 Job 的方法，并用 SQLite 测试验证 token fencing、幂等和失败保留候选

## 3. 摘要生成与调度

- [x] 3.1 实现确定性的 Feed 摘要构建器，按发布时间排序、按 canonical URL 跨源去重、保留来源和链接，并验证文章数上限、UTF-8 字节上限和空候选行为
- [x] 3.2 实现按 IANA 时区计算本地日期和每日发送时间的摘要 scheduler，验证同一天只创建一个 Job、错过发送时间可补建 Job、未到时间不创建 Job
- [x] 3.3 实现摘要 worker，在事务外使用冻结的 Job 文本调用主动发送，成功提交通知状态，暂时性错误按现有重试规则处理，永久错误安全记录并验证重启恢复

## 4. 飞书主动消息与服务集成

- [x] 4.1 扩展 Feishu adapter，增加以 `open_id` 为目标的主动文本发送、稳定 UUID、请求长度校验和错误分类，并用伪造 HTTP 客户端测试成功、超时、限流、权限和目标不可用
- [x] 4.2 将摘要 scheduler/worker 接入 `serve-feishu` 的启动、等待和 drain 生命周期，按 Job kind 与 Feed poll 隔离，并用服务测试验证无摘要配置时聊天和采集行为不变

## 5. 文档与验收

- [x] 5.1 更新 README、Feishu 配置/部署文档和路线图，说明主动消息所需的机器人权限、接收用户、摘要格式、重试和回滚方式，并验证示例命令可复制运行
- [x] 5.2 运行 `npm test`、`npm run check`、`npm run build` 和 `openspec validate add-feed-digest-feishu --strict`，再用本地 SQLite 与伪造 Feishu transport 完成一次“候选 → Job → 发送 → 已通知”端到端验收
