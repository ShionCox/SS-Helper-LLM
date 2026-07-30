import {
    describeSSHelperFailure,
    isSSHelperReasonCode,
    type PopupUiContext,
    type ToastLevel,
} from '@ss-helper/sdk';
import { JSONEditor, Mode, type Content } from 'svelte-jsoneditor/index.js';
import { mount, unmount } from 'svelte';
import type { LlmWorkspaceRepository } from '../storage/llm-workspace-repository';
import {
    STATUS_LABEL,
    asRecord,
    clampLogListWidth,
    presentDiagnostic,
    presentLogRow,
    text,
    type LogRow,
} from './request-log-presentation';

type DetailTab = 'overview' | 'input' | 'raw' | 'parsed' | 'route' | 'errors';

function formatDate(value: unknown): string {
    const time = Number(value);
    if (!Number.isFinite(time) || time <= 0) return '时间未知';
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(time));
}

function formatBytes(value: number): string {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function control<T extends HTMLElement>(element: T, kind: string, tone?: string): T {
    element.setAttribute('data-ss-helper-control', kind);
    if (tone) element.setAttribute('data-ss-helper-tone', tone);
    return element;
}

function button(label: string, action: string, tone = 'neutral'): HTMLButtonElement {
    const value = control(document.createElement('button'), 'button', tone);
    value.type = 'button'; value.textContent = label; value.dataset.logAction = action;
    return value;
}

function stat(label: string, value: string, hint = ''): HTMLElement {
    const item = document.createElement('div'); item.className = 'ss-helper-llm-log-stat';
    const labelNode = document.createElement('span'); labelNode.className = 'ss-helper-llm-log-stat-label'; labelNode.textContent = label;
    const valueNode = document.createElement('strong'); valueNode.className = 'ss-helper-llm-log-stat-value'; valueNode.textContent = value;
    item.append(labelNode, valueNode);
    if (hint) { const hintNode = document.createElement('small'); hintNode.textContent = hint; item.append(hintNode); }
    return item;
}

function badge(value: string, tone: string): HTMLElement {
    const node = control(document.createElement('span'), 'status', tone); node.className = 'ss-helper-llm-log-badge'; node.textContent = value; return node;
}

function field(label: string, kind: 'input' | 'select', filter: string, placeholder = ''): HTMLElement {
    const wrap = document.createElement('label'); wrap.className = 'ss-helper-llm-log-filter';
    const title = document.createElement('span'); title.textContent = label; wrap.append(title);
    const input = kind === 'select' ? document.createElement('select') : document.createElement('input');
    control(input, kind); input.setAttribute('aria-label', label); input.dataset.logFilter = filter;
    if (kind === 'input') {
        const textInput = input as HTMLInputElement;
        textInput.type = filter === 'search' ? 'search' : 'text';
        textInput.placeholder = placeholder || label;
    }
    wrap.append(input); return wrap;
}

function editorContent(value: unknown, empty: string): { readonly content: Content; readonly mode: Mode } {
    const normalized = value === undefined || value === null || value === '' ? empty : value;
    if (typeof normalized !== 'string') return { content: { json: normalized }, mode: Mode.tree };
    try {
        return { content: { json: JSON.parse(normalized) }, mode: Mode.tree };
    } catch {
        return { content: { text: normalized }, mode: Mode.text };
    }
}

function jsonEditorBlock(value: unknown, registerCleanup: (cleanup: () => void) => void, empty = '暂无记录'): HTMLElement {
    const host = document.createElement('div');
    host.className = 'ss-helper-llm-json-editor jse-theme-dark';
    const normalized = editorContent(value, empty);
    const editor = mount(JSONEditor, {
        target: host,
        props: {
            content: normalized.content,
            mode: normalized.mode,
            readOnly: true,
            ariaLabel: 'JSON 日志内容',
            mainMenuBar: true,
            navigationBar: false,
            statusBar: true,
        },
    });
    registerCleanup(() => { void unmount(editor); });
    return host;
}


function errorSummary(row: LogRow): string {
    const response = asRecord(row.response);
    const code = asRecord(response.failure).reasonCode;
    if (!isSSHelperReasonCode(code)) return '请求已完成';
    return describeSSHelperFailure(response.failure).title;
}

function renderSelectOptions(select: HTMLSelectElement, options: readonly [string, string][]): void {
    select.replaceChildren(...options.map(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; return option; }));
}

