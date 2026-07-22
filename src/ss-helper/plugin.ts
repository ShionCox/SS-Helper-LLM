import { bootstrapSSHelper, type PluginSession, type PopupUiContext, type SessionBootstrap } from '@ss-helper/sdk';
import { logger } from '../runtime/logger';
import { createWorkspaceLlmSettingsAdapter, LLM_SETTINGS_SCHEMA } from './settings';
import { exposeLlmServices, type LlmServiceHandlers } from './services';
import { createProductionLlmServices, createProviderFromResource } from './llm-service-runtime';
import { LlmWorkspaceRepository } from '../storage/llm-workspace-repository';
import type { LLMCapability, ResourceConfig } from '../schema/types';
import { registerLlmChatIndicator } from './chat-indicator';
import config from '../../plugin.config.json' with { type: 'json' };
import { LlmSettingsStatusMonitor } from './settings-status';
import { renderRequestLogViewer } from '../ui/request-log-viewer';

const POPUP_NAMES = ['resource-wizard', 'resource-manager', 'rerank-test', 'route-manager', 'route-preview', 'advanced-routing', 'budget-manager', 'queue-manager', 'permission-manager', 'display-rules', 'diagnostics', 'request-logs', 'backup', 'reset-confirm'] as const;
type PopupName = typeof POPUP_NAMES[number];

async function providerFor(repository: LlmWorkspaceRepository, resource: ResourceConfig) {
    const apiKey = await repository.getResourceSecret(resource.id);
    if (!apiKey) throw new Error('这个资源缺少密钥');
    return createProviderFromResource(resource, apiKey);
}

export interface StartLlmPluginOptions {
    pluginVersion: string;
    services?: LlmServiceHandlers;
    target?: { addEventListener(type: string, listener: EventListener): void; removeEventListener(type: string, listener: EventListener): void };
}

function button(text: string): HTMLButtonElement { const value = document.createElement('button'); value.type = 'button'; value.textContent = text; value.className = 'stx-ui-btn'; return value; }
function field(label: string, type: string, value = ''): HTMLInputElement { const input = document.createElement('input'); input.type = type; input.value = value; input.className = 'text_pole'; input.setAttribute('aria-label', label); return input; }
function safeDiagnostic(error: unknown, fallback = 'OPERATION_FAILED'): string {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(code) ? code : fallback;
}

function safePopupCause(error: unknown): string {
    const raw = error && typeof error === 'object' && 'message' in error ? String((error as { message?: unknown }).message ?? '') : String(error ?? '');
    const normalized = raw.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim();
    return normalized ? normalized.slice(0, 180) : '未能取得具体原因';
}

