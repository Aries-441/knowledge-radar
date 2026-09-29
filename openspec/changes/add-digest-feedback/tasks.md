## 1. 卡片动作模型与星标渲染

- [x] 1.1 定义来源无关的摘要兴趣动作载荷，包含 `digest_interest`、条目标识和目标状态，并实现未选中与已选中星标图标的 Card 2.0 渲染；用单元测试验证两个状态、稳定的 `element_id` 和动作值。
- [x] 1.2 将兴趣状态映射接入定时摘要和手动预览的卡片构建流程，保留原文 `open_url` 按钮与现有排序、去重和字节限制；用现有 digest 测试和超限测试验证卡片 JSON 仍可解析。
- [x] 1.3 实现根据条目 ID更新已发送卡片中单个星标按钮的纯函数，拒绝缺失或重复的受控动作；用 fixture 测试确认标题、摘要、来源和原文链接不变。

## 2. SQLite 状态与消息索引

- [x] 2.1 将 runtime schema 从 v6 升级到 v7，增加 `digest_feedback`、`digest_feedback_events` 和 `digest_messages` 表、唯一约束与查询索引；用旧 v6 数据库迁移测试验证 Feed item、digest job 和 outbox 数据保持不变。
- [x] 2.2 为 `RuntimeStore` 增加读取兴趣状态、登记已发送卡片和查询消息卡片的方法；用内存 SQLite 测试验证 scope 隔离、未知消息拒绝和已发送卡片 JSON 的边界限制。
- [x] 2.3 实现兴趣事件的事务处理：先按 `event_id` 去重，再按 `(scope, item)` 写入目标状态；用单元测试验证首次点击、再次取消、相同事件重试和不同事件连续切换。

## 3. Feishu 卡片回调适配

- [x] 3.1 增加 `card.action.trigger` 的解析模型，提取应用、租户、用户、消息、事件 ID 和动作值，并复用现有 Feishu scope 校验；用伪造事件测试验证未授权用户、未知动作和缺失字段都被拒绝。
- [x] 3.2 扩展 Feishu WebSocket dispatcher 注册和 transport 回调返回类型，使普通文本事件路径保持不变、卡片事件可以返回完整卡片 JSON；用 mock WebSocket 测试验证回调结果会被编码并返回。
- [x] 3.3 将卡片动作处理结果映射为更新后的 Card 2.0 内容或空结果，并对错误记录稳定的错误原因且不记录原始 payload；用 adapter 测试验证成功更新、重复事件和失败响应。

## 4. 运行时集成

- [x] 4.1 在定时 digest 成功发送和手动预览成功发送后登记 `digest_messages`，确保 message ID、scope、卡片 JSON 和条目列表在同一成功边界内保存；用 digest worker 与 preview 测试验证发送失败不会登记消息。
- [x] 4.2 在 `serve-feishu` 中接入卡片动作处理：校验消息索引和条目归属、事务更新兴趣状态、重建单条目星标并返回卡片；用服务级测试验证文本消息、卡片动作和关闭 drain 路径互不影响。
- [x] 4.3 增加结构化日志字段 `message_id`、`item_id`、`event_id`、`target_interested` 和结果，不输出卡片正文、URL 参数或凭据；用日志断言测试验证敏感字段不会出现。

## 5. 文档、迁移与验收

- [x] 5.1 更新 README 与飞书接入文档，说明需要订阅 `card.action.trigger`、星标点击会切换状态、旧卡片没有交互能力以及状态库备份要求；用文档检查确认示例配置与当前环境变量一致。
- [x] 5.2 在本地 SQLite、伪造 Feishu transport 和 Docker 配置下完成端到端验证：发送博客摘要、点击星标、再次点击取消、重启服务后重新渲染并重放同一事件；记录可复现的验证命令和结果。
- [x] 5.3 运行 `npm test`、`npm run check`、`npm run build` 和 `openspec validate add-digest-feedback --strict`，确认所有卡片、迁移、回调和兼容性测试通过。
