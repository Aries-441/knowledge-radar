## Purpose

将授权用户的飞书私聊文字可靠地转换为持久化 Turn，明确消息去重、会话归属和确认时机，确保重投或进程重启不会重复建轮次，也不会把无权限消息传给模型。

## ADDED Requirements

### Requirement: 增量存储兼容性

系统 SHALL 从空库或现有 v1 状态库迁移到支持飞书来源关联的 v2，保持原 Conversation、Turn、Job、Outbox 数据及队列语义不变。迁移 SHALL 原子提交结构与版本，重开 v2 不重复建表，高于支持版本的数据库必须拒绝打开。

#### Scenario: 已有未完成队列的库升级

- **WHEN** 包含 running Turn、sending Outbox 和 pending Job 的 v1 数据库升级
- **THEN** 原记录、attempts 和租约保持不变，新增飞书消息能独立建立关联

#### Scenario: 迁移中断

- **WHEN** 迁移结构或写入版本时失败
- **THEN** 不留下宣称 v2 已完成的半迁移数据库，后续可重新执行迁移

### Requirement: 仅接收授权私聊文字

系统 SHALL 仅接收当前配置应用、配置租户及唯一允许的 open_id 所发出的用户私聊文字消息。消息必须具有非空 message_id、chat_id 和可解析的 content.text；空白文字、群聊、机器人消息、非文字、身份不符及结构损坏的事件 SHALL 被忽略且不生成 Turn，不调用 Agent、不主动回复。合法文字保留原内容，不执行其中的 URL 或指令工具。

#### Scenario: 授权用户发文字

- **WHEN** 授权用户在私聊中发送含公开 URL 的文字
- **THEN** 文字作为普通 Turn 输入持久化，不启动文章采集或浏览器

#### Scenario: 非授权或不支持的事件

- **WHEN** 收到其他用户、其他租户、群聊、机器人、图片、空白文字或损坏的 content JSON
- **THEN** 系统确认忽略，不生成会话、Turn 或 Outbox，日志不包含消息正文

### Requirement: 稳定私聊映射

系统 SHALL 以应用、租户及 chat_id 唯一确定固定 Conversation，绑定首次验证的 owner_open_id，不因重启、新消息或重投而更换。已归档映射或 owner 不一致 SHALL 不被自动重新激活或改绑，事件忽略并记录安全原因。轮次顺序以本地入库顺序为准，不承诺平台发送时间排序。

#### Scenario: 重启后继续聊天

- **WHEN** 相同应用、租户和私聊在重启后收到新的 message_id
- **THEN** 新 Turn 属于原 Conversation，sequence 递增

#### Scenario: 映射已归档

- **WHEN** 新消息命中已归档 Conversation 的映射
- **THEN** 不新建替代 Conversation，也不入队或调用模型，记录 conversation_archived

### Requirement: 入站接收必须原子去重

系统 SHALL 以应用、租户和 message_id 为持久化去重键，在一次事务内完成去重检查、必要的会话/映射创建、Turn 创建和来源关联。Turn 重试上限 SHALL 为 3。重复事件 SHALL 返回原关联且不覆盖原内容、目的地、序号或重试次数。重复键携带不一致的 chat_id 或 owner SHALL 被拒绝并记录身份冲突，不返回可供错误路由的关联。

#### Scenario: 重投或并发重复到达

- **WHEN** 同一 message_id 多次到达，包括不同 event_id 或两个连接并发处理
- **THEN** 数据库中只存在一个来源关联和一个 Turn，且最多创建一个私聊映射

#### Scenario: 事务中途失败

- **WHEN** 在创建映射后、完成入站事务前发生数据库错误
- **THEN** 本次事务全部回滚，不留下“已去重但没有 Turn”的记录；后续重投能正常入库

### Requirement: 提交成功才确认接收

系统 SHALL 在合法消息事务提交成功后才成功确认事件，回调不得等待模型或投递。可识别的忽略事件可以成功确认；数据库忙、提交失败或未知内部异常 SHALL 保持失败确认语义，不得伪装成忽略或已接收。

#### Scenario: 数据库锁竞争

- **WHEN** 有效消息入库因 storage_busy 失败
- **THEN** 回调失败，未产生新接收记录，平台后续重投仍可处理

#### Scenario: 提交后确认前崩溃

- **WHEN** Turn 和来源关联已提交，但进程在确认事件前退出
- **THEN** 重投被识别为重复，不创建第二个 Turn
