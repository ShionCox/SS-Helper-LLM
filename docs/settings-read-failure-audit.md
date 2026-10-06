# 设置读取失败：底层审查

日期：2026-10-07。对象：正式酒馆 `http://127.0.0.1:8000/` 的“设置读取失败，正在等待恢复”。以下至“建议实施顺序”为修复前的审查记录；本次执行结果见末节。

## 已确认的直接原因

正式 SQLite 中 `ss-helper.llm / llm:global / settings / global`（revision 45）仍含两项当前源码已删除的字段：

1. 顶层 `generationSource`。
2. `globalAssignments.generation.model`。

当前 `validateLlmSettings` 在顶层白名单校验先拒绝第 1 项；只在内存中移除第 1 项后，第 2 项继续被路由白名单拒绝。两项都从内存副本移除后，其余配置通过校验。原来源为自定义资源，选中的资源确实存在，旧路由模型与资源模型相同；本样本无需改动有效资源、任务路由或模型参数。

Git 历史显示这两项在 `3f115ed`（2026-08-05，“重构 LLM 路由与 Provider 能力”）删除。正式数据没有同步收敛到新契约；刷新页面仍会重新遇到同一非法配置。

## 失败链路

```text
SQLite settings/global
  → LlmWorkspaceRepository.initialize / loadSettingsFromWorkspace
  → validateLlmSettings
  → INVALID_PAYLOAD
     stage=llm.settings.validate
     expected=settings.generationSource 不受支持
  → repository.ready 拒绝
  → SettingsAdapter.load / loadFieldState 拒绝
  → SettingsHost.#load / #loadFieldState 吞掉异常上下文
  → SETTINGS_VALUES_LOAD_FAILED / SETTINGS_FIELD_STATE_LOAD_FAILED
  → 插件“需检查”与底栏“设置读取失败，正在等待恢复”
```

截图对应失败不是 Provider 网络、API Key 或模型输出错误。初始化未成功加载配置，资源 Provider 与路由也无法完成应用。

## 发现与修复位置

| 优先级 | 发现 | 代码位置 | 影响与最小处理方向 |
| --- | --- | --- | --- |
| P1 | 删除配置字段后，仍对已有正式设置直接执行新契约的全量拒绝校验 | `src/validation/settings.ts:247`、`:153`；`src/storage/llm-workspace-repository.ts:189` | 旧的冗余字段阻断全部 LLM 配置。需要有备份、明确字段范围、校验结果和修复预览的一次性数据修复；不恢复旧业务运行链路，也不改为静默忽略所有未知键。 |
| P2 | 常规恢复入口本身依赖成功初始化 | repository `updateSettings:341`、`reset:455`、`exportConfig:724`、`importConfig:734`、`clearAll:777` | 在这份配置下，保存、恢复默认和导出都在读取阶段失败，无法走到恢复动作。应提供独立于有效业务配置的安全诊断 / 修复或原始备份路径。当前“恢复默认”还会清资源与密钥，不适合作为保留数据修复。 |
| P2 | 读取失败被伪装成成功的默认来源 | `src/ss-helper/settings-status.ts:171`、`:62–64` | `loadSettings` 失败被转成 `undefined`，再按缺省配置显示“酒馆当前连接”且 tone=success。正式数据实际选择自定义资源。必须区分“成功读取且未指定来源”和“读取失败”，后者保留结构化失败并显示不可确定。 |
| P2 | 宿主吞掉准确诊断，生成 SDK 公共错误中心外的本地字符串 | SDK `apps/core-extension/src/settings/settings-host.ts:606–609`、`:1404` | 根因的 reasonCode、stage、expected 无法从设置页面读取；异常也可能发生在校验或 UI 同步，却全部称为读取失败。应保留安全失败上下文并用 SDK 诊断目录展示原因与处理建议。 |
| P2 | 恢复策略不一致，永久配置错误无限重试 | SDK host `:60`、`:495–501`；LLM `src/ss-helper/llm-service-runtime.ts:627–645` | SDK 为初次加三次重试，累计等待约 1.72 秒后停止；LLM 另有持续重试循环，最大间隔 5 秒，且不区分永久校验错误。等待不会改掉数据库中的旧字段。应按结构化 retryable 分类重试，并使界面反映实际恢复状态。LLM 循环在外部数据修好后仍可重新初始化，不能误判为永远没有恢复机制。 |
| P2 | 调用方注册的异步持久化未处理 Promise 拒绝 | `src/ss-helper/llm-service-runtime.ts:625`；`src/registry/consumer-registry.ts:363–366` | `void repository.saveConsumers(...)` 丢弃 Promise，注册表的同步 try/catch 捕获不到异步失败。复现捕获到同一 INVALID_PAYLOAD 的 unhandledRejection；会出现“注册成功”但落盘失败。需要在异步持久化边界保留失败并明确报告，而不是只捕获同步异常。 |

## 复现与回归证据

