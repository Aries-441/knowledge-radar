## 1. 卡片内容与摘要 payload

- [x] 1.1 抽取共享的摘要候选选择结果并实现 Card 2.0 构建器，复用现有排序、canonical URL 去重、文章数限制、文本清理和 UTF-8 字节限制；用单元测试验证 header、文章块、来源、原文按钮、预览标识和超限截断
- [x] 1.2 将新的 `feed_digest` payload 扩展为同时保存 `text` 与 `card` 的版本 2，并让 worker 兼容没有 `card` 字段的旧 payload；用 SQLite 测试验证旧 Job、幂等键、候选标记和回滚语义不变

## 2. Feishu 主动卡片发送

- [x] 2.1 扩展 Feishu adapter 的主动发送接口，校验 Card 2.0 JSON、消息大小和稳定 UUID，复用超时、限流、权限、目标不可用错误分类；用伪造 HTTP 客户端测试成功和失败响应
- [x] 2.2 让摘要 worker 优先发送冻结的卡片内容，旧 payload 回退发送文本，并保持成功后标记、失败重试和 token fencing；用 worker 测试验证候选在失败后仍可重试

## 3. 手动预览入口

- [x] 3.1 增加 `preview-feed-digest` CLI 命令，读取当前 scope 的未通知候选并发送带“预览”标识的卡片；空候选输出 `empty`，成功输出消息 ID，且用集成测试验证不创建 Job、不修改 `notified_at` 和 Feed poll 状态
- [x] 3.2 更新 README、Feed/Feishu 部署文档和验证命令，说明预览不会消耗候选、需要机器人主动消息权限，并验证示例命令可复制运行

## 4. 服务集成与兼容

- [x] 4.1 将主动卡片发送接入 `serve-feishu` 的启动、等待和 drain 生命周期，保留旧 transport mock 的兼容路径；用服务测试验证定时摘要发送卡片、聊天/采集行为不变和停止时无泄漏任务
- [x] 4.2 验证旧版本回滚可以处理新版本创建的 payload，确认不需要 schema 迁移、不删除状态 volume，并在 Compose overlay 中保留现有配置入口

## 5. 验收

- [x] 5.1 运行 `npm test`、`npm run check`、`npm run build` 和 `openspec validate add-feed-digest-cards --strict`，确认所有卡片、预览、重试和兼容测试通过
- [x] 5.2 在本地 SQLite、伪造 Feishu transport 和实际 Docker 配置下完成“候选 → 卡片 Job → 发送 → 已通知”以及“预览 → 发送 → 状态不变”两条端到端验收
