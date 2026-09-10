## Context

本稿整体替代先前“Turn 直接采集”的草案，描述 v3 的实施设计。2026-09-10 首轮已部署 v3 并完成一次真人采集核对；随后按用户确认实施可读归档收尾，采用检查点版本2、不兼容旧格式。测试数据库已备份并重建为空，新版机器人已部署并验证重启连接；原 Markdown 保留，格式收尾后的手机端完整验收仍待完成。代码与验收进度见 tasks.md，部署证据见 [验收记录](../../../docs/url-capture-verification.md)，动机与能力列表见 [proposal.md](proposal.md)。

规划时已核对的 v2 基线：jobs 已有幂等键、origin_turn_id、result_json、租约和重试；但 claimJob 是全局领取，completeJob 不创建消息。飞书发送只认 final_message，唯一约束为 (turn_id, kind)，当时的顺序会让较早未终态消息阻塞后续。历史只投影 answered Turn 的 final_message。文章模块已经具备 Playwright、Readability、Pi 摘要与 Markdown，但归档文件名含随机值、未有持久化检查点。

## Goals / Non-Goals

**Goals:**

- 将对话受理、后台执行、消息投递分别交给 Turn、Job、Outbox。
- 采集运行或退避时可继续聊天；任务完成后有独立且可追踪的结果。
- 用明确事务、唯一键、Job fencing 和文件检查点覆盖进程崩溃恢复。
- 复用当前单进程、SQLite 和模块目录，只增加一种单并发采集 Worker。

**Non-Goals:**

- 不新增 Redis、微服务、通用工作流、Job DAG、状态卡、进度消息或等待登录状态。
- 不实现自动登录、批量链接、订阅调度、全文问答、多话题切换或全文/对话归档。
- 不承诺模型恰好一次、跨 SQLite/文件事务、断电级一致性或飞书必达。
- 不为启用 Job 保留第二套 Turn 直接采集路径。

## Decisions

### 1. 先受理，再独立执行

```text
入站：授权、去重、原文/分类持久化后确认事件
  ↓
Turn Worker：原子领取并按持久化分类处理
  ├─ 普通聊天 → 无工具 Agent → answered + final_message
  ├─ 无效请求/采集不可用 → answered + 拒绝说明 final_message（无 Job）
  └─ 有效采集 → 同事务：创建 Job + Turn answered + 接收确认 final_message
                              ↓
Job Worker：读取检查点 → 必要时网页/摘要 → 检查点 → 固定 Markdown
                              ↓
               同事务：Job succeeded/failed + job_result
                              ↓
Outbox Worker：按消息种类的规则领取 → 回复原消息 → sent/重试/failed
```

Turn 的 answered 表示“这轮请求已作出响应”，不是文章已归档。确认文字固定为“已接收，正在采集。”，表示请求进入采集流程，不承诺浏览器已开始访问；确认不展示任务编号，通过回复原消息关联。Job 成败不倒改已 answered 的 Turn，不再使用 Turn token 执行采集。

三条循环分别串行，可并行等待 I/O：Turn、Job、Outbox。采集期间普通聊天模型可以运行，最多同时一个聊天模型调用与一个采集摘要调用；不保证 JavaScript 同步 CPU 工作完全不影响事件循环。若以后遇到明显 CPU 阻塞，再单独评估隔离，不提前新增进程池。

### 2. 持久化分类与入口防误用

标准库纯函数分类整条消息，首尾空白只用于识别，保留原文。单个绝对 HTTP(S) URL 或“总结”加空白再接一个 URL 触发。保留命令缺参数、多个参数或非法 URL 为明确拒绝，不交给模型猜测。单个 URI 形态但非法协议/凭据/显式本地地址也拒绝；普通句子提及链接、多个裸链接、Markdown 链接不浏览。

明确请求原始长度上限沿用4,000 UTF-16 code units；不再为了旧的“请求+摘要历史对”强制1,024上限。超限拒绝，不创建 Job。URL 不自动删尾部标点或查询参数。

