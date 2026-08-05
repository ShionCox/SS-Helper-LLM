import {
    bootstrapSSHelper,
    createSSHelperError,
    describeSSHelperFailure,
    readSSHelperFailure,
    type PluginSession,
    type PlainData,
    type PopupWizardAdapter,
    type PopupWizardDefinition,
    type PopupUiContext,
    type PopupWizardSnapshot,
    type SessionBootstrap,
    type SSHelperReasonCode,
} from '@ss-helper/sdk';
import { logger, traceLlmStartup } from '../runtime/logger';
import { createWorkspaceLlmSettingsAdapter, LLM_GENERATION_SOURCE_POPUP, LLM_POPUP_VERSION, LLM_REQUEST_LOGS_POPUP, LLM_RESOURCE_WIZARD_POPUP, LLM_SETTINGS_SCHEMA } from './settings';
import { exposeLlmServices, type LlmServiceHandlers } from './services';
import { createProductionLlmServices, createProviderFromResource } from './llm-service-runtime';
import { LlmWorkspaceRepository } from '../storage/llm-workspace-repository';
import type { LLMHubSettings, ResourceConfig } from '../schema/types';
import { registerLlmChatIndicator } from './chat-indicator';
import config from '../../plugin.config.json' with { type: 'json' };
import { LlmSettingsStatusMonitor } from './settings-status';
import { renderRequestLogViewer } from '../ui/request-log-viewer';
import { registerResourcePopups } from './resource-popups';
import { createCoreBridgeFetch } from './core-bridge-fetch';
import { BUILTIN_TAVERN_RESOURCE_ID } from '../router/router';

const POPUP_NAMES = ['rerank-test', 'route-preview', 'advanced-routing', 'budget-manager', 'queue-manager', 'diagnostics', 'request-logs', 'backup', 'reset-confirm', 'generation-source'] as const;
type PopupName = typeof POPUP_NAMES[number];

const GENERATION_SOURCE_WIZARD: PopupWizardDefinition = {
    id: 'llm-generation-source',
    submitLabel: '保存来源',
    busyLabel: '正在保存…',
    steps: [{
        id: 'source',
        label: '来源',
        title: '选择默认生成来源',
        description: '只影响没有任务级显式分配的 completion、structured 和 tool_turn 请求。',
        fields: [
            {
                kind: 'segmented',
                id: 'sourceKind',
                label: '默认生成来源',
                description: '酒馆来源沿用酒馆当前 API 连接；自定义 API 从已添加的生成资源中选择。',
                options: [{ value: 'tavern', label: '酒馆当前连接' }, { value: 'custom', label: '自定义 API' }],
                validation: { required: true },
            },
            {
                kind: 'select',
                id: 'resourceId',
                label: '自定义生成资源',
                description: '只显示已启用的生成资源；密钥和完整地址不会显示。',
                options: [],
                validation: { required: true },
            },
        ],
    }],
};

type GenerationSourceKind = 'tavern' | 'custom';

export class GenerationSourceController implements PopupWizardAdapter {
    readonly #listeners = new Set<() => void>();
    readonly #repository: LlmWorkspaceRepository;
    readonly #ui: PopupUiContext;
    #sourceKind: GenerationSourceKind;
    #resourceId: string;
    #resources: ResourceConfig[];
    #status?: PopupWizardSnapshot['status'];
    #busy = false;

