## RENAMED Requirements

- FROM: `### Requirement: 两条有界后台处理循环`
- TO: `### Requirement: 三条有界后台处理循环`

## MODIFIED Requirements

### Requirement: 独立常驻命令与配置校验

系统 SHALL 提供无位置参数的serve-feishu，启动前校验KNOWLEDGE_RADAR_STATE_PATH、FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_TENANT_KEY、FEISHU_ALLOWED_OPEN_ID，模型沿用KNOWLEDGE_RADAR_MODEL及现有凭据。核心缺配置/多余参数 SHALL 安全退出1，不建立连接。归档配置和发布能力 SHALL 单独探测；不可用仅降级采集，不关闭聊天、不以root/放宽权限绕过。既有一次性URL CLI与本地Conversation处理保持兼容，run-once的飞书拒绝遵守独立规范。

#### Scenario: 未配置允许用户

- **WHEN** 缺少FEISHU_ALLOWED_OPEN_ID
- **THEN** 失败退出，不自动绑定首个发消息用户

#### Scenario: 归档不可用

- **WHEN** 归档未配置、不可写或缺少发布能力
- **THEN** 只输出安全capture_disabled状态，纯聊天启动；探测只清理自己创建的临时文件

### Requirement: 三条有界后台处理循环

系统 SHALL 独立调度Turn、Job、Outbox三条串行循环，各最多一个进行中的操作，空闲或可恢复错误后间隔1秒检查。Turn只处理当前授权活跃Conversation，领取前恢复其过期Turn；采集受理只创建Job和确认，普通聊天使用无工具Agent。Job只处理当前授权来源capture_article，已受理Job不因Conversation归档而取消。Outbox按对应规范投递两类消息。不得消费其他种类或无授权来源Job。

#### Scenario: 采集挂起时继续聊天

- **WHEN** Job网页或模型等待，同时有新文字及待发送回复
- **THEN** 入站、Turn聊天与Outbox可独立推进，不等待Job结束

#### Scenario: 重启后没有新消息

- **WHEN** 状态库中仅有过期Job或未来到期任务/消息
- **THEN** 后台持续恢复与检查，到期后自行推进，不因一次idle永久停止

#### Scenario: 交接前Turn失败

- **WHEN** 明确采集Turn在创建Job前恢复耗尽成为failed
- **THEN** 后台按当前来源幂等补齐唯一拒绝final_message，不伪称已创建Job；普通聊天失败仍只日志

#### Scenario: 已归档会话的受理任务

- **WHEN** Job已受理后Conversation被归档
- **THEN** 不接收该会话的新Turn，既有Job和消息仍可在当前授权范围完成

### Requirement: 明确日志和停止契约

stdout SHALL 不输出服务业务JSON，stderr SHALL 输出安全结构化事件，适用时包括conversation_id、turn_id、job_id、outbox_id、outcome、error_code；不得包含密钥、Token、消息/正文、完整URL、绝对敏感路径或原始SDK/provider/浏览器错误。SIGINT/SIGTERM SHALL 同时停止接收和三条循环的新领取，总计最多85秒排空在途与清理后再关库，正常退出0，核心启动失败/不可恢复存储错误/排空超时退出1。

#### Scenario: 数据库忙

- **WHEN** 任一循环遇到storage_busy
- **THEN** 记录并延迟，不等同idle或归类模型失败；不可恢复存储错误停止服务

#### Scenario: 三类工作同时在途时停止

- **WHEN** 聊天、Job和发送同时进行且收到停止信号
- **THEN** 不再接收/领取，三者共享85秒排空期限，不逐个等待85秒、不提前关闭在用库；未提交工作下次按租约恢复

### Requirement: 容器状态持久化

飞书Compose SHALL 保持非root和状态命名卷，KNOWLEDGE_RADAR_STATE_PATH固定/var/lib/knowledge-radar/radar.db，stop_grace_period为100秒。系统 SHALL 提供无需归档挂载的纯聊天配置及叠加的采集配置：后者把专用KNOWLEDGE_RADAR_ARCHIVE_DIR_HOST绑定/app/archive并设置KNOWLEDGE_RADAR_ARCHIVE_DIR、shm_size=1gb。不得因空路径绑定整个项目/知识库，不开放端口或挂Docker socket。重建 SHALL 保留Job、来源、检查点和已发布文件。

#### Scenario: 重建采集容器

- **WHEN** 使用相同项目、状态卷和专用归档绑定目录重建
- **THEN** 非root可继续同一Job，宿主机能读原Markdown，不重复正式归档

#### Scenario: 仅启用文字配置

- **WHEN** 用户未启用采集挂载
- **THEN** 可启动文字服务，新采集请求明确拒绝，旧待执行Job不丢失或增加attempts