v3 入站事务对新明确请求（含非法请求）保存 source=feishu_url_capture，其他保持 feishu。标签由可信代码生成；重复消息保留首次分类。升级前 source=feishu 的 URL 不追溯采集。回调不访问网页、不调用模型或操作归档。

本地 run-once 在恢复和领取之前检查 Conversation.kind：feishu_private 返回单行 JSON {"outcome":"unsupported_conversation"}、退出1，不修改 Turn/Job/Outbox。这是刻意新增的入口约束；本地 Conversation 与旧文章 URL CLI 默认行为不变。飞书 Worker 只领取自己的授权映射，不能按 source 单独推断授权。

### 3. 最小 v3 数据增量与稳定身份

不增加 Turn/Job 状态枚举，不增加 outbox.job_id 或通用 lane 表。v3 增加：

| 对象 | 约束/内容 |
| --- | --- |
| jobs 部分唯一索引 | kind='capture_article' 且 origin_turn_id 非空时，同一个 origin_turn_id 最多一条；已有 idempotency_key 全局唯一保留 |
| article_captures | STRICT；job_id 为非空主键和 jobs 外键，result_json 非空且 json_valid；一 Job 一份不可变检查点 |
| 既有 Outbox 唯一键 | (originTurnId, final_message) 为受理回复；(originTurnId, job_result) 为该唯一 Job 的成功或失败结果 |

新采集 Job 的 origin_turn_id 必须指向授权飞书来源，幂等键固定 capture_article:<turnId>，maxAttempts=3，payload 为版本化的已验证请求 URL；目的地只从 SQLite 来源关联读取，不放进模型可控制的载荷。

一 Turn 一 Job 的约束使 job_result 按来源 Turn 唯一等价于按 Job 唯一，无需再加 job_id 列。不得用包含随机 Job ID 的新 kind 绕过唯一约束。未来一 Turn 多 Job 需要新 Change 调整映射，本轮不预留泛化接口。

检查点 version=2，保存请求/最终 URL、完整标题、summary/keyPoints、taskId、taskCreatedAt、capturedAt、filename、markdown、replyText；taskCreatedAt 必须等于持久化 Job.created_at，capturedAt 是首次摘要生成时间。文件名为“清理后的文章标题--短任务标识.md”；短标识固定取 SHA-256(完整任务 ID) 前 8 位 hex，仅用于展示，不作为数据库身份或路由键。标题 NFC 规范化，Windows 非法字符和控制字符替换为连字符、空白折叠、保留名加下划线、标题部分按完整 Unicode 码点截至 160 UTF-8 字节，去掉末尾空格和句点，空标题回退 article。文件名随检查点首次提交后固定，重试不得按新标题、时间或随机数重算；短标识冲突仍严格拒绝不同内容，不覆盖或自动换名。最终 Job.result_json 只保存版本、检查点 ID 和文件名，避免再复制 Markdown；checkpoint 存在不代表 Job succeeded。

迁移覆盖 v0/v1/v2→v3、v3 重开、未来版本拒绝与失败回滚；旧行、attempts、租约、来源不得改变。若旧库人为使用保留 kind 导致索引冲突，迁移明确失败并回滚，不删除或重命名用户记录。先前 Turn-keyed v3 只是未实施草案，不制造额外 v4 或迁移不存在的线上结构。

### 4. 两个必须原子的交接边界

**A. Turn → Job + 接收确认**

受理事务在 BEGIN IMMEDIATE 内重查授权来源、分类、running、当前 Turn token 与未过期租约，然后创建/验证唯一 Job，更新 Turn 为 answered 并清除其租约，插入 final_message。三者一次提交。幂等键命中时还必须核对 origin/kind/规范化 URL，不静默复用冲突任务。

只有事务提交后发送器才能看见确认，Job Worker 才能领取；不按“enqueueJob；completeTurn”两个独立事务拼接。失租返回 lost_lease，零部分写入；数据库忙保持 storage_busy，不伪装成采集拒绝。非法请求或当前采集能力不可用只原子完成拒绝回复，不创建 Job。

**B. Job → 终态 + 结果**