function reportBackgroundFailure(session: PluginSession, stage: string, error: unknown): void {
    const code = safeDiagnostic(error, 'LLM_BACKGROUND_FAILED');
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

async function renderPopup(container: HTMLElement, name: PopupName, repository: LlmWorkspaceRepository, ui?: PopupUiContext, notify?: (notification: { level: 'info' | 'success' | 'warning' | 'error'; title: string; message: string; code: string }) => void): Promise<() => void> {
    const title = document.createElement('h3'); title.textContent = ({ 'resource-wizard': '添加资源', 'resource-manager': '资源管理', 'rerank-test': 'Rerank 测试', 'route-manager': '路由分配', 'route-preview': '路由预览', 'advanced-routing': '高级规则', 'budget-manager': '额度与熔断', 'queue-manager': '请求队列', 'permission-manager': '后台权限', 'display-rules': '展示规则', diagnostics: '服务检查', 'request-logs': '请求日志', backup: '配置导入导出', 'reset-confirm': '全局重置' } as Record<PopupName, string>)[name];
    const body = document.createElement('div'); body.className = `ss-helper-llm-popup-body${name === 'request-logs' ? ' ss-helper-llm-popup-body--workspace' : ''}`;
    if (name === 'request-logs') container.append(body);
    else container.append(title, body);
    if (name === 'resource-wizard') {
        const type = document.createElement('select'); type.className = 'text_pole'; type.setAttribute('aria-label', '资源用途'); ['generation', 'embedding', 'rerank'].forEach((value) => { const option = document.createElement('option'); option.value = value; option.textContent = value === 'generation' ? '生成' : value === 'embedding' ? '向量化' : '重排序'; type.append(option); });
        const api = document.createElement('select'); api.className = 'text_pole'; api.setAttribute('aria-label', '服务模板'); ['auto', 'openai', 'deepseek', 'claude', 'gemini', 'generic'].forEach((value) => { const option = document.createElement('option'); option.value = value; option.textContent = value === 'auto' ? '自动识别' : value; api.append(option); });
        const label = field('资源名称', 'text'); const baseUrl = field('Base URL', 'url'); const model = field('默认模型', 'text'); const key = field('API Key', 'password');
        const save = button('测试并保存'); const status = document.createElement('p');
        save.addEventListener('click', async () => { try { const id = `resource-${Date.now().toString(36)}`; const settings = await repository.loadSettings(); const capabilities: LLMCapability[] = type.value === 'rerank' ? ['rerank'] : type.value === 'embedding' ? ['embeddings'] : ['chat', 'json']; const resource: ResourceConfig = { id, type: type.value as ResourceConfig['type'], source: 'custom', apiType: api.value as ResourceConfig['apiType'], label: label.value.trim() || id, baseUrl: baseUrl.value.trim(), model: model.value.trim(), enabled: false, capabilities };
            await repository.saveSettings({ ...settings, resources: [...(settings.resources ?? []), resource] }); if (key.value) { await repository.setResourceSecret(id, key.value, { label: resource.label }); key.value = ''; } status.textContent = '配置已保存；连接测试通过后可启用。'; } catch (error) { status.textContent = `保存失败（${safeDiagnostic(error, 'LLM_SETTINGS_SAVE_FAILED')}）`; } });
        body.append(document.createTextNode('步骤 1：选择用途'), type, document.createTextNode('步骤 2：选择模板'), api, label, baseUrl, key, model, save, status);
    } else if (name === 'resource-manager') {
        const search = field('搜索资源', 'search'); const usage = document.createElement('select'); usage.className = 'text_pole'; usage.setAttribute('aria-label', '按用途筛选'); for (const value of ['all', 'generation', 'embedding', 'rerank']) { const option = document.createElement('option'); option.value = value; option.textContent = value === 'all' ? '全部用途' : value === 'generation' ? '生成' : value === 'embedding' ? '向量化' : '重排序'; usage.append(option); } const list = document.createElement('div'); const refresh = button('刷新'); const status = document.createElement('p');
        const load = async (): Promise<void> => { list.replaceChildren(); const settings = await repository.loadSettings(); const query = search.value.trim().toLowerCase(); for (const resource of settings.resources ?? []) { if (usage.value !== 'all' && resource.type !== usage.value) continue; if (query && !`${resource.id} ${resource.label} ${resource.type} ${resource.apiType ?? ''}`.toLowerCase().includes(query)) continue; const row = document.createElement('div'); row.className = 'stx-settings-row'; const labelText = document.createElement('span'); labelText.textContent = `${resource.label} · ${resource.type} · ${resource.enabled === false ? '停用' : '启用'}`; const toggle = button(resource.enabled === false ? '启用' : '停用'); const edit = button('编辑'); const secret = button('替换密钥'); const copy = button('复制'); const test = button('测试连接'); const models = button('获取模型'); const remove = button('删除');
            toggle.addEventListener('click', async () => { const latest = await repository.loadSettings(); await repository.saveSettings({ ...latest, resources: latest.resources?.map((item) => item.id === resource.id ? { ...item, enabled: item.enabled === false } : item) ?? [] }); await load(); });
            edit.addEventListener('click', async () => { const latest = await repository.loadSettings(); const label = typeof window !== 'undefined' ? window.prompt('资源名称', resource.label) : resource.label; if (!label) return; const baseUrl = typeof window !== 'undefined' ? window.prompt('Base URL', resource.baseUrl ?? '') : resource.baseUrl; const model = typeof window !== 'undefined' ? window.prompt('默认模型', resource.model ?? '') : resource.model; await repository.saveSettings({ ...latest, resources: latest.resources?.map((item) => item.id === resource.id ? { ...item, label, baseUrl: baseUrl?.trim(), model: model?.trim() } : item) ?? [] }); await load(); });
            secret.addEventListener('click', async () => { const value = typeof window !== 'undefined' ? window.prompt('API Key（留空则删除）', '') : ''; if (value === null) return; if (value.trim()) await repository.setResourceSecret(resource.id, value.trim(), { label: resource.label }); else await repository.deleteResourceSecret(resource.id); status.textContent = value.trim() ? '密钥已保存。' : '密钥已删除，资源已停用。'; if (!value.trim()) { const latest = await repository.loadSettings(); await repository.saveSettings({ ...latest, resources: latest.resources?.map((item) => item.id === resource.id ? { ...item, enabled: false } : item) ?? [] }); } await load(); });
            copy.addEventListener('click', async () => { const latest = await repository.loadSettings(); const id = `resource-${Date.now().toString(36)}`; const clone = { ...resource, id, label: `${resource.label}（副本）`, enabled: false }; await repository.saveSettings({ ...latest, resources: [...(latest.resources ?? []), clone] }); status.textContent = '资源已复制；为安全起见密钥不会复制，请为副本单独填写。'; await load(); });
            test.addEventListener('click', async () => { try { const provider = await providerFor(repository, resource); const result = await provider.testConnection?.() ?? { ok: false, message: 'Provider 不支持连接测试' }; status.textContent = result.ok ? `${resource.label}：连接成功` : `${resource.label}：请求失败（LLM_PROVIDER_TEST_FAILED）`; provider.dispose?.(); if (result.ok) { const latest = await repository.loadSettings(); await repository.saveSettings({ ...latest, resources: latest.resources?.map((item) => item.id === resource.id ? { ...item, enabled: true } : item) ?? [] }); } await load(); } catch (error) { status.textContent = `测试失败（${safeDiagnostic(error, 'LLM_PROVIDER_TEST_FAILED')}）`; } });
            models.addEventListener('click', async () => { try { const provider = await providerFor(repository, resource); const result = await provider.listModels?.() ?? { ok: false, models: [], message: 'Provider 不支持模型发现' }; status.textContent = result.ok ? `${resource.label}：${result.models.length} 个模型` : `${resource.label}：请求失败（LLM_PROVIDER_MODELS_FAILED）`; provider.dispose?.(); } catch (error) { status.textContent = `获取失败（${safeDiagnostic(error, 'LLM_PROVIDER_MODELS_FAILED')}）`; } });
            remove.addEventListener('click', async () => { await repository.deleteResource(resource.id); await load(); });
            row.append(labelText, toggle, edit, secret, copy, test, models, remove); list.append(row); } if (!(settings.resources ?? []).length) status.textContent = settings.generationSource === 'custom' ? '自定义 API 模式尚未添加资源。' : '当前使用酒馆模型。添加资源后可以使用其他服务。'; };
        search.addEventListener('input', () => { void load(); }); usage.addEventListener('change', () => { void load(); }); refresh.addEventListener('click', () => { void load(); }); body.append(search, usage, refresh, list, status); void load();
    } else if (name === 'rerank-test') {
        const query = field('Query', 'text'); const docs = document.createElement('textarea'); docs.className = 'text_pole'; docs.placeholder = '每行一个候选文档'; const topK = field('Top K', 'number', '3'); const resource = document.createElement('select'); resource.className = 'text_pole'; resource.setAttribute('aria-label', 'Rerank 资源'); const settings = await repository.loadSettings(); for (const item of settings.resources ?? []) if (item.type === 'rerank') { const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; resource.append(option); } const run = button('运行测试'); const result = document.createElement('pre'); run.addEventListener('click', async () => { try { const item = (await repository.loadSettings()).resources?.find((candidate) => candidate.id === resource.value); if (!item) throw new Error('还没有重排序资源，添加后才能使用模型排序。'); const provider = await providerFor(repository, item); const response = await provider.rerank?.({ query: query.value, docs: docs.value.split(/\r?\n/).filter(Boolean), topK: Number(topK.value) || 3, model: item.model }); provider.dispose?.(); if (!response) throw new Error('Provider 不支持重排序'); result.textContent = JSON.stringify(response.results ?? [], null, 2); } catch (error) { result.textContent = `测试失败（${safeDiagnostic(error, 'LLM_RERANK_TEST_FAILED')}）`; } }); body.append(query, docs, topK, resource, run, result);
    } else if (name === 'advanced-routing') {
        const area = document.createElement('textarea'); area.className = 'text_pole'; area.style.minHeight = '20rem'; const settings = await repository.loadSettings(); area.value = JSON.stringify(settings, null, 2); const save = button('校验并应用'); const status = document.createElement('p'); save.addEventListener('click', async () => { try { const parsed = JSON.parse(area.value) as Record<string, unknown>; await repository.saveSettings(parsed); status.textContent = '已校验并应用。'; } catch (error) { status.textContent = `JSON 无效（${safeDiagnostic(error, 'PAYLOAD_INVALID')}）`; } }); body.append(area, save, status);
    } else if (name === 'backup') {
        const exportButton = button('导出配置'); const importButton = button('导入配置'); const area = document.createElement('textarea'); area.className = 'text_pole'; area.placeholder = '粘贴备份 JSON'; const status = document.createElement('p'); exportButton.addEventListener('click', async () => { try { const value = await repository.exportConfig(); area.value = JSON.stringify(value); status.textContent = '已生成备份（不包含密钥）。'; } catch (error) { status.textContent = `导出失败（${safeDiagnostic(error, 'LLM_EXPORT_FAILED')}）`; } }); importButton.addEventListener('click', async () => { try { const value = JSON.parse(area.value) as { archive: unknown; sha256: string }; await repository.importConfig(value.archive as never, value.sha256); status.textContent = '恢复完成。'; } catch (error) { status.textContent = `恢复失败（${safeDiagnostic(error, 'BACKUP_INVALID')}）`; } }); body.append(exportButton, importButton, area, status);
    } else if (name === 'reset-confirm') {
        const confirmButton = button('确认清空 LLM 配置'); confirmButton.className += ' danger'; const status = document.createElement('p'); confirmButton.addEventListener('click', async () => { await repository.clearAll(); status.textContent = '已恢复酒馆零配置状态。'; }); body.append(document.createTextNode('此操作会删除 LLM 资源、路由、额度、日志和密钥。'), confirmButton, status);
    } else if (name === 'request-logs') {
        return renderRequestLogViewer(body, repository, { ui, notify });
    } else if (name === 'diagnostics') {
        const output = document.createElement('pre'); body.append(output); try { const health = await repository.health(); output.textContent = JSON.stringify({ ...health, secretReady: health.secretReady === true ? '可用' : '不可用' }, null, 2); } catch (error) { output.textContent = `workspace 不可用（${safeDiagnostic(error, 'WORKSPACE_UNAVAILABLE')}）`; }
    } else if (name === 'route-manager' || name === 'budget-manager' || name === 'permission-manager' || name === 'display-rules') {
        const settings = await repository.loadSettings(); const area = document.createElement('textarea'); area.className = 'text_pole'; area.style.minHeight = '15rem'; const key = name === 'route-manager' ? 'globalAssignments' : name === 'budget-manager' ? 'budgets' : name === 'permission-manager' ? 'silentPermissions' : 'resultDisplay'; area.value = JSON.stringify((settings as Record<string, unknown>)[key] ?? (name === 'display-rules' ? 'auto' : {}), null, 2); const save = button('应用'); const status = document.createElement('p'); save.addEventListener('click', async () => { try { const value = JSON.parse(area.value) as unknown; await repository.saveSettings({ ...(await repository.loadSettings()), [key]: value }); status.textContent = '已应用，正在热加载。'; } catch (error) { status.textContent = `配置无效（${safeDiagnostic(error, 'PAYLOAD_INVALID')}）`; } }); if (name === 'route-manager') { const note = document.createElement('p'); note.textContent = '模型来源是全局强制策略；生成路由仅在“自定义 API”模式下决定具体资源，向量化和重排序始终使用自定义资源。'; body.append(note); } body.append(area, save, status);
    } else if (name === 'route-preview') {
        const settings = await repository.loadSettings(); const output = document.createElement('pre'); output.textContent = JSON.stringify({ generationSource: settings.generationSource ?? 'tavern', sourcePolicy: settings.generationSource === 'custom' ? '仅允许自定义 API；禁止回退酒馆' : '仅允许酒馆当前模型；禁止回退自定义 API', customPriority: ['调用指定', '任务分配', '任务推荐', '插件分配', '全局分配', '同类型 fallback', '能力 fallback'], globalAssignments: settings.globalAssignments ?? {}, pluginAssignments: settings.pluginAssignments ?? [], taskAssignments: settings.taskAssignments ?? [] }, null, 2); body.append(output);
    } else if (name === 'queue-manager') {
        const output = document.createElement('p'); output.textContent = '队列由 LLM Runtime 实时管理；正在等待的任务会显示在请求日志中。'; body.append(output);
    } else {
        const settings = await repository.loadSettings(); const output = document.createElement('pre'); output.textContent = JSON.stringify(settings, null, 2); body.append(output);
    }
    return () => undefined;
}

export function registerLlmPopups(session: PluginSession, repository: LlmWorkspaceRepository): () => void {
    const cleanups = POPUP_NAMES.map((name) => session.registerPopup({ token: { kind: 'popup', provider: 'ss-helper.llm', name, version: 0 }, title: 'SS-Helper LLM', ariaLabel: `LLM ${name}`, ...(name === 'request-logs' ? { presentation: 'workspace' as const, closeLabel: '关闭请求日志' } : {}), render: (container, _input, ui) => { let disposed = false; void renderPopup(container, name, repository, ui, (notification) => session.ui.showToast(notification)).catch((error) => { if (!disposed) container.textContent = `加载失败（${safeDiagnostic(error, 'POPUP_LOAD_FAILED')}）：${safePopupCause(error)}`; }); return () => { disposed = true; container.replaceChildren(); }; } }));
    return () => cleanups.reverse().forEach((cleanup) => cleanup());
}

export async function startLlmPlugin(options: StartLlmPluginOptions): Promise<SessionBootstrap<'tavern.generation.read' | 'tavern.generation.execute' | 'tavern.chat.events' | 'core.ui.notification.v0' | 'secrets.read' | 'secrets.write'>> {
    return bootstrapSSHelper({ id: 'ss-helper.llm', displayName: config.displayName, settingsDisplayName: 'AI调度中枢', pluginVersion: options.pluginVersion, capabilities: ['tavern.generation.read', 'tavern.generation.execute', 'tavern.chat.events', 'core.ui.notification.v0', 'secrets.read', 'secrets.write'] }, (session) => {
        const repository = new LlmWorkspaceRepository(session.workspace, session.secrets);
        const cleanups: Array<() => void> = [];
        try {
            const services = options.services ?? createProductionLlmServices(session, { repository });
            const statusMonitor = new LlmSettingsStatusMonitor(session, repository, services, (options.target ?? globalThis) as EventTarget & Record<PropertyKey, unknown>);
            void statusMonitor.start().catch((error) => reportBackgroundFailure(session, 'status monitor startup', error));
            cleanups.push(session.registerSettings(LLM_SETTINGS_SCHEMA, createWorkspaceLlmSettingsAdapter(repository, statusMonitor, (notification) => session.ui.showToast(notification))));
            cleanups.push(registerLlmChatIndicator(session, repository));
            cleanups.push(registerLlmPopups(session, repository));
            cleanups.push(exposeLlmServices(session, services));
            cleanups.push(() => statusMonitor.dispose());
        } catch (error) {
            reportBackgroundFailure(session, 'session activation', error);
            cleanups.reverse().forEach((cleanup) => cleanup());
            session.dispose();
            throw error;
        }
        void session.closed
            .then(() => cleanups.reverse().forEach((cleanup) => cleanup()))
            .catch((error) => logger.error('Session cleanup failed', { code: safeDiagnostic(error, 'LLM_SESSION_CLEANUP_FAILED') }));
    }, { target: options.target });
}
