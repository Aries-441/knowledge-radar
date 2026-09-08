# Docker 部署设计

## 1. 目标

Knowledge Radar 以 Docker Compose 作为正式部署方式。用户只需要 Docker Desktop 或 Docker Engine，不需要在宿主机安装 Node.js、pi 或 Playwright。

容器化解决三个问题：

- 固定运行时和依赖，便于安装、升级和回滚。
- 使用 Compose 管理常驻进程、健康检查和失败重启。
- 限制不同组件能够访问的文件、密钥和登录态，缩小故障或攻击影响范围。

容器化不能把不可信代码自动变安全，也不能保护主动挂载给容器的宿主目录。安全收益来自非 root、最小权限和最小挂载，而不是“用了 Docker”这件事本身。

## 2. 服务拓扑

```mermaid
flowchart TB
    subgraph Compose[Knowledge Radar Compose Project]
        Radar[radar<br/>默认常驻]
        Browser[browser<br/>登录网页启用时常驻]
        Login[browser-login<br/>人工登录时临时启动]

        Radar -->|内部认证的 Fetch 请求| Browser
        Login --> Profiles[(browser-profiles)]
        Browser --> Profiles
        Radar --> State[(radar-state)]
    end

    Radar <--> InternetA[飞书 / Feed / 模型 API]
    Browser <--> InternetB[目标网页]
    Radar <--> Inbox[宿主机 Private/Inbox]
    Operator[用户浏览器] -.127.0.0.1 临时端口.-> Login
```

### `radar`

默认启动的应用核心：

- 维持飞书 WebSocket 长连接。
- 轮询 Feed 和执行定时摘要。
- 管理 SQLite 任务状态。
- 调用 pi SDK。
- 只在知识库 Inbox 内创建和更新 Markdown。

它不能访问 Browser Profile，也不包含 Chromium。

### `browser`

可选的内容提取服务：

- 使用指定 Profile 打开指定 URL。
- 执行登录状态检查和正文提取。
- 返回清洗后的内容、最终 URL 和完整度。
- 只接受 Compose 内部网络中的受限接口调用。

它不能访问知识库、SQLite、飞书密钥或模型密钥。接口不提供任意 JavaScript、任意文件读取、通用 CDP 或自由浏览能力。

### `browser-login`

默认按需启动的辅助服务：

- 与 `browser` 共享 Profile named volume。
- 提供可见浏览器或 noVNC 页面，让用户手动完成登录、扫码和验证码。
- 本机模式的端口只绑定宿主机 `127.0.0.1`，完成登录后立即停止。
- 远程模式不映射宿主机端口，由隔离隧道访问登录端口；没有活动会话时只返回拒绝响应。
- 启动前应暂停使用同一个 Profile 的抓取任务，避免 Chromium 并发打开相同目录。

它不是自动填写密码的服务。基础部署不向公网开放；启用远程登录 overlay 时，只允许经过身份代理的隧道访问其临时登录界面。

## 3. 持久化和挂载

| 容器 | 容器路径 | 来源 | 权限 | 内容 |
| --- | --- | --- | --- | --- |
| `radar` | `/var/lib/knowledge-radar` | `radar-state` named volume | 读写 | SQLite、任务状态、会话索引 |
| `radar` | `/data/archive` | 宿主机 `Private/Inbox` | 读写 | Markdown 归档 |
| `radar` | `/etc/knowledge-radar/config.yml` | 本地配置文件 | 只读 | Feed、时间和策略 |
| `radar` | `/run/secrets/*` | Compose secrets | 只读 | 飞书和模型密钥 |
| `browser` | `/var/lib/knowledge-radar/profiles` | `browser-profiles` named volume | 读写 | Cookie、Local Storage、IndexedDB |
| `browser-login` | 同上 | 同一 named volume | 读写 | 人工建立或刷新登录态 |

默认的 `browser-profiles` 只允许保存匿名账号或低权限阅读账号。个人主账号、付费账号、公司账号以及能访问私密数据的账号不得与其共用 Profile volume；确实需要接入时，应为每个信任级别建立独立的 `browser` 服务、named volume 和内部令牌。这样不能消除站点封禁或浏览器漏洞风险，但可以避免一个低价值站点的登录态泄露连带暴露其他高价值账号。

不挂载以下内容：

- 整个 `D:/Desktop/MyKnowledgeBase`
- 项目源码目录
- 用户日常 Chrome Profile
- Docker Socket
- Windows 用户主目录
- SSH、Git 或云平台凭据目录