成功：验证当前 Job token/租约/范围、检查点与文件已确认发布，在同事务中写 Job succeeded/result_json 并插入 job_result。普通永久失败及最后一次重试失败：同事务写 Job failed/error_code 并插入失败 job_result。任一插入失败回滚 Job 状态，不把数据库错误放进网页/模型 catch。

禁止先用现有 completeJob 提交成功再单独 enqueueOutbox；需小型专用事务方法。各方法内部用 SQL/私有原语复用逻辑，不嵌套调用已有 BEGIN IMMEDIATE 公共方法。成功、失败、重试三个 Job 写回分支失败均立刻 lost_lease，不重新读状态猜测结果。

### 5. Job 作用域、重试与恢复

专用领取/恢复只作用于 kind=capture_article、有 origin_turn_id、source=feishu_url_capture 且来源关联匹配当前 app/tenant/owner 的 Job。其他种类、无来源、其他身份 Job 的 state/attempts/租约不变；不能复用全局 claimJob/recoverExpiredLeases 直接扫描全部任务。

Job 领取采用 available_at、created_at、id 稳定排序，单并发、120秒租约、三次尝试。可重试失败仅修改 Job，至少30秒退避；等待退避的 Job 不阻塞其他到期 Job，也不阻塞 Turn。归档 Conversation 不再接收新请求，但已原子受理的 Job 继续完成并向原消息回报；归档不等于取消 Job。换授权身份后旧范围任务不自动执行。

每轮 Job 扫描先恢复范围内过期 running：尚有次数变 pending；耗尽则在同一事务中 failed + job_result。恢复条件是已过期状态及当前范围，不持旧 token 冒充 Runner。缺检查点时重新抓取/总结；有检查点时只核对/发布文件。第三次中断耗尽不增加“第四次收尾尝试”，通知明确“未能确认完成”；存在检查点时说明可能已留下文件。

服务采集能力关闭时暂停新 Job 领取，不增加 attempts、不将配置等待当业务失败；仍恢复过期 Job、补齐终态通知、发送既有 Outbox。修复目录后重启恢复能力，不增加 waiting_auth/paused 状态。

交接前 Turn 本身也可能多次在进程中断后耗尽。发送循环每轮以最多20条的幂等事务补齐 source=feishu_url_capture、failed、无 Job、缺 final_message 的拒绝通知；不扫描旧普通聊天。Job 终态通知正常与终态原子写入，不依赖一个“先完成、以后再补”的常规缺口。

### 6. 检查点与无覆盖文件发布

检查点首次保存验证 **Job** 的授权、running、当前 token 与 lease_expires_at>now；已有结果只读返回且仍需验证有效执行权，不能覆盖。禁止在检查点提交前发布正式文件，不从迟到内存结果写文件。

发布流程复用标准库：

1. 从已提交检查点取得固定路径与准确 Markdown；操作前检查当前执行权/截止时间。
2. 已有目标用 lstat 拒绝符号链接/非普通文件，逐字节内容一致视为成功，不同则 archive_conflict，不能换名规避或覆盖用户内容。
3. 无目标时，在相同目录用独占随机临时名写完整内容并关闭；link(temp, final) 原子、无覆盖地发布。EEXIST 回到内容核对；再清理自己的临时名。
4. 确认发布后才进入 Job 终态事务。

文件系统不受 SQLite token 撤销控制；旧执行者已发出的 link 可能迟到，但它最多发布唯一检查点的同一内容，不能产生另一份新摘要或覆盖目标。失租后仍不能写 Job/Outbox。正常关闭只清理自己创建的临时文件，硬退出遗留物保留待停机核对，不递归删除用户目录。投递器不读写归档，用户之后修改/删除文件不触发自动补写。

拒绝弱化为直接写 final 或覆盖 rename；不支持 link 的目录将采集能力标为 unavailable，聊天继续。实际 Windows/Docker bind mount 验证作为 apply 验收前置，不以 YAML 校验代替。此协议面向进程崩溃恢复，不宣称能在恶意宿主机并发改目录或整机断电下保证跨资源一致性。

