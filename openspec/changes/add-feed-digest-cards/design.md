## Context

当前摘要链路已经完成候选选择、日期幂等 Job、发送重试和成功后通知标记。`DigestPayload` 目前冻结纯文本，Feishu adapter 只暴露主动文本发送；`serve-feishu` 没有人工查看当前候选的入口。参见 `proposal.md` 和 `specs/feed-digest-cards/spec.md`。

## Goals / Non-Goals

**Goals:**

- 让定时摘要和人工预览使用同一套候选选择、去重、排序和有界策略。
- 发送 Card 2.0 JSON，并把外部 Feed 数据限制在文本、链接和受控的 `open_url` 行为内。
- 让 `preview-feed-digest` 在不创建 Job、不修改通知状态的前提下发送预览卡片。
- 让新版本可以继续处理已有的纯文本摘要 Job，并支持安全回滚。

**Non-Goals:**

- 本变更不引入模型生成中文摘要。
- 本变更不增加卡片按钮回调、收藏、归档或多用户路由。
- 本变更不修改 SQLite schema；卡片数据只作为现有 Job payload 的新版本字段保存。

## Decisions

### 1. 在现有摘要选择器上增加卡片渲染层

抽取一个共享的确定性选择结果，继续沿用发布时间、来源优先级、canonical URL 去重、文章数和 UTF-8 字节限制。纯文本摘要和 Card 2.0 都从这个结果渲染，避免预览与定时发送出现不同文章。

备选方案是为卡片重新查询和排序候选，这会复制规则并产生预览/正式摘要漂移，因此不采用。

### 2. Job payload 同时保存兼容文本和卡片 JSON

新 Job payload 使用版本 2，保存 `text` 与 `card` 两个冻结内容，以及已有的 `itemIds`、`canonicalUrls` 和 scope。新 worker 优先发送 `card`；遇到旧版本或缺少卡片字段的 Job 时发送 `text`。这样不需要迁移历史 Job，旧镜像回滚时也能继续读取 `text`。

备选方案是部署时删除旧摘要 Job 或重建卡片，这会增加重复发送和数据丢失风险，因此不采用。

### 3. Feishu adapter 增加独立的主动卡片发送能力

在现有 `sendText` 旁增加 `sendInteractive`，统一使用 `receive_id_type=open_id`、稳定 UUID、超时和现有错误分类。请求层验证 JSON 的 `schema` 为 `2.0`、内容为对象且 UTF-8 字节数不超过内部上限；Feed 数据只能填入文字和已校验 URL，不能注入任意组件。

备选方案是把卡片 JSON 塞进文本发送方法或绕过 adapter 直接调用 SDK，这会破坏类型边界和错误处理复用，因此不采用。

### 4. 预览使用显式 CLI 命令并复用同一 transport

增加 `preview-feed-digest` 命令。它打开现有状态库，读取当前 scope 的未通知候选，构建带“预览”标识的卡片，并直接发送给 `FEISHU_ALLOWED_OPEN_ID`。无候选时输出 `{outcome:"empty"}`；发送成功只输出消息 ID，不写 Job、不写 `notified_at`。命令不启动 WebSocket 长连接，只复用 adapter 的 HTTP 主动发送方法。

备选方案是在飞书聊天中增加“预览摘要”指令，需要修改入站意图路由、权限和帮助文案，超出本次卡片化的最小闭环，因此暂不采用。

### 5. 卡片采用固定 Card 2.0 结构

卡片包含蓝色 header、摘要日期与数量、每篇文章一个内容块，以及一个 `open_url` 的“阅读原文”按钮。标题、来源和摘录经过 HTML 清理、长度限制和换行归一化；不接受 Feed 中的组件 JSON。卡片内部限制为 20,000 UTF-8 bytes，达到限制时停止加入后续完整条目，不拆分文章条目。

## Risks / Trade-offs

- **卡片内容可能比纯文本更容易达到平台限制** → 在构建阶段按序列化 JSON 字节数限制条目，并在 adapter 再做最终校验。
- **旧 Job 没有 `card` 字段** → 保留 `text` 字段，新 worker 对旧 payload 发送纯文本；新 Job 同时保存两种表示。
- **预览会产生真实飞书消息** → 预览必须是显式 CLI 操作，卡片加“预览”标识，且不改变通知状态；不提供自动预览调度。
- **Feed 标题和摘要包含 Markdown 特殊字符** → 只允许受控 markdown 文本组件并清理 HTML/控制字符，不把外部输入当作卡片结构解析。
- **发送卡片需要新的机器人消息能力** → 复用现有 `im:message:send_as_bot` 权限；权限错误沿用永久失败分类并记录安全错误码。

## Migration Plan

1. 先运行现有测试、卡片构建测试和 `openspec validate add-feed-digest-cards --strict`。
2. 构建新镜像并用同一 Compose project 重启，不删除 `radar-state` volume。
3. 运行 `preview-feed-digest` 验证卡片；确认成功后等待下一个摘要时间。
4. 观察 `feed_digest` 日志和 Feishu 消息；成功后候选才会被标记为已通知。
5. 回滚时恢复旧镜像即可；新 payload 保留 `text`，旧 worker 能继续发送纯文本。不要使用 `down -v`。
