import type { SettingsAdapter, SettingsFieldStateMap, SettingsSchema, SettingsValues, ToastNotification } from '@ss-helper/sdk';
import { describeSSHelperFailure } from '@ss-helper/sdk';
import config from '../../plugin.config.json' with { type: 'json' };
import { DEFAULT_LLM_SETTINGS } from '../schema/defaults';
import type { LLMHubSettings } from '../schema/types';
import type { LlmWorkspaceRepository } from '../storage/llm-workspace-repository';
import type { LlmSettingsStatusSource } from './settings-status';
import { configuredMaxTokensControl } from '../sdk/max-tokens';

export const LLM_POPUP_VERSION = 0 as const;

const popup = (name: string) => ({ kind: 'popup', provider: 'ss-helper.llm', name, version: LLM_POPUP_VERSION } as const);

export const LLM_REQUEST_LOGS_POPUP = popup('request-logs');
export const LLM_RESOURCE_WIZARD_POPUP = popup('resource-wizard');
export const LLM_RESOURCE_MANAGER_POPUP = popup('resource-manager');
export const LLM_GENERATION_SOURCE_POPUP = popup('generation-source');

export const LLM_SETTINGS_SCHEMA = {
    id: 'ss-helper.llm',
    title: config.settingsTitle,
    fields: [
        { kind: 'section', id: 'start', label: '开始', children: [
            { kind: 'section', id: 'startStatus', label: '服务状态', children: [
                { kind: 'toggle', id: 'enabled', label: '启用 LLM', description: '开启AI服务。', defaultValue: DEFAULT_LLM_SETTINGS.enabled },
                { kind: 'status', id: 'tavernStatus', label: '大语言模型', description: '显示酒馆正在使用的来源和模型，不需要额外配置。', value: '正在连接', tone: 'neutral' },
                { kind: 'status', id: 'generationSourceStatus', label: '默认生成来源', description: '普通生成、结构化和 Agent 的自动路由使用此来源；任务级显式分配仍优先。', value: '正在同步', tone: 'neutral' },
                { kind: 'status', id: 'generationStatus', label: '生成服务', description: '当前生成路由状态。', value: '正在同步', tone: 'neutral' },
                { kind: 'status', id: 'embeddingStatus', label: '向量服务', description: '当前向量资源状态。', value: '正在同步', tone: 'neutral' },
                { kind: 'status', id: 'rerankStatus', label: '重排服务', description: '当前重排资源状态。', value: '正在同步', tone: 'neutral' },
            ] },
            { kind: 'section', id: 'generationPreferences', label: '生成偏好', children: [
                { kind: 'select', id: 'globalProfile', label: '回答风格', description: '选择回答偏好。均衡适合大多数情况。', options: [{ value: 'balanced', label: '均衡' }, { value: 'precise', label: '精确' }, { value: 'creative', label: '创意' }, { value: 'economy', label: '省用' }], defaultValue: DEFAULT_LLM_SETTINGS.globalProfile },
                { kind: 'select', id: 'maxTokensMode', label: '输出长度', description: '自动按内容决定长度；手动可以设置最大值。', options: [{ value: 'inherit', label: '跟随模型' }, { value: 'adaptive', label: '自动估算' }, { value: 'manual', label: '手动上限' }], defaultValue: DEFAULT_LLM_SETTINGS.maxTokensMode },
                { kind: 'number', id: 'maxTokens', label: '手动最大长度', description: '仅在选择手动上限时使用。', defaultValue: DEFAULT_LLM_SETTINGS.maxTokens, validation: { min: 1, max: 32768 }, step: 128, unit: 'tokens', showStepper: true },
            ] },
            { kind: 'section', id: 'requestDisplay', label: '高级：请求与展示', collapsible: true, children: [
                { kind: 'toggle', id: 'streamingEnabled', label: '流式响应', description: '控制自定义 API 的普通生成、结构化请求和 Agent 工具调用；酒馆当前模型沿用酒馆设置。', defaultValue: DEFAULT_LLM_SETTINGS.streamingEnabled },
                { kind: 'number', id: 'maxRequestsPerMinute', label: '请求速率上限', description: '限制普通请求、自动重试和 Agent 模型轮次的启动频率；0 表示不限速。', defaultValue: DEFAULT_LLM_SETTINGS.maxRequestsPerMinute, validation: { min: 0, max: 60000 }, step: 1, unit: '次/分钟', showStepper: true },
                { kind: 'number', id: 'timeoutSeconds', label: '请求超时', description: '超过这个时间仍未完成时停止请求。', defaultValue: DEFAULT_LLM_SETTINGS.timeoutMs / 1000, validation: { min: 1, max: 300 }, step: 0.001, unit: '秒', showStepper: false },
            ] },
            { kind: 'section', id: 'sourceConfiguration', label: '模型来源', children: [
                { kind: 'action', id: 'generationSourceConfig', label: '默认生成来源', description: '选择酒馆当前连接或已添加的自定义生成 API。', actionId: 'open-generation-source', placement: 'inline', buttonLabel: '设置', popup: LLM_GENERATION_SOURCE_POPUP },
            ] },
        ] },
        { kind: 'section', id: 'resources', label: '资源', children: [
            { kind: 'section', id: 'resourceManagement', label: '资源管理', children: [
                { kind: 'action', id: 'resourceWizard', label: '添加资源', description: '按步骤添加生成、向量化或重排序服务。', actionId: 'open-resource-wizard', placement: 'inline', buttonLabel: '打开向导', popup: LLM_RESOURCE_WIZARD_POPUP },
                { kind: 'action', id: 'resourceManager', label: '管理资源', description: '查看、测试、启用、编辑或删除已有资源。', actionId: 'open-resource-manager', placement: 'inline', buttonLabel: '打开', popup: LLM_RESOURCE_MANAGER_POPUP },
            ] },
            { kind: 'section', id: 'resourceTesting', label: '能力测试', children: [
                { kind: 'action', id: 'rerankTest', label: 'Rerank 测试', description: '用一组示例文档检查排序效果。', actionId: 'open-rerank-test', placement: 'inline', buttonLabel: '开始测试', popup: popup('rerank-test') },
            ] },
        ] },
        { kind: 'section', id: 'routing', label: '路由', children: [
            { kind: 'section', id: 'routingConfiguration', label: '通用路由', children: [
                { kind: 'action', id: 'routePreview', label: '路由预览', description: '查看一次请求最终会使用哪个资源和模型。', actionId: 'open-route-preview', placement: 'inline', buttonLabel: '预览', popup: popup('route-preview') },
            ] },
            { kind: 'section', id: 'routingAdvanced', label: '高级配置', children: [
                { kind: 'action', id: 'defaultRoutes', label: '默认资源', description: '选择生成、向量和重排的默认资源；任务专属分配由对应插件管理。', actionId: 'open-default-routes', placement: 'inline', buttonLabel: '选择', popup: popup('default-routes') },
            ] },
        ] },
        { kind: 'section', id: 'runtime', label: '运行', children: [
            { kind: 'section', id: 'runtimeLimits', label: '额度与任务', children: [
                { kind: 'action', id: 'budgetManager', label: '使用额度', description: '按调用方限制请求频率、Token 和等待时间。', actionId: 'open-budget-manager', placement: 'inline', buttonLabel: '配置', popup: popup('budget-manager') },
            ] },
        ] },
        { kind: 'section', id: 'diagnostics', label: '诊断', children: [
            { kind: 'section', id: 'diagnosticsChecks', label: '检查与日志', children: [
                { kind: 'action', id: 'serviceDiagnostics', label: '服务检查', description: '检查数据库、酒馆连接和外部资源是否正常。', actionId: 'open-diagnostics', placement: 'inline', buttonLabel: '运行检查', popup: popup('diagnostics') },
                { kind: 'action', id: 'requestLogs', label: '请求日志', description: '查看等待与运行中的任务、请求使用的资源及成功或失败原因。', actionId: 'open-request-logs', placement: 'inline', buttonLabel: '查看', popup: LLM_REQUEST_LOGS_POPUP },
            ] },
            { kind: 'section', id: 'requestLogPolicy', label: '日志记录策略', children: [
                { kind: 'select', id: 'requestLogging.detailMode', label: '记录范围', description: '完整模式会在本机保存模型返回、解析结果和最终记忆内容；不保存 Prompt、API Key 或认证头。', options: [
                    { value: 'full', label: '完整返回与诊断' }, { value: 'failed-full', label: '仅失败保存完整返回' }, { value: 'summary', label: '仅诊断摘要' }, { value: 'off', label: '不记录' },
                ], defaultValue: DEFAULT_LLM_SETTINGS.requestLogging.detailMode },
                { kind: 'section', id: 'logRetention', label: '高级：日志保留', collapsible: true, children: [
                { kind: 'number', id: 'requestLogging.maxEntries', label: '最大条数', description: '达到上限后自动删除最旧日志。', defaultValue: DEFAULT_LLM_SETTINGS.requestLogging.maxEntries, validation: { min: 1, max: 5000 }, step: 50, unit: '条', showStepper: true },
                { kind: 'number', id: 'requestLogging.retentionDays', label: '保留天数', description: '超过天数的日志会自动删除。', defaultValue: DEFAULT_LLM_SETTINGS.requestLogging.retentionDays, validation: { min: 1, max: 3650 }, step: 1, unit: '天', showStepper: true },
                { kind: 'number', id: 'requestLogging.maxBytesMb', label: '最大占用', description: '达到空间上限后自动删除最旧诊断记录。', defaultValue: DEFAULT_LLM_SETTINGS.requestLogging.maxBytes / (1024 * 1024), validation: { min: 1, max: 1024 }, step: 10, unit: 'MB', showStepper: true },
                ] },
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
} as const satisfies SettingsSchema;

function toSettingsValues(settings: LLMHubSettings): SettingsValues {
    const output = configuredMaxTokensControl(settings);
    const logging = settings.requestLogging ?? DEFAULT_LLM_SETTINGS.requestLogging;
    return {
        enabled: settings.enabled ?? DEFAULT_LLM_SETTINGS.enabled,
        streamingEnabled: settings.streamingEnabled ?? DEFAULT_LLM_SETTINGS.streamingEnabled,
        maxRequestsPerMinute: settings.maxRequestsPerMinute ?? DEFAULT_LLM_SETTINGS.maxRequestsPerMinute,
        globalProfile: settings.globalProfile ?? DEFAULT_LLM_SETTINGS.globalProfile,
        maxTokensMode: output.mode,
        maxTokens: output.manualValue,
        timeoutSeconds: (settings.timeoutMs ?? DEFAULT_LLM_SETTINGS.timeoutMs) / 1000,
        'requestLogging.detailMode': logging.enabled === false ? 'off' : logging.detailMode ?? DEFAULT_LLM_SETTINGS.requestLogging.detailMode,
        'requestLogging.maxEntries': logging.maxEntries ?? DEFAULT_LLM_SETTINGS.requestLogging.maxEntries,
        'requestLogging.retentionDays': logging.retentionDays ?? DEFAULT_LLM_SETTINGS.requestLogging.retentionDays,
        'requestLogging.maxBytesMb': (logging.maxBytes ?? DEFAULT_LLM_SETTINGS.requestLogging.maxBytes) / (1024 * 1024),
    };
}

function applySettingsValues(current: LLMHubSettings, values: SettingsValues): LLMHubSettings {
    const existingLogging = current.requestLogging ?? DEFAULT_LLM_SETTINGS.requestLogging;
    const detailMode = values['requestLogging.detailMode'];
    const output = configuredMaxTokensControl(current);
    const { maxTokensMode: _mode, maxTokens: _tokens, ...retained } = current;
    const maxTokensMode = values.maxTokensMode === 'inherit' || values.maxTokensMode === 'manual' || values.maxTokensMode === 'adaptive'
        ? values.maxTokensMode
        : output.mode;
    const maxTokens = typeof values.maxTokens === 'number' ? values.maxTokens : output.manualValue;
    return {
        ...retained,
        enabled: typeof values.enabled === 'boolean' ? values.enabled : current.enabled ?? DEFAULT_LLM_SETTINGS.enabled,
        streamingEnabled: typeof values.streamingEnabled === 'boolean' ? values.streamingEnabled : current.streamingEnabled ?? DEFAULT_LLM_SETTINGS.streamingEnabled,
        maxRequestsPerMinute: typeof values.maxRequestsPerMinute === 'number' ? values.maxRequestsPerMinute : current.maxRequestsPerMinute ?? DEFAULT_LLM_SETTINGS.maxRequestsPerMinute,
        globalProfile: typeof values.globalProfile === 'string' ? values.globalProfile : current.globalProfile ?? DEFAULT_LLM_SETTINGS.globalProfile,
        maxTokensControl: {
            ...output,
            mode: maxTokensMode,
            manualValue: maxTokens,
        },
        timeoutMs: typeof values.timeoutSeconds === 'number' ? Math.round(values.timeoutSeconds * 1000) : current.timeoutMs ?? DEFAULT_LLM_SETTINGS.timeoutMs,
        requestLogging: {
            ...existingLogging,
            enabled: detailMode === undefined ? existingLogging.enabled : detailMode !== 'off',
            detailMode: detailMode === 'full' || detailMode === 'failed-full' || detailMode === 'summary' || detailMode === 'off'
                ? detailMode
                : existingLogging.detailMode,
            maxEntries: typeof values['requestLogging.maxEntries'] === 'number' ? values['requestLogging.maxEntries'] : existingLogging.maxEntries,
            retentionDays: typeof values['requestLogging.retentionDays'] === 'number' ? values['requestLogging.retentionDays'] : existingLogging.retentionDays,
            maxBytes: typeof values['requestLogging.maxBytesMb'] === 'number'
                ? Math.round(values['requestLogging.maxBytesMb'] * 1024 * 1024)
                : existingLogging.maxBytes,
        },
    };
}

export function createWorkspaceLlmSettingsAdapter(repository: LlmWorkspaceRepository, statusSource: LlmSettingsStatusSource, notify?: (notification: ToastNotification) => void): SettingsAdapter {
    const fieldState = (settings: LLMHubSettings): SettingsFieldStateMap => {
        const values = toSettingsValues(settings);
        return {
            maxTokens: { disabled: false, hidden: values.maxTokensMode !== 'manual' },
            ...Object.fromEntries(['maxEntries', 'retentionDays', 'maxBytesMb'].map((key) => [`requestLogging.${key}`, { disabled: false, hidden: values['requestLogging.detailMode'] === 'off' }])),
        };
    };
    const reportSaveFailure = (failure: unknown): void => {
        const diagnosis = describeSSHelperFailure(failure, { reasonCode: 'SETTINGS_SAVE_FAILED', stage: 'llm.settings.save' });
        try { notify?.({ level: 'error', title: diagnosis.title, message: `${diagnosis.reason} ${diagnosis.action}${diagnosis.requestId ? `（${diagnosis.requestId}）` : ''}`, code: diagnosis.reasonCode, durationMs: 5200 }); } catch { /* Keep the original save failure authoritative. */ }
    };
    return {
        async load(): Promise<SettingsValues> { return toSettingsValues(await repository.loadSettings()); },
        async save(values): Promise<void> {
            try {
                await repository.updateSettings((current) => applySettingsValues(current, values) as LLMHubSettings & Record<string, unknown>);
            }
            catch (failure) { reportSaveFailure(failure); throw failure; }
        },
        async reset(): Promise<SettingsValues> { return toSettingsValues(await repository.reset()); },
        subscribe: (listener) => repository.subscribeSettings((settings) => listener(toSettingsValues(settings))),
        loadFieldState: async () => fieldState(await repository.loadSettings()),
        subscribeFieldState: (listener) => repository.subscribeSettings((settings) => listener(fieldState(settings))),
        loadStatus: () => statusSource.loadStatus(),
        subscribeStatus: (listener) => statusSource.subscribeStatus(listener),
    };
}
