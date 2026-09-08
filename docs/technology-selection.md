# 技术选型

## 1. 状态

本文记录设计阶段的候选技术和选择理由。除明确标为 **Accepted** 的条目外，其余仍是 **Proposed**；Accepted 表示已完成与该决定直接相关的最小验证，不代表整项功能已实现。

第一版的选型标准：

1. 适合单用户、单机、长期运行。
2. Windows Docker Desktop 和 Linux Docker Engine 上安装、升级和回滚成本低。
3. 优先使用官方 SDK 和成熟库。
4. 组件能够替换，不把业务逻辑绑死在某个 Agent 框架上。
5. 不为了未来可能出现的规模提前引入分布式基础设施。

## 2. 选型总览

| 领域 | 暂定选择 | 状态 |
| --- | --- | --- |
| 语言和运行时 | Node.js 24 + TypeScript | Proposed |
| 项目形态 | 独立仓库中的模块化单体 | Proposed |
| 仓库和包管理 | npm workspaces：两个应用、一个协议包 | Proposed |
| Agent Runtime | pi SDK 的 Direct Agent，通过内部接口接入 | Accepted（2026-09-08） |
| 消息渠道 | 飞书官方 Node SDK Channel，WebSocket 长连接 | Proposed |
| 运行状态 | Node.js 内置 SQLite | Proposed |
| Feed 解析 | `rss-parser` | Proposed |
| 公开网页提取 | Fetch + Mozilla Readability + JSDOM | Proposed |
| 登录网页提取 | Playwright 独立持久化 Profile | Proposed |
| 调度 | Croner | Proposed |
| 配置 | YAML + Zod | Proposed |
| 日志 | Pino | Proposed |
| 测试 | Node.js Test Runner | Proposed |
| 部署和进程管理 | Docker Compose | Proposed |
| 浏览器隔离 | 独立、非 root 的 Playwright 服务 | Proposed |
| 开源许可证 | MIT | Proposed |

具体版本在实现开始时锁定，不在设计阶段追逐最新版本。

## 3. 语言和运行时

### 选择：Node.js 24 + TypeScript

理由：

- pi SDK 和飞书官方 SDK 都以 TypeScript/Node.js 为一等使用方式。
- 本机已经使用 Node.js 24，能够直接利用内置 SQLite，减少原生依赖。
- 飞书长连接、网页抓取、RSS 轮询和模型调用都是 I/O 密集任务，Node.js 足够合适。
- TypeScript 能约束消息、任务、文章和模型输出之间的数据契约。

未选择 Python，不是因为它做不了，而是当前核心依赖都偏向 TypeScript。为了内容处理单独引入第二语言暂时没有收益。

