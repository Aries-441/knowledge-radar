# 会话运行时与可恢复状态机

- 状态：Implemented subset（v3 代码：飞书显式 URL → Job；真人验收单独记录）
- 日期：2026-09-10
- 已实现前置 Change：`add-durable-runtime-store`、`add-topic-aware-agent-runtime`、`add-feishu-text-chat`；本轮 `add-feishu-url-capture` 的逐项进度见 tasks.md。
- 后续关联：显式多话题路由、状态卡、登录态浏览

## 0. Pi 技术验证结论

第一版采用 **Direct Agent + Radar 自己的 SQLite 状态机**，不将 `AgentHarness` 或 Pi 的 SQLite Session Backend 放入生产运行路径。

验证保留在 [`src/agent/pi-harness-spike.test.ts`](../src/agent/pi-harness-spike.test.ts)，不读取密钥、不请求模型网络：

1. `AgentHarness` 与官方 `SqliteSessionRepo` 能在关闭、重开后恢复同一 Lane 的消息，持久化能力本身有效。
2. 当 Radar 在同一个 SQLite 文件中持有 `BEGIN IMMEDIATE` 事务时，Harness 的独立写入因 `database is locked` 失败。
3. Harness backend 自行打开连接并提交内部事务，没有暴露可与 Radar 组合的连接或事务。因此不能原子地提交 Turn、Job、Outbox 与 Pi 会话写入。

Harness 的分支、工具状态和会话恢复以后仍可能有价值；届时需要可组合的存储适配器，或者显式接受两个独立提交及其补偿逻辑。在此之前，Direct Agent 每次从 Radar 的已提交状态重建上下文。

## 1. 目标与边界

目标上，Knowledge Radar 的飞书窗口需要容纳多个话题；当前实现仍是一私聊固定一 Conversation，尚未实现下文的多话题路由。后续用户可以同时讨论文章、项目设计和临时问题，各话题拥有独立上下文和归档去向。

目标模型需要：

1. 在 Docker 重启、模型调用失败、飞书断连或登录过期后恢复可恢复的工作。
2. 避免同一入站消息重复建任务、同一抓取重复归档，或不同话题串上下文。
3. 只向用户显示稳定、可解释的状态，不推送未完成的模型流式文本。
4. 保持单机单 `radar` 进程和单一 SQLite 数据库，不引入分布式队列或多 Worker 协调。

系统不承诺第三方模型或飞书 API 的端到端 exactly-once。本地状态以原子事务保证一致；未来对外投递采用可去重的 at-least-once 语义。

`add-durable-runtime-store` 是这个目标的窄子集：它只实现本地 SQLite 的 Conversation、Turn、Job、Outbox 及其队列语义，不接飞书、Agent、浏览器或实际投递。

## 2. 状态边界

### 2.1 四种实体不能混用

| 实体 | 含义 | v1 状态 | 后续扩展 | 不应承担的职责 |
| --- | --- | --- | --- | --- |
| Conversation | 一个长期话题 | `active`、`archived` | 会话路由与摘要元数据 | 不记录单次外部工作是否失败 |
| Turn | 一条输入或内部通知的一次处理 | `queued`、`running`、`answered`、`failed` | 无额外运行态 | 不等待人工登录 |
| Job | 可重试的提交后工作 | `pending`、`running`、`succeeded`、`failed` | `waiting_auth` | 不决定话题上下文 |
| Outbox | 某个 Turn 的最终消息投递意图 | `pending`、`sending`、`sent`、`failed` | 状态卡/revision 的独立模型 | 不保存业务结果本身 |

`retry_wait` 不是任何实体的状态。延迟重试仍保留在可领取状态，通过未来的 `available_at` 阻止过早领取。

`waiting_auth` 仅属于未来的 Job 模型。它要等登录 Profile、认证健康检查和相应迁移一起落地，不能被 v1 的通用队列 API 预先伪实现。

### 2.2 Agent 内存不是事实来源

Pi 的 `AgentHarness` 可持久化 Lane，但其提交无法和 Radar 业务事务原子组合。因此 Direct Agent 不持有跨进程运行态：处理每个 Turn 时，由程序从 `radar.db` 的已提交投影重建模型上下文。

模型不得获得或持久化 Cookie、Local Storage、密码、验证码、浏览器 Profile，未完成流式文本、未验证的工具参数，或完整第三方原文。会话只关联 `captureId`、URL、标题、已归档摘要和受限摘录。

## 3. 持久化模型

`radar.db` 是运行状态唯一的真相来源。下面明确区分当前 Change 实现的 v1 与未来目标模型，避免把未来字段错误放入第一轮 schema。

