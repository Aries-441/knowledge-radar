# 飞书 URL 采集验收记录

日期：2026-09-10。Change：`add-feishu-url-capture`。本记录区分离线验证和真实部署，不以测试通过代替手机端验收。

## 已完成的环境验证

- Windows 独立临时目录：完整发布、并发同内容复用、EEXIST 不覆盖、不同内容和目录冲突保留，通过。
- Docker Desktop：使用现有镜像，`--network none`、非 root `pwuser`（UID 1001）、独立临时 bind mount；同一发布测试通过，包括符号链接冲突。没有使用真实知识目录、状态卷或凭据。
- Windows 创建文件符号链接缺少权限；该项由以上 Linux 容器测试覆盖，未提升宿主机权限。
- 入口分类与 run-once 防误用测试通过；现有 73 项离线回归通过（新增完整采集测试之前的基线）。

## 容器重建验证

独立 `radar-url-capture-check` Compose 项目、独立命名卷和临时归档目录，三个新容器均以 UID 1001 通过：

1. 基础配置无归档挂载、归档变量为空，创建本地状态记录。
2. 叠加采集配置后保留原库，受理 URL、创建 Job/检查点、发布 Markdown，在终态提交前退出。
3. 换新容器，保留去重、Job、检查点和宿主 Markdown；恢复过期 Job，仅核对文件后提交结果，没有浏览器或模型调用，正式 Markdown 仍只有一份。

脚本为 `scripts/verify-capture-container.mjs`。额外只读源码挂载曾卡在 Docker 创建阶段，已取消该次验收客户端；改为内联传入同一脚本后通过，未重启 Docker 或真实机器人。基础/override 的 `config --quiet` 均通过，缺少宿主归档路径明确报错。

## 最终离线验收

- `npm test`：102/102 通过；`npm run check`、`npm run build` 通过。
- 最终独立 Linux 镜像中，35/35 采集相关测试通过（无网络，包括符号链接、磁盘/权限故障、迟到文件发布、三循环排空与 SQLite 恢复）。
- 目标 Change 严格校验通过；全部 5 个 Change 严格校验通过。前置规范尚未归档的 INFO 提示保留，不能据此直接归档当前 MODIFIED/RENAMED delta。
- README 与四份关联文档的本地链接检查通过；`git diff --check` 通过。本 Change 未增加依赖或 Agent 工具。
- 真实 Playwright 只读访问给定博客园文章，通过 HTTP/正文检查，提取标题“OpenAI 开源 Codex Security，Vibe Coding 我替你试了半开源真相”，正文 8,908 字符。本次没有调用真实模型、发送飞书或写入知识库。
- 已清理独立验收卷、网络和测试 Markdown/空临时目录；保留测试脚本与独立测试镜像。该阶段没有更新真实容器；随后部署情况见下一节。

## 首轮真实部署（2026-09-10，历史记录）

- 用户确认宿主归档目录为 `D:\Desktop\MyKnowledgeBase\Private\Inbox`；现有 `.env` 配置已匹配，本次未修改凭据或 `.env`。
- 保留旧镜像标签 `knowledge-radar-feishu-radar:pre-url-capture-20260910`。在干净停机（退出码 0）后，将 v2 数据库备份到 `data/backups/pre-url-capture-20260910/radar-v2.db`，完整性检查为 `ok`；目录原有文件备份到同级 `Inbox`。备份目录不纳入 Git。
- 复用已通过离线验证的镜像，以原 Compose 项目 `knowledge-radar-feishu` 和采集 override 重建服务，保留原状态卷 `knowledge-radar-feishu_radar-state`。数据库迁移至 v3，完整性检查为 `ok`；原有 3 条 answered Turn 和 3 条 sent Outbox 保留，部署检查时没有 Job。
- 唯一新增宿主挂载为确认目录至 `/app/archive`。容器以 `pwuser`（UID 1001）运行，共享内存为 1 GiB；同目录发布能力探测通过，临时探测文件已清理，原目录文件数量未变。
- 首轮部署检查时 `knowledge-radar-feishu-radar-1` 运行中，重启计数为 0，日志确认 `capture_enabled`、`connecting`、`connected`。本次部署检查没有代替用户发送消息、调用模型或归档文章。
- 回滚不能只切换旧镜像：旧版本不支持 v3 数据库，需要停机并恢复对应的 v2 备份，且先保留部署后的新数据。