    get hasCustomResources(): boolean { return this.#resources.length > 0; }

    private constructor(repository: LlmWorkspaceRepository, ui: PopupUiContext, settings: LLMHubSettings) {
        this.#repository = repository;
        this.#ui = ui;
        const selected = settings.globalAssignments?.generation?.resourceId ?? BUILTIN_TAVERN_RESOURCE_ID;
        this.#resources = (settings.resources ?? []).filter((resource) => resource.type === 'generation' && resource.enabled !== false);
        this.#sourceKind = selected === BUILTIN_TAVERN_RESOURCE_ID ? 'tavern' : 'custom';
        this.#resourceId = this.#resources.some((resource) => resource.id === selected) ? selected : '';
        if (this.#sourceKind === 'custom' && this.#resourceId === '') {
            this.#status = { tone: 'error', message: '当前自定义默认资源不存在或已停用；请选择一个有效资源。', code: 'LLM_TASK_ROUTE_UNAVAILABLE' };
        }
    }

    static async create(repository: LlmWorkspaceRepository, ui: PopupUiContext): Promise<GenerationSourceController> {
        return new GenerationSourceController(repository, ui, await repository.loadSettings());
    }

    snapshot(): PopupWizardSnapshot {
        const options = this.#resources.map((resource) => ({
            value: resource.id,
            label: `${resource.label} · ${resource.apiType} · ${resource.model ?? '未指定模型'}`,
        }));
        const customInvalid = this.#sourceKind === 'custom' && !options.some((option) => option.value === this.#resourceId);
        return {
            activeStepId: 'source',
            completedStepIds: [],
            values: { sourceKind: this.#sourceKind, resourceId: this.#resourceId },
            fieldOptions: { resourceId: options },
            hiddenFieldIds: this.#sourceKind === 'tavern' ? ['resourceId'] : [],
            busy: this.#busy,
            submitDisabled: this.#busy || customInvalid,
            ...(this.#status === undefined ? {} : { status: this.#status }),
        };
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    change(fieldId: string, value: PlainData): void {
        if (this.#busy) return;
        if (fieldId === 'sourceKind' && (value === 'tavern' || value === 'custom')) {
            this.#sourceKind = value;
            if (value === 'custom' && !this.#resources.some((resource) => resource.id === this.#resourceId)) {
                this.#resourceId = this.#resources[0]?.id ?? '';
            }
            this.#status = undefined;
        } else if (fieldId === 'resourceId' && typeof value === 'string') {
            this.#resourceId = value;
            this.#status = undefined;
        } else return;
        this.#emit();
    }

    navigate(): void {}
    back(): void {}

    async submit(): Promise<void> {
        if (this.#busy) return;
        const settings = await this.#repository.loadSettings();
        const resourceId = this.#sourceKind === 'tavern' ? BUILTIN_TAVERN_RESOURCE_ID : this.#resourceId;
        const resource = settings.resources?.find((candidate) => candidate.id === resourceId);
        if (this.#sourceKind === 'custom' && (!resource || resource.type !== 'generation' || resource.enabled === false)) {
            this.#status = { tone: 'error', message: '请选择一个仍然启用的自定义生成资源。', code: 'LLM_TASK_ROUTE_UNAVAILABLE' };
            this.#emit();
            return;
        }
        this.#busy = true;
        this.#status = { tone: 'neutral', message: '正在应用默认生成来源…' };
        this.#emit();
        try {
            let selectedLabel = resource?.label ?? resourceId;
            await this.#repository.updateSettings((current) => {
                const latestResource = current.resources?.find((candidate) => candidate.id === resourceId);
                if (this.#sourceKind === 'custom' && (!latestResource || latestResource.type !== 'generation' || latestResource.enabled === false)) {
                    throw createSSHelperError('LLM_TASK_ROUTE_UNAVAILABLE', { stage: 'llm.generation-source.save', resourceId });
                }
                selectedLabel = latestResource?.label ?? selectedLabel;
                return {
                    ...current,
                    globalAssignments: {
                        ...(current.globalAssignments ?? {}),
                        generation: { resourceId },
                    },
                };
            });
            this.#status = { tone: 'success', message: this.#sourceKind === 'tavern' ? '已切换为酒馆当前连接。' : `已切换为自定义资源“${selectedLabel}”。` };
            this.#emit();
            this.#ui.close();
        } catch (error) {
            this.#status = { tone: 'error', message: `保存失败（${safeDiagnostic(error, 'LLM_REQUEST_INVALID')}）。`, code: safeDiagnostic(error, 'LLM_REQUEST_INVALID') };
            this.#busy = false;
            this.#emit();
        }
    }

    #emit(): void {
        for (const listener of this.#listeners) {
            try { listener(); } catch { /* A broken popup observer must not block the source update. */ }
        }
    }
}

async function providerFor(repository: LlmWorkspaceRepository, resource: ResourceConfig, fetchImpl: typeof fetch) {
    const apiKey = await repository.getResourceSecret(resource.id);
    if (!apiKey) throw createSSHelperError('AUTH_FAILED', { stage: 'llm.resource.secret', resourceId: resource.id });
    return createProviderFromResource(resource, apiKey, fetchImpl);
}

export interface StartLlmPluginOptions {
    pluginVersion: string;
    services?: LlmServiceHandlers;
    target?: { addEventListener(type: string, listener: EventListener): void; removeEventListener(type: string, listener: EventListener): void };
}

function safeDiagnostic(error: unknown, fallback: SSHelperReasonCode = 'INTERNAL_ERROR'): string {
    return readSSHelperFailure(error, { reasonCode: fallback, stage: 'llm.ui.popup' })!.reasonCode;
}