### 3.1 v1：`add-durable-runtime-store` 的实现契约

| 表 | v1 字段与约束 |
| --- | --- |
| `conversations` | `id`、`kind`、`title`、`status`、创建/更新时间；仅作为 Turn 父实体。 |
| `turns` | `id`、`conversation_id`、`sequence`、`source`、`content`、`state`、`available_at`、`run_token`、`lease_expires_at`、`attempts`、`max_attempts`、`error_code`、时间戳；唯一 `(conversation_id, sequence)`。 |
| `jobs` | `id`、可空 `origin_turn_id`、`kind`、`payload_json`、`idempotency_key`、`result_json`、`error_code`、`state`、`available_at`、`run_token`、`lease_expires_at`、`attempts`、`max_attempts`、时间戳；唯一 `idempotency_key`。 |
| `outbox` | `id`、`turn_id`、`kind`、`payload_json`、`state`、`available_at`、`run_token`、`lease_expires_at`、`attempts`、`max_attempts`、`error_code`、时间戳；唯一 `(turn_id, kind)`。 |

v1 约束如下：

- 所有时间均为可比较的 epoch 毫秒整数。`max_attempts` 是创建时给定并永久持久化的上限，不能只存在于调用栈。
- Job 的 `origin_turn_id` 可为空，系统 Job 不必伪造来源 Turn。
- Outbox 只保存 Turn 的不可变最终消息。它不保存 `conversation_id`、`sequence`、`lane`、`revision` 或状态卡内容；顺序由 join 到所属 Turn 的 Conversation 和 `sequence` 推导。
- v1 不建 `chat_contexts`、`inbound_messages`、`archive_entries`、`auth_profiles`，也不建 `memory_summary`、`agent_context_json`、`runtime_version`。
- v1 不会实际发送 Outbox；`sending`/`sent` 状态属于先定义并测试好的投递队列契约，供后续通知适配器使用。

唯一的跨实体业务事务是：验证已领取 Turn 的有效令牌后，在一次提交中把它设为 `answered` 并创建其唯一最终 Outbox。入站确认、状态卡和 Agent 上下文投影均不在此事务中。

### 3.2 后续目标模型

以下是 v2 文字闭环之外的后续目标，不修改 v1 状态语义：

| 目标能力 | 可能新增的持久化内容 |
| --- | --- |
| 会话路由 | `chat_contexts(owner_open_id, chat_id, current_conversation_id)` 与飞书来源标识。 |
| 入站去重 | 已由 v2 的 feishu_inbound_messages 实现，以 app_id、tenant_key、message_id 唯一；不能改为只按 event_id 去重。 |
| Agent 上下文 | Conversation 的 `memory_summary`、受限 `agent_context_json`、`runtime_version`。 |
| 登录态 | `auth_profiles`、健康状态与 generation；等待登录的 Job 才可使用 `waiting_auth`。 |
| 归档补偿 | `archive_entries`，记录稳定路径、内容哈希与 Archive Job 意图。 |
| 飞书状态展示 | 独立的状态卡/revision 模型及其迁移；不得反向污染 v1 最终消息 Outbox。 |

这些字段只保存可安全重放的业务投影。绝不直接序列化任意 Pi 内部对象，也不写入凭据、完整原文或未验证的工具调用。

## 4. v1 状态机与并发规则

### 4.1 Turn

```text
queued --claim--> running --complete--> answered
                    |  \--terminal failure--> failed
                    \--retry before limit--> queued (future available_at)
```

同一 Conversation 的 Turn 按 `sequence` FIFO。领取者只能领取最早的非终态 Turn，且该 Turn 必须是 `queued`、`available_at <= now`、`attempts < max_attempts`。前序 `running` 或未来 `queued` Turn 阻塞后续 Turn；`answered`、`failed` 不阻塞。

### 4.2 Job

```text
pending --claim--> running --success--> succeeded
                     |  \--terminal failure--> failed
                     \--retry before limit--> pending (future available_at)
```

Job 不需要 Conversation FIFO。它以全局唯一 `idempotency_key` 入队，允许可空 `origin_turn_id`。未来登录接入后才增加 `running -> waiting_auth -> pending`；该转移不属于 v1。

### 4.3 Outbox

```text
pending --claim--> sending --sent--> sent
                     |  \--terminal failure--> failed
                     \--retry before limit--> pending (future available_at)
```

Outbox 在所属 Turn 的 Conversation 内按 Turn `sequence` 投递。较早的非终态 Outbox 阻塞较晚记录；较早的 `sent` 或 `failed` 记录不阻塞。v1 仅有最终消息，没有状态通道，也没有 revision 覆盖规则。

