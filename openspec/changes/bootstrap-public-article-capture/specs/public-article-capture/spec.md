## Purpose

让用户通过一次容器命令，把单个公开文章 URL 的渲染结果转换为可阅读、可追溯的 Markdown 摘要，并明确知道归档是否成功。

## ADDED Requirements

### Requirement: 完成单篇公开文章归档
系统 SHALL 接收一个公开文章 URL，渲染并取得可用正文，生成包含 `summary` 和 `keyPoints` 的摘要，在配置的归档目录内创建 Markdown，并只在文件写入完成后返回归档路径。Markdown SHALL 包含文章标题、最终来源 URL、采集时间、概述和要点，且 MUST NOT 保存完整第三方原文。

#### Scenario: 成功归档动态或静态文章
- **WHEN** URL 的渲染结果包含可提取正文，AgentRuntime 返回有效摘要，且归档目录可写
- **THEN** 系统 SHALL 创建一份包含来源和摘要的 Markdown，输出其归档路径并以成功状态退出

#### Scenario: 任一步骤失败
- **WHEN** 导航、正文提取、摘要生成或文件写入任一步骤失败
- **THEN** 系统 SHALL 输出简明错误并以非零状态退出，且 MUST NOT 报告归档成功或留下不完整的 Markdown

### Requirement: 浏览器以临时且受限的上下文渲染页面
系统 MUST 仅接受不含嵌入凭据的 HTTP/HTTPS URL。每次采集 SHALL 使用新的非持久化浏览器上下文，禁用 Service Worker、下载和弹出页面，不保存 Cookie 或其他浏览数据。系统 SHALL 阻止 `file:`、`data:` 等非 HTTP(S) 请求，以及指向 `localhost`、环回地址、私有地址或链路本地地址的显式 URL；系统 SHALL 阻止图片、媒体、字体及其他与正文渲染无关的资源。

#### Scenario: 页面请求明显本地目标
- **WHEN** 初始 URL 或页面后续请求使用本地、环回、私有或链路本地地址字面量
- **THEN** 系统 SHALL 取消该请求，且 MUST NOT 把该响应交给正文提取或 AgentRuntime

#### Scenario: 页面加载无关资源
- **WHEN** 页面请求图片、媒体、字体或下载内容
- **THEN** 系统 SHALL 取消该资源请求，并继续处理不依赖该资源的正文

### Requirement: AgentRuntime 只总结不可信正文
系统 SHALL 仅把提取后的文章标题和正文作为不可信数据交给 AgentRuntime，并要求其返回非空 `summary` 与非空 `keyPoints` 数组。AgentRuntime MUST 禁用 Shell、文件、浏览器和其他工具，不得执行文章中的指令。

#### Scenario: 正文包含提示词注入
- **WHEN** 文章正文要求 AgentRuntime 忽略系统指令、调用工具或执行外部操作
- **THEN** AgentRuntime SHALL 仅总结该内容，并返回符合结构的摘要

#### Scenario: AgentRuntime 返回无效结构
- **WHEN** AgentRuntime 返回空内容、无法解析的内容或缺少必要字段
- **THEN** 系统 SHALL 视为摘要失败，不创建归档
