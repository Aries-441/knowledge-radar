## Context

See proposal.md for the motivation. `add-feed-ingestion` 已将 Feed 来源、`baseline`/`candidate` 条目和 `feed_poll` Job 接入单个 SQLite 状态库，并让 `serve-feishu` 同时运行 Feed scheduler 与 worker。现有 Feishu transport 只支持回复一个已收到的消息，不能主动向用户发送新消息；现有 `outbox` 又要求绑定到聊天 Turn，因此不能直接复用来表示每日摘要。

## Goals / Non-Goals

**Goals:**

- 复用当前 Feed candidate 数据和通用 Job lease/retry/token fencing。
- 以用户本地时区生成一个稳定的每日摘要 Job，并支持服务重启后继续发送。
- 让机器人向配置的 `ownerOpenId` 主动发送一条有界的文本消息。
- 发送成功后原子记录候选文章已通知状态，避免下次重复出现。

**Non-Goals:**

- 本变更不抓取文章正文，不调用模型生成新的文章摘要。
- 本变更不通过飞书消息管理订阅，也不支持多个用户或群组路由。
- 本变更不改变普通聊天回复和文章采集 Outbox 的投递顺序。

## Decisions

### 1. 使用 `feed_digest` Job，不扩展普通回复 Outbox

每日摘要是没有入站 Turn 的主动任务。scheduler 创建 `kind = 'feed_digest'` 的 Job，payload 固化摘要日期、目标 open_id、候选 item ID 列表和最终文本；worker 在事务外调用 Feishu，成功后用 token fencing 在一个短事务中同时更新候选通知状态和 Job 状态。这样不会把主动消息伪装成聊天回复，也不会让摘要被普通 Outbox 的会话顺序阻塞。

候选列表和文本在 Job 创建时冻结。新到达的候选留给下一次摘要；发送失败只重试同一个 Job，避免重试期间内容漂移。

### 2. 在 `feed_items` 增加可空 `notified_at`

新增 `notified_at INTEGER`，保持现有 `baseline`/`candidate` 语义不变。摘要选择条件是 `state = 'candidate' AND notified_at IS NULL`。发送成功提交时仅更新 payload 中的 item ID；如果某个 ID 已被其他成功 Job 标记，则事务仍保持幂等。使用 v4→v5 前向 migration，并为选择条件添加索引。

### 3. 使用本地日期幂等键和明确的摘要时间配置

Feed 配置新增：

```yaml
digest:
  enabled: true
  time: "09:00"
  maxItems: 20
```

`time` 按配置的 `timezone` 解释，格式为 `HH:mm`；`maxItems` 限制为 1 到 50。摘要 Job 的幂等键为 `feed_digest:<ownerOpenId>:<localDate>`。scheduler 每次循环只做短事务检查和创建 Job，不执行网络请求；服务停止后重启会为当前日期补建尚未存在的到期 Job。

不额外引入定时器库，继续沿用当前服务循环和 SQLite 到期检查。这样不会产生悬挂 timer，也能覆盖服务停机跨过发送时间的情况。

### 4. 摘要采用确定性的纯文本格式

摘要标题包含本地日期和新文章数量。条目按 `published_at`（缺失时 `first_seen_at`）降序，再按来源优先级和稳定 ID 排序；相同 canonical URL 合并来源名称。每条只输出来源、标题、URL 和已保存的有界 Feed summary，整体限制在 5,500 个 UTF-8 字节以内，超出时停止追加条目并保留已选候选未通知。

第一版不接入模型，先让订阅到飞书的链路可验证且成本可控；后续若需要模型摘要，可以在 Job 创建前增加独立的摘要生成步骤，不改变发送和幂等边界。

### 5. 在 Feishu adapter 增加主动文本发送方法

保留当前 `send(messageId, outbox)`，另增 `sendText(receiveId, text, uuid)`，调用 SDK 的 `im.v1.message.create`，使用 `receive_id_type = open_id`、`msg_type = text` 和 JSON content。`uuid` 由 Job ID 稳定派生，便于发送后本地提交前退出时安全重试。主动发送复用当前 HTTP 超时、错误分类和安静日志策略；缺少发送权限或目标不可用时映射为永久错误。

### 6. 在现有服务中增加独立摘要循环

`serve-feishu` 在摘要启用且存在启用 Feed 时启动 digest scheduler/worker。摘要 worker 和 Feed poll worker 使用不同的 Job kind 过滤；任一来源失败只记录该 Job，不停止聊天、文章采集或其他 Feed。服务 drain 时停止创建新 Job，并等待正在执行的请求按现有超时规则结束。

## Risks / Trade-offs

- **飞书应用缺少主动发消息权限** → 启动配置保持兼容，发送失败记录安全错误；部署文档明确列出应用权限和目标用户要求。
- **发送成功后进程在本地提交前退出** → 使用稳定 UUID 重试同一 Job；若平台仍返回重复消息，后续可增加发送回执表，但第一版保持最小状态模型。
- **摘要文本达到飞书限制** → 在构建阶段按 UTF-8 字节限制截断，未纳入的候选保留到下一天。
- **Feed summary 质量不一致** → 只把 RSS/Atom 中已保存且已限长的 summary 当作补充文本，标题和 canonical URL 始终保留。
- **schema v5 回滚复杂** → 部署前备份 SQLite；回滚时必须同时恢复 v4 数据库和旧应用，旧应用不得打开 v5 数据库。

## Migration Plan

1. 发布支持 schema v5 和 `digest` 配置的应用；打开 v4 数据库时在一个事务中增加 `feed_items.notified_at` 和索引。
2. 在 `feeds.yaml` 中显式设置 `digest.enabled: true`、摘要时间和条数上限，确认 `FEISHU_ALLOWED_OPEN_ID` 是接收用户的 open_id。
3. 确认飞书应用具备机器人主动发送文本消息的权限后重启 `serve-feishu`；首次摘要只发送已经存在但尚未通知的 candidate，不发送 baseline。
4. 使用安全日志、Job 状态和飞书私聊验证成功、重试、重启恢复及空候选行为。
5. 回滚时停止服务，恢复 v4 数据库备份和旧镜像；不要让旧版本直接打开 v5 数据库。