### 4.4 原子领取、租约和写回

每种领取在短 `BEGIN IMMEDIATE` 事务中完成：选择候选记录，再以状态和可用时间为条件更新。领取成功时将记录变为运行态、递增 `attempts`、写入不可预测的 `run_token` 和未来 `lease_expires_at`。

每个完成、失败、重试或续租写回都必须同时满足：记录仍处于对应运行态、`run_token` 相同、`lease_expires_at > now`。不满足时影响行数为零，旧 Runner 必须放弃写回。离开 `running` 或 `sending` 时，必须在同一更新中清除令牌和租约。

SQLite 连接设置有限 busy timeout。超过该时间的 `SQLITE_BUSY` 是可重试的存储忙错误，不能被当成“没有可领取记录”；无论空结果或存储忙，竞争领取时至多一个 Runner 得到同一记录。

### 4.5 延迟、上限与启动恢复

调用方计算退避时间，状态层只保存并执行 `available_at`。未耗尽 `max_attempts` 的失败记录直接回到 `queued` 或 `pending`，并在未来时间前不能再次领取；已经耗尽时转为 `failed`。

启动恢复只处理租约已过期的 `running` Turn/Job 与 `sending` Outbox：仍有尝试次数的记录恢复为当前可领取的状态，耗尽的记录变为 `failed`。两种路径都清除旧令牌和租约。未过期租约不变，避免重启窗口内重复执行。

## 5. 后续飞书与 Agent 接入流程

下面是目标流程，不是 v1 的实现清单。飞书入口 Change 在同时引入入站去重、路由与状态展示模型后，才能实现它。

```text
飞书事件
-> 本地事务：入站去重、Conversation 路由、Turn(queued)
-> 立即确认飞书事件
-> Conversation Runner 领取最早 Turn
-> Direct Agent 与短工具处理
-> 本地事务：安全上下文投影、Turn(answered)、最终 Outbox
-> Job Worker / Archive Worker / Outbox Sender 执行提交后的副作用
```

事件处理器在本地入站事务提交后尽快确认飞书，不等待抓取或模型调用。未来状态卡只在持久化状态变化时更新，不逐字转发模型 token；它将拥有独立的版本和投递模型，不与最终消息 Outbox 共用 `lane` 或 `revision`。

### 5.1 话题路由

模型不决定消息属于哪个话题。飞书接入后的固定优先级为：

1. `/new <title>` 创建新 Conversation；`/use <id>` 或卡片动作切换当前 Conversation。
2. 回复机器人历史消息时，使用该消息关联的 Conversation。
3. 新 URL 默认创建新的文章 Conversation。
4. 普通文本进入当前 Conversation；没有当前 Conversation 时要求用户选择或新建。

每个用户、每个飞书聊天范围内只维护一个 `current_conversation_id`。切换话题不取消其他 Conversation 中已运行的 Job。

### 5.2 短工具与长工作

短工具在当前 Agent Turn 内完成，例如 `get_current_article()`、`search_archived_articles(query)`、`get_auth_status(site)`。长工作只创建具备稳定 `idempotency_key` 的 Job，例如 `request_capture(url)`、`request_login(site, profileId)`；真实副作用由提交后的 Job Worker 执行。

登录失败时，未来认证 Change 把关联 Job 置为 `waiting_auth` 并记录匹配的 Profile generation。用户在手机上触发人工登录后，Profile generation 变化才能使匹配 Job 回到 `pending`；不得伪造抓取成功。

## 6. 断点与恢复语义

| 断点 | v1 或后续处理 | 用户可见结果 |
| --- | --- | --- |
| 进程在模型调用中退出 | v1 中 Turn 租约到期后按上限恢复；后续 Agent 从已提交投影重建 | 不发送半句回答 |
| 进程在最终消息提交前退出 | Turn 保持非终态，恢复后重新处理 | 不出现无记录的“已回复” |
| 进程在最终消息提交后退出 | Turn 与最终 Outbox 已同时存在，后续 Sender 可投递 | 最终结果可补发 |
| Job Worker 在副作用前退出 | Job 租约到期后恢复 | 可继续执行 |
| Job Worker 在副作用后退出 | 依赖已提交 Job 的 `idempotency_key` 查询或去重 | 不重复创建业务工作 |
| 浏览器发现登录失效 | 后续认证模型让 Job 等待登录 | 一次明确登录提示 |
| 飞书连接断开 | 后续 Outbox Sender 重试可投递记录 | 待发送结果补发 |

租约是单实例部署下的防御性正确性约束，不代表当前设计支持多 Worker 水平扩展。

