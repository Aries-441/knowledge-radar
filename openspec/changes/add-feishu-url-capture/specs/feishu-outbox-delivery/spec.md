## MODIFIED Requirements

### Requirement: 仅投递当前授权范围的最终回复

投递器 SHALL 仅领取当前app/tenant/owner且有持久化飞书来源的final_message，以及同一范围终态capture_article Job对应的job_result。回复原message_id，不能使用最近聊天对象或模型给出的地址。其他身份、渠道和kind记录 SHALL 不变；映射归档后已提交消息仍可投递。job_result必须与唯一来源Job对应，不能仅凭kind字符串放行。

#### Scenario: 混合消息

- **WHEN** 存在当前聊天确认、当前任务结果、本地消息及其他身份/种类消息
- **THEN** 仅前两类被领取，其他记录状态和attempts不变

#### Scenario: 连续采集多个URL

- **WHEN** 不同Job结果先后准备投递且期间收到新消息
- **THEN** 每个结果回复自己的原消息并带Job标识，不按最新URL路由

### Requirement: 持久化有限重试和稳定发送身份

系统 SHALL 为两类消息分别原子领取，增加attempts并取得60秒租约及run_token；含认证的发送总期限为10秒并实际取消超时请求。每次重试保持原目标、已提交文字和由本Outbox身份派生的UUID；两类消息不得复用同一Outbox或UUID。至少30秒退避并尊重更长有效Retry-After，最多已持久化的三次尝试，不允许隐藏发送重试。序列化text内容最多20,000 UTF-8字节，不分片或截断。

#### Scenario: 任务结果发送超时

- **WHEN** 远端是否接收未知且还有次数
- **THEN** 重试相同job_result，不重新执行Job、模型或归档

#### Scenario: 永久错误或耗尽

- **WHEN** 无权限、原消息不可回复、载荷非法/过大或次数耗尽
- **THEN** 当前Outbox为failed，不改投其他目的地、不覆盖另一种消息

### Requirement: 范围恢复和会话投递顺序

系统 SHALL 持续恢复上述两类合法消息的过期sending，保持尝试上限，不改其他消息或Job。final_message SHALL 仅被同会话更早未终态final_message阻塞，sent/failed不阻塞；job_result不得阻塞普通final_message。job_result SHALL 等待自身来源Turn的final_message成为sent或failed；确认缺失或未终态不得发送该结果，确认最终failed后允许独立发送结果。job_result之间不按来源Turn序号互相阻塞。候选按available_at、created_at、id确定选择，避免固定优先级饿死某类消息。

#### Scenario: 自身确认仍在发送

- **WHEN** Job已经成功但接收确认pending或sending
- **THEN** 结果等待确认终态，Job不重跑；确认sent后可以发送结果

#### Scenario: 确认最终失败

- **WHEN** 接收确认已failed而任务结果ready
- **THEN** 允许结果独立尝试，明确这不保证用户先看到确认

#### Scenario: 结果退避与后续聊天

- **WHEN** 较早Job未完成或其结果在退避，后续普通final_message到期且前序final_message已终态
- **THEN** 普通回复可发送；其他就绪job_result也可发送，不被较早任务阻塞

#### Scenario: 无新事件重启

- **WHEN** 重启后仅有过期sending或未来到期pending消息
- **THEN** 轮询自行恢复和投递，不依赖新入站
