# 使用与维护指南

[返回项目首页](../README.md)

本页由原 README 迁入，保留完整配置、运行、数据管理与开发说明。以下命令均在项目根目录执行。

把手机上发现的好文章，变成自己知识库里的 Markdown。

Knowledge Radar 是一个面向个人使用的自托管知识收件箱：通过飞书发送公开文章链接，机器人提取正文、生成摘要，并将结果保存到你指定的目录。收到摘要后，可以继续围绕文章讨论。

```text
手机发送链接 → 确认接收 → 后台采集与总结 → Markdown 归档 → 飞书返回结果
```

> 项目处于早期可用阶段。飞书聊天、公开文章采集、RSS / Atom 和 GitHub Trending 订阅已实现；登录态浏览、话题切换和可视化页面仍在计划中。实际验证范围见[验收记录](url-capture-verification.md)。

## 现在能做什么

- **飞书私聊**：仅处理配置中指定用户的私聊文字，通过 Pi Direct Agent 调用模型回复。
- **明确触发采集**：单独发送一个 URL，或使用 `总结 <URL>`。普通聊天中提到链接不会自动打开网页。
- **公开文章总结**：使用 Playwright 渲染网页、Readability 提取正文，返回文章标题、摘要、要点和归档文件名。
- **继续讨论**：聊天可以使用最近的文章摘要；采集在后台执行，不要求用户等待它结束才能聊天。
- **可读归档**：文件名为 `文章标题--短任务标识.md`，保存到现有知识库的专用目录，不绑定某款笔记软件。
- **持久化任务**：SQLite 保存会话、任务、检查点和待发送回复。已保存检查点的任务重试不重新总结；回复投递重试不重新采集或归档。

## 快速开始：飞书聊天与文章采集

当前提供的是**源码构建部署**，还没有面向使用者的预构建镜像发布流程。宿主机无需安装 Node.js，但首次构建需要下载基础镜像和 npm 依赖。

已验证的环境是 Windows Docker Desktop。其他环境需要自行核对浏览器运行条件及目录权限，暂不承诺全部平台可直接使用。

### 1. 准备环境和飞书应用

需要：

- Docker Desktop 和 Docker Compose。
- 一个飞书企业自建应用，开启机器人能力并发布到包含你自己的可用范围。
- 一个支持的模型供应商账号和 API key。
- 一个已存在、可写的专用归档目录。

飞书采用**长连接接收事件**，无需给本项目配置公网域名、Webhook 回调地址或入站端口。应用需要接收私聊消息及以机器人身份发送消息的权限，并订阅 `im.message.receive_v1`。

