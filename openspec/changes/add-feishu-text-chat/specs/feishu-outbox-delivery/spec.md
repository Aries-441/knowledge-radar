## Purpose

把已提交的最终回复投递回其对应的飞书原消息，在本地租约与第三方发送之间明确成功、重试及不确定性的边界，避免错误路由、重复模型调用和无限发送。

## ADDED Requirements

### Requirement: 仅投递当前授权范围的最终回复

投递器 SHALL 仅领取当前配置应用、租户、owner 对应的、具有持久化飞书来源关联的 final_message Outbox。回复目标 SHALL 使用关联中的原 message_id，不使用内存中的最近聊天对象，也不从模型文本解析地址。其他渠道、其他身份和其他 kind 的记录 SHALL 保持不变。映射归档后已提交的最终回复仍可在当前身份授权下完成投递。

#### Scenario: 数据库混有本地与其他应用记录

- **WHEN** 本地 run-once、其他应用和当前私聊均有待投递 Outbox
- **THEN** 飞书投递器只领取当前范围内有飞书来源的 final_message，其他记录的状态和 attempts 不变

#### Scenario: 处理期间收到下一条输入

- **WHEN** 用户的新消息到达，而前一个 Turn 的回复准备投递
- **THEN** 回复仍指向前一个 Turn 记录的原 message_id

### Requirement: 持久化有限重试和稳定发送身份

系统 SHALL 在发送前原子领取、增加 attempts 并取得 60 秒租约及 run_token；一次发送操作含认证等待的总期限 SHALL 为 10 秒。每次重试 SHALL 使用相同的原消息目标、已提交文本和稳定 UUID。失败重试间隔至少 30 秒，尊重更长的有效 Retry-After；最多使用 Outbox 已持久化的 3 次尝试。发送请求不得在投递器之外隐式重试。文本仅编码为一条 text 消息，序列化 content 的 UTF-8 长度超过 20,000 字节或结构非法 SHALL 终止为安全错误，不分片、不截断。

#### Scenario: 请求超时

- **WHEN** 回复请求超时，远端是否接收无法确定，且尚未达到尝试上限
- **THEN** 使用有效令牌安排未来重试，保留文本和 UUID，不重新调用模型

#### Scenario: 永久错误或超限

- **WHEN** 明确无权限、原消息不可回复、文本载荷非法/过大，或重试次数耗尽
- **THEN** Outbox 进入 failed，保留安全错误码，不改发到其他目的地，不无限重试

### Requirement: 成功回写和租约 fencing

系统 SHALL 仅在飞书返回业务成功及非空回复 message_id 后，以仍有效的 run_token 将 Outbox 标为 sent。任何成功、失败或重试回写遇到过期租约或旧 token SHALL 返回 lost_lease，不覆盖新持有者状态、不发起补偿发送。HTTP 成功但业务码失败或缺少回执不得记为 sent。

#### Scenario: 老进程延迟回写

- **WHEN** 新持有者已重新领取，而旧持有者拿到远端成功响应
- **THEN** 旧持有者的本地回写失败并报告 lost_lease，不覆盖新状态

#### Scenario: 平台已发送但本地提交失败

- **WHEN** 远端已成功，进程在本地标记 sent 前退出
- **THEN** 恢复后允许以同一 UUID 重试；系统明确这是有上限的至少一次投递尝试，不承诺最终必达或平台去重窗口外无重复

### Requirement: 范围恢复和会话投递顺序

系统 SHALL 在启动及后续轮询中恢复当前投递范围的过期 sending Outbox，复用已有尝试耗尽规则，不触碰 Job 或其他渠道租约。同一 Conversation 内较早的未终态最终回复 SHALL 阻塞较晚回复；较早回复成为 sent 或 failed 后后续回复可继续。

#### Scenario: 没有新入站事件也能恢复

- **WHEN** 服务重启时只有过期 sending 或未来才到期的 pending 回复
- **THEN** 后台轮询在租约/退避到期后自行恢复并处理，不需要用户再发消息

#### Scenario: 前序回复等待重试

- **WHEN** 较早回复尚未到 available_at，而较晚回复已经 ready
- **THEN** 不越过前序回复发送后续回复；其他 Conversation 不因此被全局阻塞
