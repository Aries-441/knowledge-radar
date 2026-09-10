## Purpose

为一个已持久化的话题 Turn 构建有界、可重放的上下文并生成单一最终回复，使模型调用不依赖进程内会话、浏览器状态或消息渠道。

## ADDED Requirements

### Requirement: 从已提交的完成轮次重建有界上下文
系统 SHALL 为一个待处理 Turn 仅使用同一 Conversation 中更早、状态为 `answered` 且具有 `final_message` 最终回复的 Turn 重建上下文。上下文 MUST 按 Turn 序号保留用户输入与最终回复的先后关系，MUST 排除当前 Turn、`queued`、`running`、`failed` 记录及任何未完成流式内容。

系统 MUST 先排除用户输入和回复合计超过 4,000 个字符的候选轮次，再从其余候选中保留序号最新的六个完整轮次，并以升序交给 Agent；不得截断或混入不完整轮次。无法解析为 `{ text: string }` 的 `final_message` 也不是候选轮次。

#### Scenario: 只使用已完成的同话题历史
- **WHEN** 一个 Conversation 包含两个已完成 Turn、一个 `running` Turn 和当前已领取 Turn
- **THEN** Agent 输入 SHALL 只包含两个已完成 Turn 的用户输入与最终回复，以及当前 Turn 的用户输入

#### Scenario: 历史超出轮次数量限制
- **WHEN** 一个 Conversation 已有七个符合条件的完成轮次
- **THEN** Agent 输入 SHALL 只包含序号最新的六个完整轮次，并保持升序对话顺序

#### Scenario: 最新历史轮次本身超长
- **WHEN** 序号最新的完成 Turn 的用户输入与最终回复合计超过 4,000 个字符，且此前有六个符合长度限制的完成 Turn
- **THEN** Agent 输入 MUST 排除该超长 Turn，并包含此前六个完整轮次，且不得截断该超长 Turn

### Requirement: 生成受约束的最终回复
系统 SHALL 为当前 Turn 生成一个非空、去除首尾空白且不超过 6,000 个字符的最终文本回复。模型调用 MUST 不获得 Shell、文件系统、浏览器、网络请求、消息发送或任何其他工具能力，且 Agent Runtime MUST 不直接写入 SQLite、Markdown 或外部消息渠道。

默认 Pi 适配器 MUST 为每次调用新建 `pi-agent-core` `Agent`，设置空工具列表，并使用 `models.streamSimple` 的 `toolChoice: "none"` 与 60 秒超时。它 MUST 在首个 Agent Turn 后停止，至多发起一次 Provider 请求，并只接受 `stop` 的无 tool call 纯文本 Assistant 结果。任何超时、Provider/认证失败、非 `stop`、tool call 或无效文本 MUST 作为不含原始 Provider 内容的失败返回。

#### Scenario: Agent 生成有效回复
- **WHEN** Agent 为一个已领取 Turn 返回有效的文本回复
- **THEN** 系统 SHALL 将该文本作为该 Turn 的唯一最终回复候选交给 Turn Worker

#### Scenario: Agent 返回空文本
- **WHEN** Agent 返回空白文本或超过长度限制的文本
- **THEN** 系统 MUST 将本次调用视为失败，且不得产生最终回复候选

### Requirement: 上下文不包含敏感运行态
系统 MUST 不把 Cookie、Local Storage、密码、验证码、浏览器 Profile、模型内部对象、未验证工具参数或完整第三方原文放入 Agent 上下文。每次调用 MUST 仅依赖已提交的结构化话题历史和当前 Turn。

#### Scenario: 历史记录包含受限运行态字段
- **WHEN** 运行时存储或其他调用方持有浏览器认证数据
- **THEN** Agent 输入 MUST 不包含该认证数据或其存储位置
