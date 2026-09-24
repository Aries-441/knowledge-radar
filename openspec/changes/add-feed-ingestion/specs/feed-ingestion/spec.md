## Purpose

为 Knowledge Radar 提供可配置、可恢复且不会重复制造历史候选的 RSS/Atom Feed 摄取能力，使后续每日技术雷达可以从持久化的新文章集合开始工作。

## ADDED Requirements

### Requirement: 本地 Feed 配置

系统 SHALL 从配置文件读取 Feed 来源、稳定 `id`、显示名称、启用状态、优先级和标签，并读取轮询间隔、时区及每个来源的单次读取上限。配置中的 Feed `id` SHALL 唯一，来源 URL SHALL 为 HTTP 或 HTTPS URL，禁止携带用户名、密码或无效地址。

配置文件不存在或没有启用 Feed 时，系统 SHALL 保持现有飞书聊天和文章采集行为，并不创建 Feed 轮询 Job。配置文件存在但格式、字段或 URL 校验失败时，系统 SHALL 在启动阶段返回明确的安全错误，不得使用部分配置继续运行。

#### Scenario: 没有 Feed 配置

- **WHEN** 服务启动时没有配置文件或没有启用的 Feed
- **THEN** 现有聊天和文章采集可以正常启动，Feed scheduler 不创建轮询 Job

#### Scenario: 配置含重复 ID 或非法 URL

- **WHEN** 配置文件包含重复 Feed `id`、凭据 URL、非 HTTP(S) URL 或无效轮询参数
- **THEN** 服务拒绝启动并指出配置错误类别，日志不输出凭据或完整敏感配置

#### Scenario: 配置源被禁用

- **WHEN** 一个 Feed 的 `enabled` 为 false
- **THEN** 系统保留其已保存状态，但不为它创建新的轮询 Job，也不更新其文章记录

### Requirement: 受控 RSS/Atom 获取与归一化

系统 SHALL 支持 RSS 2.0 和 Atom Feed，并把每个有效条目归一化为至少包含来源 Feed、稳定文章身份、标题、canonical URL（如果存在）、Feed 摘要、作者（如果存在）、发布时间（如果可解析）和首次发现时间的记录。

系统 SHALL 对每次请求设置超时和响应体大小上限，手动处理重定向，并在初始 URL及每个重定向目标上阻止环回、链路本地、私有网络和云元数据地址。请求 SHALL 使用已保存的 ETag 和 Last-Modified 发起条件请求；HTTP 304 SHALL 被视为一次成功检查，不产生新文章。

Feed 响应状态、内容类型、大小、超时、重定向或 XML 解析失败时，系统 SHALL 记录安全错误类别和检查时间，不写入正文，不把该次失败当作成功基线。单个格式无效的条目 SHALL 不使已解析的其他有效条目重复入库；若 Feed 整体无法可靠解析，则整次检查失败。

#### Scenario: RSS 和 Atom 成功解析

- **WHEN** 受控请求返回可解析的 RSS 2.0 或 Atom 文档
- **THEN** 系统保存归一化的 Feed 元数据和条目，更新成功检查时间及可用的 HTTP 缓存标记

#### Scenario: 条件请求返回未修改

- **WHEN** Feed 返回 HTTP 304
- **THEN** 系统更新检查时间，保留已有文章和缓存标记，不创建新的候选条目

#### Scenario: 目标地址被阻止

- **WHEN** 初始 URL或重定向目标解析到环回、链路本地、私有网络或云元数据地址
- **THEN** 系统拒绝本次请求并记录可重试或不可重试的安全错误类别，不访问该目标

#### Scenario: Feed 返回过大或不可解析内容

- **WHEN** 响应超过大小上限、内容类型不受支持、请求超时或 XML 无法解析
- **THEN** 系统保留已有状态，记录错误和下一次可重试时间，不建立或刷新成功基线

### Requirement: 首次成功同步建立基线

系统 SHALL 为每个 Feed 持久化初始化状态。一个 Feed 的第一次成功解析（包括成功解析但没有条目的空 Feed） SHALL 将当次已有条目标记为 `baseline`，设置基线时间，并且不得将这些历史条目作为后续通知候选。

在基线建立前发生的请求、HTTP 或解析失败 SHALL 不设置基线。基线建立后再次出现相同身份的条目 SHALL 保持原记录，不因为 Feed 顺序变化、服务重启或重复响应而重新成为候选。

#### Scenario: 首次同步包含历史文章

- **WHEN** 一个从未成功同步的 Feed 首次返回已有文章
- **THEN** 系统保存这些文章为基线，设置初始化时间，不创建待通知候选

#### Scenario: 首次同步为空

