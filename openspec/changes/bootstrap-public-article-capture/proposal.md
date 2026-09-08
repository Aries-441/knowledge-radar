## Why

公开文章的实际页面形态差异很大，静态下载无法稳定获得动态渲染后的正文。第一轮改用一次性 Playwright 渲染，先验证“一个常见博客链接能否变成可留存 Markdown 摘要”。

## What Changes

- 提供一个容器命令，接收单个公开 HTTP/HTTPS URL。
- 使用临时浏览器上下文渲染页面后提取正文；允许必要脚本和接口请求，阻止明显本地目标及图片、媒体、字体等无关资源。
- 通过一个最小 `AgentRuntime` 函数调用 pi SDK，在禁用工具的情况下生成包含概述和要点的结构化摘要。
- 将标题、最终来源 URL、采集时间和摘要写成一份 Markdown，并返回归档路径。
- 用自制网页、Fake AgentRuntime 和临时目录验证归档闭环，并以博客园文章完成真实冒烟测试。
- 本轮不接入飞书、RSS、SQLite、后台进程、重试、去重、登录态、多轮对话、浏览器持久化 Profile、域名白名单或出口代理。

## Capabilities

### New Capabilities

- `public-article-capture`: 从一个人工提交的公开 URL 渲染并取得正文、生成摘要、写入 Markdown，并返回结果的完整行为。

### Modified Capabilities

- 无。

## Impact

- 新增一个 Node.js/TypeScript 应用、Playwright 依赖、一个 Dockerfile 和一个单服务 Compose 入口。
- 容器只挂载配置的归档目录；浏览器使用临时上下文，AgentRuntime 不获得网络、Shell、浏览器或文件系统工具。
- 首轮采用基础浏览器网络过滤；Docker 隔离降低风险，但不替代完整的出口网络策略。