function safePopupCause(error: unknown): string {
    const diagnostic = describeSSHelperFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'llm.ui.popup' });
    return `${diagnostic.title}：${diagnostic.reason}`;
}

function reportBackgroundFailure(session: PluginSession, stage: string, error: unknown): void {
    const code = safeDiagnostic(error, 'INTERNAL_ERROR');
    logger.error(`LLM ${stage} failed`, { code });
    try {
        session.ui.showToast({
            level: 'error',
            title: 'LLM 后台任务失败',
            message: 'LLM 已安全降级；可稍后在设置中重新检查连接。',
            code,
        });
    } catch {
        // The Core may be disposing. The structured console diagnostic is enough.
    }
}

export function editableGenericRoutingSettings(settings: LLMHubSettings): Record<string, unknown> {
    const { taskAssignments: _consumerOwnedTaskAssignments, ...genericSettings } = settings;
    return genericSettings;
}

export function mergeGenericRoutingSettings(current: LLMHubSettings, edited: Record<string, unknown>): Record<string, unknown> {
    if (Object.hasOwn(edited, 'taskAssignments')) {
        throw createSSHelperError('LLM_REQUEST_INVALID', { stage: 'llm.routing.advanced' });
    }
    return {
        ...edited,
        ...(current.taskAssignments === undefined ? {} : { taskAssignments: current.taskAssignments }),
    };
}