## 7. Agent 上下文与归档目标

后续 Agent 运行时每次重建时读取已提交的 `memory_summary`、受限上下文投影和关联 Capture 元数据，并按 `prompt_version`、模型和工具 schema 重建 Direct Agent。上下文超限时，先把摘要作为一个普通 Turn 的最终事务的一部分提交，再丢弃旧投影；不能先删后写。

归档接入后，`article` Conversation 的问答由 Archive Writer 追加到对应 Markdown；`general` Conversation 写入 `Private/Conversations/`。SQLite 与文件系统不能组成同一原子事务，因此必须先写 `archive_entries` 的稳定意图和路径，再通过可重试 Archive Job 写临时文件并原子替换。此机制不属于 v1。

## 8. 本地 run-once 实现

`add-topic-aware-agent-runtime` 在 v1 表结构上提供单次消费入口：

v3 入口限制：先检查 Conversation；`feishu_private` 返回 `{"outcome":"unsupported_conversation"}`、退出 1，不恢复或领取任何队列。下列步骤仅适用于本地会话。

1. 只恢复目标 Conversation 的过期 Turn，按持久化尝试上限恢复为 `queued` 或 `failed`。
2. 以 120 秒租约领取最早可处理 Turn；当前输入超过 4,000 个 UTF-16 code units 时直接失败。
3. 从之前 `answered` Turn 的 `final_message` 重建历史；先排除无效载荷及合计超过 4,000 字符的轮次，再保留最近六轮。只投影文本，不传递 token、凭据或 SDK 对象。
4. 每次新建无工具 Pi `Agent`，60 秒总截止时间，一次 Provider stream 调用。
5. 回复经验证后，通过 `completeTurnWithOutbox()` 原子落库；最终 Outbox 使用 `max_attempts = 3`。Agent 失败退避 30 秒；成功、失败和重试写回失租时均放弃旧结果。

