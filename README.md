# Knowledge Radar

Knowledge Radar 是一个自托管的个人技术信息雷达和知识收件箱。

它持续监听关注的博客更新，在设定的时间通过飞书发送技术摘要；也接收从手机发来的文章链接，完成内容提取、总结、连续对话，并把结果归档到现有的 Markdown 知识库。

> 当前状态：第一条公开文章采集闭环正在实现。飞书、订阅和登录态仍未开始。

## 立即尝试

第一版使用一次性 Playwright 浏览器上下文渲染公开文章，再通过 pi SDK 生成摘要并归档。它不保存 Cookie 或登录态，也不支持登录页面。

1. 基于 [`.env.example`](.env.example) 创建本地 `.env`，设置归档目录、模型和对应供应商凭据。
2. 运行：

   ```powershell
   docker compose run --rm radar https://www.cnblogs.com/uniqueDong/p/22889846
   ```

成功时标准输出会返回标题、最终 URL 和相对于归档目录的 Markdown 路径。文章全文不会写入归档。

## 为什么做这个项目

平时看到值得读的文章，通常会先丢进微信、飞书或浏览器收藏夹，但后续很少真正整理。与此同时，博客和技术社区每天都有大量更新，逐个订阅和检查容易制造噪音，也很难形成稳定的阅读节奏。

Knowledge Radar 希望解决两个具体问题：

1. 把零散发现的文章变成可追问、可检索、可继续加工的知识素材。
2. 把博客更新压缩成一份有优先级的定时摘要，帮助持续接触新的技术方向。

## 核心原则

- **本地优先**：运行状态、浏览器登录态和知识归档默认留在自己的电脑上。
- **容器优先部署**：通过 Docker Compose 管理服务、持久卷和重启策略，不要求宿主机安装 Node.js。
- **Markdown 是资产**：SQLite 和 Agent 会话可以替换，最终内容必须是普通 Markdown。
- **确定性程序控制副作用**：抓取、文件路径、归档和通知由普通代码负责，Agent 只处理文本。
- **人掌握登录和发布权**：不把账号密码交给模型，不自动把私人素材发布到博客。
- **先完成小闭环**：第一版不做向量数据库、管理后台、多 Agent 或账号池。
- **开源从不完整开始**：设计、限制和路线图本身就是项目的一部分。

## 目标工作流

### 飞书知识收件箱

```text
手机发送文章链接
→ 机器人确认收件
→ 后台提取正文并总结
→ 飞书返回摘要
→ 围绕文章继续对话
→ 摘要和对话归档到知识库
```

### 博客技术雷达

```text
定时检查 RSS / Atom
→ 记录新增文章并去重
→ 根据兴趣和来源优先级筛选
→ 在设定时间生成一份摘要
→ 通过飞书提醒阅读
```

## 第一版边界

第一版计划支持：

- 飞书私聊接收单个网页链接
- 公开网页正文提取
- 中文摘要和围绕当前文章的连续追问
- Markdown 归档
- RSS / Atom 订阅、去重和每日摘要
- 消息幂等、失败重试和飞书用户白名单

第一版明确不做：

- 通用网页操作 Agent
- 自动注册或轮换网站账号
- 绕过付费墙、验证码或平台访问限制
- 自动发布博客或自动提交 Git
- 向量数据库和语义检索
- PDF、图片 OCR 和音视频解析
- Web 管理后台和多用户系统

需要登录的网页已经纳入架构设计，但安排在公开网页闭环完成之后实现。

## 文档

- [系统架构](docs/architecture.md)
- [技术选型](docs/technology-selection.md)
- [仓库结构设计](docs/project-structure.md)
- [迭代路线](docs/roadmap.md)
- [Docker 部署设计](docs/deployment.md)
- [会话运行时与可恢复状态机](docs/conversation-runtime.md)
- [ADR-0001：通过适配器使用 pi SDK](docs/decisions/0001-use-pi-sdk-behind-an-interface.md)
- [ADR-0002：副作用由确定性程序控制](docs/decisions/0002-keep-side-effects-outside-the-agent.md)
- [ADR-0003：登录态优先于自动填写密码](docs/decisions/0003-session-first-authentication.md)
- [ADR-0004：使用隔离的 Docker 服务部署](docs/decisions/0004-containerized-deployment.md)
- [ADR-0005：使用 npm workspaces 组织单仓库](docs/decisions/0005-organize-as-npm-workspaces.md)

## 暂定默认值

以下内容只是便于推进的工作假设，不是不可修改的承诺：

| 项目 | 暂定值 |
| --- | --- |
| 项目名称 | Knowledge Radar |
| 每日摘要时间 | 20:30，Asia/Shanghai |
| 知识库目录 | 由本地配置指定 |
| 默认归档目录 | `Private/Inbox` |
| 原文保存 | 默认不保存完整原文 |
| 运行方式 | Windows Docker Desktop + Docker Compose |
| 许可证 | 计划采用 MIT |

## 当前阶段的完成标准

开始写代码之前，应当能够从文档中回答这些问题：

- 哪个模块可以访问飞书、浏览器、模型和知识库？
- 公开网页、登录网页和用户提供内容分别怎样处理？
- 登录态失效、抓取失败和模型失败时，任务处于什么状态？
- 哪些数据可以提交到 Git，哪些必须留在本机？
- 第一版做什么，以及哪些功能明确推迟？