function metadataGrid(row: LogRow): HTMLElement {
    const grid = document.createElement('dl'); grid.className = 'ss-helper-llm-log-metadata';
    const view = presentLogRow(row);
    const request = asRecord(row.request);
    const structuredOutput = asRecord(request.structuredOutput);
    const values: readonly (readonly [string, unknown])[] = [
        ['日志 ID', row.logId], ['根请求 ID', row.requestId], ['Attempt ID', row.attemptId], ['任务', `${view.taskLabel} · ${view.taskKey}`],
        ['插件', row.sourcePluginId], ['状态', STATUS_LABEL[view.state] ?? view.state], ['尝试', view.attempt],
        ['结构化传输', [row.plannedTransport, row.actualTransport].filter(Boolean).join(' → ') || '未记录'],
        ['来源', view.source], ['模型', view.model || '模型未知'], ['耗时', view.latencyMs === undefined ? '未记录' : `${view.latencyMs} ms`], ['时间', formatDate(view.createdAt)],
        ...(Object.keys(structuredOutput).length === 0 ? [] : [
            ['结构化传输', structuredOutput.transport],
            ['上下文', structuredOutput.contextMode === 'isolated' ? '隔离生成' : '聊天上下文'],
            ['原生 JSON', structuredOutput.nativeJsonMode === true ? '已启用' : '未启用'],
            ['原生 Schema', structuredOutput.nativeSchemaSent === true ? '已发送' : '未发送'],
        ] as const),
    ];
    for (const [label, value] of values) { const dt = document.createElement('dt'); dt.textContent = label; const dd = document.createElement('dd'); dd.textContent = text(value); grid.append(dt, dd); }
    return grid;
}

function detailValue(row: LogRow, tab: DetailTab): unknown {
    const request = asRecord(row.request);
    const response = asRecord(row.response);
    if (tab === 'overview') {
        const view = presentLogRow(row);
        return {
            logId: row.logId,
            requestId: row.requestId,
            attemptId: row.attemptId,
            task: `${view.taskLabel} · ${view.taskKey}`,
            state: STATUS_LABEL[view.state] ?? view.state,
            attempt: view.attempt,
            source: view.source,
            model: view.model || '模型未知',
            latencyMs: view.latencyMs,
            createdAt: view.createdAt,
            contentMode: row.contentMode,
            redactions: row.redactions,
        };
    }
    if (tab === 'input') {
        return {
            input: request.generationInput ?? request.embeddingTexts ?? { rerankQuery: request.rerankQuery, rerankDocs: request.rerankDocs },
            schema: request.schema,
            schemaSummary: request.schemaSummary,
            budget: request.budget,
            resolvedMaxTokens: request.resolvedMaxTokens,
            structuredOutput: request.structuredOutput,
        };
    }
    if (tab === 'raw') return response.rawResponseText ?? response.providerResponse;
    if (tab === 'parsed') return response.normalizedResponse ?? response.parsedResponse;
    if (tab === 'route') return { routeHint: request.routeHint, providerRequest: request.providerRequest, meta: response.meta };
    return {
        failure: response.failure,
        validationErrors: response.validationErrors,
        truncated: row.truncated,
        redactions: row.redactions,
    };
}

