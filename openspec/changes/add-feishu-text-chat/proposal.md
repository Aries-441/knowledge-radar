## Why

现有 `add-topic-aware-agent-runtime` 已能在本地领取 Turn、调用 Direct Agent，并原子生成最终回复 Outbox，但还没有手机可用的消息入口和回复投递器。下一步接通飞书私聊文字，验证已有持久化运行时在真实通信渠道中的完整闭环。

## What Changes

- 使用官方 `@larksuiteoapi/node-sdk` 的长连接接收 `im.message.receive_v1`，不开放公网 webhook。
- 第一版仅允许配置的一个飞书用户发送私聊文字；一个私聊固定映射一个 Conversation，URL 也只作为文字，不触发采集。
- 在同一 SQLite 事务内完成消息去重、会话映射和 Turn 创建；落库成功后才确认接收，不在回调内调用模型。
- 新增常驻 `serve-feishu` 命令：后台复用现有 Turn Worker，并以独立投递循环领取 `final_message` Outbox、回复原消息、记录发送结果。
- 投递复用现有 run_token、租约和有限重试；稳定的发送 UUID 用于平台去重，但不承诺跨平台 exactly-once。
- 增量迁移 `radar.db` 保存飞书会话与入站消息关联；增加假飞书/Fake Agent 测试、配置指引及独立 Docker Compose 部署入口，持久化数据库。

### Non-goals

不接群聊、多用户、话题切换、流式输出、处理中卡片、失败通知消息、浏览器/工具、登录态、URL 自动采集、Job 执行器或通用渠道插件框架。不新增管理后台；终态失败先通过安全日志和本地状态排查。

## Capabilities

### New Capabilities

- `feishu-text-ingress`：私聊身份过滤、文本解析、稳定映射及入站原子去重。
- `feishu-outbox-delivery`：目标范围内的最终回复领取、发送、失败与恢复。
- `feishu-chat-service`：长连接常驻服务、后台调度、配置、关闭与容器持久化。

### Modified Capabilities

无。保留已有 `run-once`、文章采集和无工具 Agent 契约；现有未归档变更是实现依赖，不在本变更中重复定义。

## Impact

- 依赖已实现的 `add-durable-runtime-store`、`add-topic-aware-agent-runtime`；本变更文档完成不代表代码已完成。
- 预计涉及 `src/runtime/` 的增量 schema/范围查询，新增薄的 `src/channels/feishu/` 适配器和投递逻辑，以及 `src/cli/` 常驻入口。
- 仅新增飞书官方 SDK 运行依赖；复用 `node:sqlite`、现有 Agent Runtime 和测试方式，不引入队列服务、HTTP 框架或第二套状态机。
- apply 阶段更新 `.env.example`、README、部署/状态机文档和容器配置；密钥、个人标识、真实消息及数据库不提交 Git。
