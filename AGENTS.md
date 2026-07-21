# SS-Helper LLM 项目约束

## 图标

- LLM 只能使用 SDK Core 注册的 `<ss-helper-icon name="...">` 或声明式 Chat Indicator 图标名称；名称不带 `fa-` 前缀且必须存在于 SDK Solid 图标清单。
- 禁止加载或复制 Font Awesome CSS/字体、使用全局 `fa-*` class、内联 SVG 或 Emoji 替代统一图标。
- 带可见文本或位于已有 `aria-label` 按钮内的图标使用 `decorative`；独立语义图标必须提供 `label`，图标按钮的可访问名称由按钮自身承担。
