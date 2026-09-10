## 1. SDK 与边界契约

- [x] 1.1 安装并锁定官方 `@larksuiteoapi/node-sdk` 正式版本；核对事件字段、失败 ACK、start/close 生命周期、可取消 HTTP、回复 UUID 限制和权限/错误码，把版本与官方依据写入接入文档；用假传输验证回调 reject 不被吞成成功、start 返回不伪报 ready，不连接真实平台。
- [x] 1.2 实现配置校验和事件归一化，仅接受配置 app/tenant/owner 的用户私聊文字；以无凭据单元测试覆盖合法文本、URL 普通输入、空白、坏 JSON、群聊、非文字、其他身份和缺失字段，确认非法输入不调用 store/Agent。

## 2. 原子入站与范围查询

- [x] 2.1 增加 v2 的 feishu_chats、feishu_inbound_messages 及唯一/外键约束，保留原四表；测试 v0→v2、v1→v2、v2 重开、较新版本拒绝、迁移失败回滚，以及原有队列数据和租约不变。
- [x] 2.2 实现单事务接收：固定映射、Turn sequence 分配、maxAttempts=3、来源关联和持久化去重；测试不同 event_id 的重复 message_id、双连接重复、身份冲突、归档映射与中途回滚，确认只建一个 Turn 且不覆盖原内容。
- [x] 2.3 实现当前 app/tenant/owner 的 Conversation 枚举、飞书 final_message 原子领取与 scoped Outbox 过期恢复；测试本地/其他应用/其他用户/其他 kind/Job 均不被领取或恢复，同会话前序阻塞、其他会话可继续。
- [x] 2.4 将事件回调接到原子接收操作，提交后才返回成功；测试 storage_busy/提交失败传递失败确认、忽略事件正常确认、提交后确认前退出再重投不会重建 Turn。

## 3. 最终回复投递

- [x] 3.1 实现薄回复传输，持久化来源决定原 message_id，稳定 UUID 由 Outbox ID 派生，文本序列化后检查 20,000 字节上限；假传输断言完整请求、Unicode/转义长度边界、同一 Outbox 重试三要素不变，过大载荷不发网。
- [x] 3.2 实现投递单步：60 秒租约、含认证的 10 秒总期限、可取消 HTTP、禁止隐式发送重试、30 秒退避及更长 Retry-After；测试 HTTP 成功但业务失败/无回执、超时、限流、永久失败和三次耗尽均正确落库且不重跑 Agent。
- [x] 3.3 接通成功/失败/重试的 fenced 回写；测试三个分支 token 失效均报告 lost_lease，标记 sent 的存储错误不被当平台失败，模拟远端成功而本地未提交后重启仍使用同一 UUID。

## 4. 常驻调度与命令

- [x] 4.1 编排两个独立串行循环，复用 processConversationOnce，持续扫描数据库而非仅依赖入站唤醒；Fake Agent 挂起时测试入站与 Outbox 仍可进行、每条循环无重叠、退避到期及过期租约无新消息也会恢复。
- [x] 4.2 增加 serve-feishu CLI 与生产依赖注入，保留 URL/run-once 行为；通过 CLI 假依赖测试缺配置/多余参数退出 1、正常停止退出 0、常驻 stdout 不输出结果 JSON，测试不构造真实 SDK 连接或模型请求。
- [x] 4.3 实现安全 JSON Lines 日志及关闭协调，覆盖 SDK 日志边界，记录终态失败（包括过期恢复耗尽，必要时增加最小状态投影）、lost_lease 与 storage_busy；测试日志不含原文/凭据/原始异常，不逐秒刷 idle，SIGTERM 停止领取后排空、超时退出 1 且不提前关闭在用数据库。

## 5. 部署与接入说明

- [x] 5.1 新增独立 compose.feishu.yaml，命名状态卷、非 root 可写目录、90 秒 stop_grace_period、restart 策略和 serve-feishu 命令；用占位配置执行 `docker compose -f compose.feishu.yaml config --quiet` 验证，不暴露真实配置，确认不需要归档目录/ports/Docker socket。
- [x] 5.2 在临时独立 Compose 项目/命名卷验证首次非 root 写库和重建后数据保留（不接真实平台），记录结果；若 Docker 不可用则保留此项未完成并明确环境阻碍，不能仅靠 YAML 校验声称持久化已验证。
- [x] 5.3 更新 .env.example、README、部署文档和 docs/conversation-runtime.md：记录配置、官方最小权限和发布步骤、open_id/tenant_key 获取方式、单私聊上下文、失败不发通知及重复投递限制；核查链接和占位符，标明 v1/v2 与未来多话题阶段，不提交秘密或真实聊天。
- [x] 5.4 提供真人飞书手动验收清单：私聊成功、连续两轮、重复事件、断网重连、模型/发送中断恢复与终态排查；清单须区分“已验证/待用户配置”，无需为完成文档任务发送真实消息，也不能把文档编写等同真人验收通过。

## 6. 跨模块验收

- [x] 6.1 使用临时真实 SQLite、Fake Agent 和假飞书运行接收→Turn→final_message→sent 集成测试；覆盖关闭重开、回调不等待模型、双入站只生成一次、接收事务中断、模型租约恢复、平台成功/本地写回中断和旧令牌迟到。
- [x] 6.2 运行 `npm test`、`npm run check`、`npm run build`、`openspec validate add-feishu-text-chat --strict` 及 `openspec validate --all --strict`；记录真实执行结果，保留未执行的环境相关验收，确认本变更没有引入 Agent 工具或 Job 外部副作用。
