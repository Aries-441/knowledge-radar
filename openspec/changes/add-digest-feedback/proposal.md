## Why

当前 RSS / Atom 摘要卡片只能打开原文，用户无法在阅读摘要时留下明确的兴趣信号。每周热点和博客订阅将共用这类卡片；现在建立来源无关的反馈能力，可以让后续 GitHub 热点、博客推荐和个性化摘要复用同一套交互与数据模型。

## What Changes

- 为摘要卡片中的每个条目增加星标图标按钮，使用紧凑的视觉状态表示“感兴趣”。
- 星标按钮 SHALL 支持切换：点击未选中星标会记录感兴趣，点击已选中星标会取消感兴趣。
- 处理飞书 `card.action.trigger` 事件，校验应用、租户、用户、条目和操作类型后再更新状态。
- 将当前用户对条目的兴趣状态持久化到 SQLite，并绑定来源消息与飞书事件 ID。
- 对同一个飞书事件保持幂等，避免平台重试导致一次点击被切换两次；不同事件的连续点击 SHALL 正常产生状态切换。
- 卡片反馈成功后更新星标的选中状态；反馈失败时保留原状态并记录可诊断的错误。
- RSS / Atom 博客摘要和后续其他来源的摘要 SHALL 使用同一套反馈动作载荷和存储接口。

## Capabilities

### New Capabilities

- `digest-feedback`: 为飞书摘要卡片提供星标兴趣切换、事件校验、持久化和卡片状态更新。

### Modified Capabilities

- 无。现有 Feed ingestion、digest delivery 和 source connector 的核心要求保持不变；本变更只为摘要卡片增加可选交互。

## Impact

- **卡片构建**：扩展 `src/feed/digest.ts`，为每个条目生成可识别且可验证的星标动作。
- **飞书适配器**：扩展 `src/channels/feishu/adapter.ts` 的事件分发和卡片回调接口，继续复用现有 WebSocket 长连接。
- **运行时服务**：在 `src/runtime/feishu-service.ts` 接收并处理卡片动作，保持普通文本消息路径不变。
- **状态库**：增加兴趣反馈与事件去重所需的 SQLite 表和 `RuntimeStore` 方法，采用前向 schema migration。
- **测试与文档**：补充状态切换、事件重试、未授权用户、卡片渲染和数据库迁移测试，并说明星标交互行为。
- **范围边界**：本变更不实现评论输入、评论列表、GitHub connector 或兴趣驱动的推荐排序；这些能力可以在后续 change 中复用本变更的动作边界。