### 7. 两类 Outbox 与投递顺序

接收确认/拒绝和普通聊天为 final_message；Job 成功或失败结果为 job_result。两种载荷均为 {"text":string}，各自的 Outbox ID 派生稳定 UUID，maxAttempts=3，原 message_id 从 outbox.turn_id 对应来源读取。成功正文按标题、摘要、要点、归档文件名排列，末尾显示短任务标识；失败正文先说明原因，末尾同样显示短标识。完整 Job ID 保留在数据库、检查点和 Markdown，消息始终回复原来源，不靠短标识路由。

飞书专用领取在一个事务内选择符合以下规则的候选：

- final_message：仅被同会话更早且非终态的 final_message 阻塞；任何 job_result 都不能成为其 FIFO 阻塞项。
- job_result：关联 Job 必须终态且属于当前授权采集范围；其自身 Turn 的 final_message 必须存在并为 sent 或 failed。pending/sending 的接收确认阻塞该结果，不阻塞 Job 执行。
- 确认最终 failed 后允许结果独立尝试发送，不永久丢弃成果；这是“确认优先”的明确失败例外，不承诺用户一定看到确认。缺确认属于存储不变量异常，不能按已发送放行。
- job_result 之间按当前可投递时间调度，不保留原 Turn 序号 FIFO；较早任务未完成或结果退避时可发送其他结果/普通回复。
- 合并候选按 available_at、created_at、id 升序取一个，避免无条件优先聊天导致结果饿死；单发送循环不并发请求。

只改飞书专用选择策略，通用默认 FIFO 保留；runtime-outbox-queue 增加明确例外说明，不能让两份规范互相冲突。范围恢复同时包含上述两种合法消息，其他 kind 保持不变。

发送仍为60秒租约、含认证10秒实际截止时间、至少30秒退避并尊重更长 Retry-After，最多三次。成功/失败/重试回写均 fenced。HTTP业务成功且有回执才 sent；平台成功而本地提交失败仅重发同一请求，不触发 Job/模型/归档。UUID的有限去重窗口不等于端到端恰好一次。

### 8. Job 上下文独立于接收确认

保留原有六个合格历史轮次、每轮4,000字符过滤；接收确认即使进入历史，也不能被当作摘要。增加可选 captureContext，作为被标记为不可信数据的结构化补充，不伪造用户 Turn，不覆盖旧 final_message，不重新排列历史轮次。

在每次聊天模型调用前的短只读事务中同时读取历史与 Job 快照，事务结束再发模型请求。候选只来自同一 Conversation、当前授权来源且 origin Turn.sequence < 当前序号：

- 成功结果：Job=succeeded 且成功 job_result 已提交，按结果 Outbox 的 created_at、id 倒序取最近三项，展示时升序。包括 Job ID、来源轮次、显示标题、摘要/要点和文件名。
- 状态项：最近三个 pending/running/failed Job，按来源序号倒序取后升序展示；仅包含 Job ID、来源轮次、状态和安全失败说明，不取未完成检查点中的摘要。
- 成功条目序列化不超过4,000字符，状态条目不超过500字符；先排除不合法/超限条目，再各取最新三项。整个补充（含JSON结构）最多12,000字符；仍超限时先逐项移除最旧成功摘要，再移除最旧状态，直至满足预算。不截断JSON或混入全文。成功回复2,800字符上限不再与原请求拼成一对才决定能否入上下文。
- 不以 sent 为成功摘要可见前提，但仅称“任务已完成”，不声称手机已送达。pending/running 只说明处理中；失败不当成功摘要。
- 模型调用中途 Job 完成不修改当前快照；下一次调用/重试重新读取。超过最近三份成功结果不承诺记忆，跨会话/身份绝不混入。

同一对话同时有A、B两个任务时，不靠“最新URL”作唯一关联；结果都标记来源/任务，用户指代不明时模型应澄清，不猜测打开新网页。普通无工具 Agent 边界保持不变，只能依据被提供的摘要回答，不能声称读到了全文。

### 9. 页面、摘要、错误与期限

