## 1. Feed item metadata and migration

- [x] 1.1 扩展 `NormalizedFeedItem`、`FeedItem`、序列化和 store 写入路径，支持有界 connector metadata；用 RSS fixture 验证旧条目仍使用空 metadata 且现有字段不变
- [x] 1.2 实现 schema v7 → v8 的 `metadata_json` migration、回滚保护和高版本拒绝；用临时 SQLite 验证旧数据库升级后 conversations、jobs、feed items 和 feedback 数据仍完整
- [x] 1.3 为带有合法 rank 的 item 增加摘要排序规则，并验证没有 metadata 的 RSS item 保持原有排序

## 2. GitHub Trending HTTP 与解析

- [x] 2.1 从 RSS parser 抽取共享的有界 HTTP 请求辅助函数，保留超时、大小、重定向、DNS/SSRF、AbortSignal、ETag 和 Last-Modified 行为；运行现有 parser 测试确认 RSS 行为不变
- [x] 2.2 新增 GitHub Trending HTML parser 和 daily/weekly/monthly fixture，解析仓库名称、URL、描述、语言、排名和 star 增长，并验证 identity、metadata 边界和页面排名顺序
- [x] 2.3 为无有效项目、结构变化、超大响应、非法重定向和缺失趋势字段增加解析错误或降级测试；确认不会返回部分结果或泄露响应正文

## 3. Connector registry 与配置

- [x] 3.1 注册 `github_trending` connector，校验 GitHub Trending HTTPS 主机、`period`、`language` 和未知 connector 选项；用配置测试验证默认周榜和非法配置拒绝
- [x] 3.2 让 connector 复用来源缓存和共享 HTTP helper，处理 304、可重试 HTTP 错误和不可重试解析错误；用注入 fetch 测试验证请求 URL、条件请求头和错误分类
- [x] 3.3 验证 feed worker 对 GitHub 来源执行 itemLimit、租约和 token fencing，并复用现有 baseline/candidate 去重；用 source E2E 测试覆盖首次基线、后续新仓库和重复仓库更新

## 4. 摘要展示与兼容性

- [x] 4.1 更新摘要候选和 Card 2.0 renderer，在存在 GitHub metadata 时展示语言、趋势周期和 star 增长，metadata 缺失时回退到普通 RSS 行；用卡片测试验证字节上限和旧卡片兼容
- [x] 4.2 验证现有 `digest_interest` 对 GitHub item 继续使用相同的消息范围、幂等和 `☆ / ★` 切换语义；用回调测试覆盖重启后状态恢复

## 5. 文档与验收

- [x] 5.1 更新 README、feed ingestion、部署和故障排查文档，提供 `github_trending` YAML 示例、公开访问限制、v8 备份/回滚说明和 fixture 验证方式
- [x] 5.2 运行 `npm test`、`npm run check`、`npm run build` 和 `openspec validate add-github-trending-source --strict`，确认所有 connector、migration、digest 和 callback 测试通过
