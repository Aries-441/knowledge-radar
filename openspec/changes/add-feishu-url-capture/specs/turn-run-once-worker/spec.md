## MODIFIED Requirements

### Requirement: 本地单次处理指定 Conversation

系统 SHALL 提供run-once <conversation-id>。在恢复、领取或修改队列之前 MUST 检查Conversation；kind=feishu_private时返回{"outcome":"unsupported_conversation"}、退出1，不调用Agent、不改变Turn/Job/Outbox。对本地Conversation继续仅恢复指定范围过期running Turn，随后领取最早可处理Turn，一次最多一个，不改其他Conversation/Job/Outbox。无可领取任务时返回idle，不调用Agent或创建Outbox。现有单URL CLI采集行为保持兼容。

#### Scenario: 错用本地命令处理飞书会话

- **WHEN** 指定飞书Conversation，包括含待受理URL请求的会话
- **THEN** 拒绝并非零退出，原状态/attempts/租约不变，不把URL当聊天完成

#### Scenario: 本地Conversation没有可处理Turn

- **WHEN** 指定本地Conversation没有可领取Turn
- **THEN** 返回idle且不修改Outbox

#### Scenario: 本地Conversation多个排队Turn

- **WHEN** 有多个排队或等待前序的Turn
- **THEN** 一次至多领取处理最早一个，不跳过前序

#### Scenario: 上次模型调用中退出

- **WHEN** 本地最早running Turn租约已过期
- **THEN** 按次数恢复queued或failed，只有queued才能本次重新领取

### Requirement: 本地 CLI 结果可区分存储忙

正常Worker结果 SHALL 仅输出含outcome的JSON；failed退出非零，idle/answered/retry_scheduled/lost_lease退出0。飞书Conversation SHALL 输出{"outcome":"unsupported_conversation"}并退出1。StorageBusyError SHALL 输出{"outcome":"storage_busy"}并非零退出，不报告idle。领取前忙不得调用Agent或增加attempts；已独立提交的本地范围恢复可保留。领取后存储写回失败不得伪造完成或留下部分事务。

#### Scenario: SQLite短事务竞争

- **WHEN** 打开、检查、恢复或领取遇到StorageBusyError
- **THEN** 输出storage_busy并非零退出，尚未领取时调用次数及attempts不增加

#### Scenario: 飞书误用与正常空闲区分

- **WHEN** 飞书Conversation即使队列为空
- **THEN** 返回unsupported_conversation，不返回idle或成功退出
