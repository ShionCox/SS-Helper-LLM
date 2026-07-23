import type { SettingsAdapter, SettingsSchema, SettingsValues, ToastNotification } from '@ss-helper/sdk';
import config from '../../plugin.config.json' with { type: 'json' };
import { DEFAULT_LLM_SETTINGS } from '../schema/defaults';
import type { LLMHubSettings } from '../schema/types';
import type { LlmWorkspaceRepository } from '../storage/llm-workspace-repository';
import type { LlmSettingsStatusSource } from './settings-status';

export const LLM_SETTINGS_KEY = 'ss-helper.llm.settings.v0';

export const LLM_POPUP_VERSION = 0 as const;

const popup = (name: string) => ({ kind: 'popup', provider: 'ss-helper.llm', name, version: LLM_POPUP_VERSION } as const);

export const LLM_REQUEST_LOGS_POPUP = popup('request-logs');

export const LLM_SETTINGS_SCHEMA: SettingsSchema = {
    id: 'ss-helper.llm',
    title: config.settingsTitle,
    fields: [
        { kind: 'section', id: 'start', label: '开始', children: [
            { kind: 'section', id: 'startStatus', label: '服务状态', children: [
                { kind: 'toggle', id: 'enabled', label: '启用 LLM', description: '开启AI服务。', defaultValue: DEFAULT_LLM_SETTINGS.enabled },
                { kind: 'status', id: 'tavernStatus', label: '大语言模型', description: '显示酒馆正在使用的来源和模型，不需要额外配置。', value: '正在连接', tone: 'neutral' },
                { kind: 'status', id: 'serviceStatus', label: '服务状态', description: '实时显示生成、向量化和重排序能力。', value: '正在同步', tone: 'neutral' },
            ] },
            { kind: 'section', id: 'generationPreferences', label: '生成偏好', children: [
                { kind: 'select', id: 'generationSource', label: '模型来源', description: '仅影响大语言模型生成；向量化和重排序始终使用自定义 API。', options: [{ value: 'tavern', label: '酒馆当前模型' }, { value: 'custom', label: '自定义 API' }], defaultValue: DEFAULT_LLM_SETTINGS.generationSource },
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
                { kind: 'action', id: 'routeManager', label: '默认与插件路由', description: '自定义 API 模式下为生成选择具体资源；向量化和重排序始终按自定义资源路由。', actionId: 'open-route-manager', placement: 'inline', buttonLabel: '配置', popup: popup('route-manager') },
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
                { kind: 'action', id: 'requestLogs', label: '请求日志', description: '查看请求经过了哪个资源，以及成功或失败的原因。', actionId: 'open-request-logs', placement: 'inline', buttonLabel: '查看', popup: LLM_REQUEST_LOGS_POPUP },
            ] },
            { kind: 'section', id: 'requestLogPolicy', label: '日志记录策略', children: [
                { kind: 'toggle', id: 'requestLogging.enabled', label: '保存请求日志', description: '保存请求诊断链路；关闭后不再写入新的日志。', defaultValue: DEFAULT_LLM_SETTINGS.requestLogging.enabled },
                { kind: 'select', id: 'requestLogging.detailMode', label: '记录范围', description: '完整日志会包含 Prompt 和模型原始返回，请确认本机数据安全。', options: [
                    { value: 'full', label: '全部完整记录' }, { value: 'failed-full', label: '仅失败完整记录' }, { value: 'summary', label: '仅摘要' }, { value: 'off', label: '不记录' },
                ], defaultValue: DEFAULT_LLM_SETTINGS.requestLogging.detailMode },
                { kind: 'number', id: 'requestLogging.maxEntries', label: '最大条数', description: '达到上限后自动删除最旧日志。', defaultValue: DEFAULT_LLM_SETTINGS.requestLogging.maxEntries, validation: { min: 1, max: 5000 }, step: 50, unit: '条', showStepper: true },
                { kind: 'number', id: 'requestLogging.retentionDays', label: '保留天数', description: '超过天数的日志会自动删除。', defaultValue: DEFAULT_LLM_SETTINGS.requestLogging.retentionDays, validation: { min: 1, max: 3650 }, step: 1, unit: '天', showStepper: true },
                { kind: 'number', id: 'requestLogging.maxBytesMb', label: '最大占用', description: '完整日志可能包含聊天正文；达到空间上限后自动删除最旧日志。', defaultValue: DEFAULT_LLM_SETTINGS.requestLogging.maxBytes / (1024 * 1024), validation: { min: 1, max: 1024 }, step: 10, unit: 'MB', showStepper: true },
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

function withLogFields(values: SettingsValues): SettingsValues {
    const logging = (values.requestLogging && typeof values.requestLogging === 'object' ? values.requestLogging : {}) as Record<string, unknown>;
    return {
        ...values,
        'requestLogging.enabled': logging.enabled ?? DEFAULT_LLM_SETTINGS.requestLogging.enabled,
        'requestLogging.detailMode': logging.detailMode ?? DEFAULT_LLM_SETTINGS.requestLogging.detailMode,
        'requestLogging.maxEntries': logging.maxEntries ?? DEFAULT_LLM_SETTINGS.requestLogging.maxEntries,
        'requestLogging.retentionDays': logging.retentionDays ?? DEFAULT_LLM_SETTINGS.requestLogging.retentionDays,
        'requestLogging.maxBytesMb': Number(logging.maxBytes ?? DEFAULT_LLM_SETTINGS.requestLogging.maxBytes) / (1024 * 1024),
    } as unknown as SettingsValues;
}

function withoutLogFields(values: SettingsValues): Record<string, unknown> {
    const next = { ...values } as Record<string, unknown>;
    const existing = next.requestLogging && typeof next.requestLogging === 'object' ? next.requestLogging as Record<string, unknown> : {};
    next.requestLogging = {
        ...existing,
        enabled: typeof next['requestLogging.enabled'] === 'boolean' ? next['requestLogging.enabled'] : existing.enabled,
        detailMode: typeof next['requestLogging.detailMode'] === 'string' ? next['requestLogging.detailMode'] : existing.detailMode,
        maxEntries: typeof next['requestLogging.maxEntries'] === 'number' ? next['requestLogging.maxEntries'] : existing.maxEntries,
        retentionDays: typeof next['requestLogging.retentionDays'] === 'number' ? next['requestLogging.retentionDays'] : existing.retentionDays,
        maxBytes: typeof next['requestLogging.maxBytesMb'] === 'number' ? Math.round(next['requestLogging.maxBytesMb'] * 1024 * 1024) : existing.maxBytes,
    };
    delete next['requestLogging.enabled']; delete next['requestLogging.detailMode']; delete next['requestLogging.maxEntries']; delete next['requestLogging.retentionDays']; delete next['requestLogging.maxBytesMb'];
    return next;
}

export function createWorkspaceLlmSettingsAdapter(repository: LlmWorkspaceRepository, statusSource: LlmSettingsStatusSource, notify?: (notification: ToastNotification) => void): SettingsAdapter {
    let generationSource: 'tavern' | 'custom' | undefined;
    const sourceOf = (values: SettingsValues): 'tavern' | 'custom' => values.generationSource === 'custom' ? 'custom' : 'tavern';
    const warnIfSelectedSourceUnavailable = async (): Promise<void> => {
        try {
            await statusSource.refreshNow();
            const status = await statusSource.loadStatus();
            if (status.serviceStatus?.tone !== 'error') return;
            notify?.({ level: 'warning', title: '模型来源不可用', message: '所选大语言模型来源当前不可用，请检查酒馆连接或自定义资源配置。', code: 'LLM_GENERATION_SOURCE_UNAVAILABLE', durationMs: 4200 });
        } catch { /* Status and toast are best effort after the setting has committed. */ }
    };
    const reportSaveFailure = (failure: unknown): void => {
        const code = failure && typeof failure === 'object' && 'code' in failure && typeof failure.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(failure.code)
            ? failure.code
            : 'LLM_SETTINGS_SAVE_FAILED';
        try { notify?.({ level: 'error', title: '设置保存失败', message: `模型来源设置未能保存（${code}），请检查运行状态。`, code, durationMs: 5200 }); } catch { /* Keep the original save failure authoritative. */ }
    };
    return {
        async load(): Promise<SettingsValues> { const loaded = withLogFields(await repository.loadSettings() as unknown as SettingsValues); generationSource = sourceOf(loaded); return loaded; },
        async save(values): Promise<void> {
            const nextSource = sourceOf(values);
            const sourceChanged = generationSource !== undefined && generationSource !== nextSource;
            let saved: SettingsValues;
            try { saved = withLogFields(await repository.saveSettings(withoutLogFields(values) as LLMHubSettings & Record<string, unknown>) as unknown as SettingsValues); }
            catch (failure) { reportSaveFailure(failure); throw failure; }
            generationSource = sourceOf(saved);
            if (sourceChanged) void warnIfSelectedSourceUnavailable();
        },
        async reset(): Promise<SettingsValues> { const reset = withLogFields(await repository.reset() as unknown as SettingsValues); generationSource = sourceOf(reset); return reset; },
        loadStatus: () => statusSource.loadStatus(),
        subscribeStatus: (listener) => statusSource.subscribeStatus(listener),
    };
}

export { DEFAULT_SETTINGS };
