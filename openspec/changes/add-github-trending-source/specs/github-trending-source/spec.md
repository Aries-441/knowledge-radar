## Purpose

为 Knowledge Radar 提供一个不依赖登录态的 GitHub Trending 来源，把公开的周榜项目转换为统一的来源条目，让现有基线、去重、摘要和飞书反馈流程可以消费开源项目趋势。

## ADDED Requirements

### Requirement: GitHub Trending 来源配置 SHALL 被显式识别和校验

系统 SHALL 支持 `kind: github_trending` 的来源配置，并 SHALL 只接受受控的 connector 选项：`period` 为 `daily`、`weekly` 或 `monthly`，默认值为 `weekly`；`language` 为 `all` 或单个 GitHub 语言路径值，默认值为 `all`。来源 URL SHALL 使用 HTTPS 且指向 GitHub Trending 页面；配置不得包含 URL 凭据或未声明的 connector 选项。

#### Scenario: 解析最小周榜配置

- **WHEN** 配置包含 `kind: github_trending`、合法的 GitHub Trending URL 且未提供 connector 选项
- **THEN** 系统将来源标准化为 `period: weekly`、`language: all`，并保留现有来源的启用状态、优先级、标签和条数限制

#### Scenario: 拒绝不支持的趋势配置

- **WHEN** `period`、`language` 或来源 URL 不符合 GitHub Trending connector 的约束
- **THEN** 配置加载失败并返回安全的配置错误，系统不启动该来源的轮询 Job

### Requirement: GitHub Trending connector SHALL 生成稳定且有界的来源条目

connector SHALL 从公开 Trending 响应中提取仓库名称、仓库链接、项目描述、主要语言、排名和趋势 star 信息。每个有效项目 SHALL 使用 `github:owner/repository` 作为稳定 identity，规范化仓库 URL 作为 canonical URL，并将展示文本限制在现有 Feed item 字段边界内；返回条目 SHALL 按页面排名顺序排列。

#### Scenario: 解析周榜项目

- **WHEN** GitHub 返回包含排名、仓库名称、描述、语言和 star 增长信息的 Trending 页面
- **THEN** connector 返回带有稳定 identity、规范化 URL、非空标题和包含趋势信息的有界摘要条目

#### Scenario: 页面没有有效项目

- **WHEN** 响应成功但页面结构中没有可识别的有效仓库条目
- **THEN** connector 将本次轮询标记为不可解析错误，不写入空基线，也不删除该来源已有的条目

### Requirement: GitHub Trending 轮询 SHALL 复用来源生命周期和去重语义

GitHub 来源 SHALL 使用现有 feed poll Job、租约、重试和 token fencing 机制。首次成功响应 SHALL 建立 baseline；后续响应中 identity 未出现过的项目 SHALL 成为 candidate；同一 identity 的重复响应 SHALL 更新展示字段而不插入重复条目或重置 `first_seen_at`。

#### Scenario: 首次成功建立基线

- **WHEN** GitHub 来源第一次成功解析出项目列表
- **THEN** 所有项目保存为 baseline，且每日摘要候选中不包含这些历史项目

#### Scenario: 后续新项目进入候选

- **WHEN** 后续轮询返回已知项目和一个新的 `github:owner/repository` identity
- **THEN** 已知项目保持原条目身份，新的项目保存为 candidate 并可被摘要 Job 选择

### Requirement: GitHub Trending 请求 SHALL 遵守公开来源和失败隔离约束

connector SHALL 只访问配置允许的 GitHub Trending HTTPS 地址，不得读取 Cookie、登录态或未声明的密钥。响应大小、重定向、超时和解析边界 SHALL 受限；网络暂时失败、限流或服务端错误 SHALL 进入现有可重试路径，页面结构变化或配置错误 SHALL 进入不可重试的安全错误路径，且不得阻塞其他来源。

#### Scenario: GitHub 暂时不可用

- **WHEN** 请求超时、连接失败、收到可重试的服务端状态码或条件请求返回未修改
- **THEN** 来源只更新自身的轮询状态，按现有重试或 not-modified 语义处理，其他来源继续运行

#### Scenario: 响应包含超出边界的内容

- **WHEN** GitHub 响应超过大小限制、发生不允许的重定向或包含不受支持的页面结构
- **THEN** 本次来源轮询失败并记录安全错误码，不写入部分结果，不泄露响应正文或凭据
