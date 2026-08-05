# LLM 全链路断代实施跟踪

版本基线：SDK、LLM、Memory 均保持 `0.0.1`。本文件记录 v0 断代，不提供旧链路兼容读取。

## 已完成

- [x] SDK 增加 `LlmExecution`、任务需求、任务状态、路由分配、状态变化和资源能力验证契约。
- [x] `HostGenerationPort` 支持 Tavern inspect、消息/工具/Schema、流式 chunk、AbortSignal 和任务取消。
- [x] Tavern 连接建模为动态资源 `tavern:active`，请求体由 `ChatCompletionService.presetToGeneratePayload()` 生成。
- [x] LLM 路由按“任务显式分配 → execution 默认资源”解析；无同类型遍历、跨类型 fallback、模型名/URL 猜测或运行中换源。
- [x] Provider manifest 覆盖 OpenAI、Claude、Gemini、DeepSeek、Kimi、GLM、xAI 和 Generic OpenAI-compatible。
- [x] 能力探测拆分基础工具、严格 Schema、增量流式、并行和 reasoning replay；可选失败保留为 `optionalFailures`。
- [x] 结构化链按预先选择的 `json_schema → json_object → prompt_only` 执行；响应只解析一个 JSON 根对象并本地强校验。
- [x] Memory 路由目录统一覆盖九个场景，Agent 就绪数只统计三条 `tool_turn` 任务。
- [x] 共享错误上下文、requestId、Provider kind、HTTP 状态和 stage 穿过 Core、LLM、Memory 日志。
- [x] 生成资源保存独立 `LlmReasoningPolicy`；支持 Provider 默认、开启/关闭和统一强度枚举，`tavern:active` 复用同一策略表。
- [x] 思考能力验证拆分 completion、structured、tool_turn；显式策略缺少匹配快照时路由阻止，部分链路失败不会抹掉已验证链路。
- [x] Provider 请求只接收规范化 reasoning；OpenAI、Claude、Gemini、DeepSeek、Kimi、GLM、xAI 映射集中在 manifest/compiler，Tavern 交给宿主 canonical payload。

## 验证记录

- [x] SDK：`npm test -- --run`（139 tests passed）。
- [x] LLM：`npm test -- --run`（172 tests passed）。
- [x] Memory：`npm run typecheck`、`npm test -- --run`（550 tests passed，2 skipped）。
- [x] `npm run verify:dist`、`npm run verify:workspace`、`npm run verify:versions`。
- [ ] 使用当前 Tavern DeepSeek 连接完成真实 structured、非流式 tool_turn、取消和 Provider 错误实测；已完成九场景 UI、消费者注册和能力探测烟测，当前连接的基础工具探测明确返回 `LLM_TOOL_CALLS_UNSUPPORTED`，因此未伪造 Agent 成功。
- [ ] 使用当前连接逐项实测思考开启、关闭和强度子集；需要部署最新 SDK/Core/LLM 产物后记录真实 Provider 能力快照。

## 明确不保留

- `generationSource=tavern/custom` 双轨、插件推荐路由、任务模型覆盖、fallbackResourceId。
- 通过 URL、模型名、翻译后的错误文本推断 Provider 能力。
- 运行中静默切换 Provider、跨 execution fallback、结构化 JSON 拼接或字段修补。
- Agent 的 Single/Repair 工具定义和第二套路由/限流/日志包装。
