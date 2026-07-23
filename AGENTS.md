# SS-Helper LLM 项目约束

## 版本规则

- LLM 发布版本唯一来源是 `plugin.config.json` 的 `manifest.version`，本次断代基线为 `0.0.1`；构建产物 `manifest.json`、SDK 依赖和 API descriptor 必须由该来源派生。
- 公共 API 使用 SemVer 字符串 `apiVersion`/`minApiVersion`，当前为 `0.0.1`；SS-Helper 自有事件、归档和桥接协议使用 v0，不保留旧 v1/v2 运行时兼容链路。
- Node.js、SillyTavern、npm 依赖及第三方 provider URL 的版本属于外部约束，不随插件版本重置。

## 图标

- LLM 只能使用 SDK Core 注册的 `<ss-helper-icon name="...">` 或声明式 Chat Indicator 图标名称；名称不带 `fa-` 前缀且必须存在于 SDK Solid 图标清单。
- 禁止加载或复制 Font Awesome CSS/字体、使用全局 `fa-*` class、内联 SVG 或 Emoji 替代统一图标。
- 带可见文本或位于已有 `aria-label` 按钮内的图标使用 `decorative`；独立语义图标必须提供 `label`，图标按钮的可访问名称由按钮自身承担。

## 结构化输出

- 优先使用 Provider 原生 JSON；prompt-only 也只能接受一个完整 JSON 根对象。
- 只允许确定性清理 `<think>`、代码围栏和空白，禁止拼接多个 JSON；未知枚举不得改成 `other`。
- 仅超时、限流、网络和临时 Provider 故障自动重试一次；日志不得记录完整 Prompt、凭据或聊天正文。
- Memory Capture 的详细用法见 [../SS-Helper-Memory/docs/structured-capture.md](../SS-Helper-Memory/docs/structured-capture.md)。
