## Purpose

为 Knowledge Radar 提供唯一、可持久化且可升级的本地运行状态库，使后续渠道和执行器能在进程重启后读取一致的 Conversation、Turn、Job 与 Outbox 记录。

## ADDED Requirements

### Requirement: 初始化唯一的运行状态库
系统 SHALL 在调用方指定的位置创建或打开唯一的运行状态库，并保存 Conversation、Turn、Job 与 Outbox 记录。系统 MUST 将运行状态与 Markdown 知识库、浏览器 Profile 和 Pi 会话存储分离。

#### Scenario: 首次打开状态库
- **WHEN** 指定路径不存在运行状态库
- **THEN** 系统 SHALL 创建可用的状态库，并允许后续创建 Conversation、Turn、Job 与 Outbox

#### Scenario: 重开已有状态库
- **WHEN** 一个已写入记录的状态库被关闭后重新打开
- **THEN** 系统 SHALL 保留已提交的记录及其状态

### Requirement: 有版本地升级状态库
系统 SHALL 识别已提交的状态库版本，并在升级到受支持版本时保留已有的有效记录。系统 MUST 拒绝打开高于自身支持版本的状态库，且不得修改该文件。

#### Scenario: 从旧受支持版本升级
- **WHEN** 系统打开一个低于当前受支持版本的状态库
- **THEN** 系统 SHALL 完成所需升级并保留原有记录

#### Scenario: 打开未来版本
- **WHEN** 状态库版本高于当前程序支持的版本
- **THEN** 系统 MUST 返回明确错误，且不得写入或降级该状态库

### Requirement: 完成 Turn 与最终消息原子提交
系统 SHALL 支持将一个持有有效租约的 Turn 标记为 `answered`，并创建其最终 Outbox 意图作为一笔提交处理。提交失败时，系统 MUST 不留下已完成 Turn 或最终 Outbox 的部分状态。

#### Scenario: 原子完成 Turn 与创建最终消息
- **WHEN** 当前 Runner 完成一个已领取 Turn，并请求创建最终 Outbox 记录
- **THEN** Turn 的 `answered` 状态与最终 Outbox SHALL 同时可见，或在事务失败时均不可见
