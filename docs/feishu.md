# 飞书私聊与公开文章采集

当前代码支持一个授权用户私聊、公开文章采集和可选 RSS/Atom 每日摘要；群聊、图片和未授权消息忽略。订阅候选保存在 radar.db，摘要由机器人主动发送到 `FEISHU_ALLOWED_OPEN_ID`。聊天文字及公开文章正文会发送给配置的模型供应商，文章全文不归档。代码验收与真实部署分别记录于 [URL 采集验收](url-capture-verification.md)。

## 1. 应用与配置

使用企业自建应用，开启机器人能力，配置可用范围包含你自己，发布应用版本。事件订阅方式选择长连接，添加 `im.message.receive_v1`；如果后台要求已有连接，先运行服务再保存订阅方式。不要同时运行连接同一应用的旧机器人程序。

最小收发权限：

- `im:message.p2p_msg:readonly`：读取用户发给机器人的单聊消息。
- `im:message:send_as_bot`：以应用身份发送消息。

### 摘要卡片交互

每日摘要和手动预览使用 Feishu Card 2.0。每篇文章旁边的星标按钮表示当前兴趣状态：空心星点击后变为实心星，再点一次恢复空心。每次点击都提交目标状态，重复投递同一个事件不会重复改变状态，新的点击事件可以继续切换。

在开发者后台打开「应用 → 事件与回调 → 回调配置」，启用卡片回调。这里不是普通的事件订阅项；服务会通过已有的长连接接收 `card.action.trigger`，校验应用、租户、授权用户、消息 ID 和受控 action，再把卡片更新结果作为长连接 ACK 返回。未启用卡片回调时，飞书会在点击按钮后提示“该应用尚未配置卡片回调”。旧的纯文本摘要和没有受控 action 的卡片会安全忽略。卡片回调不会把文章正文、完整卡片或密钥写入日志。

如果点击提示中的“前往配置”后显示应用不存在，先不要新建应用。项目发送卡片使用的是 `.env` 中的 `FEISHU_APP_ID`；`lark-cli auth status` 显示的是 CLI 当前授权应用，两者可能不同。请在与项目应用相同的飞书租户中登录开发者后台，按 `.env` 中的应用 ID 搜索应用，再进入上面的回调配置；如果搜索不到，需要让该应用的管理员把当前账号加入开发者协作者，或切换到应用所属租户。

卡片交互使用与订阅和对话相同的 `app_id`、`tenant_key`、`owner_open_id` 范围。更换这些身份前应先完成旧实例的队列处理，并备份状态库。

### 摘要卡片主题

卡片会按来源类型区分颜色和分组，方便在混合摘要中快速识别内容：RSS/博客使用青绿色，GitHub Trending 使用靛蓝色，GitHub Releases 使用紫色，arXiv 使用紫罗兰色，Newsletter 使用橙色，微信公众号使用绿色，未知来源使用灰色。混合来源卡片的总标题使用中性蓝色，每个来源分组保留自己的浅色背景。

主题只影响 Card 2.0 的标题模板、来源标签和分组背景，不改变文章排序、摘要内容或星标回调。新增 connector 时在 `src/feed/card-themes.ts` 注册 `sourceKind`，同时补充 resolver 和卡片结构测试；缺少 `sourceKind` 的历史数据会从旧的 provider 元数据推断，无法推断时使用灰色兜底。

