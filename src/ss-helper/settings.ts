import type { SettingsAdapter, SettingsSchema, SettingsValues } from '@ss-helper/sdk';

export const LLM_SETTINGS_KEY = 'ss-helper.llm.settings.v1';
export const LLM_ADVANCED_ROUTING_KEY = 'ss-helper.llm.advanced-routing.v1';

export const LLM_SETTINGS_SCHEMA: SettingsSchema = {
    id: 'ss-helper.llm',
    title: 'SS-Helper LLM',
    fields: [
        { kind: 'toggle', id: 'enabled', label: '启用 LLM 服务', description: '允许其他插件通过 Core 调用统一的 LLM completion 服务。', defaultValue: true },
        { kind: 'text', id: 'route', label: '默认路由', description: '未显式指定路由时使用的模型或路由名称。', defaultValue: 'default' },
        { kind: 'number', id: 'timeoutMs', label: '请求超时（毫秒）', description: '单次生成请求的最大等待时间。', defaultValue: 60000, validation: { min: 1000, max: 300000 } },
        { kind: 'action', id: 'advanced', label: '高级路由配置', description: '在 Core popup 中编辑个性化路由配置。', actionId: 'open-advanced', popup: { kind: 'popup', provider: 'ss-helper.llm', name: 'advanced-routing', version: 1 } },
    ],
};

const DEFAULT_SETTINGS: SettingsValues = { enabled: true, route: 'default', timeoutMs: 60000 };

export function loadLlmSettings(storage: Pick<Storage, 'getItem'> = localStorage): SettingsValues {
    const raw = storage.getItem(LLM_SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as SettingsValues) }; } catch { return DEFAULT_SETTINGS; }
}

export function createLlmSettingsAdapter(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage): SettingsAdapter {
    return {
        load(): SettingsValues { return loadLlmSettings(storage); },
        save(values): void { storage.setItem(LLM_SETTINGS_KEY, JSON.stringify(values)); },
        reset(): SettingsValues { storage.removeItem(LLM_SETTINGS_KEY); return DEFAULT_SETTINGS; },
    };
}
