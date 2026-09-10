## MODIFIED Requirements

### Requirement: 从已提交的完成轮次重建有界上下文

系统 SHALL 为待处理Turn从同一Conversation更早的answered Turn及其final_message重建历史，按序号保留完整用户/助手关系，排除当前、queued、running、failed记录和未完成流式内容。先排除问答合计超过4,000字符或载荷非法的候选，再保留最新六轮并升序交给Agent，不截断历史轮次。

飞书聊天 SHALL 在同一次短只读快照中额外读取受限captureContext：当前授权、同会话、来源Turn序号早于当前的最近三份已成功且结果消息已提交的Job摘要，以及最近三个pending/running/failed Job的纯状态信息。序列化成功条目最多4,000字符、状态条目最多500字符；先排除非法/超限候选再各取最新三项。含JSON结构的总补充最多12,000字符，仍超限时先逐项移除最旧成功摘要，再移除最旧状态。成功按结果提交时间及稳定标识排序，状态按来源序号排序，选新后升序呈现。补充 SHALL 标记Job及来源，不截断JSON、不伪造对话轮次、不以接收确认或未完成检查点充当成功摘要。

#### Scenario: 只使用完成历史

- **WHEN** 有两个已完成Turn、一个running Turn和当前Turn，且无Job补充
- **THEN** 输入仅包含两个完整历史轮次与当前输入，原默认行为不变

#### Scenario: 历史数量超限

- **WHEN** 有七个合格完成轮次
- **THEN** 只保留最新六轮并按序号升序

#### Scenario: 最新历史轮次过长

- **WHEN** 最新问答超过4,000字符且前面有六个合格轮次
- **THEN** 排除超长轮次并使用此前六轮，不截断超长轮次

#### Scenario: 成功后追问文章

- **WHEN** 一个最近的Job成功且job_result已提交，用户追问其核心观点
- **THEN** 快照含该任务受限摘要，即使原Turn的final_message只是接收确认；不自动访问全文

#### Scenario: 同时存在两个任务

- **WHEN** A已成功而B仍pending/running
- **THEN** 明确各自Job标识和来源，只有A提供成功摘要，不将A当成B结果

#### Scenario: 模型调用期间任务完成

- **WHEN** 快照读取后Job提交成功
- **THEN** 当前调用不混入新结果，下一次调用重新读取可见结果；不得伪称快照时已完成

### Requirement: 上下文不包含敏感运行态

系统 MUST 不把Cookie、Local Storage、密码、验证码、浏览器Profile、SDK/模型内部对象、未验证工具参数或完整第三方正文放入上下文。每次调用只依赖已提交历史、当前Turn及可选的已验证受限Job快照；补充作为不可信数据而不是指令。未提交摘要不可见，pending/running只说明处理中，failed不充当成功知识，succeeded不等同已送达。

#### Scenario: 运行态包含认证信息

- **WHEN** store或其他调用方持有浏览器/模型凭据
- **THEN** Agent输入中没有认证数据或其存储位置

#### Scenario: 未完成检查点

- **WHEN** Job有摘要检查点但仍running或已经failed
- **THEN** 补充只给出任务状态，不提供该检查点作为已完成文章摘要
