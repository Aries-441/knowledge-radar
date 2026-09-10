## Why

`radar.db` 已能可靠保存、领取和恢复 Turn，但尚无任何组件真正消费它。若现在直接接入飞书，事件回调会被迫同时承担会话上下文、模型调用、失败重试和投递编排，后续难以验证或恢复。

本 Change 先建立一个可在本地重复运行的 Turn -> Direct Agent -> 最终 Outbox 闭环，为飞书入口提供稳定的内部边界。

## What Changes

- 新增一个从已提交 Turn 和最终 Outbox 重建受限话题上下文的 Agent Runtime；默认实现使用 `pi-agent-core` 的 Direct Agent，且没有工具。
- 新增单次 Turn Worker：先恢复指定 Conversation 的过期 Turn 租约，再领取最早可处理的 Turn，调用 Agent，并通过现有原子状态操作完成 Turn 与创建 `final_message` Outbox。
- 新增本地 `run-once <conversation-id>` CLI 命令，用于在不接飞书的情况下触发一次处理并报告结果。
- 使用 Fake Agent 覆盖成功、空队列、可重试 Agent 失败、租约过期和旧令牌写回；不调用真实模型网络。

## Capabilities

### New Capabilities

- `topic-agent-runtime`: 从有限、已提交的话题历史生成受约束的最终文本回复，并隔离模型与高风险工具。
- `turn-run-once-worker`: 以一次可观察的本地操作领取 Turn、调用 Agent、可靠写回结果或重试状态。

### Modified Capabilities

- 无。

## Impact

- 新增 `src/agent/` 下的 Pi `Agent` 适配器与 `src/runtime/` 下的历史读取、目标 Conversation 租约恢复、Turn Worker 和测试；不新增 npm 依赖。
- 扩展 CLI 的本地子命令和状态库路径配置；现有公开文章 URL 调用保持兼容。
- 依赖已完成的 `add-durable-runtime-store`，但不修改其表结构、飞书、浏览器、登录态或真实消息投递。