async function renderPopup(container: HTMLElement, name: PopupName, repository: LlmWorkspaceRepository, fetchImpl: typeof fetch, ui?: PopupUiContext, notify?: (notification: { level: 'info' | 'success' | 'warning' | 'error'; title: string; message: string; code: string }) => void, services?: LlmServiceHandlers, openResourceWizard?: () => void): Promise<() => void> {
    if (ui === undefined) throw createSSHelperError('CORE_BRIDGE_UNAVAILABLE', { stage: 'llm.ui.popup' });
    const title = document.createElement('h3'); title.textContent = ({ 'rerank-test': 'Rerank 测试', 'route-preview': '路由预览', 'advanced-routing': '高级规则', 'budget-manager': '额度与熔断', 'queue-manager': '请求队列', diagnostics: '服务检查', 'request-logs': '请求日志', backup: '配置导入导出', 'reset-confirm': '全局重置', 'generation-source': '默认生成来源' } as Record<PopupName, string>)[name];
    const body = document.createElement('div'); body.className = `ss-helper-llm-popup-body${name === 'request-logs' ? ' ss-helper-llm-popup-body--workspace' : ''}`;
    if (name === 'request-logs') container.append(body);
    else container.append(title, body);
    if (name === 'rerank-test') {
        const query = ui.createInput({ label: 'Query' });
        const docs = ui.createTextarea({ label: '候选文档', placeholder: '每行一个候选文档' });
        const topK = ui.createInput({ label: 'Top K', type: 'number', value: '3' });
        const settings = await repository.loadSettings();
        const resources = (settings.resources ?? []).filter((item) => item.type === 'rerank');
        let resourceId = resources[0]?.id ?? '';
        const resource = ui.createSelect({ label: 'Rerank 资源', value: resourceId, options: resources.map((item) => ({ value: item.id, label: item.label })), onChange: (value) => { resourceId = value; } });
        const run = ui.createButton({ label: '运行测试', tone: 'primary' });
        const result = document.createElement('pre');
        run.addEventListener('click', async () => {
            let provider: Awaited<ReturnType<typeof providerFor>> | undefined;
            try {
                const item = (await repository.loadSettings()).resources?.find((candidate) => candidate.id === resourceId);
                if (!item) throw new Error('还没有重排序资源，添加后才能使用模型排序。');
                provider = await providerFor(repository, item, fetchImpl);
                const response = await provider.rerank?.({ query: query.value, docs: docs.value.split(/\r?\n/).filter(Boolean), topK: Number(topK.value) || 3, model: item.model });
                if (!response) throw new Error('Provider 不支持重排序');
                result.textContent = JSON.stringify(response.results ?? [], null, 2);
            } catch (error) { result.textContent = `测试失败（${safeDiagnostic(error, 'LLM_PROVIDER_TEST_FAILED')}）`; }
            finally { provider?.dispose?.(); }
        });
        body.append(query, docs, topK, resource, run, result);
    } else if (name === 'generation-source') {
        const controller = await GenerationSourceController.create(repository, ui);
        const handle = ui.mountWizard(GENERATION_SOURCE_WIZARD, controller);
        if (!controller.hasCustomResources) {
            const addResource = ui.createButton({ label: '添加自定义 API', tone: 'neutral' });
            addResource.addEventListener('click', () => {
                ui.close();
                openResourceWizard?.();
            });
            // Core's wizard owns and replaces the popup container on every
            // adapter update, so keep the escape hatch beside (not inside)
            // that managed subtree.
            container.parentElement?.insertBefore(addResource, container.nextSibling);
            return () => { addResource.remove(); handle.dispose(); };
        }
        return () => handle.dispose();
    } else if (name === 'advanced-routing') {
        const settings = await repository.loadSettings();
        const area = ui.createTextarea({ label: '通用路由与调度 JSON', value: JSON.stringify(editableGenericRoutingSettings(settings), null, 2) }); area.style.minHeight = '20rem';
        const save = ui.createButton({ label: '校验并应用', tone: 'primary' });
        const status = document.createElement('p'); save.addEventListener('click', async () => { try { const parsed = JSON.parse(area.value) as Record<string, unknown>; await repository.updateSettings((current) => mergeGenericRoutingSettings(current, parsed)); status.textContent = '已校验并应用。'; } catch (error) { status.textContent = `JSON 无效（${safeDiagnostic(error, 'LLM_REQUEST_INVALID')}）`; } }); body.append(area, save, status);
    } else if (name === 'backup') {
        const exportButton = ui.createButton({ label: '导出配置' }); const importButton = ui.createButton({ label: '导入配置', tone: 'primary' }); const area = ui.createTextarea({ label: '配置备份 JSON', placeholder: '粘贴备份 JSON' }); const status = document.createElement('p'); exportButton.addEventListener('click', async () => { try { const value = await repository.exportConfig(); area.value = JSON.stringify(value); status.textContent = '已生成备份（不包含密钥）。'; } catch (error) { status.textContent = `导出失败（${safeDiagnostic(error, 'INTERNAL_ERROR')}）`; } }); importButton.addEventListener('click', async () => { try { const value = JSON.parse(area.value) as { archive: unknown; sha256: string }; await repository.importConfig(value.archive as never, value.sha256); status.textContent = '恢复完成。'; } catch (error) { status.textContent = `恢复失败（${safeDiagnostic(error, 'LLM_REQUEST_INVALID')}）`; } }); body.append(exportButton, importButton, area, status);
    } else if (name === 'reset-confirm') {
        const confirmButton = ui.createButton({ label: '确认清空 LLM 配置', tone: 'danger' }); const status = document.createElement('p'); confirmButton.addEventListener('click', async () => { if (!await ui.confirm({ title: '清空全部 LLM 数据？', message: '资源、路由、额度、日志和密钥会被删除。', danger: true })) return; await repository.clearAll(); status.textContent = '已恢复酒馆零配置状态。'; }); body.append(document.createTextNode('此操作会删除 LLM 资源、路由、额度、日志和密钥。'), confirmButton, status);
    } else if (name === 'request-logs') {
        return renderRequestLogViewer(body, repository, { ui, notify, describeTask: services?.describeTask });
    } else if (name === 'diagnostics') {
        const output = document.createElement('pre'); body.append(output); try { const health = await repository.health(); output.textContent = JSON.stringify({ ...health, secretReady: health.secretReady === true ? '可用' : '不可用' }, null, 2); } catch (error) { output.textContent = `workspace 不可用（${safeDiagnostic(error, 'WORKSPACE_UNAVAILABLE')}）`; }
    } else if (name === 'budget-manager') {
        const settings = await repository.loadSettings(); const area = ui.createTextarea({ label: '额度 JSON', value: JSON.stringify((settings as Record<string, unknown>).budgets ?? {}, null, 2) }); area.style.minHeight = '15rem'; const save = ui.createButton({ label: '应用', tone: 'primary' }); const status = document.createElement('p'); save.addEventListener('click', async () => { try { const value = JSON.parse(area.value) as LLMHubSettings['budgets']; await repository.updateSettings((current) => ({ ...current, budgets: value })); status.textContent = '已应用，正在热加载。'; } catch (error) { status.textContent = `配置无效（${safeDiagnostic(error, 'LLM_REQUEST_INVALID')}）`; } }); body.append(area, save, status);
    } else if (name === 'route-preview') {
        const settings = await repository.loadSettings(); const output = document.createElement('pre'); output.textContent = JSON.stringify({ executionDefaults: settings.globalAssignments ?? {}, taskAssignments: settings.taskAssignments ?? [], routingPolicy: '仅按任务分配或 execution 默认资源解析；不跨类型回退' }, null, 2); body.append(output);
    } else if (name === 'queue-manager') {
        const output = document.createElement('p'); output.textContent = '队列由 LLM Runtime 实时管理；正在等待的任务会显示在请求日志中。'; body.append(output);
    } else {
        const settings = await repository.loadSettings(); const output = document.createElement('pre'); output.textContent = JSON.stringify(settings, null, 2); body.append(output);
    }
    return () => undefined;
}