Node.js 的 SQLite API见[官方文档](https://nodejs.org/api/sqlite.html)。正式实现前需要用目标 Node 24 小版本验证备份、WAL 和异常恢复行为。

## 4. Agent Runtime

### 选择：pi SDK 的 Direct Agent，而不是 fork pi 或持久化 Harness

pi 官方 SDK 支持嵌入应用、模型选择、会话管理、自定义系统提示和禁用工具，覆盖本项目需要的能力。[pi SDK 文档](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md)

接入方式：

```text
应用服务 → AgentRuntime 接口 → PiAgentRuntime → pi SDK
```

内部接口只暴露项目需要的能力：

- `summarize(document)`
- `continueConversation(session, message)`
- `rankDigest(candidates)`
- `closeSession(session)`

第一版不给 pi 内置的 Shell、浏览器、编辑或写文件工具。这样既利用 pi 的模型能力，又不让业务流程依赖其工具实现。

会话恢复由 Radar SQLite 的 `agent_context_json` 完成，不采用 Pi `AgentHarness` + SQLite Session Backend。2026-09-08 的本地技术验证确认后者可以恢复 Lane，但它的内部 SQLite 提交不能与 Radar 的 Turn、Job、Outbox 事务合并；同库写锁下会报 `database is locked` 并使 Harness fault。验证及状态机见[会话运行时与可恢复状态机](conversation-runtime.md)。

未选择方案：

| 方案 | 暂不选择的原因 |
| --- | --- |
| Fork pi | 升级、冲突解决和安全修复成本长期落在自己身上 |
| Pi `AgentHarness` + SQLite Session Backend | 会引入无法与 Job/Outbox 原子提交的第二个状态机；当前不需要分支会话能力 |
| 直接调用单一模型 SDK | 初期更简单，但会丢失 pi 已有的模型目录和供应商适配 |
| LangGraph | 当前流程主要是确定性编排，图框架增加的抽象多于收益 |
| 通用多 Agent 框架 | 本项目没有需要多个自主 Agent 协商的任务 |

详细决定见 [ADR-0001](decisions/0001-use-pi-sdk-behind-an-interface.md)。

## 5. 飞书接入

### 选择：`@larksuiteoapi/node-sdk` 的 Channel 模块

Channel 已经封装 WebSocket 长连接、自动重连、消息归一化、策略控制、消息回复和流式输出，适合对话式机器人。[飞书官方 SDK Channel 文档](https://github.com/larksuite/node-sdk/blob/main/docs/channel.zh.md)

选择长连接的原因：

- 主机只需要主动连接飞书，不需要开放入站端口。
- 不需要公网 IP、域名、HTTPS 证书和反向代理。
- 更符合个人电脑常驻服务。

应用仍然要自己实现跨重启幂等，因为 SDK 的内存去重不能覆盖进程重启。

暂不选择 Webhook。未来若部署到稳定的公网服务器，Webhook 可以作为第二种 Transport，而不改变内部消息模型。

## 6. 状态存储

### 选择：SQLite

SQLite 保存的是运行状态，不是知识正文：

- 飞书消息幂等键
- Feed 游标和文章去重键
- 持久化任务和重试状态
- 文章、归档文件和会话之间的映射
- 等待发送的 Outbox 消息
- 登录 Profile 的元数据和健康状态

未选择 Redis、PostgreSQL 和专用任务队列。当前只有一个进程和一个用户，引入独立服务会增加备份、启动顺序和故障排查成本。

并发策略保持保守：单进程、有限 Worker、同一浏览器 Profile 串行执行。SQLite 使用 WAL，并在应用启动时回收超时的 `processing` 任务。

## 7. 内容获取

### 7.1 RSS 和 Atom

选择 `rss-parser`，用于把 RSS 2.0、Atom 和常见扩展字段归一化。Feed 获取本身仍由受控 HTTP 客户端完成，以便统一处理超时、体积限制、重定向和日志。

订阅状态必须区分：

- 首次基线
- 新增候选
- 已进入摘要
- 已通知
- 解析失败

### 7.2 公开网页

选择原生 Fetch、JSDOM 和 Mozilla Readability：

1. Fetch 负责受限下载和重定向检查。
2. JSDOM 构造文档对象。
3. Readability 提取标题、作者、摘要和正文。
4. 自己的清洗器限制长度并删除无关内容。

不能只依赖 Readability。页面内嵌 JSON、Open Graph、JSON-LD 和 Feed 摘要都可以作为补充证据。

### 7.3 登录网页

选择直接使用 Playwright Library，而不是把 Playwright MCP 暴露给 Agent。

原因：

- 本项目只需要打开指定 URL 并提取正文，不需要模型自由浏览网页。
- 程序可以严格控制目标域名、跳转、超时和读取范围。
- 独立持久化 Profile 能保存 Cookie、Local Storage 和 IndexedDB。

Playwright 明确支持持久化 `userDataDir`，同时不建议自动化日常 Chrome 主 Profile。[Playwright BrowserType 文档](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)

浏览器能力作为后续阶段加入，公开网页流程不依赖它。

## 8. 认证方案调研结论

主流项目采用的不是单一“自动登录算法”，而是多层认证策略：

| 项目 | 做法 | 对本项目的启发 |
| --- | --- | --- |
| Playwright MCP | 项目级持久化 Profile，也能通过扩展复用现有浏览器标签页 | 登录一次、长期复用状态是基础方案。[文档](https://playwright.dev/mcp/configuration/user-profile) |
| OpenClaw | 推荐用户在独立 Profile 手动登录，不把凭据交给模型 | 默认登录流程应当有人参与。[文档](https://docs.openclaw.ai/tools/browser-login) |
| Browser Use | Profile、Storage State、域名限制；敏感值以占位符传给模型，随后注入页面 | 自动填密可做，但必须与模型隔离。[文档](https://docs.browser-use.com/open-source/examples/templates/sensitive-data) |
| Skyvern | 外部 Vault、运行时凭据注入、TOTP 和 Browser Profile | 适合作为后续高级方案，不适合第一版照搬。[文档](https://www.skyvern.com/docs/developers/credentials/store-credentials) |
| Browserbase | 云端 Context 保存完整浏览器状态，支持人工 Live View 登录 | 证明 Profile 模式有效，但个人项目没必要上传登录态。[文档](https://docs.browserbase.com/platform/browser/core-features/contexts) |
| Composio | OAuth Connect Link、按用户保存连接并自动刷新 Token | 有官方 API 时优先 OAuth，不应抓网页。[文档](https://github.com/ComposioHQ/composio/blob/next/docs/content/docs/authentication/index.mdx) |

本项目采用：

```text
官方 API / 私有 Feed 优先
→ 匿名网页抓取
→ 独立 Profile 的已登录会话
→ 用户手动提供正文
```

密码保险库、自动填写和 TOTP 不进入第一版。详细决定见 [ADR-0003](decisions/0003-session-first-authentication.md)。

## 9. 调度和任务执行

### 选择：Croner + SQLite 任务表

Croner 只负责“什么时候触发”，SQLite 任务表负责“是否已经执行”和“失败后怎么办”。不能把可靠性寄托在内存定时器上。

默认计划：

- Feed 轮询：每 30 分钟。
- 每日摘要：每天 20:30，`Asia/Shanghai`。
- 登录失效：发现时提示，不循环轰炸。
- 失败重试：指数退避并设置最大次数。

未选择 BullMQ，因为它要求 Redis；也不采用系统计划任务分别启动每个业务任务，因为常驻进程已经需要维持飞书长连接。

## 10. 配置、日志和测试

### 配置

- YAML 保存非敏感业务配置：Feed、标签、时间、限额和域名策略。
- Zod 在启动时验证配置并提供明确错误。
- 环境变量或系统凭据保存飞书和模型密钥。
- Browser Profile 保存在项目和知识库之外。

### 日志

Pino 输出结构化日志。默认记录任务 ID、阶段、耗时和错误类别，不记录网页正文、用户对话、Cookie、Token 或模型完整 Prompt。

### 测试

Node.js Test Runner 足够覆盖第一版，不增加测试框架依赖。测试分层：

- 单元测试：URL 安全、去重、调度、归档路径、配置校验。
- 契约测试：AgentRuntime、ContentResolver、Notifier。
- 集成测试：临时 SQLite 和本地测试网页。
- 手工验证：真实飞书长连接和需要登录的网站。

## 11. 部署和仓库边界

Agent 项目与 `MyKnowledgeBase` 分开：

```text
D:/Desktop/knowledge-radar                    # 开源代码和公开文档
D:/Desktop/MyKnowledgeBase/Private/Inbox      # 唯一读写挂载的知识库目录
Docker named volume: radar-state              # SQLite 和应用状态
Docker named volume: browser-profiles         # Cookie 和浏览器状态
宿主机受限 secrets 目录                       # 飞书和模型密钥
```

### 选择：Docker Compose

Docker Compose 是正式部署入口，从第一个可运行版本开始提供。它负责服务生命周期、重启策略、网络、持久卷和 secrets 授权，使宿主机不需要安装 Node.js、Playwright 或项目依赖。

部署拆为两个安全域：

| 服务 | 拥有 | 明确不拥有 |
| --- | --- | --- |
| `radar` | 飞书连接、模型访问、SQLite、Inbox 写入 | Cookie、Chromium、整个知识库、Docker Socket |
| `browser` | Chromium、Browser Profiles、目标网页网络访问 | 飞书和模型密钥、SQLite、知识库 |

Playwright 官方建议抓取不可信网站时使用非 root 用户和适合 Chromium sandbox 的 seccomp 配置，并建议固定容器和客户端版本。[Playwright Docker 文档](https://playwright.dev/docs/docker)

`radar` 使用非 root 用户、只读根文件系统、`cap_drop: ALL` 和 `no-new-privileges`。Docker 官方说明 `read_only`、secrets 和 `no-new-privileges` 都可以在 Compose 服务上声明；secrets 只会挂载给显式授权的服务。[Compose 服务文档](https://docs.docker.com/reference/compose-file/services/)

`browser` 同样使用非 root 用户和最小权限。为了保留 Chromium sandbox，采用 Playwright 推荐的受限 seccomp 配置；不使用 `privileged`。优先设置独立 `/dev/shm` 大小，不默认共享宿主 IPC。若目标平台验证后确实需要 `ipc: host`，必须记录为平台例外。

Docker 本身不能消除所有风险。Docker 官方仍将 daemon、容器配置、内核和宿主挂载列为安全面；因此不挂载 Docker Socket，不使用宿主网络，并把知识库读写挂载缩小到 Inbox。[Docker Engine 安全文档](https://docs.docker.com/engine/security/)

Windows Docker Desktop 通过 bind mount 将 `Private/Inbox` 映射到容器路径。路径转换只存在于 Compose 部署配置中，应用内部始终使用 Linux 容器路径。状态和 Browser Profiles 使用 named volumes，避免把高频 SQLite I/O 和 Linux 浏览器 Profile 直接放在 Windows 文件共享上。

独立仓库的好处是机器人密钥、运行状态和第三方依赖不会污染知识库，其他用户也可以把它连接到自己的任意 Markdown 目录。

仓库内部使用 npm workspaces 管理 `apps/radar`、`apps/browser` 和 `packages/browser-contracts`。它只承担本地 package 链接、统一安装和单一 lockfile，不引入额外 monorepo 编排工具。完整目录和依赖规则见[仓库结构设计](project-structure.md)。

## 12. 许可证

计划采用 MIT，目标是降低个人用户和二次开发者的使用门槛。实现前还需要根据最终依赖锁文件完成一次许可证核对，并在 README 中列出需要额外遵守的组件条款。
