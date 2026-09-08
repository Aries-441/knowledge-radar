## 1. 建立可运行的浏览器入口

- [x] 1.1 在仓库根目录加入匹配镜像版本的 Playwright 依赖，并以 `npm install`、类型检查和测试命令成功作为验证。

## 2. 完成采集闭环

- [x] 2.1 实现一次性 Playwright 渲染、基础 URL/资源过滤和 Readability 正文提取，并用自制页面验证动态 DOM、资源阻断和明显本地地址拦截。
- [x] 2.2 实现函数型 AgentRuntime 的 pi 绑定和最小摘要校验，确认不注册任何工具，并用 Fake AgentRuntime 验证有效与无效摘要结果。
- [x] 2.3 实现顺序编排、Markdown 临时写入后重命名和 CLI 输出，并用 Fake 渲染器、Fake AgentRuntime 与临时目录跑通一次端到端测试，验证成功文件内容及失败时不残留 `.md`。

## 3. 放入容器验证

- [x] 3.1 添加单服务 Playwright Dockerfile 与 Compose 配置，仅挂载归档目录并传入必要模型配置；运行 `docker compose config`、镜像构建和容器内测试验证配置可用。
- [x] 3.2 通过 `docker compose run --rm radar https://www.cnblogs.com/uniqueDong/p/22889846` 完成一次真实模型冒烟测试，确认标准输出返回归档路径且宿主机得到可读 Markdown。