数据库错误不会被当成 Agent 失败重试；领取后的提交失败由租约过期恢复继续处理。`run-once` 不消费 Job 或投递 Outbox。完整契约见 [Change design](../openspec/changes/add-topic-aware-agent-runtime/design.md)，本地命令见 [README](../README.md#本地话题运行时)。

## 9. 验收与明确延后

`add-durable-runtime-store` 必须通过以下可重复的本地测试：

1. `radar.db` 的首次创建、重开、前向迁移和未来版本拒绝。
2. 两个 Runner 竞争领取一条 Turn、Job 或 Outbox 时，至多一个成功；另一方只得到无记录或可重试存储忙。
3. 旧令牌、过期租约或错误运行态均不能写回；离开运行态后令牌和租约被清除。
4. 未来 `available_at` 不可领取，重试上限在重开后仍生效，过期租约按是否耗尽分流为可领取或 `failed`。
5. 已领取 Turn 的 `answered` 状态和唯一最终 Outbox 同时可见或同时不可见。
6. 不存在 `retry_wait`、Outbox `lane`/`revision`、飞书状态卡或 Agent/浏览器/网络副作用。

上述是最初 v1 的存储验收。现已接入飞书收发、入站去重和受限 Agent 历史，v3 采集 Job 见第 11 节；仍延后话题指针、状态卡和 revision、登录 Profile 与 `waiting_auth`、长期压缩记忆、独立 Archive Job、浏览器持久化 Profile、Shell/文件/CDP 工具，以及端到端 exactly-once 承诺。

## 10. v2 飞书文字闭环

本节记录 v2 历史行为；v3 的三循环、85 秒排空、显式 URL 与失败通知以第 11 节为准。

新增 feishu_chats（应用/租户/私聊唯一映射）和 feishu_inbound_messages（应用/租户/message_id 去重并关联 Turn），原四表结构与状态枚举保持不变。入站事务原子创建映射、Turn 和来源关联，成功后才确认事件。

serve-feishu 使用两条独立串行循环：Turn 循环复用第 8 节 Worker，投递循环只领取当前 app/tenant/owner 范围内有飞书来源的 final_message。启动及轮询都恢复到期工作，不恢复无关 Job；归档会话不接收新 Turn，但其已提交回复仍可投递。

Outbox 租约 60 秒，发送含取 Token 最多 10 秒，至少 30 秒退避（限流时尊重更长 Retry-After），上限 3 次。回复原消息的 UUID 从 Outbox ID 固定派生。远端成功后才 fenced 标记 sent，数据库提交失败不当成模型/发送失败；旧 token 的成功、失败、重试写回一律 lost_lease。

正常停止不再接收或领取，最多等待 65 秒排空；超时进程退出 1，不伪写成功，由下次租约恢复。当前失败只记安全日志，不发失败通知或处理中卡片；输入超过 4,000 字符失败，URL 不触发采集。平台 UUID 仅在有效时间窗口内去重，因此不承诺端到端 exactly-once 或有限重试下必达。

运行参数、错误码、SDK 依据和已验证/待真人验证项目见 [飞书接入与验收指引](feishu.md)。

## 11. v3 显式 URL：Turn → Job → Outbox

入站回调仅在同一事务持久化原文、来源与分类后 ACK：新明确请求（含无效命令）为 `feishu_url_capture`，普通聊天为 `feishu`；重投保留首次分类，升级前 URL 不追溯。授权仍由 app/tenant/owner 和来源关联验证，不能仅凭 source 标签。

```text
Turn 执行权 → 同事务：唯一 capture_article Job + Turn answered + final_message 接收确认
Job 执行权  → Playwright / Pi → 不可变检查点 → 完整无覆盖 Markdown
           → 同事务：Job succeeded/failed + job_result
Outbox 执行权 → 回复原消息 → sent / 有界重试 / failed
```

Turn answered 只表示已受理/响应，不表示文章完成。无效/超长/能力关闭请求直接 answered + 拒绝，无 Job。交接前 Turn 耗尽由发送循环每轮至多 20 条补齐唯一拒绝；旧普通聊天失败不补通知。

v3 仅新增 STRICT `article_captures(job_id PK/FK, result_json CHECK json_valid)` 和 capture_article 非空 origin_turn_id 部分唯一索引。幂等键为 `capture_article:<turnId>`，每 Turn 一 Job、一 ACK 和一成功或失败结果。不增状态枚举、outbox.job_id 或通用调度层。

Job Worker 只领取/恢复授权来源的 capture_article，单并发、120 秒租约、三次尝试、至少 30 秒退避；其他身份/种类/无来源任务不变。归档 Conversation 不取消已受理任务。失租写回立即 lost_lease；耗尽恢复与失败 job_result 同事务，无第四次收尾尝试。DB busy 单独处理，不归类模型错误。

检查点由有效 Job token 首次提交，之后不可覆盖；version=2，包含 URL、完整标题、完整任务 ID、任务创建时间、摘要生成时间、摘要/要点、固定文件名、Markdown 和成功回复。文件名为 `文章标题--短任务标识.md`，短标识为 Job ID 的 SHA-256 前8位；标题部分清理 Windows 非法字符并限制160 UTF-8字节。文件名随检查点冻结，短标识不代替完整数据库身份。Markdown 头部保存静态元数据，不保存实时任务/投递状态。本次测试部署先备份并重建数据库，不兼容旧检查点，既有 Markdown 保留。发布使用同目录独占临时文件 + link，已有普通文件只接受逐字节一致；不同内容/符号链接/目录拒绝且保留。检查点前崩溃可能重复模型调用，检查点后只发布/核对，文件后崩溃只补终态。旧文件操作可能迟到，但最多发布同一快照；不承诺 SQLite 和文件跨资源事务或断电级一致性。

两类 Outbox 各有稳定 UUID，均回复来源 message_id：final_message 只被前序同种非终态消息阻塞；job_result 等待自身确认 sent/failed，缺确认不放行。候选合并按 available_at/created_at/id 选择，结果退避不挡聊天或其他就绪结果。发送重试不读写文件、不重跑 Job/模型。

每次普通聊天调用前，在同一短只读事务读取六轮合格历史和 captureContext 快照。补充仅当前身份/会话、更早来源：最近三份成功且结果已提交的摘要（每项 JSON ≤4,000），及三个 pending/running/failed 状态（每项 ≤500）。先过滤后选新，总 JSON ≤12,000；超限先移除最旧摘要，再移除最旧状态。成功不要求消息 sent，但不代表送达；未完成检查点不能当成功知识。调用中途完成的 Job 下一次才可见。无工具 Agent 不访问全文。

三循环共享 85 秒停止排空，容器宽限 100 秒。采集页面20秒、模型50秒、持久化/发布5秒、清理5秒，共享80秒；实际取消模型和关闭浏览器，清理失败停止服务非零退出，不开始下一 Job。能力关闭暂停新领取但仍恢复过期工作和投递消息；修复后重启探测，不偷偷变更归档根。

实施和真人部署证据见 [验收记录](url-capture-verification.md)。OpenSpec 前置变化尚未归档；需按 `add-durable-runtime-store` → `add-topic-aware-agent-runtime` → `add-feishu-text-chat` 的依赖顺序同步规范后再归档本 Change。本轮不自动归档。