复用 Playwright 的无登录态上下文和现有公开目标限制。新增主响应状态/HTML类型检查，以及有明确证据的登录墙/验证码检测；单纯文章含“登录”不拒绝。401表示需认证，403只表示受阻；无法识别所有网站的阻拦页，不自动登录、不绕验证码、不接Profile。

飞书摘要限800字符、1–5个每项最多200字符的要点，显示标题160字符（截短带省略号），成功结果正文末尾含短任务标识和文件名且不超过2,800字符/飞书序列化20,000字节。Markdown 一级标题保留完整文章标题，头部列表依次记录来源链接、任务创建时间、摘要生成时间、完整任务 ID；时间使用明确 UTC 的 ISO 8601 格式。只保存同一摘要和要点，不保存全文，不把 running/succeeded/sent 等动态状态写入静态文档。一次性 CLI 复用该格式，任务 ID 为本次调用生成的 UUID，创建时间取采集开始时刻，不伪称有数据库 Job。Pi复用原模型注册与密钥配置；摘要模型无工具，结构/预算不合法按摘要失败重试，不静默截要点。

| 归属 | 预算/规则 |
| --- | --- |
| Turn | 租约120秒、三次；聊天模型仍60秒；采集受理仅短事务，不等待Job |
| Job | 租约120秒、三次；至少30秒退避 |
| 采集一次工作 | 页面20秒、模型50秒、检查点/文件/最终提交预算5秒、清理5秒，共80秒 |
| 服务停止 / Compose宽限 | 三条循环同时停止新领取，合计等待85秒 / 100秒；不是各等85秒 |
| Outbox | 租约60秒、发送10秒、三次；独立退避 |

各阶段取阶段上限与共享剩余期限的较小值。模型设置maxRetries=0并传真实AbortSignal，网页超时关闭上下文/浏览器，启动迟到也关闭新浏览器。不是仅Promise.race提前返回。清理超时不得开启下一个Job；停止服务退出1，由容器重启与租约恢复处理。文件I/O不可完全取消，迟到发布依赖第6节无覆盖协议。同步事件循环阻塞不是计时器可严格打断的情形，不将80秒宣传为实时系统保证。

| 情况 | 安全错误码 | 处理 |
| --- | --- | --- |
| 命令/URL/长度非法 | capture_invalid_request / capture_invalid_url / capture_input_too_large | Turn answered + 拒绝final_message，无Job |
| 采集能力关闭 | capture_unavailable | Turn answered + 拒绝final_message，无Job |
| 401/明确登录墙 | capture_login_required | Job永久失败，提示当前仅支持公开文章 |
| 403/验证码/反爬 | capture_access_blocked | Job永久失败，不自动认定缺登录 |
| 404/410 | capture_not_found | Job永久失败 |
| 非HTML/无正文/过长 | capture_unsupported_content / capture_no_content / capture_content_too_large | Job永久失败 |
| 网络/429/5xx | capture_fetch_failed | Job有限重试；合法更长Retry-After可延后 |
| 页面/模型/总期限 | capture_timeout | 实际取消后有限重试 |
| 模型/结构错误 | capture_summary_failed | Job有限重试；明确缺配置用capture_configuration永久失败 |
| 写入暂时错误 | archive_write_failed | 复用检查点有限重试；权限/ENOSPC永久失败 |
| 文件冲突 | archive_conflict | Job永久失败，保留用户文件 |
| 最后租约恢复耗尽 | capture_interrupted | Job failed + 失败job_result；检查点存在时说明可能已有文件 |

数据库busy单独日志并延迟，不算provider失败；不可恢复数据库错误停止服务。Job失败只说明任务失败，不改写接收成功事实。失败结果发送失败只留日志，不递归创建“通知失败的通知”。

### 10. 采集降级与运维边界

没有归档配置、目录不可写或发布能力探测失败时，服务以capture_disabled安全事件启动纯聊天，Job循环不新领取；新请求明确拒绝。启动能力探测只创建/删除自己的独占临时文件，不打印绝对路径或secret。修复目录后重启重新探测；不引入自动轮询配置修复。

