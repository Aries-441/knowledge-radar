## ADDED Requirements

### Requirement: 有界采集尝试与实际取消

每次采集Job SHALL 使用共享80秒工作与清理预算，页面阶段最多20秒、模型最多50秒、检查点及文件/最终提交预算5秒、清理5秒；各阶段同时受剩余总预算限制，不通过隐藏重试扩大期限。模型请求 SHALL 实际取消，浏览器及迟到启动资源必须关闭；仅Promise提前返回不算取消。清理未完成不得开始下一Job，无法排空时停止服务非零退出并由持久化租约恢复。文件I/O可能迟到，必须遵守不可变检查点及无覆盖发布约束，不宣称实时系统级硬截止。

#### Scenario: 模型或页面挂起

- **WHEN** 在途请求超过阶段或总预算
- **THEN** 执行实际取消和资源清理，完成后才重试；清理失败则停止服务，不留下旧调用与新Job重叠

#### Scenario: 浏览器启动迟到

- **WHEN** 启动请求在超时后才返回浏览器句柄
- **THEN** 关闭该资源，不继续导航、总结或以旧执行权写回

### Requirement: 原子受理有来源的采集任务

系统 SHALL 对有当前授权飞书来源的明确采集Turn，在验证其running、当前run_token及未过期租约后，同事务创建唯一capture_article Job、将Turn置为answered并创建接收确认final_message。Job SHALL 固定关联来源Turn、幂等键、已验证URL和三次上限；同一非空来源Turn只能存在一个该种类Job。幂等命中必须核对来源及请求，不静默复用冲突任务。失租或提交失败不得留下部分状态。

#### Scenario: 交接事务故障

- **WHEN** 创建Job后但完成Turn或写确认前发生错误
- **THEN** 整笔事务回滚，用户不会得到没有持久化任务的成功确认

#### Scenario: 重复受理和旧令牌

- **WHEN** 受理重试、并发或旧Turn令牌再次提交
- **THEN** 至多一个Job和确认；旧令牌返回lost_lease，不改变现有记录

### Requirement: 有作用域的采集领取和恢复

采集Worker SHALL 仅领取/恢复kind=capture_article、拥有持久化飞书来源、明确采集分类且匹配当前app/tenant/owner的Job。其他种类、无来源及其他身份的记录 SHALL 不变。候选须pending、到期、attempts未耗尽，按available_at/created_at/id排序；领取增加一次attempt并分配120秒租约与新token，单并发执行。来源Conversation归档不取消已受理Job。归档能力关闭时不得新领取或增加attempts，但过期恢复与终态通知仍继续。

#### Scenario: 混合队列

- **WHEN** 队列含当前飞书采集、其他应用采集、无来源Job及其他种类任务
- **THEN** 本Worker只改变授权采集范围，不能全局恢复或误领其他任务

#### Scenario: 某任务正在退避

- **WHEN** 较早采集Job尚未到available_at，另一个Job已经到期
- **THEN** 后者可被领取，Turn聊天也无需等待前者

### Requirement: 原子提交采集终态和独立结果

采集Job成功 SHALL 在检查点与文件发布确认后，在当前有效Job token下同事务提交succeeded、结果引用及唯一job_result；永久失败或重试耗尽 SHALL 同事务提交failed、安全原因及失败job_result。来源Turn的answered及确认不得改写。未耗尽的暂时失败 SHALL 只把Job退避为pending至少30秒并清除租约，不创建中间结果。成功、失败、重试写回若token或租约无效 SHALL 立即lost_lease。Outbox插入失败必须回滚终态，不能丢失通知意图。

#### Scenario: 成功事务在消息插入处失败

- **WHEN** 文件已发布，但结果消息插入失败
- **THEN** Job成功状态也回滚；下次有效尝试复用检查点/文件，不重新生成摘要

#### Scenario: 永久失败与迟到结果

- **WHEN** 当前执行者把Job失败并提交结果，旧执行者随后回报成功
- **THEN** 旧执行者不能翻转终态或覆盖唯一结果，Turn受理确认保持不变

### Requirement: 过期采集耗尽也必须有结果

采集范围的过期running Job SHALL 在事务内按尝试上限恢复：尚有次数变pending并清除旧租约；耗尽变failed并同时生成唯一失败job_result。恢复必须检查当前过期状态而不是借用旧token。无新事件时仍 SHALL 执行恢复。检查点存在但未完成时不得承诺没有文件，也不得绕过上限增加第四次尝试。

#### Scenario: 最后一次执行中断

- **WHEN** 第三次running Job租约过期
- **THEN** 同事务终止Job并提交未确认完成的结果通知，重复恢复不重复通知，后续聊天不受阻