export function registerLlmPopups(session: PluginSession, repository: LlmWorkspaceRepository, services: LlmServiceHandlers = {} as LlmServiceHandlers): () => void {
    const fetchImpl = createCoreBridgeFetch((request, options) => session.host.request.send(request, options));
    const cleanups = POPUP_NAMES.map((name) => session.registerPopup({ token: name === 'request-logs' ? LLM_REQUEST_LOGS_POPUP : name === 'generation-source' ? LLM_GENERATION_SOURCE_POPUP : { kind: 'popup', provider: 'ss-helper.llm', name, version: LLM_POPUP_VERSION }, title: 'SS-Helper LLM', ariaLabel: `LLM ${name}`, ...(name === 'request-logs' ? { presentation: 'workspace' as const, closeLabel: '关闭请求日志' } : {}), render: (container, _input, ui) => { let disposed = false; void renderPopup(container, name, repository, fetchImpl, ui, (notification) => session.ui.showToast(notification), services, () => session.ui.openPopup(LLM_RESOURCE_WIZARD_POPUP, {})).catch((error) => { if (!disposed) container.textContent = `加载失败（${safeDiagnostic(error, 'INTERNAL_ERROR')}）：${safePopupCause(error)}`; }); return () => { disposed = true; container.replaceChildren(); }; } }));
    cleanups.push(registerResourcePopups(session, repository, services));
    return () => cleanups.reverse().forEach((cleanup) => cleanup());
}

export async function startLlmPlugin(options: StartLlmPluginOptions): Promise<SessionBootstrap<'tavern.generation.read' | 'tavern.generation.execute' | 'tavern.chat.events' | 'tavern.plugin.request' | 'core.ui.notification.v0' | 'secrets.read' | 'secrets.write'>> {
    return bootstrapSSHelper({ id: 'ss-helper.llm', displayName: config.displayName, settingsDisplayName: 'AI调度中枢', pluginVersion: options.pluginVersion, capabilities: ['tavern.generation.read', 'tavern.generation.execute', 'tavern.chat.events', 'tavern.plugin.request', 'core.ui.notification.v0', 'secrets.read', 'secrets.write'] }, (session) => {
        traceLlmStartup('session:activate');
        const repository = new LlmWorkspaceRepository(session.workspace, session.secrets);
        const cleanups: Array<() => void> = [];
        try {
            const services = options.services ?? createProductionLlmServices(session, { repository });
            const statusMonitor = new LlmSettingsStatusMonitor(session, repository, services, (options.target ?? globalThis) as EventTarget & Record<PropertyKey, unknown>);
            void statusMonitor.start().catch((error) => reportBackgroundFailure(session, 'status monitor startup', error));
            cleanups.push(session.registerSettings(LLM_SETTINGS_SCHEMA, createWorkspaceLlmSettingsAdapter(repository, statusMonitor, (notification) => session.ui.showToast(notification))));
            cleanups.push(registerLlmChatIndicator(session, repository));
            cleanups.push(registerLlmPopups(session, repository, services));
            cleanups.push(session.registerExtensionMenuItem({
                id: 'request-logs',
                label: 'LLM 请求日志',
                icon: 'clipboard-list',
                order: 200,
                onActivate: () => session.ui.openPopup(LLM_REQUEST_LOGS_POPUP, {}),
            }));
            cleanups.push(exposeLlmServices(session, services));
            cleanups.push(() => statusMonitor.dispose());
            traceLlmStartup('session:contributions-registered');
        } catch (error) {
            reportBackgroundFailure(session, 'session activation', error);
            cleanups.reverse().forEach((cleanup) => cleanup());
            session.dispose();
            throw error;
        }
        void session.closed
            .then(() => cleanups.reverse().forEach((cleanup) => cleanup()))
            .catch((error) => logger.error('Session cleanup failed', { code: safeDiagnostic(error, 'INTERNAL_ERROR') }));
    }, { target: options.target });
}