- 只读 SQLite 查询、正式浏览器错误堆栈、当前安装 bundle 第 2715 行与源码白名单互相一致。
- 修复前复现脚本：`.tmp/settings-read-audit.mjs`。它只读正式设置，在内存副本复现，最后断言写入次数为零；其中的失败断言不再适用于已修复的正式配置。本次回归使用下述维护脚本测试及各项目测试。
- 复现覆盖：两个旧键逐级拒绝、其余配置有效、load/update/reset/export 被同一根因阻断、错误的成功来源显示、注册持久化未处理拒绝、SDK 四次尝试后不再自行轮询。
- 现有 SDK 设置宿主、LLM 设置状态与 Workspace 相关回归共 68 项通过。现有用例验证“不允许写旧 generationSource”和“临时首次初始化失败可恢复”，没有覆盖正式旧数据被读取时的完整恢复与诊断链路，因此通过测试不能排除本次故障。
- 复现日志：工作区 `.tmp/settings-read-audit-results.log`；回归日志：`.tmp/settings-read-audit-regression.log`；浏览器截图：`.tmp/settings-read-error.jpg`。

## 建议实施顺序

1. 对这份设置做一次精确、可审阅的数据修复：保留原始备份，仅移除已确认冗余的两项，并再次完整校验。此步骤尚未执行。
2. 修复加载失败的状态、诊断和恢复入口，避免再展示默认配置为已读取配置。
3. 处理异步持久化失败，统一永久与临时失败的重试规则，并把本次旧配置样本的完整链路纳入回归。

没有执行全库重置、恢复默认、导入覆盖或部署。

## 本次实施与验收

已按授权处理审查的第 1–11 项；第 12 项版本检查脚本未修改，SDK、Core、LLM、Memory 仍为 0.0.1。

| 项目 | 已完成处理 |
| --- | --- |
| 1 | 独立维护脚本只修复确认一致的两项旧字段；完整 SQLite 备份、修复预览、revision 冲突保护及重复执行检查。设置宿主保留根因和定位，提供重新读取，永久错误停止自动重试；异步注册落盘捕获拒绝并在停止时取消待执行写入。 |
| 2 | 界面、仓储、初始化、重置和运行时共用输出长度解析，保存使用单一控制对象，保留高级参数与已有效的手动上限。 |
| 3 | 向量和重排的空默认资源明确显示未配置，实际执行继续拒绝缺失路由。 |
| 4 | 必需的原生结构化输出、严格工具 Schema、流式工具调用在执行和任务状态中生效；拒绝不支持的模式及运行时降级。 |
| 5 | 旧链路扫描支持 Unicode 路径和未跟踪文件，排除工作区已删除文件；测试夹具采用当前 DTO，只对明确的负例片段作范围有限的排除。 |
| 6–11 | 删除旧模板与提案转换、失效绑定检测、孤立事实验证、无调用辅助函数、未使用参数及 CSS；移除只覆盖已删除代码的测试和直接 Zod 依赖，保留当前事实校验、独立任务分配和私密记忆边界。 |

正式设置从 revision 45 精确修复为 46，之后键盘切换输出模式并恢复原模式用于持久化验收；原手动值 32768 保持有效。原始完整数据库备份为工作区 `.tmp/settings-backups/llm-settings-1791308211941-8c12fe73-244f-4f94-b9be-c1335bc48962.sqlite3`。部署均使用 `--preserveData`，先停止酒馆并收敛 WAL，再备份插件与数据、部署并后台恢复原服务。最新部署记录在 `.tmp/audit-deploy-applied.log`，其中包含酒馆备份目录。

自动检查：SDK 148 项、LLM 198 项、Memory 560 项通过；Memory 两项真实模型集成测试未启用。维护脚本测试、部署测试、四个 TypeScript 项目的未使用代码检查、SDK 类型夹具及迁移检查、旧链路扫描、统一构建、错误规范和版本规范均通过。构建保留了依赖自身的 Svelte 可访问性提示及 Node 弃用提示。

真实酒馆验收：两个插件状态正常，原读取错误消失，自定义生成来源及其模型保留；键盘切换、字段隐藏后的值保留、刷新后持久化、弹窗 Escape 与焦点恢复正常。八类 Memory 任务的独立路由仍显示；已配置生成与工具任务可用，未配置向量和重排明确不可用。390×844 浏览器视口没有横向溢出，之后已恢复 2370×1244 原视口。修复验收中发现的 `hidden` 被按钮样式覆盖问题已在 SDK 根节点样式中修正，健康状态的重新读取按钮确实隐藏。

截图：`.tmp/audit-browser/desktop-settings.png`、`.tmp/audit-browser/mobile-settings.png`。本次真实酒馆检查没有生成聊天或调用模型，没有选中角色；具体模型执行、当前聊天事实库与 3D 场景的浏览器验收不属于上述设置验收结果。移动检查为浏览器视口模拟，不是实体手机测试。