知识库 bind mount 是刻意保留的最小副作用边界。即使 `radar` 被利用，默认可写范围也只包含 Inbox，不包含 Hugo 的 `Public` 目录。

## 4. Secrets

Compose secrets 只授予 `radar`：

- `feishu_app_id`
- `feishu_app_secret`
- 模型提供商所需凭据

`browser` 不需要这些密钥。服务间调用使用单独的随机内部令牌，并将其作为独立 secret 分别授予两个服务。

可选远程登录使用的隧道令牌只授予隧道容器，不授予 `radar`、`browser` 或 `browser-login`。Cloudflare Access 的身份策略在服务端配置，不写入仓库。

在单机 Docker Compose 中，secret 的宿主来源仍然可能是本地文件或环境变量；只读挂载不等同于加密保存。因此宿主 secret 文件应放在仓库之外，并用 Windows ACL 或 Linux 文件权限限制访问。任何 secret、Profile 或 SQLite 文件都不得进入镜像构建上下文和 Git。

Docker Compose 支持把 secret 作为只读文件挂载到 `/run/secrets/<name>`，且只有显式声明的服务可以访问。[Docker Compose secrets 文档](https://docs.docker.com/reference/compose-file/secrets/)

## 5. 容器加固基线

### 所有服务

- 固定基础镜像和直接依赖版本，不使用 `latest`。
- 以专用非 root UID/GID 运行。
- `read_only: true`，需要写入的位置使用 named volume 或 `tmpfs`。
- `cap_drop: [ALL]`，只在有证据时为单个服务增加必要能力。
- `security_opt: [no-new-privileges:true]`。
- 不使用 `privileged`、宿主网络或 Docker Socket。
- 设置内存、CPU、PIDs、日志轮转和临时空间上限。
- 使用 init 进程正确回收子进程。
- 只发布明确需要的端口。
- 使用健康检查和 `restart: unless-stopped`。

Docker 官方建议移除进程不需要的 capabilities；`no-new-privileges` 阻止容器进程通过 `setuid` 等机制获得新权限。[Docker Engine 安全](https://docs.docker.com/engine/security/)、[Docker run 安全选项](https://docs.docker.com/reference/cli/docker/container/run/#security-opt)

### 浏览器服务

浏览器直接处理不可信网页，是风险更高的服务：

- Chromium 必须以非 root 用户运行并保留浏览器 sandbox。
- 使用与固定 Playwright 版本匹配的浏览器镜像。
- 使用适合 Chromium sandbox 的受限 seccomp 配置，不采用 `seccomp=unconfined`。
- 优先分配独立的 `/dev/shm`，不默认使用 `ipc: host`。
- 不添加 `SYS_ADMIN`；该能力只作为本地调试诊断手段，不进入正式 Compose。
- 限制下载体积、导航次数、页面数量、执行时间和响应大小。
- 对传入 URL 和每一次重定向执行 SSRF 检查。

Playwright 官方对抓取场景同样建议非 root 用户和 seccomp，并提醒其通用 Docker 镜像不应直接作为访问不可信网站的完整安全方案。[Playwright Docker 文档](https://playwright.dev/docs/docker)

## 6. 网络设计

第一版需要出站互联网访问：

- `radar`：飞书、Feed、公开网页和模型 API。
- `browser`：目标网页及其静态资源。

默认不需要任何公网入站端口。飞书使用主动建立的 WebSocket 长连接。

Compose 内建立专用内部网络供 `radar` 调用 `browser`。浏览器接口不映射到宿主机。人工登录端口只在 `browser-login` 运行时映射到 `127.0.0.1`，不能绑定 `0.0.0.0`。

容器网络不能单独完成 SSRF 防护，因为浏览器仍可能访问 Docker Desktop 或局域网可达地址。应用层必须阻止私网、环回、链路本地和云元数据地址，并对 DNS 解析和跳转后的地址重复检查。

### 6.1 手机免安装的远程登录

远程登录不是默认部署的一部分。需要从手机系统浏览器处理登录时，使用根目录的 `compose.remote-login.yaml` 显式增加：

- 空闲运行的 `browser-login`，只在收到内部授权请求后创建临时会话。
- 使用固定版本官方镜像的 `login-tunnel`，主动向 Cloudflare 建立出站连接。
- 独立登录网络，使 `login-tunnel` 只能访问 `browser-login` 的登录端口，不能访问 `radar` 或 `browser` 的抓取端口。

`radar` 只可以通过窄接口申请或取消登录会话，不能通过 Docker Socket 启停容器。登录 URL 需要同时通过 Cloudflare Access 身份认证和项目生成的一次性任务令牌。令牌绑定飞书用户、站点、Profile 与任务，建议 10 分钟过期，并在成功、超时或连续失败后立即作废。

该模式不会打开家庭路由器入站端口，但会创建一个由第三方身份代理保护的公网主机名。应先建立默认拒绝的 Access 策略，再配置 Tunnel，并在源站或隧道侧验证 Access Token，避免因路由配置错误绕过身份层。[Cloudflare Access 自托管应用文档](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)

远程登录 overlay 不命名为 `compose.override.yaml`，防止 Compose 自动加载。使用时必须显式指定基础文件和 overlay；不用时停止 overlay 中的服务。Cloudflare Tunnel 由内向外建立连接，不要求手机安装客户端，也不要求家庭网络具有公网 IP。[Cloudflare 私有 Web 应用文档](https://developers.cloudflare.com/cloudflare-one/setup/secure-private-apps/private-web-app/)

## 7. Windows Docker Desktop

开发机器上的推荐映射：

```text
D:/Desktop/MyKnowledgeBase/Private/Inbox  →  /data/archive
Docker named volume: radar-state          →  /var/lib/knowledge-radar
Docker named volume: browser-profiles     →  /var/lib/knowledge-radar/profiles
```

SQLite 和 Browser Profile 放在 Linux named volume 中，而不是 Windows bind mount：

- SQLite 对文件锁和同步语义敏感。
- Chromium Profile 包含大量小文件和 Linux 权限信息。
- named volume 通常比跨 Windows/Linux 文件共享更稳定。

Inbox 保留 bind mount，因为 Markdown 需要立即被 Windows 上的 Obsidian 和 Git 看见。部署前需要验证 Docker Desktop 对 `D:` 盘的文件共享权限。

Docker Desktop 必须在用户登录后运行，Compose 的 restart policy 才能接管应用启动。如果未来需要真正无人值守开机运行，Linux 主机或 NAS 上的 Docker Engine 更合适。

## 8. 生命周期

### 首次启动

1. 准备仓库外的配置和 secret 文件。
2. 创建 Inbox 目录并核对 bind mount 目标。
3. 拉取固定版本镜像。
4. 启动 `radar`，执行数据库迁移和健康检查。
5. 在飞书发送测试消息，确认归档只能写入 Inbox。
6. 需要登录网页时，再启用 `browser` 服务。

### 登录刷新

1. `browser` 发现会话失效，将任务标记为 `waiting_auth`。
2. `radar` 通过飞书发送 Profile 和站点信息，不发送凭据。
3. 系统暂停该 Profile 的抓取；本机模式由用户启动 `browser-login`，远程模式激活已空闲运行的登录服务。
4. 用户在本机临时页面完成登录。
5. 关闭登录会话；本机模式停止 `browser-login`，远程模式恢复为空闲拒绝状态，然后恢复任务并验证正文完整度。

### 升级

1. 备份 `radar-state` 和 `browser-profiles` volumes。
2. 拉取固定的新版本镜像，不覆盖旧标签。
3. 运行迁移并检查健康状态。
4. 验证飞书收件、Feed 轮询和一篇登录网页。
5. 失败时回退镜像；涉及数据库迁移时按迁移文档恢复备份。

## 9. 备份

- Markdown 继续由 `MyKnowledgeBase` 的 Git 策略管理。
- SQLite 使用数据库在线备份能力生成一致性快照，不能直接复制活跃的 WAL 文件组合。
- Browser Profiles 包含可冒用登录态，默认不做云端备份。需要备份时必须加密，并设置较短保留时间。
- secrets 与 Profile 分开备份，不能打进同一个可移植压缩包。

## 10. 仍待验证

开始实现 Docker 文件前，需要完成以下小规模验证：

- Node.js 24 内置 SQLite 在目标基础镜像中的可用性。
- Docker Desktop 重启后 named volume 和 Inbox bind mount 的一致性。
- Chromium 在非 root、`cap_drop: ALL` 和候选 seccomp 下能否稳定运行。
- 使用 `shm_size` 代替 `ipc: host` 时的页面稳定性。
- noVNC 或其他人工登录界面在 Windows localhost 下的可用性。
- Playwright 客户端、服务和浏览器镜像的版本锁定方式。
- 两个不同信任级别的 Browser Profile 是否确实落在不同 named volume，且服务不能交叉读取。

这些验证通过前，Docker 和浏览器相关选型保持 Proposed。
