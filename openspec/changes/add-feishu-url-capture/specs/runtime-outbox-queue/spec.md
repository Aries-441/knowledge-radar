## MODIFIED Requirements

### Requirement: 有序领取最终消息

默认通用领取 SHALL 按所属Turn的Conversation和序号选择最终消息；较早非终态消息阻塞较晚消息，sent或failed不阻塞。飞书专用领取 SHALL 允许明确的异步结果例外：final_message只在同种对话回复间保持FIFO，job_result仅等待自身来源确认终态，不阻塞普通回复或其他就绪Job结果；其他渠道默认行为不变。该例外不得放宽授权范围、attempts或lease/token条件。

#### Scenario: 两条默认最终消息

- **WHEN** 使用通用默认领取且同会话较早、较晚Turn都有message记录
- **THEN** 先领取较早记录，不跳过未终态前序

#### Scenario: 较早最终消息已失败

- **WHEN** 较早最终消息为failed
- **THEN** 允许满足其他条件的后续消息

#### Scenario: 飞书异步结果例外

- **WHEN** 使用飞书专用领取且旧job_result退避、后续final_message已就绪
- **THEN** 后续普通回复无需等待该结果，默认通用FIFO测试仍保持原行为
