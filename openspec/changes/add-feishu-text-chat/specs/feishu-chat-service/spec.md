## Purpose

提供适合私人电脑与 Docker 长期运行的飞书文字聊天入口，复用本地持久化会话运行时，明确配置、重连、调度、停止和可测试边界，使消息接收与模型调用解耦。

## ADDED Requirements

### Requirement: 独立常驻命令与配置校验

系统 SHALL 提供无位置参数的 serve-feishu 命令，启动前检查 KNOWLEDGE_RADAR_STATE_PATH、FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_TENANT_KEY、FEISHU_ALLOWED_OPEN_ID 非空，模型复用 KNOWLEDGE_RADAR_MODEL 及现有凭据约定。缺配置或多余参数 SHALL 以退出码 1 和安全配置错误结束，不建立连接或调用模型。已有 URL 采集及 run-once 输出和退出码契约 SHALL 保持不变。

#### Scenario: 未配置允许用户

- **WHEN** 缺少 FEISHU_ALLOWED_OPEN_ID
- **THEN** 命令失败退出，不默认允许所有人，不通过首条入站消息自动绑定用户

### Requirement: 长连接接收与恢复边界

系统 SHALL 通过出站长连接接收消息，不要求公网监听端口；网络断开后自动重连。连接开始请求不等于已连接，不得输出虚假 ready 状态。恢复承诺 SHALL 针对已经提交到本地状态库的工作；不得声称能无限补收停机期间尚未入库的事件。

#### Scenario: 短时断网

- **WHEN** 长连接断开又恢复
- **THEN** 服务无需重启即可恢复接收；重复事件仍走持久化去重

### Requirement: 两条有界后台处理循环

系统 SHALL 独立调度 Turn 处理和最终回复投递，每条循环最多一个进行中的操作，空闲或可恢复错误后间隔 1 秒再检查。Turn 循环只枚举当前授权飞书映射的活跃 Conversation，在领取前恢复其过期 Turn，并使用现有无工具 Agent 与上下文裁剪规则。模型调用 SHALL 不阻塞入站确认或已生成回复的发送。不得创建或执行 Job。

#### Scenario: 正在生成下一轮

- **WHEN** Agent 正在处理一条 Turn，同时已有前序 Outbox 可发送且新事件到达
- **THEN** 投递与入站持久化仍可进行，不等待本次模型完成

#### Scenario: 模型中断后重启

- **WHEN** 上次调用未完成就退出，重启时前序 Turn 仍为 running
- **THEN** 到期后恢复该 Turn 再领取，不因一次 idle 永久停止检查

#### Scenario: 运行失败与后续轮次

- **WHEN** Turn 到达 failed，包括输入超过现有 4,000 字符限制或模型重试耗尽
- **THEN** 记录安全失败日志，后续轮次按已有队列规则继续；本版不生成失败通知 Outbox

### Requirement: 明确日志和停止契约

serve-feishu 的 stdout SHALL 不用于最终命令 JSON；stderr SHALL 输出结构化安全事件，至少包含 event，适用时包含本地 conversation_id、turn_id、outbox_id、outcome 或 error_code。日志不得包含密钥、Token、消息正文、完整 SDK 事件或原始 provider 错误。正常 SIGINT/SIGTERM SHALL 停止接收和新领取，最多等待 65 秒在途工作，正常排空退出 0，启动失败、不可恢复存储错误或排空超时退出 1。尚未提交的工作 SHALL 依靠租约恢复，不伪写成功。

#### Scenario: 数据库忙与损坏

- **WHEN** 后台遇到 storage_busy 或不可恢复的数据库错误
- **THEN** 前者记录 storage_busy 并延迟重试，不等同 idle；后者停止服务并以 1 退出，不无限循环刷错

#### Scenario: 停止发生在模型调用期间

- **WHEN** 收到停止信号且有在途 Turn
- **THEN** 不再领取新工作；在途任务完成后再关闭其使用的数据库，超时则退出并由下次运行恢复租约

### Requirement: 容器状态持久化

系统 SHALL 提供独立飞书 Compose 部署配置，复用现有镜像、非 root 运行，以命名卷保存 /var/lib/knowledge-radar 并把 KNOWLEDGE_RADAR_STATE_PATH 固定到该目录下 radar.db。正常重建容器 SHALL 保留队列、消息去重和会话映射；不得要求文章归档路径、开放入站端口或挂载 Docker socket。

#### Scenario: 首次启动和重建

- **WHEN** 使用全新命名卷启动、收到消息后重建容器
- **THEN** 非 root 进程能写入数据库，重建后继续原会话且重复消息不产生新 Turn

### Requirement: 离线自动化验收

系统 SHALL 能通过 Fake Agent、假事件和假发送器验证完整链路，不读取真实模型/飞书凭据、不连接外网。真实飞书冒烟验证 SHALL 单列为需用户配置后的手动步骤，不得把未执行的外部验收标为已通过。

#### Scenario: 无凭据运行测试

- **WHEN** 清除飞书和模型凭据后执行自动化测试
- **THEN** 能覆盖接收、去重、处理、投递、重启恢复和失败分支，且不创建真实长连接或模型请求
