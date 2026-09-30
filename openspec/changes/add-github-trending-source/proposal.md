## Why

当前来源 registry 只有 RSS / Atom，Knowledge Radar 还不能主动收集 GitHub 热点趋势。用户希望按周收到可排序、可去重的开源项目动态，而现有 feed 基线、候选和飞书摘要链路已经可以复用，适合先接入一个来源明确、边界可测试的 GitHub Trending connector。

## What Changes

- 新增显式 `github_trending` source connector，读取公开 GitHub Trending 页面并输出统一的 feed snapshot。
- 支持 `weekly` 趋势周期，并保留 `daily`、`monthly` 作为受校验的配置选项；支持全部语言或单一语言过滤。
- 解析仓库名称、仓库 URL、项目描述、主要语言、排名和趋势 star 增长信息，生成稳定的 `github:owner/repository` 条目身份。
- 复用现有首次基线、候选去重、轮询 Job、失败重试和每日摘要发送流程；首次成功抓取只建立基线，不向飞书发送历史项目。
- 为 GitHub 页面解析增加固定 HTML fixture、配置校验、HTTP 条件请求、解析失败和结构变化测试；测试不依赖实时 GitHub 网络。
- 更新来源配置、部署和故障排查文档，提供 GitHub Trending 的最小 YAML 示例。

## Capabilities

### New Capabilities

- `github-trending-source`: 定义 GitHub Trending 来源配置、抓取、解析、稳定身份、趋势字段和错误行为。

### Modified Capabilities

- 无。现有 RSS / Atom 来源和摘要行为保持兼容；GitHub 来源通过显式 `kind` 加入 registry。

## Impact

- 影响 `src/feed/source.ts`、`src/feed/config.ts`、feed parser/connector 实现、运行时 feed item 序列化和相关 SQLite migration（若需要保存结构化趋势元数据）。
- 影响来源配置文档、Compose feed overlay 文档、connector contract 测试和 feed source 端到端测试。
- 不新增必需的 GitHub token，不使用登录态浏览器；第一版只访问公开 Trending 页面。网络不可用、GitHub 限流或页面结构变化时，单个来源进入现有可重试/可诊断的失败路径，不影响其他来源和飞书对话。
