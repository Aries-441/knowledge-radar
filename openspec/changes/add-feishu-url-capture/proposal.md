## Why

飞书文字收发已被用户确认可用，下一步需要让手机分享链接真正触发公开文章采集，同时允许用户在网页访问、摘要生成或重试期间继续聊天。现有 Job 已具备持久化、幂等、租约和重试，本变更整体采用 Turn → Job → Outbox，而不是让一次对话长期承担后台任务。

## What Changes

- 仅单独 URL 或“总结 <URL>”触发采集；其他聊天提到链接不打开网页。新请求持久化分类，旧消息不追溯采集。
- Turn 在一个事务中创建唯一 capture_article Job、结束本轮并写入“已接收，正在采集。”的 final_message；不等待网页或模型。
- 单并发 Job Worker 复用 Playwright、Readability 与 Pi 摘要，按 Job token 保存不可变检查点、发布固定 Markdown，再原子提交 Job 成功及独立 job_result Outbox。
- 归档采用“文章标题--短任务标识.md”，文档头部保存来源、任务创建时间、摘要生成时间和完整任务 ID；回复以标题开头、短任务标识收尾。本轮测试格式直接替换，不兼容旧检查点；备份后重建测试状态库，保留 Markdown、.env 和备份。
- 接收确认与任务结果各自去重；投递规则区分对话回复和异步任务结果，采集退避不阻塞普通聊天。
- Job 临时失败有限重试，永久失败及恢复耗尽产生唯一失败结果；Outbox 重试只重发已提交文字。
- 聊天额外读取同会话受限的 Job 状态/成功摘要快照；模型调用中途完成的结果不混入本次上下文，不承诺全文问答。
- 归档目录可用时启用采集；不可用时保留聊天，新采集请求收到明确拒绝，旧 Job 不因配置缺失耗尽尝试。
- **BREAKING（入口约束）**：本地 run-once 拒绝飞书 Conversation，避免错误消费渠道任务；本地 Conversation 的原有行为与一次性 URL CLI 保持兼容。

## Capabilities

### New Capabilities

- `feishu-url-capture`：明确触发、接收确认、公开内容、独立 Job 执行与可见失败。
- `durable-article-archive`：以 Job 为身份的不可变检查点、文件发布及跨资源恢复。

### Modified Capabilities

- `feishu-text-ingress`：v3 原子分类与迁移，保留既有授权、来源和去重。
- `feishu-chat-service`：Turn/Job/Outbox 三个串行循环、采集能力降级、停止与容器归档。
- `feishu-outbox-delivery`：final_message 与 job_result 的领取、因果顺序和独立重试。
- `runtime-job-queue`：新增有作用域的采集调度、Turn→Job 原子交接、Job→结果原子提交契约。
- `runtime-outbox-queue`：默认 FIFO 保留，为飞书异步结果明确受限的顺序例外。
- `topic-agent-runtime`：增加受限 Job 上下文快照，保留无工具模型边界。
- `turn-run-once-worker`：在任何恢复或领取前拒绝飞书 Conversation。

既有能力目前来自尚未归档的 add-durable-runtime-store、add-topic-aware-agent-runtime、add-feishu-text-chat。本变更的修改型 delta 以这些已实现能力为基线；归档前必须按依赖顺序同步前置规范。严格校验不等于这些归档前提已满足；本轮不改写或自动归档旧 Change。

## Impact

- 复用 SQLite 与现有 jobs/outbox；不增加 Redis、消息中间件、微服务或新依赖。不将抓取、摘要、归档拆成多个 Job。
- 涉及 store/schema、飞书三条循环、话题上下文、文章模块、CLI 边界及对应测试。
- v3 新增按 Job 唯一的 article_captures 检查点及每个来源 Turn 仅一个采集 Job 的约束；不增加 Turn/Job 状态枚举，不引入 waiting_job 或 waiting_auth。
- 部署增加专用归档目录绑定、85 秒应用排空和100秒容器停止期限；数据库与 Markdown 分别备份。
- 延后自动登录、批量 URL、订阅调度、多话题、状态卡和全文检索。当前只消费有授权飞书来源的 capture_article，不消费无来源或其他种类 Job。
- 规划阶段不迁移真实数据库、不更新容器、不调用模型或飞书；apply 的实际代码、离线验收及待真人验收进度以 tasks.md 和验收记录为准。旧 Turn 直接采集草案被本稿整体替代，不保留双轨实现。
