# SS-Helper LLM

`@ss-helper/llm` 是 SS-Helper 的 LLM 服务插件。它通过 Core 提供的公开、无状态的 `@ss-helper/sdk` 契约向其他插件暴露文本补全、结构化任务、嵌入、重排和路由诊断能力。

## 依赖与安装

- SDK 包身份：`@ss-helper/sdk@1.0.0`
- 本地依赖来源：`vendor/ss-helper-sdk-1.0.0.tgz`
- `package.json` 的 pnpm override 将 SDK 固定为该 tgz；不使用 workspace、软链接、sibling 源码或开发机绝对路径。
- Core 负责会话连接、服务/事件注册、普通设置宿主和 popup 宿主；LLM 插件不嵌入 Core 或宿主适配层。

```powershell
pnpm install --frozen-lockfile --ignore-workspace
pnpm typecheck
pnpm lint
pnpm test
pnpm test:browser-migration
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

普通设置由 `LLM_SETTINGS_SCHEMA` 经 Core Settings Host 注册；高级路由编辑器仅通过 Core popup token `ss-helper.llm/advanced-routing@1` 打开。完整消费者示例见 [docs/integration-manual.md](docs/integration-manual.md)。

## 数据迁移归属

LLM 插件独立拥有 Dexie 数据库 `SSHelperLLMDatabase`：`llm_credentials`、`llm_request_logs` 与无 payload 的迁移证据。它负责从冻结的旧 schema 执行校验、拷贝、校验和回滚；不会升级、删除或接管旧数据库中的其他插件数据。

历史复制和迁移记录仅用于审计，见 `docs/copy-baseline.md` 与 `docs/g006-migration.md`；它们不是当前集成说明。
