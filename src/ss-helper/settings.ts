import type { SettingsAdapter, SettingsSchema, SettingsValues } from '@ss-helper/sdk';
import config from '../../plugin.config.json' with { type: 'json' };
import { DEFAULT_LLM_SETTINGS } from '../schema/defaults';
import type { LlmWorkspaceRepository } from '../storage/llm-workspace-repository';
import type { LlmSettingsStatusSource } from './settings-status';

export const LLM_SETTINGS_KEY = 'ss-helper.llm.settings.v2';

const popup = (name: string) => ({ kind: 'popup', provider: 'ss-helper.llm', name, version: 2 } as const);

export const LLM_SETTINGS_SCHEMA: SettingsSchema = {
    id: 'ss-helper.llm',
    title: config.settingsTitle,
    fields: [
        { kind: 'section', id: 'start', label: '开始', children: [
            { kind: 'section', id: 'startStatus', label: '服务状态', children: [
                { kind: 'toggle', id: 'enabled', label: '启用 LLM', description: '启用后，其他 SS-Helper 插件可以调用统一的 AI 服务。', defaultValue: DEFAULT_LLM_SETTINGS.enabled },
                { kind: 'status', id: 'tavernStatus', label: '当前酒馆连接', description: '显示酒馆正在使用的来源和模型，不需要额外配置。', value: '正在连接', tone: 'neutral' },
                { kind: 'status', id: 'serviceStatus', label: '服务状态', description: '实时显示生成、向量化和重排序能力。', value: '正在同步', tone: 'neutral' },
            ] },
            { kind: 'section', id: 'generationPreferences', label: '生成偏好', children: [
                { kind: 'select', id: 'globalProfile', label: '回答风格', description: '选择回答偏好。均衡适合大多数情况。', options: [{ value: 'balanced', label: '均衡' }, { value: 'precise', label: '精确' }, { value: 'creative', label: '创意' }, { value: 'economy', label: '省用' }], defaultValue: DEFAULT_LLM_SETTINGS.globalProfile },
                { kind: 'select', id: 'maxTokensMode', label: '输出长度', description: '自动按内容决定长度；手动可以设置最大值。', options: [{ value: 'inherit', label: '跟随模型' }, { value: 'adaptive', label: '自动估算' }, { value: 'manual', label: '手动上限' }], defaultValue: DEFAULT_LLM_SETTINGS.maxTokensMode },
                { kind: 'number', id: 'maxTokens', label: '手动最大长度', description: '仅在选择手动上限时使用。', defaultValue: DEFAULT_LLM_SETTINGS.maxTokens, validation: { min: 1, max: 32768 }, step: 128, unit: 'tokens', showStepper: true },
            ] },
            { kind: 'section', id: 'requestDisplay', label: '请求与展示', children: [
                { kind: 'number', id: 'timeoutMs', label: '请求超时', description: '超过这个时间仍未完成时停止请求。', defaultValue: DEFAULT_LLM_SETTINGS.timeoutMs, validation: { min: 1000, max: 300000 }, step: 1000, unit: '毫秒', showStepper: true },
                { kind: 'select', id: 'resultDisplay', label: '结果展示', description: '智能模式只显示必要结果，后台任务不会频繁打扰。', options: [{ value: 'auto', label: '智能' }, { value: 'compact', label: '紧凑' }, { value: 'fullscreen', label: '全屏' }, { value: 'silent', label: '静默（需授权）' }], defaultValue: DEFAULT_LLM_SETTINGS.resultDisplay },
            ] },
        ] },
        { kind: 'section', id: 'resources', label: '资源', children: [
            { kind: 'section', id: 'resourceManagement', label: '资源管理', children: [
                { kind: 'action', id: 'resourceWizard', label: '添加资源', description: '按步骤添加生成、向量化或重排序服务。', actionId: 'open-resource-wizard', placement: 'inline', buttonLabel: '打开向导', popup: popup('resource-wizard') },
                { kind: 'action', id: 'resourceManager', label: '管理资源', description: '查看、测试、启用、编辑或删除已有资源。', actionId: 'open-resource-manager', placement: 'inline', buttonLabel: '打开', popup: popup('resource-manager') },
            ] },
            { kind: 'section', id: 'resourceTesting', label: '能力测试', children: [
                { kind: 'action', id: 'rerankTest', label: 'Rerank 测试', description: '用一组示例文档检查排序效果。', actionId: 'open-rerank-test', placement: 'inline', buttonLabel: '开始测试', popup: popup('rerank-test') },
            ] },
        ] },
        { kind: 'section', id: 'routing', label: '路由', children: [
            { kind: 'section', id: 'routingConfiguration', label: '路由配置', children: [
                { kind: 'action', id: 'routeManager', label: '默认与插件路由', description: '为生成、向量化和重排序选择默认资源，也可按插件和任务覆盖。', actionId: 'open-route-manager', placement: 'inline', buttonLabel: '配置', popup: popup('route-manager') },
                { kind: 'action', id: 'routePreview', label: '路由预览', description: '查看一次请求最终会使用哪个资源和模型。', actionId: 'open-route-preview', placement: 'inline', buttonLabel: '预览', popup: popup('route-preview') },
            ] },
            { kind: 'section', id: 'routingAdvanced', label: '高级配置', children: [
                { kind: 'action', id: 'advanced', label: '高级规则', description: '直接编辑完整配置，适合熟悉路由的用户。', actionId: 'open-advanced', placement: 'inline', buttonLabel: '编辑', popup: popup('advanced-routing') },
            ] },
        ] },
        { kind: 'section', id: 'runtime', label: '运行', children: [
            { kind: 'section', id: 'runtimeLimits', label: '额度与任务', children: [
                { kind: 'action', id: 'budgetManager', label: '使用额度与熔断', description: '限制插件的请求频率、Token、等待时间和成本。', actionId: 'open-budget-manager', placement: 'inline', buttonLabel: '配置', popup: popup('budget-manager') },
                { kind: 'action', id: 'queueManager', label: '请求队列', description: '查看正在等待和运行的任务，也可以取消任务。', actionId: 'open-queue-manager', placement: 'inline', buttonLabel: '查看', popup: popup('queue-manager') },
            ] },
            { kind: 'section', id: 'runtimePermissions', label: '权限与展示', children: [
                { kind: 'action', id: 'permissionManager', label: '后台权限', description: '决定哪些插件任务可以静默运行。', actionId: 'open-permission-manager', placement: 'inline', buttonLabel: '配置', popup: popup('permission-manager') },
                { kind: 'action', id: 'displayRules', label: '展示规则', description: '设置普通任务和后台任务如何显示结果。', actionId: 'open-display-rules', placement: 'inline', buttonLabel: '配置', popup: popup('display-rules') },
            ] },
        ] },
        { kind: 'section', id: 'diagnostics', label: '诊断', children: [
            { kind: 'section', id: 'diagnosticsChecks', label: '检查与日志', children: [
                { kind: 'action', id: 'serviceDiagnostics', label: '服务检查', description: '检查数据库、酒馆连接和外部资源是否正常。', actionId: 'open-diagnostics', placement: 'inline', buttonLabel: '运行检查', popup: popup('diagnostics') },
                { kind: 'action', id: 'requestLogs', label: '请求日志', description: '查看请求经过了哪个资源，以及成功或失败的原因。', actionId: 'open-request-logs', placement: 'inline', buttonLabel: '查看', popup: popup('request-logs') },
            ] },
            { kind: 'section', id: 'diagnosticsData', label: '数据管理', children: [
                { kind: 'action', id: 'backup', label: '导入导出', description: '备份或恢复配置。密钥不会包含在备份中。', actionId: 'open-backup', placement: 'inline', buttonLabel: '管理', popup: popup('backup') },
                { kind: 'action', id: 'reset', label: '全局重置', description: '清空 LLM 配置和密钥，恢复只使用酒馆模型。', actionId: 'reset-llm', tone: 'danger', placement: 'inline', buttonLabel: '重置', popup: popup('reset-confirm') },
            ] },
            { kind: 'section', id: 'diagnosticsAbout', label: '关于', children: [
                { kind: 'status', id: 'about', label: '版本信息', description: '显示当前连接的 LLM、Core、SDK 和 API 版本。', value: '正在同步', tone: 'neutral' },
            ] },
        ] },
    ],
};

const DEFAULT_SETTINGS = DEFAULT_LLM_SETTINGS as unknown as SettingsValues;

export function createWorkspaceLlmSettingsAdapter(repository: LlmWorkspaceRepository, statusSource: LlmSettingsStatusSource): SettingsAdapter {
    const listeners = new Set<(values: SettingsValues) => void>();
    return {
        async load(): Promise<SettingsValues> { return repository.loadSettings() as unknown as SettingsValues; },
        async save(values): Promise<void> { const saved = await repository.saveSettings(values as Record<string, unknown>); listeners.forEach((listener) => listener(saved as unknown as SettingsValues)); },
        async reset(): Promise<SettingsValues> { const reset = await repository.reset(); listeners.forEach((listener) => listener(reset as unknown as SettingsValues)); return reset as unknown as SettingsValues; },
        subscribe(listener): () => void { listeners.add(listener); return () => listeners.delete(listener); },
        loadStatus: () => statusSource.loadStatus(),
        subscribeStatus: (listener) => statusSource.subscribeStatus(listener),
    };
}

export { DEFAULT_SETTINGS };