- **WHEN** 一个从未成功同步的 Feed 成功返回空条目集合
- **THEN** 系统设置基线时间，后续首次出现的新条目可以成为候选

#### Scenario: 首次同步失败后恢复

- **WHEN** Feed 首次请求失败，随后一次请求成功
- **THEN** 只有成功请求建立基线，失败请求不产生基线或历史候选

### Requirement: Feed 条目去重和候选状态

系统 SHALL 按以下顺序生成条目身份：Feed 提供的稳定 `id` 或 `guid`、规范化 canonical URL、最后由 Feed 标识与条目元数据组成的稳定回退键。相同 Feed 和相同身份 SHALL 只保留一条条目记录。

新条目在基线建立后 SHALL 标记为 `candidate`，并保存 `first_seen_at`。系统 SHALL 同时保存 canonical URL（如果存在）供后续每日摘要进行跨 Feed 去重；本变更不改变不同 Feed 各自的来源记录，也不提前把跨 Feed 合并当作已通知。

#### Scenario: 重复轮询

- **WHEN** 后续轮询再次返回已经保存的条目
- **THEN** 系统不新增记录、不重置首次发现时间、不重复创建候选

#### Scenario: Feed 缺少稳定 ID

- **WHEN** 条目没有稳定 `id` 或 `guid`，但有 canonical URL
- **THEN** 系统使用规范化 URL去重，并保留该 URL作为条目身份依据

#### Scenario: 相同文章出现在两个 Feed

- **WHEN** 两个 Feed 返回相同 canonical URL
- **THEN** 系统分别保留来源条目及其来源关系，后续摘要层可以按 canonical URL合并，不在摄取层错误丢失来源

### Requirement: 可恢复的轮询 Job

系统 SHALL 将每个到期 Feed 检查表示为持久化 Job，并使用包含 Feed `id` 和轮询时间槽的稳定幂等键。相同幂等键重复调度 SHALL 返回原 Job，不产生第二个执行意图。

Feed worker SHALL 只领取 Feed 轮询 kind 的 Job，按到期时间、创建时间和 ID稳定排序，领取时增加尝试次数并取得租约和 run token。网络请求和 XML 解析不得在 SQLite 写事务中执行；成功入库、游标更新和检查结果 SHALL 在短事务中提交。

进程重启或租约过期后，系统 SHALL 恢复未完成的 Feed Job；未耗尽的 Job 重新进入 pending，耗尽的 Job 进入 failed。旧 run token、重复 worker 或迟到的外部结果 SHALL 不能覆盖新的执行结果。Feed Job 的恢复不得领取或改变现有文章采集 Job、普通会话 Turn 或会话回复 Outbox。

#### Scenario: 重复调度同一时间槽

- **WHEN** scheduler 因重启或重复触发再次请求同一 Feed 时间槽
- **THEN** 系统只保留一个幂等 Job，不能并发创建第二个相同轮询意图

#### Scenario: 轮询过程重启

- **WHEN** Feed worker 在外部请求期间退出，随后服务重新启动
- **THEN** 过期租约按尝试上限恢复，新的 worker 可以继续检查，旧 worker 不能写回或覆盖新状态

#### Scenario: 混合 Job 队列

- **WHEN** SQLite 中同时存在 Feed 轮询、文章采集和其他 kind 的 Job
- **THEN** Feed worker 只改变 Feed 轮询范围，其他 Job 的状态、租约和 attempts 保持不变

### Requirement: 调度和状态库兼容

系统 SHALL 在现有常驻服务生命周期内运行 Feed scheduler，并在启动时检查已到期的 Feed 轮询意图；调度器不得把网络请求直接放在定时回调中。启用 Feed 时，服务 SHALL 按配置间隔创建轮询 Job；服务停止时不得再创建或领取新的 Feed Job。

系统 SHALL 通过前向 schema migration 增加 Feed 状态和条目所需的数据结构，升级时保留现有 schema v3 中的 Conversation、Turn、Job、文章采集检查点和会话回复 Outbox。程序 SHALL 拒绝打开高于自身支持版本的状态库。

#### Scenario: 从 v3 数据库升级

- **WHEN** 服务打开一个有效的 schema v3 数据库
- **THEN** 系统新增 Feed 所需结构并保留所有已有运行状态，现有飞书聊天和文章采集可以继续恢复

#### Scenario: 高版本数据库

- **WHEN** 服务打开一个高于自身支持版本的数据库
- **THEN** 系统明确拒绝启动，不修改或降级该数据库

#### Scenario: 服务停止期间错过轮询

- **WHEN** 服务停止时间覆盖了一个或多个 Feed 轮询时间槽，随后重新启动
- **THEN** 启动检查会为到期来源创建缺失的幂等 Job，并继续使用基线和条目去重规则
