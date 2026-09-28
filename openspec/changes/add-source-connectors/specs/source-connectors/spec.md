## Purpose

为不同类型的外部信息来源提供统一、可验证且可恢复的接入边界，让 RSS/Atom、GitHub、微信公众号、Newsletter 和 arXiv 后续能够复用同一套去重、基线、轮询、摘要和通知流程。

## ADDED Requirements

### Requirement: 统一来源配置

系统 SHALL 支持以 `sources` 作为来源配置入口。每个来源 MUST 具有稳定 `id`、显示名称、`kind`、启用状态、优先级、标签和单次条数上限；connector 所需的附加配置 MUST 位于受控的来源配置字段中，不得把凭据写入来源 URL 或普通日志。

现有 `feeds` 配置 SHALL 作为 RSS/Atom 的兼容别名被规范化为 `kind: rss` 的来源。一个配置文件同时提供 `feeds` 和 `sources` 时，系统 SHALL 拒绝启动并返回配置错误，避免两个入口产生不同步的来源集合。当前未注册的 `kind` SHALL 在启动时被拒绝，不得静默回退到 RSS。

#### Scenario: 旧 feeds 配置继续工作

- **WHEN** 配置文件只包含现有 `feeds` 列表
- **THEN** 系统将其转换为 `kind: rss` 的标准来源，保留 ID、名称、优先级、标签、启用状态和条数限制

#### Scenario: 新 sources 配置被规范化

- **WHEN** 配置文件包含 `sources` 列表和一个已注册的来源类型
- **THEN** 系统返回统一来源配置，轮询调度可以根据来源类型选择 connector

#### Scenario: 配置入口或来源类型无效

- **WHEN** 配置同时包含 `feeds` 与 `sources`，或来源缺少 `kind`、使用未注册类型、包含凭据 URL 或附加字段不符合类型约束
- **THEN** 系统在启动阶段拒绝完整配置，不使用部分来源继续运行，也不把凭据写入错误信息

### Requirement: Connector SHALL 返回统一来源快照

每个已注册 connector SHALL 接收一个标准来源配置和受控请求上下文，并返回统一快照。快照 MUST 包含最终来源地址、条件请求缓存标记、是否未修改以及规范化条目；条目 MUST 至少包含稳定身份、标题、canonical URL（如果存在）、受限摘要、作者（如果存在）和发布时间（如果可解析）。

Connector SHALL 在数据库事务之外执行网络访问和解析，不得直接修改 SQLite 或创建通知 Job。轮询 worker SHALL 负责把快照提交到现有来源状态、文章状态和 `feed_poll` Job。

#### Scenario: RSS connector 返回标准快照

- **WHEN** RSS connector 成功读取 RSS 2.0 或 Atom 来源
- **THEN** worker 获得与当前实现等价的条目快照，并继续使用现有 baseline、candidate 和 canonical URL 去重规则

#### Scenario: 条件请求未修改

- **WHEN** connector 返回 `notModified`
- **THEN** worker 只更新检查时间和可用缓存标记，不插入新条目、不改变基线和候选状态

#### Scenario: Connector 失败

- **WHEN** connector 返回超时、限流、不可解析、响应过大或目标地址被阻止的受控错误
- **THEN** worker 使用现有来源级错误、重试和租约语义处理，不影响其他来源、聊天 Turn 或文章采集 Job

### Requirement: 来源类型选择 SHALL 可扩展且失败可见

系统 SHALL 通过显式 registry 根据来源 `kind` 选择 connector。未注册或配置错误的来源类型 MUST 产生安全、稳定的配置错误；系统不得通过 URL 外观猜测来源类型，也不得把第三方响应 JSON 或任意组件结构直接写入文章记录。

#### Scenario: Registry 选择 RSS connector

- **WHEN** 来源类型为 `rss`
- **THEN** registry 返回 RSS/Atom connector，复用现有 HTTP 安全边界、响应上限、条件请求和错误分类

#### Scenario: Registry 缺少来源类型

- **WHEN** worker 领取一个来源类型不存在或已被移除的轮询 Job
- **THEN** 当前来源记录该错误并按永久失败结束该 Job，其他来源继续处理

### Requirement: 来源状态升级 SHALL 保留既有数据

系统 SHALL 通过前向 schema migration 为来源记录增加 connector 类型和受控配置数据，现有 RSS 来源默认迁移为 `rss`。升级 MUST 保留现有来源 URL、HTTP 缓存标记、基线时间、检查时间、错误状态、文章记录、Jobs、Turns 和 Outbox。

来源的 connector 类型或 connector 配置发生变化时，系统 SHALL 清空只属于旧 connector 的 HTTP 缓存和基线游标，并按来源 URL 变化的现有规则重新建立基线；不得把旧来源条目静默当作新 connector 的候选。

#### Scenario: 旧状态库升级

- **WHEN** 服务打开只包含 RSS 来源的旧状态库
- **THEN** migration 为每条来源填充 `rss` 默认类型，所有既有文章、候选和运行队列保持可读取

#### Scenario: 来源类型发生变化

- **WHEN** 同一来源 ID 从一个 connector 类型改为另一个类型
- **THEN** 系统重置该来源的 connector 缓存和基线状态，保留数据库完整性并等待新的首次成功同步

#### Scenario: 高版本状态库

- **WHEN** 服务打开高于自身支持版本的状态库
- **THEN** 系统拒绝启动，不修改状态库，也不尝试降级来源数据

### Requirement: Existing polling and digest semantics SHALL remain compatible

统一来源 SHALL 继续使用现有持久化轮询 Job、租约、重试、token fencing、baseline/candidate 状态和每日摘要流程。新版本 worker SHALL 读取旧版 `feed_poll` payload 中的 `feedId`，并允许新 payload 使用来源 ID；旧版本来源状态不得被重复入库或重复通知。

#### Scenario: 旧轮询 Job 在升级后恢复

- **WHEN** 升级前已经存在带 `feedId` 的 pending 或 running `feed_poll` Job
- **THEN** 新 worker 可以安全领取、恢复或提交该 Job，且不改变其原有幂等、租约和重试语义

#### Scenario: 来源条目进入每日摘要

- **WHEN** connector 产生新的标准化条目并完成候选入库
- **THEN** 现有摘要选择器可以读取该条目，按来源优先级、canonical URL 去重和通知状态生成摘要
