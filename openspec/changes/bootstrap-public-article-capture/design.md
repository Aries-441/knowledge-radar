## Context

仓库正处于首个可运行闭环的实现阶段。用户人工提交的链接通常来自常见技术站点，首轮优先提高正文获取成功率；行为约束见 `specs/public-article-capture/spec.md`。

## Goals / Non-Goals

**Goals:**

- 用 `docker compose run --rm radar <url>` 渲染一篇文章并归档。
- 用一次性浏览器上下文处理动态页面，但不保留站点状态。
- 保持单包、单进程和单个容器服务。

**Non-Goals:**

- 不承诺抵御 DNS 重绑定或实现出口代理级别的 SSRF 防护。
- 不支持自动登录、持久 Cookie、验证码、付费墙或反爬绕过。
- 不建立浏览器服务、Profile 管理、站点白名单、队列或数据库。

## Decisions

### Playwright 直接作为首轮正文入口

使用 Playwright Chromium 访问 URL，在 `domcontentloaded` 后短暂等待网络稳定，再把 `page.content()` 交给 Readability。静态 HTTP 下载器不进入首轮，避免为同一来源维护两套提取路径。

每次运行创建无痕 BrowserContext，并在 `finally` 中关闭 Context 和 Browser。不开启下载、不接受弹窗，禁用 Service Worker；路由只放行 HTTP(S) 的文档、脚本、样式、XHR 和 Fetch 请求，阻断非 HTTP(S)、明显本地地址字面量、图片、媒体、字体及 WebSocket。

这是基础过滤而非网络隔离：Chromium 自行 DNS 解析，无法在不增加代理的前提下保证阻止 DNS 重绑定。首轮将 URL 视为用户亲自提交的低风险输入；将来开放飞书入口或支持任意用户时，再增加域名策略或受控出口。

### AgentRuntime 保持函数类型

`AgentRuntime` 只定义为接收文章文本并返回 `{ summary, keyPoints }` 的异步函数类型。生产环境直接绑定 pi SDK，测试传入 Fake 函数；不建立 class、factory、provider registry 或通用 Agent 工具层。

pi 请求不注册任何工具。返回值使用少量手写类型检查验证；无效结果直接失败，不做自动重试或修复循环。

### 单镜像的轻量容器边界

镜像使用与 npm Playwright 版本匹配的官方 Playwright Chromium 基础镜像。应用以非 root 用户运行，容器只挂载归档目录，不挂载 Docker Socket 或用户主目录；临时浏览数据仅存在于容器临时文件系统。

不增加独立浏览器服务、代理或持久卷。Compose 使用 `init` 和受限共享内存大小以提高 Chromium 稳定性；更严格的 seccomp、出口网络规则和独立浏览器安全域留到登录态阶段。

### Markdown 是唯一持久化结果

归档根目录由容器内固定路径指定。文件名由时间、清洗后的标题和 URL 短哈希生成；先写同目录临时文件，再重命名为 `.md`，避免失败时留下半份归档。

CLI 成功时向标准输出写出标题、最终 URL 和归档路径的 JSON；失败时写标准错误并返回非零退出码。第一轮不保存数据库状态、浏览数据和完整原文。

## Risks / Trade-offs

- [页面脚本能发起复杂网络请求] → 临时 Context、资源路由和容器隔离降低影响；DNS 重绑定与出口限制推迟到扩大输入来源时处理。
- [站点检测或阻止 Headless Chromium] → 以博客园等真实样本验证；失败后再评估持久 Profile，而非预建反检测机制。
- [Chromium 镜像大、启动慢] → 接受首轮成本，以换取动态正文支持和后续登录态复用。
- [动态页面仍可能无法稳定提取] → 明确失败并保留来源 URL，不编造摘要。

## Migration Plan

移除未完成的原生 HTTP 下载器，安装 Playwright 并构建单镜像。先用容器内自制页面测试，再用博客园文章冒烟；回滚只需停止使用该镜像，已生成的 Markdown 保持可读。