[事件说明](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[权限列表](https://feishu.apifox.cn/doc-1939254)、[官方长连接 SDK](https://github.com/larksuite/node-sdk/blob/main/README.zh.md)。

复制 `.env.example` 为 `.env`，只在本地填入：

| 配置 | 获取方式 |
| --- | --- |
| FEISHU_APP_ID / FEISHU_APP_SECRET | 开发者后台 → 应用 → 凭证与基础信息。 |
| FEISHU_ALLOWED_OPEN_ID | API 调试台选择当前应用，在发送消息页面选择 open_id，通过快速复制成员 ID 选择你本人。不是机器人 ID。 |
| FEISHU_TENANT_KEY | 调试台查询企业信息，取 data.tenant.tenant_key；不是 display_id 或 tenant_access_token。 |
| KNOWLEDGE_RADAR_STATE_PATH | 本地数据库文件路径，例如 ./data/radar.db；Docker 会覆盖。 |
| KNOWLEDGE_RADAR_MODEL / 供应商密钥 | 沿用现有配置，例如 deepseek/deepseek-v4-flash 和 DEEPSEEK_API_KEY。 |

[获取 Open ID](https://open.feishu.cn/document/faq/trouble-shooting/how-to-obtain-openid)、[获取企业信息](https://feishu.apifox.cn/api-60206610)。本服务固定 app/tenant/owner 三元范围，更换后需重启，旧身份的队列不会自动排空到新身份。找不到标识时不要通过关闭白名单或“首个发消息的人自动成为管理员”绕过配置。

## 2. 运行与停止

本地开发（Node >=22.19，建议 Node 24）：

```powershell
npm ci
node --env-file=.env --import tsx src/cli.ts serve-feishu
```

For a read-only daily digest check, run:

```powershell
node --env-file=.env --import tsx src/cli.ts preview-feed-digest
```

The preview sends a Feishu Card 2.0 to `FEISHU_ALLOWED_OPEN_ID`, prints the accepted message ID, and leaves feed jobs, poll state, and `notified_at` unchanged. The bot must have `im:message:send_as_bot`.

Ctrl+C 停止；普通 npm start 不自动加载 .env。

Docker：

```powershell
docker compose -p knowledge-radar-feishu -f compose.feishu.yaml up -d --build
docker compose -p knowledge-radar-feishu -f compose.feishu.yaml logs -f radar
docker compose -p knowledge-radar-feishu -f compose.feishu.yaml stop
```

此文件可独立使用，不要叠加文章采集的 compose.yaml。非 root 用户运行，无监听端口；命名卷挂到 /var/lib/knowledge-radar，数据库固定为其下 radar.db。密钥通过环境变量注入，不会进入镜像，但本机有 Docker 管理权限的人仍可读取容器配置。

每次部署保持相同 Compose project 名，否则会创建另一套状态卷，看起来像“丢失历史”。可用 RADAR_ENV_FILE 指向另一份 env 文件，默认 .env；离线容器验收使用 .env.example。不运行 `down -v`，它会删除持久卷。状态库会从旧版本原子迁移到 v8，旧代码拒绝 v8；升级前停止服务并做一致性 SQLite 备份，Markdown 单独备份。回滚需恢复旧代码和迁移前数据库；保留新 Markdown 待核对，不批量删除。备份后的任务与消息去重状态会丢失，恢复后可能重复处理。

### 开启公开文章采集

先创建专用目录，设置 `.env` 的 `KNOWLEDGE_RADAR_ARCHIVE_DIR_HOST`，不可使用项目根或整个知识库：

```powershell
docker compose -p knowledge-radar-feishu -f compose.feishu.yaml -f compose.feishu.capture.yaml up -d --build
docker compose -p knowledge-radar-feishu -f compose.feishu.yaml -f compose.feishu.capture.yaml logs -f radar
```

override 将专用目录绑定到 `/app/archive`，设置容器归档变量和 `shm_size: 1gb`。目录必须已存在、可写且支持硬链接无覆盖发布；不自动创建宿主目录，不使用 root 或 chmod 777。基础文件显式清空容器归档变量，不产生此绑定。停止和重建使用同样两份文件、相同 project、相同归档根。

自定义 env 文件时，两种参数含义不同：`--env-file` 用于 Compose 路径变量插值；`RADAR_ENV_FILE` 用于服务 `env_file` 注入。需要同时设置，例如：

```powershell
$env:RADAR_ENV_FILE = 'D:/RadarConfig/radar.env'
docker compose --env-file D:/RadarConfig/radar.env -p knowledge-radar-feishu -f compose.feishu.yaml -f compose.feishu.capture.yaml up -d --build
```

本地 `serve-feishu` 使用 `KNOWLEDGE_RADAR_ARCHIVE_DIR`；宿主 `_HOST` 变量只给 Compose 使用。配置/目录修复后重启重新探测。目录缺失、不可写或不支持发布时输出 `capture_disabled`，仍能聊天；新 URL 明确拒绝，旧 pending Job 不增加 attempts，过期 Job 与已有 Outbox 继续恢复。已有检查点恢复必须使用同一根目录，改目录前先排空或人工处理未完成任务。

### 手机交互

- 单独发送 `https://example.com/article`，或 `总结 https://example.com/article`；不要用 Markdown 链接包装。
- 收到“已接收，正在采集。”只表示受理成功。采集期间可以聊其他问题；结果另行回复原消息，按标题、摘要、要点、归档文件名排列，末尾显示短任务标识。文件名为 `文章标题--短任务标识.md`；短标识取完整 Job ID 的 SHA-256 前8位，不是路由键。文档开头保存来源、任务创建时间、摘要生成时间和完整任务 ID（时间为 ISO 8601 UTC），不维护实时任务或投递状态。
- 普通句子提及链接、多个裸链接不自动浏览；明确命令缺参数/多个参数、无效协议、凭据、本地目标和超过 4,000 字符的请求会被拒绝。
- 可追问最近三份成功摘要，也会提供最近三个未完成/失败任务状态；不是全文检索或永久记忆。模型调用开始后才完成的任务，下次调用才能看见。多个任务指代不明时需明确任务或文章。
- 当前只访问公开正文，不登录、不绕验证码；401/登录墙、403/验证码、404/PDF/无正文等会有对应失败说明。正常文章谈论“登录”不会仅因关键词被拒绝。

## 3. 状态与故障排查

服务 stdout 不输出业务结果；stderr 是安全 JSON Lines 日志：

- connecting：开始连接，不代表成功；connected/reconnected 才是 SDK 的已连接回调。
- accepted/duplicate：已持久化入站/消息已接收过，附本地 turn_id 与 conversation_id。
- turn + answered：最终文本和 Outbox 已原子提交，不表示手机已收到。
- outbox + sent：飞书返回业务成功及消息回执，本地 sent 已提交。
- retry_scheduled：等待持久化 available_at；默认至少 30 秒，限流时尊重更长 Retry-After。
- lost_lease：旧执行者不能再回写；等待当前持有者或过期恢复。
- failed：终态。采集 Job 原子产生失败结果；普通聊天的模型终态失败仍只记日志。结果本身发送失败不再生成递归通知。
- storage_busy：数据库忙，不是 idle；确认没有其他进程长期持有写锁。
- capture_enabled/capture_disabled：归档能力已启用/降级；job 事件带 job_id、outcome 和安全错误码。
- stopped + drained：正常排空；三个循环共享 85 秒，Compose 宽限 100 秒。排空超时或采集资源清理失败退出 1，下次运行等待租约恢复。

输入最多 4,000 UTF-16 code units；超限 Turn 为 turn_too_large，不调用模型。历史最近六个合格轮次，每轮问答合计不超过 4,000；模型最多 60 秒生成，最终文本不超过 6,000。Turn 最多 3 次，租约 120 秒；Outbox 最多 3 次，租约 60 秒，发送含认证最多 10 秒。终态失败释放后续轮次/回复的阻塞。

上段超长失败规则针对普通聊天；明确采集请求超长会提交拒绝回复，不创建 Job。Job 租约 120 秒、最多三次、至少 30 秒退避；一次页面/模型/持久化/清理分别最多 20/50/5/5 秒，共用 80 秒预算并实际取消模型与关闭浏览器。文件 I/O 可能迟到，依靠不可变检查点和无覆盖发布保护，不承诺实时硬截止或断电级事务。

两种消息：`final_message` 为普通回复/接收确认/拒绝，`job_result` 为采集终态。普通回复只在同种消息内 FIFO；结果等待自身确认 sent 或 failed，其后可独立发送，不被较早任务或结果退避阻塞。确认 failed 后仍允许发结果，不保证用户先看到确认。消息重试只重发已提交文本，不读写 Markdown 或重跑模型。用户编辑归档后，未完成任务遇到内容冲突会失败并保留用户文件；已完成任务不会自动修复用户修改。

采集错误码与永久/临时分类见 [Change design](../openspec/changes/add-feishu-url-capture/design.md#9-页面摘要错误与期限)。模型与浏览器的原始异常、正文、完整 URL 和敏感路径不进入日志。

错误码：feishu_timeout、feishu_rate_limited、feishu_unavailable 可有限重试；feishu_forbidden、feishu_target_unavailable、feishu_invalid_payload、feishu_payload_too_large 终止。修复权限/配置后发送一条新的测试消息；本版没有“重置旧任务”命令，不要手改 attempts 或 token。

本地只读排查可使用 SQLite 客户端打开状态库，查询不含正文的投影：

```sql
SELECT id, conversation_id, state, attempts, max_attempts, error_code FROM turns ORDER BY created_at DESC LIMIT 20;
SELECT id, turn_id, state, attempts, max_attempts, error_code FROM outbox ORDER BY created_at DESC LIMIT 20;
```

只查询自己控制的数据库，不复制正文、secret、Token 或 SDK 原始对象到日志/问题报告。

## 4. SDK 契约与投递限制

锁定官方 `@larksuiteoapi/node-sdk@1.73.3`，许可证 MIT；保留包内 LICENSE。它提供真实 WSClient 的 onReady/onError/onReconnecting/onReconnected 和 close。start 提前返回不等同连接成功，SDK 日志全部关闭，由应用输出固定事件。

自动测试直接调用该版本真实 EventDispatcher 与 WSClient 事件帧处理逻辑：handler 抛错产生 ACK 500，成功为 200。适配器只在 SQLite 提交后确认，不在接收回调调用模型。SDK 的请求实例使用统一 AbortSignal，把取 Token 和回复请求纳入同一截止时间；实际 HTTP 请求被取消，没有额外发送重试层。

每条 Outbox 回复原 message_id。uuid 为 SHA-256(outbox.id) 的前 40 个十六进制字符，重试保持目标、内容、UUID 相同。接口说明 uuid 最大 50 字符，同 uuid 在 1 小时内至多成功一次；本地唯一约束和令牌 fencing 不会把平台这个时间窗口变成永久保证。[回复消息接口](https://feishu.apifox.cn/api-58349897)

因此“飞书成功但本地提交 sent 前崩溃”可能在去重窗口内被去重，超过窗口恢复则仍可能重复；有限重试也不保证必达。不会为不确定结果改发另一个用户、重跑模型或更换 UUID。

本项目 content 序列化后上限为 20,000 UTF-8 字节（比接口文档的文本上限更保守）；超限不静默截断或分片。永久错误映射采用接口列出的 230001/230011/230013/230025/230027 等数字，不解析错误文案，未知错误最多有限重试。[同一接口的错误表](https://feishu.apifox.cn/api-58349897)

## 5. 验收记录与真人清单

2026-09-09 已验证：

- 真实认证、机器人信息查询与租户匹配；真实私聊接收到指定测试文字（独立接收探针，非完整 Agent 闭环）。
- 自动化：70 项离线测试通过，TypeScript check/build 通过；包括入站事务回滚、重复消息、作用域隔离、SDK ACK、超时取消、发送成功/本地提交失败、旧令牌回写和停止排空。
- Docker：独立测试项目在全新命名卷中以非 root 写入；第二个新容器恢复同一会话，去重、历史、过期 Turn/Outbox 恢复及假投递均通过，不使用真实凭据。
- 实际服务：`knowledge-radar-feishu` Compose 项目已启动，收到 SDK `connected` 回调；容器内通过同一 Pi Runtime 完成一次真实 DeepSeek 简短回复测试。尚未据此认定真人收发或多轮上下文验收通过。
- OpenSpec：18/18 实施任务完成，目标变更及全部 4 个变更严格校验通过。临时 `radar-feishu-check` 测试卷和网络已清理；真实服务使用独立命名卷，不读取或覆盖宿主机原有数据库。

完整真人验收在用户可交互时逐项执行，不以以上离线测试替代：

- [ ] 发一句普通文字，日志依次出现 accepted、answered、sent，并在手机看到回复。
- [ ] 连续两轮对话，第二轮能使用前一轮上下文，回复关联正确原消息。
- [ ] 重启容器后继续聊天，上下文和去重记录保持。
- [ ] 飞书短时断网后恢复连接；平台重投不生成新 Turn。
- [ ] 模型调用中断后，租约到期恢复；不会发送半段输出。
- [ ] 回复发送中断后恢复；核对稳定 UUID，接受超出平台窗口的重复风险。
- [ ] 超长输入/权限失效等终态能从安全日志定位，不泄露正文或密钥。

断网/中断演练只针对本项目实例，不修改整机网络、不影响其他应用。正式对话测试会调用配置的真实模型，可能产生供应商费用。