function detailContent(row: LogRow, tab: DetailTab, registerCleanup: (cleanup: () => void) => void): HTMLElement {
    const request = asRecord(row.request);
    const response = asRecord(row.response);
    if (tab === 'overview') {
        const section = document.createElement('div'); section.className = 'ss-helper-llm-log-detail-section';
        section.append(metadataGrid(row));
        const notice = document.createElement('div'); notice.className = 'ss-helper-llm-log-notice';
        notice.append(badge(text(row.contentMode) === 'full' ? '完整正文已保存' : '仅保存摘要', text(row.contentMode) === 'full' ? 'success' : 'warning'));
        if (Array.isArray(row.redactions) && row.redactions.length) { const note = document.createElement('span'); note.textContent = `已脱敏 ${row.redactions.length} 个敏感字段`; notice.append(note); }
        section.append(notice); return section;
    }
    if (tab === 'input') {
        const section = document.createElement('div'); section.className = 'ss-helper-llm-log-detail-section';
        section.append(jsonEditorBlock(request.generationInput ?? request.embeddingTexts ?? { rerankQuery: request.rerankQuery, rerankDocs: request.rerankDocs }, registerCleanup));
        const schema = document.createElement('details'); schema.open = false; const summary = document.createElement('summary'); summary.textContent = 'Schema 与生成参数'; schema.append(summary, jsonEditorBlock({ schema: request.schema, schemaSummary: request.schemaSummary, budget: request.budget, resolvedMaxTokens: request.resolvedMaxTokens, structuredOutput: request.structuredOutput }, registerCleanup)); section.append(schema); return section;
    }
    if (tab === 'raw') return jsonEditorBlock(response.rawResponseText ?? response.providerResponse, registerCleanup);
    if (tab === 'parsed') return jsonEditorBlock(response.normalizedResponse ?? response.parsedResponse, registerCleanup);
    if (tab === 'route') return jsonEditorBlock({ routeHint: request.routeHint, providerRequest: request.providerRequest, meta: response.meta }, registerCleanup);
    const section = document.createElement('div'); section.className = 'ss-helper-llm-log-detail-section';
    const diagnostic = presentDiagnostic(response.failure);
    if (diagnostic.code || diagnostic.message) {
        const heading = document.createElement('div'); heading.className = 'ss-helper-llm-log-error-heading';
        if (diagnostic.code) heading.append(badge(diagnostic.code, 'error'));
        if (diagnostic.message) { const message = document.createElement('p'); message.textContent = diagnostic.message; heading.append(message); }
        section.append(heading);
    }
    const diagnostics = Object.fromEntries(Object.entries({ validationErrors: response.validationErrors, truncated: row.truncated, redactions: row.redactions }).filter(([, value]) => value !== undefined && value !== null && value !== false && (!Array.isArray(value) || value.length > 0)));
    if (Object.keys(diagnostics).length) section.append(jsonEditorBlock(diagnostics, registerCleanup));
    return section;
}

export interface RequestLogViewerOptions {
    readonly ui?: PopupUiContext;
    readonly notify?: (notification: { level: ToastLevel; title: string; message: string; code: string }) => void;
}

