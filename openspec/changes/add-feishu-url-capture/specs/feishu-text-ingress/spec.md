## MODIFIED Requirements

### Requirement: 增量存储兼容性

系统 SHALL 从空库或现有v1/v2原子迁移到v3，保留原Conversation、Turn、Job、Outbox与飞书来源关联、状态、attempts和租约。v3 SHALL 支持Job唯一检查点以及同一非空来源Turn最多一个capture_article Job；重开不重复迁移，未来版本拒绝，约束冲突不得靠删除用户记录修复。

#### Scenario: 旧库包含在途队列

- **WHEN** v1或v2含running Turn/Job及sending Outbox
- **THEN** 升级保留既有记录及租约，新结构可用

#### Scenario: 迁移中断或冲突

- **WHEN** 建表、约束或版本提交失败
- **THEN** 全部迁移回滚，不留下半个v3、不丢弃旧任务

### Requirement: 仅接收授权私聊文字

系统 SHALL 仅接收当前配置应用、租户及唯一允许open_id发来的用户私聊文字，要求非空message_id、chat_id和可解析content.text。空白、群聊、机器人、非文字、身份不符及损坏事件 SHALL 忽略，不生成Turn、不调用模型、不回复。合法原文与可信代码生成的采集分类 SHALL 同事务保存；回调不得运行浏览器、模型或归档。Job由后台受理事务创建，不由接收回调创建。

升级前普通文字 SHALL 保持原分类与处理语义，重复消息不得覆盖原分类、来源或内容，不追溯采集旧URL或补发旧普通聊天失败通知。

#### Scenario: 授权URL输入

- **WHEN** 收到合法私聊URL
- **THEN** 保存原文与明确分类后确认事件，稍后由Turn Worker受理，不等待任务完成

#### Scenario: 不支持或未授权事件

- **WHEN** 收到其他身份、群聊、机器人、图片或损坏JSON
- **THEN** 确认忽略，不生成会话/Turn/Job/Outbox，日志不含原文

#### Scenario: 旧消息重投

- **WHEN** v2已按普通文字保存的URL在升级后重投
- **THEN** 返回原Turn且保持普通聊天分类，不创建新Job
