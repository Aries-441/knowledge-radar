## 1. 已提交话题历史

- [x] 1.1 在 `RuntimeStore` 增加只读的完成轮次历史查询，仅关联当前 Turn 之前的 `answered` Turn 与可解析 `final_message` `{ text }` Outbox；通过临时 SQLite 测试验证排除当前、非终态、失败和无效载荷。
- [x] 1.2 实现六轮、每轮 4,000 字符的完整轮次边界与升序返回；先排除超长候选，再从最新的合格候选收集六轮。通过测试验证最新超长轮次被自身排除、不截断且不串入其他 Conversation。

## 2. 话题 Agent Runtime

- [x] 2.1 定义 `TopicAgentRuntime` 请求、历史轮次和最终文本回复类型，校验空白与超过 6,000 字符的回复，并把 Pi 的异常、超时、非 `stop` 与 tool call 转为安全错误；通过 Fake Agent 单元测试验证有效和无效结果。
- [x] 2.2 实现每次调用新建的 `pi-agent-core` `Agent` 适配器，使用固定系统提示、重建消息、空工具列表、`toolChoice: "none"`、60 秒超时和单次 Provider 调用上限；通过 Fake Stream 的无网络测试验证该契约，且适配器不持有状态库、浏览器或副作用依赖。
- [x] 2.3 实现上下文组装，将合格完成历史与不超过 4,000 字符的当前 Turn 以明确用户/助手顺序传给 `TopicAgentRuntime`；通过 Fake Agent 断言验证不包含敏感运行态或未完成记录。

## 3. 单次 Turn Worker

- [x] 3.1 实现仅恢复目标 Conversation 过期 `running` Turn 的状态库操作，并在 `processConversationOnce(conversationId)` 领取前调用；通过测试验证进程中断后的下一次调用可恢复并处理 Turn，且不改变其他 Conversation、Job 或 Outbox。
- [x] 3.2 以 120 秒租约领取指定 Conversation 最早可处理的 Turn 并返回 `idle`；通过测试验证空队列不调用 Fake Agent 且一次调用不处理第二个 Turn。对于超过 4,000 字符的已领取 Turn，以 `turn_too_large` 终态失败且不调用 Agent。
- [x] 3.3 在 Agent 成功后以 `{ text }`、`final_message` 和固定 `maxAttempts = 3` 调用原子完成操作；通过测试验证 Turn `answered` 与唯一 `pending` Outbox 同时出现，并持久化该上限。
- [x] 3.4 将 Agent 异常和无效回复映射为 30 秒后的 `retryTurn`，并依据已领取 Turn 的尝试次数返回 `retry_scheduled` 或 `failed`；通过固定时钟测试验证重试时间、尝试耗尽和不泄露原始错误文本。
- [x] 3.5 处理成功、终态输入失败或重试写回时的失租结果；通过受控时钟与第二 Runner 测试验证旧 Runner 返回 `lost_lease` 且不修改 Turn 或 Outbox。

## 4. 本地 CLI 与验收

- [x] 4.1 扩展 CLI 支持 `run-once <conversation-id>`，从必需的 `KNOWLEDGE_RADAR_STATE_PATH` 打开状态库并输出 `{ outcome }`；将命令处理函数与生产 Pi Runtime 组装分开，测试注入 Fake Agent。验证 `failed`、`storage_busy` 非零退出，其余 Worker 结果正常退出。
- [x] 4.2 保持裸公开 URL 的既有采集入口兼容；通过现有 CLI/采集测试确认 URL 不被当作 `run-once` 参数解释。
- [x] 4.3 运行 `npm test`、`npm run check`、`npm run build`、`openspec validate add-topic-aware-agent-runtime --strict` 与 `git diff --check`，确认本 Change 未接入飞书、浏览器、归档、Outbox Sender 或真实模型网络测试。