export async function renderRequestLogViewer(container: HTMLElement, repository: LlmWorkspaceRepository, options: RequestLogViewerOptions = {}): Promise<() => void> {
    const root = document.createElement('section'); root.className = 'ss-helper-llm-log-viewer'; root.setAttribute('aria-label', 'LLM 请求日志查看器');
    const filters = document.createElement('div'); filters.className = 'ss-helper-llm-log-filters';
    const primaryFilters = document.createElement('div'); primaryFilters.className = 'ss-helper-llm-log-filter-primary';
    primaryFilters.append(field('搜索日志', 'input', 'search', '请求 ID、任务或错误'), field('状态', 'select', 'state'), field('任务', 'select', 'taskKind'), field('时间', 'select', 'time'));
    const advancedFilters = document.createElement('div'); advancedFilters.className = 'ss-helper-llm-log-filter-advanced'; advancedFilters.id = `ss-helper-llm-log-more-${Math.random().toString(36).slice(2)}`; advancedFilters.hidden = true;
    advancedFilters.append(field('来源/资源', 'input', 'resource', '来源或资源 ID'), field('插件', 'input', 'plugin', '插件 ID'), field('模型', 'input', 'model', '模型名称'), field('错误码', 'input', 'reasonCode', '例如 INVALID_JSON'));
    const actions = document.createElement('div'); actions.className = 'ss-helper-llm-log-actions';
    const more = button('更多筛选', 'advanced'); more.setAttribute('aria-expanded', 'false'); more.setAttribute('aria-controls', advancedFilters.id);
    actions.append(more, button('刷新', 'refresh'), button('导出结果', 'export', 'primary'), button('清空', 'clear', 'danger'));
    filters.append(primaryFilters, actions, advancedFilters);
    const state = filters.querySelector<HTMLSelectElement>('[data-log-filter="state"]')!; renderSelectOptions(state, [['all', '全部状态'], ['completed', '已完成'], ['failed', '失败'], ['cancelled', '已取消'], ['queued', '排队中'], ['running', '运行中']]);
    const task = filters.querySelector<HTMLSelectElement>('[data-log-filter="taskKind"]')!; renderSelectOptions(task, [['all', '全部任务'], ['generation', '生成'], ['embedding', '向量化'], ['rerank', '重排序']]);
    const time = filters.querySelector<HTMLSelectElement>('[data-log-filter="time"]')!; renderSelectOptions(time, [['all', '全部时间'], ['day', '最近 24 小时'], ['week', '最近 7 天'], ['month', '最近 30 天']]);
    const stats = document.createElement('div'); stats.className = 'ss-helper-llm-log-stats';
    const layout = document.createElement('div'); layout.className = 'ss-helper-llm-log-layout';
    const listPane = document.createElement('div'); listPane.className = 'ss-helper-llm-log-list-pane';
    const listHeader = document.createElement('div'); listHeader.className = 'ss-helper-llm-log-list-header'; const listTitle = document.createElement('strong'); listTitle.textContent = '请求记录'; const listCount = document.createElement('span'); listHeader.append(listTitle, listCount); const list = document.createElement('div'); list.className = 'ss-helper-llm-log-list'; listPane.append(listHeader, list);
    const detailPane = document.createElement('article'); detailPane.className = 'ss-helper-llm-log-detail-pane';
    const splitter = document.createElement('div'); splitter.className = 'ss-helper-llm-log-splitter'; splitter.tabIndex = 0; splitter.setAttribute('role', 'separator'); splitter.setAttribute('aria-label', '调整请求列表宽度'); splitter.setAttribute('aria-orientation', 'vertical'); splitter.setAttribute('aria-valuemin', '20'); splitter.setAttribute('aria-valuemax', '60'); splitter.setAttribute('aria-valuenow', '32'); splitter.setAttribute('aria-valuetext', '请求列表宽度 32%');
    root.append(filters, stats, layout); layout.append(listPane, splitter, detailPane); container.replaceChildren(root);
    const controller = new AbortController();
    more.addEventListener('click', () => {
        advancedFilters.hidden = !advancedFilters.hidden;
        more.setAttribute('aria-expanded', String(!advancedFilters.hidden));
        more.textContent = advancedFilters.hidden ? '更多筛选' : '收起筛选';
        options.ui?.refreshControls(advancedFilters);
    }, { signal: controller.signal });
    const setListWidth = (requestedWidth: number): void => {
        const bounds = layout.getBoundingClientRect();
        const width = clampLogListWidth(bounds.width, requestedWidth);
        const percentage = bounds.width > 0 ? Math.round((width / bounds.width) * 100) : 32;
        layout.style.setProperty('--ss-helper-llm-log-list-width', `${width}px`);
        splitter.setAttribute('aria-valuenow', String(percentage));
        splitter.setAttribute('aria-valuetext', `请求列表宽度 ${percentage}%`);
    };
    let resizing = false;
    const stopResizing = (event?: PointerEvent): void => {
        resizing = false;
        layout.classList.remove('is-resizing');
        if (event !== undefined && splitter.hasPointerCapture?.(event.pointerId)) splitter.releasePointerCapture?.(event.pointerId);
    };
    splitter.addEventListener('pointerdown', (event) => {
        resizing = true;
        layout.classList.add('is-resizing');
        splitter.setPointerCapture?.(event.pointerId);
        setListWidth(event.clientX - layout.getBoundingClientRect().left);
        event.preventDefault();
    }, { signal: controller.signal });
    splitter.addEventListener('pointermove', (event) => { if (resizing) setListWidth(event.clientX - layout.getBoundingClientRect().left); }, { signal: controller.signal });
    splitter.addEventListener('pointerup', (event) => stopResizing(event), { signal: controller.signal });
    splitter.addEventListener('pointercancel', (event) => stopResizing(event), { signal: controller.signal });
    splitter.addEventListener('dblclick', () => setListWidth(layout.getBoundingClientRect().width * .32), { signal: controller.signal });
    splitter.addEventListener('keydown', (event) => {
        const bounds = layout.getBoundingClientRect();
        const currentWidth = listPane.getBoundingClientRect().width;
        const nextWidth = event.key === 'ArrowLeft' ? currentWidth - 24 : event.key === 'ArrowRight' ? currentWidth + 24 : event.key === 'Home' ? bounds.width * .24 : event.key === 'End' ? bounds.width * .56 : event.key === 'Enter' || event.key === ' ' ? bounds.width * .32 : undefined;
        if (nextWidth === undefined) return;
        setListWidth(nextWidth);
        event.preventDefault();
    }, { signal: controller.signal });
    let entries: LogRow[] = []; let selectedId = ''; let activeTab: DetailTab = 'overview'; let filterTimer: number | undefined;
    let editorCleanups: Array<() => void> = [];
    const disposeEditors = (): void => {
        for (const cleanup of editorCleanups.splice(0)) cleanup();
    };

    const notify = (level: ToastLevel, title: string, message: string, code: string): void => { options.notify?.({ level, title, message, code }); };
    const query = (): Record<string, string | undefined> => ({
        search: root.querySelector<HTMLInputElement>('[data-log-filter="search"]')?.value.trim() || undefined,
        state: root.querySelector<HTMLSelectElement>('[data-log-filter="state"]')?.value || 'all',
        taskKind: root.querySelector<HTMLSelectElement>('[data-log-filter="taskKind"]')?.value || 'all',
        resourceId: root.querySelector<HTMLInputElement>('[data-log-filter="resource"]')?.value.trim() || undefined,
        sourcePluginId: root.querySelector<HTMLInputElement>('[data-log-filter="plugin"]')?.value.trim() || undefined,
        model: root.querySelector<HTMLInputElement>('[data-log-filter="model"]')?.value.trim() || undefined,
        reasonCode: root.querySelector<HTMLInputElement>('[data-log-filter="reasonCode"]')?.value.trim() || undefined,
        time: root.querySelector<HTMLSelectElement>('[data-log-filter="time"]')?.value || 'all',
    });
    const renderStats = (snapshot: { count: number; failed: number; bytes: number; policy: { maxEntries: number; retentionDays: number; maxBytes: number } }): void => {
        stats.replaceChildren(stat('日志总数', String(snapshot.count), `最多 ${snapshot.policy.maxEntries} 条`), stat('失败请求', String(snapshot.failed)), stat('当前占用', formatBytes(snapshot.bytes), `上限 ${formatBytes(snapshot.policy.maxBytes)}`), stat('自动保留', `${snapshot.policy.retentionDays} 天`));
    };
    const renderList = (): void => {
        list.replaceChildren(); listCount.textContent = `${entries.length} 条`;
        if (!entries.length) { const empty = document.createElement('div'); empty.className = 'ss-helper-llm-log-empty'; empty.textContent = '没有符合条件的请求日志'; list.append(empty); return; }
        for (const row of entries) {
            const view = presentLogRow(row);
            const item = button('', 'select', 'neutral'); item.className = `ss-helper-llm-log-item${text(row.logId) === selectedId ? ' is-selected' : ''}`; item.dataset.logId = text(row.logId);
            item.setAttribute('aria-label', `${view.taskLabel} ${view.taskKey}，${STATUS_LABEL[view.state] ?? view.state}，${formatDate(view.createdAt)}`);
            const top = document.createElement('div'); top.className = 'ss-helper-llm-log-item-top';
            const titleGroup = document.createElement('span'); titleGroup.className = 'ss-helper-llm-log-item-title';
            const statusIcon = document.createElement('span'); statusIcon.className = 'ss-helper-llm-log-item-status'; statusIcon.dataset.state = view.state; statusIcon.setAttribute('aria-hidden', 'true');
            const title = document.createElement('strong'); title.textContent = `${view.taskLabel} · ${view.taskKey}`; titleGroup.append(statusIcon, title);
            const time = document.createElement('time'); time.textContent = formatDate(view.createdAt); top.append(titleGroup, time);
            const metaParts = [view.source, view.model, view.latencyMs === undefined ? '' : `${view.latencyMs} ms`].filter(Boolean);
            const meta = document.createElement('small'); meta.textContent = metaParts.join(' · ');
            const summary = document.createElement('span'); summary.className = 'ss-helper-llm-log-item-summary'; summary.textContent = errorSummary(row); item.append(top, meta, summary); list.append(item);
        }
    };
    const renderDetail = (): void => {
        disposeEditors();
        const row = entries.find((item) => text(item.logId) === selectedId);
        detailPane.replaceChildren();
        if (!row) { const empty = document.createElement('div'); empty.className = 'ss-helper-llm-log-detail-empty'; empty.textContent = '选择一条日志查看完整诊断'; detailPane.append(empty); return; }
        const view = presentLogRow(row);
        const header = document.createElement('header'); header.className = 'ss-helper-llm-log-detail-header'; const title = document.createElement('div'); const heading = document.createElement('h4'); heading.textContent = `${view.taskLabel} · ${view.taskKey}`; const subtitle = document.createElement('p'); subtitle.textContent = `${formatDate(view.createdAt)} · ${text(row.requestId)}`; title.append(heading, subtitle); const headerActions = document.createElement('div'); headerActions.append(button('复制区块', 'copy', 'neutral'), button('导出此条', 'export-selected', 'neutral'), button('删除', 'delete', 'danger')); header.append(title, headerActions); detailPane.append(header);
        const tabs = document.createElement('nav'); tabs.className = 'ss-helper-llm-log-tabs'; const tabLabels: readonly [DetailTab, string][] = [['overview', '概览'], ['input', '输入内容'], ['raw', '原始输出'], ['parsed', '解析结果'], ['route', '路由与尝试'], ['errors', '错误诊断']]; for (const [key, label] of tabLabels) { const tab = button(label, 'tab'); tab.dataset.tab = key; tab.classList.toggle('is-active', activeTab === key); tabs.append(tab); } detailPane.append(tabs);
        const content = detailContent(row, activeTab, cleanup => editorCleanups.push(cleanup)); detailPane.append(content);
    };
    const load = async (announce = false): Promise<void> => {
        try {
            const filter = query(); const now = Date.now(); const fromTs = filter.time === 'day' ? now - 86_400_000 : filter.time === 'week' ? now - 7 * 86_400_000 : filter.time === 'month' ? now - 30 * 86_400_000 : undefined;
            entries = (await repository.queryLogs({
                limit: 500,
                search: filter.search,
                state: filter.state,
                taskKind: filter.taskKind === 'all' ? undefined : filter.taskKind,
                resourceId: filter.resourceId,
                sourcePluginId: filter.sourcePluginId,
                model: filter.model,
                reasonCode: isSSHelperReasonCode(filter.reasonCode) ? filter.reasonCode : undefined,
                fromTs,
            })).map(asRecord);
            if (!entries.some((row) => text(row.logId) === selectedId)) selectedId = text(entries[0]?.logId, '');
            renderList(); renderDetail(); renderStats(await repository.getLogStats());
            if (announce) notify('success', '日志已加载', entries.length ? `已加载 ${entries.length} 条记录；完整日志仅保存在本机 Workspace。` : '当前筛选结果为空。', 'LLM_LOG_LOAD_SUCCESS');
            options.ui?.refreshControls(root);
        } catch { disposeEditors(); detailPane.replaceChildren(); if (announce) notify('error', '日志加载失败', '无法读取本机 Workspace 日志，请检查 Workspace 状态后重试。', 'LLM_LOG_LOAD_FAILED'); }
    };
    root.addEventListener('click', (event) => {
        const target = event.target as HTMLElement; const action = target.closest<HTMLElement>('[data-log-action]')?.dataset.logAction;
        if (!action) return;
        if (action === 'select') { selectedId = target.closest<HTMLElement>('[data-log-id]')?.dataset.logId ?? selectedId; activeTab = 'overview'; renderList(); renderDetail(); return; }
        if (action === 'tab') { activeTab = (target.closest<HTMLElement>('[data-tab]')?.dataset.tab as DetailTab | undefined) ?? 'overview'; renderDetail(); return; }
        if (action === 'advanced') return;
        if (action === 'refresh') { void load(true); return; }
        if (action === 'copy' || action === 'export-selected' || action === 'delete') { void handleSelected(action); return; }
        if (action === 'export') { showConfirm('export'); return; }
        if (action === 'clear') { showConfirm('clear'); }
    }, { signal: controller.signal });
    root.addEventListener('input', () => { if (filterTimer !== undefined) window.clearTimeout(filterTimer); filterTimer = window.setTimeout(() => void load(), 220); }, { signal: controller.signal });
    root.addEventListener('change', () => void load(), { signal: controller.signal });

    const showConfirm = (action: 'clear' | 'delete' | 'export' | 'export-selected'): void => {
        const existing = root.querySelector('.ss-helper-llm-log-confirm'); if (existing) existing.remove();
        const confirm = document.createElement('div'); confirm.className = 'ss-helper-llm-log-confirm'; const message = document.createElement('span'); message.textContent = action === 'clear' ? '将删除全部日志，完整 Prompt 和模型返回也会一并删除。' : action.startsWith('export') ? '导出文件可能包含聊天正文和模型原始返回，请确认只保存到安全位置。' : '将删除当前日志记录，操作不可恢复。'; const yes = button(action === 'clear' ? '确认清空' : action.startsWith('export') ? '确认导出' : '确认删除', 'confirm', action.startsWith('export') ? 'primary' : 'danger'); yes.dataset.confirmAction = action; const no = button('取消', 'cancel'); confirm.append(message, yes, no); root.append(confirm);
    };
    const exportRows = async (rows: readonly LogRow[], label: string): Promise<void> => {
        if (!rows.length) { notify('info', '没有可导出的日志', '当前筛选结果为空。', 'LLM_LOG_EXPORT_EMPTY'); return; }
        const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json;charset=utf-8' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `ss-helper-llm-${label}-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(url); notify('success', '日志已导出', `已导出 ${rows.length} 条完整诊断记录。`, 'LLM_LOG_EXPORT_SUCCESS');
    };
    const handleSelected = async (action: string): Promise<void> => {
        const row = entries.find((item) => text(item.logId) === selectedId); if (!row) { notify('info', '尚未选择日志', '请先从左侧选择一条请求记录。', 'LLM_LOG_NOT_SELECTED'); return; }
        if (action === 'copy') { const value = detailValue(row, activeTab); const content = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2); await navigator.clipboard?.writeText(content); notify('success', '已复制', '当前诊断区块已复制到剪贴板。', 'LLM_LOG_COPY_SUCCESS'); return; }
        if (action === 'export-selected') { showConfirm('export-selected'); return; }
        showConfirm('delete');
    };
    root.addEventListener('click', (event) => {
        const target = event.target as HTMLElement; const action = target.closest<HTMLElement>('[data-confirm-action]')?.dataset.confirmAction; const logAction = target.closest<HTMLElement>('[data-log-action]')?.dataset.logAction;
        if (logAction !== 'confirm' && logAction !== 'cancel') return;
        const confirm = target.closest('.ss-helper-llm-log-confirm'); if (!confirm) return;
        if (logAction === 'cancel') { confirm.remove(); return; }
        if (action === 'clear') { void repository.clearLogs().then((count) => { confirm.remove(); selectedId = ''; notify('success', '日志已清空', `已删除 ${count} 条记录。`, 'LLM_LOG_CLEAR_SUCCESS'); return load(); }).catch(() => { notify('error', '清空失败', '日志未能全部删除，请重试。', 'LLM_LOG_CLEAR_FAILED'); }); }
        else if (action === 'delete') { void repository.deleteLogs([selectedId]).then((count) => { confirm.remove(); selectedId = ''; notify('success', '日志已删除', `已删除 ${count} 条记录。`, 'LLM_LOG_DELETE_SUCCESS'); return load(); }).catch(() => { notify('error', '删除失败', '当前日志未能删除，请重试。', 'LLM_LOG_DELETE_FAILED'); }); }
        else if (action === 'export' || action === 'export-selected') { const rows = action === 'export' ? entries : entries.filter((row) => text(row.logId) === selectedId); void exportRows(rows, action === 'export' ? '筛选结果' : '选中记录').finally(() => confirm.remove()); }
    }, { signal: controller.signal });
    await load(true);
    return () => { controller.abort(); disposeEditors(); if (filterTimer !== undefined) window.clearTimeout(filterTimer); container.replaceChildren(); };
}
