## Purpose

让 Knowledge Radar 将已经去重的 Feed 新文章候选按日汇总，并通过现有飞书机器人主动发送给配置用户，同时在重启、重试和重复调度时保持可恢复且不重复通知。

## ADDED Requirements

### Requirement: 每日摘要配置与调度

系统 SHALL 支持在 Feed YAML 中配置摘要开关、IANA 时区、每日发送时间和单条摘要的最大文章数。摘要未显式启用时，现有 Feed 轮询行为 SHALL 保持不变且不创建摘要 Job。

#### Scenario: 摘要已启用且到达发送时间

- **WHEN** 服务运行在配置的时区，当前本地时间已经到达每日发送时间，且存在尚未通知的 `candidate` 文章
- **THEN** 系统 SHALL 为当天创建至多一个 `feed_digest` Job，并使用稳定的日期幂等键

#### Scenario: 同一天重复调度

- **WHEN** scheduler 在同一时区日期内重复运行或服务重启
- **THEN** 系统 SHALL 复用已有摘要 Job，不得创建第二个相同日期的摘要意图

#### Scenario: 没有候选文章

- **WHEN** 摘要已启用但没有尚未通知的 `candidate` 文章
- **THEN** 系统 SHALL 不创建摘要 Job，也不得发送空消息

### Requirement: 候选选择与摘要内容

系统 SHALL 只选择状态为 `candidate` 且尚未成功通知的文章；同一 canonical URL 出现在多个 Feed 时 SHALL 在摘要中合并为一条，并保留可追溯的来源信息。摘要 SHALL 按发布时间（缺失时使用首次发现时间）降序排列，并遵守配置的文章数上限和飞书文本长度上限。

#### Scenario: 生成有界摘要

- **WHEN** 摘要 Job 被创建
- **THEN** 摘要 SHALL 包含日期、来源、文章标题、文章链接以及可用的 Feed 摘要文本，并在达到文章数或消息字节上限时截断而不生成超限请求

#### Scenario: 跨来源重复文章

- **WHEN** 两个来源包含相同 canonical URL 的候选文章
- **THEN** 摘要 SHALL 只展示一条文章，并合并或保留两个来源名称

#### Scenario: 首次基线文章

- **WHEN** 文章属于 Feed 首次成功同步建立的 baseline
- **THEN** 文章 SHALL 永远不进入每日摘要，除非后续 Feed 轮询将其作为新的 candidate 发现

### Requirement: 可恢复的飞书主动发送

系统 SHALL 使用现有 Feishu 应用身份向 `FEISHU_ALLOWED_OPEN_ID` 对应的用户发送主动单聊文本消息。发送 SHALL 由持久化 `feed_digest` Job 驱动，网络请求不得在 SQLite 写事务中执行；发送失败 SHALL 按现有可重试或永久失败语义处理。

#### Scenario: 摘要发送成功

- **WHEN** Feishu API 接受摘要消息并返回消息 ID
- **THEN** 系统 SHALL 在同一短事务中将本次摘要中的文章标记为已通知并将 Job 标记为 succeeded

#### Scenario: 发送失败后重试

- **WHEN** Feishu API 返回超时、限流或暂时不可用错误
- **THEN** 系统 SHALL 保留候选文章为未通知状态，按照 Job 重试策略安排下一次尝试，并不得创建新的日期摘要 Job

#### Scenario: 服务在发送后提交前退出

- **WHEN** 进程在 Feishu 已接受消息但本地提交前退出
- **THEN** 重启后的 worker SHALL 使用同一个 Job 和稳定幂等 UUID 重试，且不得因为旧 run token 覆盖新的执行结果

#### Scenario: 权限或目标永久失败

- **WHEN** Feishu 返回权限不足、目标不可用或消息内容永久无效错误
- **THEN** 系统 SHALL 将 Job 标记为 failed，保留候选文章未通知状态，并写入不包含消息正文和凭据的安全错误日志

### Requirement: 状态迁移与兼容性

系统 SHALL 将摘要所需的通知状态通过前向 SQLite migration 加入现有状态库，并保留 v4 中的会话、Turn、普通 Job、Feed 轮询 Job 和回复 Outbox 数据。摘要未启用或没有 Feed 配置时，升级后的服务 SHALL 保持现有飞书聊天和文章采集行为。

#### Scenario: v4 数据库升级

- **WHEN** 服务打开有效的 v4 状态数据库
- **THEN** 系统 SHALL 原子创建摘要所需字段和索引，并保留所有既有运行记录

#### Scenario: 空配置启动

- **WHEN** Feed 配置缺失、摘要未启用或所有 Feed 均禁用
- **THEN** 系统 SHALL 不创建摘要 scheduler/worker 工作项，现有服务仍可正常启动和处理飞书聊天
