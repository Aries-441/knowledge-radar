## Context

动机见 [proposal.md](proposal.md)。代码检查基线为 2026-09-09：

- `src/runtime/schema.ts` 为 user_version=1，仅有 conversations、turns、jobs、outbox；不存在渠道映射和入站去重表。
- `RuntimeStore` 已提供短事务、令牌 fencing、租约、有限重试及 FIFO；`claimOutbox()` 当前是全局领取，不能直接作为飞书专用发送器。
- `processConversationOnce()` 已在领取前恢复指定 Conversation 的过期 Turn，调用注入的 Agent，并原子提交 answered 与 final_message。Outbox 上限为 3；失败重试 30 秒；Turn 租约 120 秒。
- Pi Runtime 单次最多 60 秒、无工具；当前输入上限 4,000 UTF-16 code units，输出 6,000。历史只用已提交问答，不以是否送达作为纳入条件。
- CLI 只有 URL 采集和 run-once；现有 Compose 面向文章归档，必须提供归档挂载路径，不能直接作为飞书服务配置。
- `docs/conversation-runtime.md` 混合已实现阶段和未来话题路由目标。apply 时需要更新阶段说明，不把本次“一私聊一会话”描述成多话题已完成。

## Goals / Non-Goals

**Goals:**

复用现有持久化边界，仅增加飞书来源关系、薄适配器及两个后台循环，让提交过的工作在重启后继续。

**Non-Goals:**

范围见 proposal。本版不增加第二套消息总线、持久化 Agent session、通用渠道注册框架或进程分布式协调；一个数据库部署一个常驻服务。数据库锁与 fencing 仍须正确，但不能据此宣称跨进程外部发送 exactly-once。

## Decisions

### 1. 官方长连接，不自建 webhook 或 WebSocket 协议

