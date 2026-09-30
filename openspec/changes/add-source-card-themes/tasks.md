## 1. 来源主题模型

- [x] 1.1 增加来源类型到 Card 2.0 主题的纯函数 resolver，覆盖 RSS、GitHub Trending、GitHub Releases、arXiv、Newsletter、微信公众号和中性 fallback；用单元测试验证未知类型和旧 provider 推断。
- [x] 1.2 让摘要候选和冻结快照携带可选 `sourceKind`，由来源查询补充且不要求数据库迁移；用持久化 round-trip 测试验证旧 payload 仍可读取。

## 2. 卡片视觉与布局

- [x] 2.1 将卡片抬头、周期信息、来源徽标和条目分组接入主题 resolver；用卡片测试验证博客、GitHub 和混合来源具有不同主题且文字仍能识别来源。
- [x] 2.2 重排条目为标题、来源/趋势元数据、短摘要和统一操作区，并将星标与阅读全文按钮放入同一操作组；用 JSON 结构测试验证顺序和缺失字段行为。
- [x] 2.3 保留预览、文本摘要和单来源卡片的现有语义，同时优化窄屏下的短文本和间距；生成本地预览 JSON 并完成移动端卡片验收。

## 3. 交互与大小边界

- [x] 3.1 保持 `digest_interest` action 名称及字段结构不变，验证不同来源条目的星标切换只更新目标按钮。
- [x] 3.2 将主题徽标、标题、摘要和趋势元数据纳入现有 UTF-8 长度预算，验证接近 20KB 时优先截断摘要且 JSON 和 action payload 仍有效。
- [x] 3.3 用 v1/v2/v3 历史 payload 和缺少 `sourceKind` 的快照验证 worker fallback 主题、发送和回调兼容。

## 4. 文档与运行态验收

- [x] 4.1 更新 feed ingestion 和 Feishu 文档，说明来源主题映射、混合来源卡片和新增 connector 的主题扩展方式；用文档示例配置解析命令验证。
- [x] 4.2 运行 `npm test`、`npm run check` 和 `npm run build`，并发送博客与 GitHub 预览卡片，检查主题、按钮和回调行为。
- [x] 4.3 运行 `openspec validate add-source-card-themes --strict`，确认任务清单和规格完整后再进入 apply 阶段。