已提交Job暂存不丢失，已终态消息仍投递。运行中目录失效对当前Job按错误规则处理；下一次启动再判断能力。不自动切换归档根目录或放宽权限。既有检查点恢复应使用同一归档根；人为改目录不会自动迁移历史，必须先排空或明确处理未完成Job。

本轮复用现有src/article、src/agent、src/runtime、src/channels和src/cli布局。不因三条循环增加三个服务或三个容器。

## Risks / Trade-offs

- [两条回复比同步模式多一条消息] → 固定接收确认+唯一任务结果，不加进度卡；确认也受平台发送失败限制。
- [异步结果不再按请求顺序到达] → 回复原消息并标明Job ID；只约束自身确认先行，避免任务等待阻塞聊天。
- [检查点前崩溃可能重复模型费用] → 明确至少一次尝试，检查点提交后禁止重跑；不承诺恰好一次。
- [SQLite与文件不原子] → Job-keyed不可变快照、固定文件名、no-clobber与故障注入；耗尽时诚实说明完成状态未确认。
- [目录能力不可用] → 仅降级采集，不关闭聊天；不放宽为覆盖写入。
- [网页不可信且与归档同容器] → 保留现有访问限制、无登录态、专用小目录、无Docker socket；并非完整SSRF/DNS重绑定或浏览器漏洞隔离。
- [上下文有限且为快照] → 最近结果与任务状态分别有界；用户追问更久历史或全文时明确限制，不伪造记忆。
- [前置OpenSpec尚未归档] → 按依赖顺序同步后再归档本Change；不能用ADDED重建不完整既有规范来消除提示。

## Migration Plan

1. 规划阶段仅改文档；apply先在独立资源实现和验证。真人部署前旧v2容器、.env、真实状态与知识目录保持不动。
2. apply在独立临时Windows目录及Docker bind mount验证非root写入与link语义；记录可用/降级两条路径，不以YAML通过替代真实发布验收。
3. 部署前停止服务并做一致性SQLite备份、单独备份归档。保持原Compose project和状态卷。原子迁移v3，旧消息source保持不变；旧版本应用拒绝v3，不混跑。
4. compose.feishu.yaml保留纯聊天基础部署，显式将容器KNOWLEDGE_RADAR_ARCHIVE_DIR设为空；compose.feishu.capture.yaml作为独立叠加配置，要求KNOWLEDGE_RADAR_ARCHIVE_DIR_HOST非空，将其挂到/app/archive并覆盖容器变量。单用基础配置不创建归档挂载，不默认为整个知识库、项目根或Docker临时目录；叠加文件缺宿主变量时Compose明确报错，不能生成空路径挂载。
5. 采集override复用已有镜像，设置shm_size: 1gb；飞书服务统一stop_grace_period: 100s，应用drain为85秒。自定义env文件同时说明Compose --env-file插值与env_file注入差异。Linux目录权限由用户按运行UID配置，不chmod777或切root。
6. 更新README、飞书/部署/状态机文档：v3三循环、两种消息、Job执行权、快照上下文、降级、run-once限制；旧v2和未来登录/订阅目标明确分层。
7. 全部离线测试后，以独立容器重建验证Job/检查点/文件恢复；经用户确认目录后再真人发送博客园URL、后台追问、结果核对和失败场景。只记录实际完成项。
8. 本次测试格式收尾不实现旧检查点兼容或迁移。通过离线验证后停止真实服务，备份当前数据库并验证完整性；只移出已核对状态目录中的 radar.db 及其 WAL/SHM 文件（优先移入备份子目录，保留可恢复副本），保留整个状态卷、.env、宿主 Markdown 和已有备份。使用同一卷启动空库；会话、来源/去重、Turn、Job、Outbox、检查点全部从空开始，旧 Markdown 不自动导入上下文。重放旧事件可能重新处理，不承诺清库前后的去重。
9. 回滚停止服务后恢复旧代码与迁移前一致性数据库；保留新增Markdown待用户核对，不批量删除。备份之后的任务/去重/消息状态会丢失，可能导致重新处理，必须告知。
