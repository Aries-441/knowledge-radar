## Context

现有 `src/feed/digest.ts` 为每篇条目生成 Card 2.0 内容，并使用 `open_url` 行为打开原文。`src/channels/feishu/adapter.ts` 的长连接只注册了 `im.message.receive_v1`，因此卡片按钮目前没有业务回调入口。运行时状态库使用 SQLite schema version 6；已发送摘要的卡片 JSON 保存在 digest job payload 中，但手动预览没有可供后续回写的消息索引。

本变更需要同时处理卡片渲染、飞书回调、状态持久化和已发送卡片更新。详细行为以 `specs/digest-feedback/spec.md` 为准。

## Goals / Non-Goals

**Goals:**

- 为所有摘要条目生成稳定、可验证的星标动作，并在未选中与已选中状态之间切换。
- 让用户的兴趣状态按 Feishu scope 和 Feed item 持久化，服务重启后仍可用于渲染。
- 让同一个飞书事件只提交一次，同时允许不同事件按卡片显示状态连续切换。
- 使用现有 WebSocket 长连接处理 `card.action.trigger`，返回更新后的完整 Card 2.0 内容。
- 为已发送的定时摘要和手动预览保存最小的消息卡片索引，支持根据消息 ID重建并更新原卡片。

**Non-Goals:**

- 本变更不实现评论输入、评论列表或评论通知。
- 本变更不实现 GitHub connector、每周调度或兴趣驱动的推荐排序。
- 本变更不引入新的消息队列或外部数据库。

## Decisions

### 1. 卡片动作携带目标状态，而不是让服务端盲目反转

每个星标按钮携带来源无关的动作值：`action: "digest_interest"`、`item_id` 和 `target_interested`。卡片生成时根据当前持久化状态把 `target_interested` 设置为相反值。

这样可以同时满足“再次点击取消兴趣”和事件重试安全：两个真实点击事件分别携带 `true`、`false`，服务端按目标状态写入；同一个事件重试时只按事件 ID 去重，不会再次反转数据库中的状态。直接使用服务端 `!currentState` 会让旧卡片或重试事件产生不可预测的结果，因此不采用。

### 2. 使用两张小表分离当前状态和事件去重

schema version 7 增加：

- `digest_feedback`：以 `(app_id, tenant_key, owner_open_id, feed_item_id)` 为唯一键，保存 `interested`、最近消息 ID 和更新时间。
- `digest_feedback_events`：以 `event_id` 为主键，保存 scope、消息 ID、条目 ID、目标状态和接收时间。

事件表保留完整的去重记录，避免只在当前状态表保存一个 `last_event_id` 时，较早的重复投递在后续点击后再次生效。状态更新、事件插入和重复事件判断都在同一 SQLite transaction 中完成。

### 3. 保存已发送卡片的最小索引，回调返回完整卡片

增加 `digest_messages` 表，保存消息 ID、scope、原始 Card 2.0 JSON、条目 ID 列表和创建时间。定时 digest 在 `commitFeedDigest` 的同一事务中登记；手动预览在发送成功后登记。消息 ID 是卡片回调中的范围边界，服务端必须先确认该消息属于当前 scope，再允许修改其中的条目。

收到有效动作后，服务端从 `digest_messages` 读取原卡片，定位动作值中的条目，重新计算目标星标状态，并通过飞书长连接回调返回 `{ card: { type: "raw", data: <完整 Card 2.0> } }`。Card 2.0 内容必须放在 `raw.data` 中，直接返回卡片 JSON 只能确认事件但不会替换原消息。卡片更新不调用新的 HTTP 发送链路，避免产生一条新的消息；找不到消息或动作按钮时拒绝更新并保留数据库状态。

备选方案是只保存 job ID，再从 digest job payload 重建卡片。这无法覆盖手动预览，也会把卡片交互与 job 生命周期耦合，因此不采用。

### 4. 保持动作解析与普通文本事件分离

`FeishuTransport.start` 继续共享一个 `EventDispatcher`，额外注册 `card.action.trigger`。动作处理器使用 SDK 的 `CardActionEvent` 规范化结构，并要求 WebSocket 接收原始事件字段以取得 `event_id`、`app_id` 和 `tenant_key`。普通文本事件仍走现有 `receiveFeishuEvent`，卡片事件走独立的解析、校验和 store 方法。

动作处理结果只返回平台支持的卡片 JSON；未知或未授权动作返回空结果并记录原因，不把原始卡片 payload 写入日志。

### 5. 星标使用图标按钮，动作语义放入 value

每个条目生成稳定的 `element_id`，按钮显示星标图标，选中与未选中使用不同的标准图标 token。动作值只包含受控的 `item_id` 和目标状态，不携带原文 URL、标题或任意外部 JSON。原文按钮继续使用现有 `open_url` 行为。

卡片构建器增加可选的兴趣状态映射；没有状态时按未选中渲染。更新已发送卡片时只改变目标条目的星标按钮，保留标题、摘要、来源和原文链接，且继续执行现有卡片字节数限制。

## Risks / Trade-offs

- **卡片回调 payload 与 SDK 版本差异** → 使用当前 `@larksuiteoapi/node-sdk` 的 `card.action.trigger` 类型和长连接返回值，增加真实 JSON fixture 测试；卡片生成集中在一个纯函数中，便于调整字段。
- **消息索引持续增长** → 为 `digest_messages` 添加消息 ID和创建时间索引；首版保留记录以支持历史卡片交互，后续再按明确的保留期限清理。
- **卡片回写失败而数据库已更新** → 先在事务中提交有效事件和状态，再把更新后的卡片作为回调结果返回；失败时记录消息 ID、条目 ID和错误码，下一次用户点击仍依据当前状态计算目标值。
- **旧卡片没有星标动作** → 对缺少受控动作值的按钮直接拒绝，不尝试从标题、URL 或卡片文本猜测条目。
- **scope 仍是单用户配置** → 数据表保留 app、tenant 和 open ID 三个范围字段，当前校验继续使用 `FEISHU_ALLOWED_OPEN_ID`，为以后多用户扩展留下边界。

## Migration Plan

1. 先运行现有测试，并执行 schema migration 测试，确认旧的 v6 状态库可以升级到 v7，Feed item、digest job 和 outbox 数据不变。
2. 部署包含新表和卡片动作监听的镜像，保留现有状态 volume；未发送的旧 digest job 继续按旧 payload 发送，旧卡片没有反馈动作也不受影响。
3. 发送一张新的 RSS 摘要卡片，验证未选中星标、点击选中、再次点击取消、服务重启后状态保持，以及重复事件不会二次切换。
4. 发布前备份 v6 状态库。由于当前运行时会拒绝打开高于自身支持版本的 schema，回滚到旧镜像时必须同时恢复 v6 备份；重新升级时 migration 必须保持幂等。新增的兴趣数据在回滚恢复后不保留，Feed、digest job 和 outbox 数据保持不变。
