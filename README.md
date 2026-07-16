# SS-Helper LLM

`@ss-helper/llm` 是 SS-Helper 的 LLM 服务插件。它通过 Core 提供的公开、无状态的 `@ss-helper/sdk` 契约向其他插件暴露文本补全、结构化任务、嵌入、重排和路由诊断能力。

## 依赖与安装

- SDK 包身份：`@ss-helper/sdk@2.0.0`
- 本地依赖来源：`vendor/ss-helper-sdk-2.0.0.tgz`
- `package.json` 的 pnpm override 将 SDK 固定为该 tgz；不使用 workspace、软链接、sibling 源码或开发机绝对路径。
- Core 负责会话连接、服务/事件注册、设置中心和 popup 宿主；LLM 插件不嵌入 Core 或宿主适配层。

```powershell
pnpm install --frozen-lockfile --ignore-workspace
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## 公开能力

消费者仅从 `@ss-helper/sdk` 包根导入并通过 Core session 调用：

- `LLM_COMPLETION_V1`
- `LLM_STRUCTURED_TASK_V1`
- `LLM_EMBEDDING_V1`
- `LLM_RERANK_V1`
- `LLM_ROUTE_DIAGNOSTICS_V1`
- `LLM_ROUTE_CHANGED_V1`

普通设置由 `LLM_SETTINGS_SCHEMA` 经 Core Settings Host 注册，设置中心包含“开始、资源、路由、运行、诊断”五页；资源向导、日志、备份和高级路由编辑器通过 Core popup 打开。完整消费者示例见 [docs/integration-manual.md](docs/integration-manual.md)。

## 数据与凭据

LLM 使用 SDK 的通用 workspace：owner 为 `ss-helper.llm`，workspace 为 `llm:global`。设置、资源、路由、消费者、预算、权限和请求摘要都保存到酒馆实例共享的 SQLite 中。Provider API Key 作为普通 `credentials` 记录由浏览器运行时读取并直接请求 Provider；设置 UI 只显示掩码，配置备份不包含 credentials 或详细日志正文。自定义 Provider 必须支持浏览器 CORS。

本项目按全新架构运行，不读取、迁移或删除旧 Dexie、Vault、localStorage 或 extensionSettings 数据。没有外部资源时自动使用 Tavern 生成；SQLite 或 Secret 不可用时，Tavern 生成仍可工作，外部资源会明确停用。