## 待真人验收（任务 8.5，未勾选）

- 首轮用户已发送博客园 URL：Job `87cf44d7-922e-4a0e-866e-2f63def46742` 于北京时间 09:53:04 受理、09:53:16 成功、09:53:18 结果发送。Turn answered、Job succeeded、确认与结果 Outbox sent，均首次成功，租约/token 已清空。检查点、Job 结果引用、回复及 Markdown 一致；数据库完整性/外键检查通过。
- 并行聊天、真人摘要追问、真实失败反馈和真人任务重启恢复未执行；格式收尾后的新请求验收也未执行。任务 8.5 继续未勾选。

## 可读归档收尾（2026-09-10）

- 文件名统一为“文章标题--短任务标识.md”；短标识为完整任务 ID 的 SHA-256 前8位，标题清理 Windows 非法字符/保留名并按完整码点限制160 UTF-8字节。文档头部保存来源、任务创建时间、摘要生成时间和完整任务 ID，不记录动态状态。一次性 CLI 复用格式。
- 检查点版本为2，创建时间核对真实 Job.created_at，文件名/时间/回复随首次检查点冻结；不兼容旧格式。确认固定为“已接收，正在采集。”，成功结果以标题开头，任务短编号收尾，失败原因也先于短编号。
- 全量104/104测试、类型检查与构建通过；新镜像无网络、非root的45/45采集相关测试通过，包括真实32位短哈希碰撞不覆盖、Unicode长度、路径边界、静态元数据、消息顺序和状态机回归。目标及全部5个Change严格校验通过；前置规范尚未归档的INFO仍保留。
- 镜像为 `knowledge-radar:readable-archive-20260910`（部署ID `sha256:6e650f7d31ee7cd7fc919ec688b441c84cc35170be3c48bda2f20cd665be6ea1`）。独立命名卷的base/seed/recover三个容器阶段均通过（UID1001）：发布中文/emoji文件名后退出，新容器复用文件/检查点，无网页和模型调用，去重、结果及上下文保持。
- Docker曾在临时宿主挂载及旧容器inspect/cp/recreate/rm操作持续等待，未据此误报部署成功。经用户明确授权后执行Docker Desktop重启，操作恢复；新镜像在独立宿主bind mount的5/5归档测试通过。重启会影响其他运行容器，本轮未修改其他项目配置。
- 服务干净停机后，原状态卷 `knowledge-radar-feishu_radar-state` 内的 `/var/lib/knowledge-radar/pre-readable-archive-20260910/snapshot.db` 保存一致性快照；旧radar.db移入同目录，WAL/SHM当时已不存在。原库的1个Conversation、4条Turn、1个Job、5条Outbox、1份检查点、1条飞书映射及4条去重记录均可从备份恢复。
- 快照导出至宿主 `data/backups/pre-readable-archive-20260910/radar-before-reset.db`，完整性复核ok。两份旧Markdown备份在同级Inbox目录，与真实知识目录逐文件SHA-256一致。旧镜像保留为 `knowledge-radar-feishu-radar:pre-readable-archive-20260910`。原状态卷、.env、旧知识文件和此前备份全部保留。
- 新空库仍为schema v3（检查点版本与数据库schema版本分开），七张业务表计数均为0、完整性ok。使用原Compose项目和状态卷部署新版，归档仍绑定 `D:\Desktop\MyKnowledgeBase\Private\Inbox` → `/app/archive`，pwuser/UID1001、1GiB共享内存，日志确认capture_enabled与connected。
- 随后单独重启机器人，日志确认正常drained并重新connected；空库、卷内备份和两份旧Markdown保持不变。独立测试卷、三个已退出辅助容器和空测试目录已清理；正式镜像及备份保留。
- 本轮未代用户调用真实模型、发送测试消息或创建真实知识归档。任务9.1–9.4完成；8.5仍需用户重新发送URL并验证新格式、追问及失败反馈。清库后的旧Markdown不会自动导入聊天上下文，清库前后的消息去重不保证延续。