App ID、Secret、租户标识和本人 Open ID 的获取方式见[飞书配置指引](feishu.md#1-应用与配置)。不要同时运行连接同一应用的旧机器人程序。

### 2. 配置本地环境

下载仓库后，在项目根目录执行以下 PowerShell 命令。**已有 `.env` 时不要覆盖，直接编辑现有文件。**

```powershell
Copy-Item .env.example .env
New-Item -ItemType Directory -Force D:\KnowledgeRadar\Inbox
```

编辑 `.env`，示例如下；占位值需要替换为你自己的配置：

```dotenv
KNOWLEDGE_RADAR_ARCHIVE_DIR_HOST=D:/KnowledgeRadar/Inbox

KNOWLEDGE_RADAR_MODEL=deepseek/deepseek-v4-flash
DEEPSEEK_API_KEY=填写模型密钥

FEISHU_APP_ID=填写应用ID
FEISHU_APP_SECRET=填写应用密钥
FEISHU_TENANT_KEY=填写租户标识
FEISHU_ALLOWED_OPEN_ID=填写你本人在该应用下的OpenID
```

上面的模型是当前验证使用的示例，不要求必须选择 DeepSeek。更换模型时，需要同时设置匹配的供应商凭据，参见[配置模板](../.env.example)。

归档目录必须支持硬链接发布；Linux 等环境还需保证容器用户有写权限。只挂载专用收件目录，不要挂载整个知识库或用户主目录。

### 3. 启动机器人

```powershell
docker compose -p knowledge-radar-feishu -f compose.feishu.yaml -f compose.feishu.capture.yaml up -d --build
```

查看启动日志：

```powershell
docker compose -p knowledge-radar-feishu -f compose.feishu.yaml -f compose.feishu.capture.yaml logs -f radar
```

看到 `capture_enabled` 表示归档能力已启用，看到 `connected` 表示飞书连接已建立。`connecting` 不代表连接成功。

若出现 `capture_disabled`，机器人仍可聊天，但会拒绝新的采集请求。检查目录配置、写权限和发布能力，修复后重启。更多说明见[故障排查](feishu.md#3-状态与故障排查)。

### 4. 从手机发送文章

直接发送一个公开文章 URL，或：

```text
总结 https://www.cnblogs.com/uniqueDong/p/22889846
```

机器人先回复“已接收，正在采集。”，成功后另行回复标题、摘要、要点、归档文件名和任务短编号。随后可以追问：

```text
这篇文章最值得我关注的观点是什么？
```

归档结构示意如下，时间和任务标识由程序生成：

```markdown
# 文章完整标题

- 来源：https://example.com/article
- 任务创建时间：2026-09-10T01:53:04.000Z
- 摘要生成时间：2026-09-10T01:53:16.000Z
- 任务 ID：完整任务标识

## 摘要

文章摘要……

## 要点

- 核心观点……
```

文章全文和聊天记录不会写入这份 Markdown。任务与回复投递状态保存在 SQLite 中，不写入静态归档。

## 日常使用与数据

停止服务：

```powershell
docker compose -p knowledge-radar-feishu -f compose.feishu.yaml -f compose.feishu.capture.yaml stop
```

再次运行相同的启动命令即可启动或重建服务。每次保持**相同项目名、状态卷和归档目录**；更改它们不会自动迁移历史。

| 数据 | 保存位置 |
| --- | --- |
| 模型与飞书配置 | 本地 `.env`，不提交到 Git |
| 会话、任务、检查点、待投递回复 | 命名卷中的 `/var/lib/knowledge-radar/radar.db` |
| 文章摘要 | 宿主机指定的归档目录，容器内为 `/app/archive` |

- 升级或进行数据库操作前，先正常停止服务，分别备份 SQLite 和 Markdown。回滚需要匹配的代码与数据库备份；详细说明见[部署文档](deployment.md)。
- **不要执行 `down -v`**，它会删除 Compose 的持久卷。
- 现有 Markdown 不会自动导入聊天上下文。删除或修改已完成归档，也不会触发机器人自动补写。
- 当前仍是测试阶段，不承诺旧检查点格式兼容；格式升级可能需要按对应变更说明备份并重建测试库，不要把清库当成日常升级步骤。

### 不接飞书，只采集一篇文章

配置好 `.env` 中的模型与归档目录后，可以使用独立的一次性入口：

```powershell
docker compose run --build --rm radar https://www.cnblogs.com/uniqueDong/p/22889846
```

成功时输出标题、最终 URL 和归档文件名。此入口不需要飞书凭据，也不使用飞书会话状态库。

仅需要文字聊天时，可以只使用 `compose.feishu.yaml`。这份配置不会挂载归档目录，具体命令见[飞书指引](feishu.md#2-运行与停止)。

## 边界、隐私与费用

- **本地保存不等于离线处理**：聊天文字和待总结文章正文会发送给配置的模型供应商。请勿发送不适合交给该供应商的内容。
- **软件开源不等于模型免费**：模型 API 调用可能产生费用；检查点提交前的中断可能导致再次调用模型。
- 当前只支持一个授权用户的私聊文字，不支持群聊、图片、语音或多用户管理。
- 网页需要登录、验证码、付费访问，或者没有可提取正文时，可能无法采集。不自动登录，也不绕过网站限制；无法保证识别所有阻拦页。
- 追问依据最近的受限摘要，而非文章全文或永久记忆。生成内容也可能不准确，重要信息请回到原文核对。
- 消息有限重试不等于必达，平台去重窗口外仍可能重复。普通聊天的模型最终失败目前可能只体现在日志中。
- 容器以非 root 用户运行，仅挂载状态和归档数据，但不等于完整安全隔离；拥有 Docker 管理权限的人仍可读取容器配置。
- 不自动发布博客、提交 Git，或把私人知识文件上传到 GitHub。

## 后续方向

优先把现有闭环做得容易部署、稳定且便于日常使用，不提前引入多服务或通用工作流。

- 完成当前版本的真人验收，整理发布与演示。
- 提供默认部署入口、预构建镜像和更清楚的配置诊断。
- 扩展来源 connector，接入 GitHub 热点、微信公众号、Newsletter 和 arXiv。
- 根据实际需求增加人工协助的登录态浏览和话题管理。
- 后续提供可视化页面，用于查看采集记录、任务状态和管理配置；当前不急于实现。

这些是方向，不是已实现能力或交付承诺。

## 开发与文档

技术栈：TypeScript / Node.js、Pi Direct Agent、Playwright、Readability、SQLite 和飞书 Node SDK。当前是一个应用容器，不依赖独立数据库、Redis 或向量数据库。

本地开发需要 Node.js >= 22.19.0：

```powershell
npm ci
npm run check
npm test
npm run build
```

离线测试使用 Fake Agent、页面或发送器验证状态机和恢复边界，不需要真实模型密钥。真实端到端验收另行记录，不能用测试通过代替。

- [飞书接入与故障排查](feishu.md)
- [代码与真实部署验收记录](url-capture-verification.md)
- [会话运行时与可恢复状态机](conversation-runtime.md)
- [Docker 部署设计](deployment.md)
- [技术选型](technology-selection.md)
- [架构与长期设计](architecture.md)
- [OpenSpec 变更](../openspec/changes/)

部分架构文档包含尚未实现的设计，以本页的当前能力和各 Change 的任务状态为准。欢迎提交问题与改进建议；问题报告请移除密钥、Token、正文和私人路径。

## 许可证

项目采用 [MIT License](../LICENSE)，允许使用、修改和分发。第三方组件仍遵循各自许可证；分发时需保留适用的许可证和版权声明。