使用 `@larksuiteoapi/node-sdk`，企业自建应用、Feishu 域，SDK 负责连接重建及应用令牌缓存。仅订阅 `im.message.receive_v1`。官方说明长连接无需公网回调地址，事件处理有约 3 秒期限，因此回调只进行边界校验和短事务，不等待模型。[官方 SDK 用法](https://github.com/larksuite/node-sdk/blob/main/README.zh.md)

在 apply 中选取并锁定可用的正式 SDK 版本；用假传输验证该版本的回调 reject 确实生成失败确认。当前官方实现会把事件处理异常编码为非成功 ACK，而不是把 throw 自动当成功。不得 catch 数据库错误后正常 return；不手写第二层重连循环。[官方 WSClient 源码](https://github.com/larksuite/node-sdk/blob/main/ws-client/index.ts)

`start()` 返回不能直接当“已联网”：只记录 starting，连接状态仅根据所选版本可验证的连接信号报告。SDK 原始日志不直接透传；适配器仅输出允许的事件/错误码，避免 SDK debug、HTTP 错误对象包含消息或凭据。

### 2. 两张渠道表，不把飞书字段塞进 Agent 或复制最终文本

在 v1 上新增 v2，保留原四表和 Outbox payload 形状：

| 新表 | 最小字段与约束 |
| --- | --- |
| `feishu_chats` | `app_id, tenant_key, chat_id` 组成主键；`owner_open_id` 非空；`conversation_id` 非空 UNIQUE 且 FK 到 conversations；`created_at`。 |
| `feishu_inbound_messages` | `app_id, tenant_key, message_id` 组成主键；`chat_id` 与前两列复合 FK 到 feishu_chats；`turn_id` 非空 UNIQUE 且 FK 到 turns；`created_at`。 |

正文只存在 Turn，回复只存在 Outbox。无需完整事件 JSON、event_id 去重表、投递审计表、provider 回执列或通用 channel 类型层级。message_id 标识业务消息，event_id 不作为唯一去重依据；相同入站键不会更新任何原记录。

`acceptFeishuText()` 是新增的单事务 store 操作（名称为实现建议）：

1. 事务前解析并校验自建应用绑定、租户、sender_type=user、允许 open_id、chat_type=p2p、message_type=text、非空标识和非空白 text。身份以平台 envelope/受认证连接绑定为准，不从 content 推导。若事件提供 app_id 必须一致，租户缺失不得用“允许租户”默认补齐。
2. BEGIN IMMEDIATE 后检查入站键；存在则核对 chat/owner，返回原 turnId、conversationId 及 duplicate，不覆盖内容。
3. 查找或创建固定映射：Conversation kind=`feishu_private`、固定标题“飞书私聊”，不取用户原文当标题。归档或 owner 冲突返回明确 ignored，不改绑。
4. 在该事务内生成递增 sequence、source=`feishu`、maxAttempts=3 的 Turn，并插入来源关联；提交后返回 accepted。
5. 不嵌套调用会自行开事务的 public create 方法：复用内部无事务 SQL 帮助方法或少量直接 SQL，确保一个连接、一次提交。任何中间失败全部回滚。store 操作验证来源 Turn 与映射所属 Conversation 一致；外键加事务保护合法写入路径。

不加长期用户管理：五项飞书/状态配置启动时读取后固定，变更需重启。过滤、扫描和投递一律应用当前 app_id、tenant_key、owner 三元范围；替换应用或用户不会排空旧范围队列。新增入站顺序采用数据库提交顺序，不实现平台时间戳重排。

### 3. Agent 不知道飞书；来源决定目的地

无需修改 `TopicAgentRuntime` 请求/返回类型和 `completeTurnWithOutbox()`。投递时由 Outbox.turn_id join 来源关联取得原 message_id，调用官方回复接口；不要改用当前 chat 指针、模型生成的地址或内存 Map。

使用 `client.im.message.reply`，path 为原 message_id，data 为 `msg_type: text`、`content: JSON.stringify({text})`、`uuid`。同一 Outbox 的稳定 uuid 使用 `sha256(outbox.id)` 十六进制前 40 字符，即便已有 ID 不是 UUID 也有固定长度。内容和目的地都来自不可变持久化记录。[官方回复消息接口](https://open.feishu.cn/document/server-docs/im-v1/message/reply)

sender 独立校验 payload.text 为非空字符串且符合现有 6,000 长度界限；content 序列化后的 UTF-8 字节数采用本项目 20,000 字节保守上限。这不是对平台限制的替代声明，SDK 版本验收时同时核对官方上限。超限终止 `feishu_payload_too_large`，不静默截断/分片，否则会引入多个发送意图和去重规则。

### 4. 有限至少一次投递，不扩展 Outbox 状态机

新增飞书范围内的领取和过期恢复查询，复用既有 transaction、attempts、令牌写回方法。范围条件必须在 SQL 领取事务内，不是先全局 claim 再在应用层跳过。仅处理 `final_message`，FIFO 保留同 Conversation 较早未终态 Outbox 的阻塞语义；无关 Conversation 不互相阻塞。

发送策略固定为：

| 项目 | 第一版行为 |
| --- | --- |
| 租约 | 60 秒；claim 与 attempts 自增原子完成。 |
| 网络期限 | 一次发送操作总共 10 秒，包含取 Token；适配器取消/限制底层 HTTP，不仅 Promise.race 后放任后台继续重发。 |
| 重试 | 禁用发送请求隐式重试；暂时性/不确定错误至少 30 秒后重试；有效 Retry-After 较长时取较长值。 |
| 上限 | 使用记录的 max_attempts，正常最终回复为 3；不在发送器重新设定或重置 attempts。 |
| 成功 | 业务 code=0 且 data.message_id 非空后调用 fenced markOutboxSent。 |
| 暂时性错误 | 网络/超时、限流、服务端错误或无法确认的响应分别映射安全 `feishu_timeout`、`feishu_rate_limited`、`feishu_unavailable`；未知业务错误有限重试。 |
| 永久错误 | 已核实的权限/不可回复原消息错误映射 `feishu_forbidden` / `feishu_target_unavailable`；非法载荷映射 `feishu_invalid_payload`；有效 token 下 failOutbox。 |
| 失去租约 | 所有 fenced 写回 false 均返回 lost_lease，不 reread 后伪报成功、不补发。 |

具体平台错误数字用所选 SDK/官方接口核验并集中做小映射，不依赖错误文本关键字猜测。网络返回 HTTP 200 不等于业务成功。标记 sent 的数据库错误不能进入“发送失败”catch；存储忙留给后续租约恢复，存储损坏停止服务。

平台 UUID 去重不是无限期保证；本文不依赖某个永久有效窗口。发送成功但本地未记账可能重试，同一 UUID 在平台有效窗口内帮助去重，窗口外仍可能重复。第一版接受此剩余风险，不增加首次发送时间、人工确认状态或送达查询补偿；有限尝试也意味着不承诺最终必达。apply 的接入指引必须记录当时官方说明的 UUID 限制和有效期，不能把本地 UNIQUE 称为端到端 exactly-once。

### 5. 单进程、两条串行循环，数据库就是待办列表

建议文件职责保持收敛：

- `src/channels/feishu/adapter.ts`：SDK/配置/事件归一化/回复传输及安全错误映射。
- `src/runtime/feishu-service.ts`：常驻协调与投递单步函数；复用 turn-worker，不重写 Agent 逻辑。
- 原 `schema.ts/store.ts/types.ts` 增加渠道存储能力；`src/cli/` 增加命令分支与生产依赖注入。测试就近放置，不预建 repositories/services/providers 多层目录。

Turn 循环逐个遍历当前授权映射的 active Conversation，每个调 `processConversationOnce()` 一次；若多项则本轮都检查，再重新扫描。Outbox 循环独立恢复目标范围过期发送、领取并发送一个回复；有进展可继续，空闲/忙/可恢复错误后用可中断的 1 秒定时再查。每条循环 await 上一操作，不使用会叠加异步回调的 setInterval。

启动以及持续轮询都会查数据库，不依赖“新消息”内存通知唤醒。过期 Turn 由现有 scoped recovery 处理；Outbox 新增 scoped recovery，attempts 耗尽即 failed。不得调用全局 `recoverExpiredLeases()` 修改无关 Job。归档会话不再运行 Agent，但先前已生成回复在授权未变时可以送达。

入站超过 4,000 字符依旧提交，由现有 Worker 产生 `turn_too_large` 终态；Agent 重试耗尽也只记录失败，不新增错误通知事务。输入/输出限制、上下文裁剪沿用既有行为。用户界面只有最终回复，不保证每条错误都有机器人提示，部署指引明确这个第一版限制。

### 6. CLI、关闭和可观察性

新增 `serve-feishu`，生产入口注入 Pi Runtime 和官方适配器；测试注入 Fake Agent、假接收/发送以及可控时钟/等待函数，不通过环境变量切换“测试生产模式”。

必需配置：`KNOWLEDGE_RADAR_STATE_PATH`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_TENANT_KEY`、`FEISHU_ALLOWED_OPEN_ID`。模型选择仍使用 `KNOWLEDGE_RADAR_MODEL`。不读取 .env 到日志，不引入明文凭据文件之外的新密钥系统。配置样例只用占位符；日志抑制也必须覆盖 SDK 本身。

常驻 stdout 保持空，stderr 为 JSON Lines 安全日志。accepted/duplicate/ignored、Turn/Outbox outcome、storage_busy、连接状态和停止结果使用固定 event 名，业务状态变化带本地 ID；忽略事件只记录 reason，不记录个人 open_id/原事件。不逐秒输出 idle。连接配置错误与不可恢复数据库错误退出 1；网络断连由 SDK 恢复。不能承诺所有凭据失效都能被启动同步检测，异步鉴权失败需可见安全日志。

SIGINT/SIGTERM 后关闭 SDK 长连接并禁止新入站/新领取，等待两条循环当前操作最多 65 秒；正常收尾关闭数据库并退出 0。超时退出 1，不能先关仍被任务使用的连接后假装排空；进程退出留下的 running/sending 由租约恢复。CLI 顶层拥有退出职责，库函数使用停止信号，不把 process.exit 散落在 store/适配器内。

### 7. Docker 复用现有镜像，独立服务配置

新增独立 `compose.feishu.yaml`，运行 `docker compose -f compose.feishu.yaml up -d --build`；不是必须和原文章 Compose 合并的覆盖文件。相同镜像入口、command=[serve-feishu]、init=true、restart=unless-stopped、stop_grace_period=90s、.env 注入，命名卷 radar-state 挂到 /var/lib/knowledge-radar，STATE_PATH=/var/lib/knowledge-radar/radar.db。无 ports，无 Docker socket，无强制归档挂载。

在镜像构建时创建该目录并赋予现有 pwuser 所有权，验证全新卷的非 root 可写性。配置调整不借机拆分镜像/移除 Playwright；聊天不用浏览器，但复用镜像是本轮最小改动。文档提醒 down -v 会删除命名卷数据，常规重建不能加 -v。

### 8. 恢复检查点与验收

| 中断点 | 下一次运行应发生什么 |
| --- | --- |
| 入站事务提交前 | 无新记录；平台重投可重新接收。 |
| 入站提交后、ACK 前 | 去重命中原 Turn。 |
| 模型调用中 | 等租约过期后恢复；从已提交历史重新调用，不恢复半段输出。 |
| answered + Outbox 提交后 | 仅发送已提交文本，不再调用模型。 |
| 发送成功、sent 提交前 | 相同目标/文本/UUID 的有限重试，存在跨平台去重窗口外重复风险。 |
| 旧进程写回 | fencing 拒绝，本地状态不回退。 |

自动验收使用真实临时 SQLite 文件和 Fake Agent/假传输，模拟关闭重开、并发重复、锁竞争、请求成功但本地写回失败、令牌过期、不同应用/用户/渠道混合队列。SDK 契约测试使用本地假 HTTP/事件帧，不连接真实平台。真人发送、断网重连与容器实机持久化按部署条件单列证据，不在缺凭据时声称已通过。

## Risks / Trade-offs

- [停机期间事件不一定无限保留] → 仅保证已提交工作的恢复，不实现平台历史拉取。
- [跨平台发送存在不确定性] → 稳定 UUID、有限重试、fencing；明确窗口外可能重复及重试耗尽可能无回复。
- [错误时手机端可能没有回复] → 本轮沿用 Worker 终态，通过安全日志排查；后续单独设计失败通知，不假借 final_message 写入未经定义的失败语义。
- [一个私聊混合多个主题] → 本轮固定一会话，验证接入后再单独做显式话题管理，不让 Agent 猜路由。
- [本地数据库包含聊天正文] → 不提交 Git、不写日志、卷由用户管理；容器不提供数据加密，不抵御本机管理员读取。
- [SQLite 同步短事务占用事件循环] → 不在事务内执行网络；保留现有 250ms busy_timeout，忙时拒绝本次入站确认，不在回调里长时间自旋。
- [SDK 正式版本与 main 分支不同] → apply 第一步锁定版本并验证 ACK、关闭、HTTP 超时与 UUID 契约，文档链接不是已安装版本证明。

## Migration Plan

1. 停服务并备份状态库，确认 v1 存量数据。v0 先建已有 v1 再顺序迁移 v2；v1 仅创建两张新表/索引，不重建原四表；v2 重开无变更。迁移事务内读取版本，DDL 和 user_version 一起提交，异常全部回滚。
2. 保持拒绝高于支持版本的库。新增测试保证原 Turn/Job/Outbox 的数据、attempts、令牌和可恢复行为不变。
3. 完成无网络自动验收；更新状态机文档的“已实现/当前 Change/未来”标签，保留后续多话题目标而非删除。
4. 使用自建应用启用机器人，订阅私聊接收事件并申请最小收发权限；发布版本、配置可用范围，按官方调试工具取得应用对应的 open_id 和 tenant_key。所有敏感配置由用户填写，不自动创建/发布应用。
5. 本地或容器启动后手动私聊验证、重投验证与重启恢复；未做的真人步骤明确标记待验证。
6. 回滚代码时先停服务。旧版本会拒绝 v2 数据库，因此使用迁移前备份恢复到另一个已确认路径；不自动降级/删表。回滚会放弃备份之后的新聊天状态，须事先告知用户。
