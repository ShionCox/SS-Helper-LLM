import {
    describeSSHelperFailure,
    isSSHelperReasonCode,
    type PopupUiContext,
    type ToastLevel,
} from '@ss-helper/sdk';
import { JSONEditor, Mode, type Content } from 'svelte-jsoneditor/index.js';
import { mount, unmount } from 'svelte';
import type { LlmWorkspaceRepository } from '../storage/llm-workspace-repository';
import type { CapabilityKind, RequestState } from '../schema/types';
import {
    STATUS_LABEL,
    asRecord,
    clampLogListWidth,
    compactLogDetail,
    isRetryAttempt,
    presentAgentApiResponse,
    presentDiagnostic,
    presentLogResult,
    presentLogRow,
    presentWorkflowResults,
    text,
    type LogRow,
} from './request-log-presentation';

type DetailTab = 'overview' | 'input' | 'raw' | 'parsed' | 'route' | 'errors' | 'stages' | 'tools' | 'result';

export interface WorkflowGroup {
    readonly id: string;
    readonly workflow: LogRow;
    readonly entries: readonly LogRow[];
    readonly state: string;
    readonly createdAt: number;
}

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
    const compacted = compactLogDetail(value);
    const normalized = compacted === undefined || compacted === null || compacted === '' ? empty : compacted;
    if (typeof normalized !== 'string') return { content: { json: normalized }, mode: Mode.tree };
    try {
        return { content: { json: JSON.parse(normalized) }, mode: Mode.tree };
    } catch {
        return { content: { json: normalized }, mode: Mode.tree };
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
    if (isSSHelperReasonCode(code)) return describeSSHelperFailure(response.failure).title;
    const agentState = text(asRecord(row.agent).state, '');
    if (agentState === 'tool_calls') return '已返回工具调用，尚非最终结果';
    if (agentState === 'final') return '已返回最终结果';
    return '请求已完成';
}

function definedRecord(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function recordedMetadata(value: unknown, legacyMessage: string): unknown {
    const record = asRecord(value);
    return Object.keys(record).length ? record : legacyMessage;
}

function responsePayload(row: LogRow, kind: 'raw' | 'parsed'): unknown {
    const response = asRecord(row.response);
    const agentResponse = kind === 'raw' ? presentAgentApiResponse(row) : undefined;
    const value = kind === 'raw'
        ? definedRecord({
            ...asRecord(agentResponse),
            metadata: asRecord(agentResponse).metadata ?? response.providerResponseMeta,
            rawResponseText: response.rawResponseText,
            responsePreview: response.responsePreview,
            providerResponse: response.providerResponse,
        })
        : definedRecord({
            metadata: response.parseMeta,
            parsedResponse: response.parsedResponse,
            normalizedResponse: response.normalizedResponse,
            validationIssues: response.validationIssues,
        });
    const hasContent = kind === 'raw'
        ? response.rawResponseText !== undefined || response.responsePreview !== undefined || response.providerResponse !== undefined
        : response.parsedResponse !== undefined || response.normalizedResponse !== undefined || response.validationIssues !== undefined;
    const incomplete = kind === 'raw' && asRecord(response.providerResponse).incomplete === true;
    const omittedPaths = Array.isArray(asRecord(row.truncated).paths) ? asRecord(row.truncated).paths as unknown[] : [];
    const responseWasTruncated = kind === 'raw' && omittedPaths.some(path => path === 'response.rawResponseText' || path === 'response.providerResponse');
    if (incomplete) {
        value.contentStatus = response.rawResponseText === undefined
            ? '连接在响应完成前中断，未收到可展示的响应正文。'
            : '以下是连接中断前已收到的不完整 API 响应，用于排查协议错误；它不代表模型的完整输出。';
    }
    if (kind === 'raw' && response.responsePreview !== undefined) {
        value.contentStatus = 'API 响应超过单条日志 4 MiB 限制；以下仅保留脱敏后的开头与结尾片段。';
    } else if (responseWasTruncated) {
        value.contentStatus = 'API 响应超过单条日志 4 MiB 限制，正文已省略；这条旧日志无法补回。';
    }
    if (!hasContent && !agentResponse && !responseWasTruncated) {
        value.contentStatus = kind === 'raw'
            ? '未记录 API 返回内容。旧日志无法补回；未收到响应时也不会产生返回内容。'
            : '未记录解析结果。旧日志无法补回；解析未执行时也不会产生结果。';
    }
    return value;
}

const RESULT_STATUS: Record<string, { readonly label: string; readonly tone: string }> = {
    validated: { label: '校验通过', tone: 'success' },
    invalid: { label: '校验未通过', tone: 'error' },
    awaiting_tools: { label: '等待后续轮次', tone: 'warning' },
    failed: { label: '请求失败', tone: 'error' },
    unavailable: { label: '结果未记录', tone: 'warning' },
    truncated: { label: '结果已省略', tone: 'warning' },
};

function resultContent(value: unknown, registerCleanup: (cleanup: () => void) => void): HTMLElement {
    const result = asRecord(value);
    const status = text(result.status, 'unavailable');
    const presentation = RESULT_STATUS[status] ?? RESULT_STATUS.unavailable;
    const section = document.createElement('div');
    section.className = 'ss-helper-llm-log-detail-section';
    section.dataset.resultStatus = status;
    const heading = document.createElement('div');
    heading.className = status === 'invalid' || status === 'failed'
        ? 'ss-helper-llm-log-error-heading'
        : 'ss-helper-llm-log-notice';
    heading.append(badge(presentation.label, presentation.tone));
    const message = document.createElement(status === 'invalid' || status === 'failed' ? 'p' : 'span');
    message.textContent = text(result.contentStatus, '没有可展示的返回结果。');
    heading.append(message);
    section.append(heading);
    const payload = Array.isArray(result.stages) ? result.stages : result.content;
    if (payload !== undefined) section.append(jsonEditorBlock(payload, registerCleanup));
    const diagnostics = definedRecord({
        validationIssues: result.validationIssues,
        diagnostic: result.diagnostic,
        omittedPaths: result.omittedPaths,
    });
    if (Object.keys(diagnostics).length) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = '校验与诊断';
        details.append(summary, jsonEditorBlock(diagnostics, registerCleanup));
        section.append(details);
    }
    return section;
}

function workflowMode(value: unknown): 'agent' | 'agent_shadow' | undefined {
    const kind = text(asRecord(value).workflowKind, '');
    return kind === 'agent' || kind === 'agent_shadow' ? kind : undefined;
}

function modeLabel(mode: 'agent' | 'agent_shadow' | undefined): string | undefined {
    return mode === 'agent_shadow' ? 'Agent Shadow' : mode === 'agent' ? 'Agent' : undefined;
}

function appendModeTag(parent: HTMLElement, mode: 'agent' | 'agent_shadow' | undefined): void {
    const label = modeLabel(mode);
    if (!label) return;
    const tag = document.createElement('span');
    tag.className = 'ss-helper-llm-log-mode-tag';
    tag.dataset.mode = mode;
    tag.textContent = label;
    tag.setAttribute('aria-hidden', 'true');
    parent.append(tag);
}

function appendRetryTag(parent: HTMLElement, retry: boolean): void {
    if (!retry) return;
    const tag = document.createElement('span');
    tag.className = 'ss-helper-llm-log-retry-tag';
    tag.textContent = '重试';
    tag.setAttribute('aria-hidden', 'true');
    parent.append(tag);
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
        ['日志 ID', row.logId], ['根请求 ID', row.requestId], ['Attempt ID', row.attemptId], ['用途', view.purpose], ['技术任务键', view.taskKey],
        ['插件', view.consumer], ['状态', STATUS_LABEL[view.state] ?? view.state], ['尝试', view.attempt],
        ['结构化传输', [row.plannedTransport, row.actualTransport, structuredOutput.transport].filter(Boolean).join(' → ') || '未记录'],
        ['来源', view.source], ['模型', view.model || '模型未知'],
        ['输入 Token', view.usage?.inputTokens ?? 'API 未返回'], ['输出 Token', view.usage?.outputTokens ?? 'API 未返回'], ['总 Token', view.usage?.totalTokens ?? 'API 未返回'],
        ['耗时', view.latencyMs === undefined ? '未记录' : `${view.latencyMs} ms`], ['时间', formatDate(view.createdAt)],
        ...(Object.keys(structuredOutput).length === 0 ? [] : [
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
            purpose: view.purpose,
            taskKey: view.taskKey,
            state: STATUS_LABEL[view.state] ?? view.state,
            attempt: view.attempt,
            source: view.source,
            model: view.model || '模型未知',
            latencyMs: view.latencyMs,
            createdAt: view.createdAt,
            diagnosticMode: row.contentMode,
            redactions: row.redactions,
        };
    }
    if (tab === 'input') return recordedMetadata(request.providerRequestMeta, '旧日志未记录此项：发送信息元数据。');
    if (tab === 'raw') return responsePayload(row, 'raw');
    if (tab === 'parsed') return responsePayload(row, 'parsed');
    if (tab === 'result') return presentLogResult(row);
    if (tab === 'route') return { meta: response.meta, plannedTransport: row.plannedTransport, actualTransport: row.actualTransport };
    return {
        failure: response.failure,
        providerResponseMeta: response.providerResponseMeta,
        parseMeta: response.parseMeta,
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
        notice.append(badge(text(row.contentMode) === 'full' ? '完整返回内容与诊断已保存' : '仅保存诊断摘要', text(row.contentMode) === 'full' ? 'success' : 'warning'));
        if (Array.isArray(row.redactions) && row.redactions.length) { const note = document.createElement('span'); note.textContent = `已脱敏 ${row.redactions.length} 个敏感字段`; notice.append(note); }
        section.append(notice); return section;
    }
    if (tab === 'input') {
        const section = document.createElement('div'); section.className = 'ss-helper-llm-log-detail-section';
        section.append(jsonEditorBlock(recordedMetadata(request.providerRequestMeta, '旧日志未记录此项：发送信息元数据。'), registerCleanup));
        const schema = document.createElement('details'); schema.open = false; const summary = document.createElement('summary'); summary.textContent = 'Schema 与结构化参数摘要'; schema.append(summary, jsonEditorBlock({ schemaSummary: request.schemaSummary, schemaHash: request.schemaHash, resolvedMaxTokens: request.resolvedMaxTokens, structuredOutput: request.structuredOutput, metrics: request.metrics }, registerCleanup)); section.append(schema); return section;
    }
    if (tab === 'raw') return jsonEditorBlock(responsePayload(row, 'raw'), registerCleanup);
    if (tab === 'parsed') return jsonEditorBlock(responsePayload(row, 'parsed'), registerCleanup);
    if (tab === 'result') return resultContent(presentLogResult(row), registerCleanup);
    if (tab === 'route') return jsonEditorBlock({ meta: response.meta, plannedTransport: row.plannedTransport, actualTransport: row.actualTransport }, registerCleanup);
    const section = document.createElement('div'); section.className = 'ss-helper-llm-log-detail-section';
    const diagnostic = presentDiagnostic(response.failure);
    if (diagnostic.code || diagnostic.message) {
        const heading = document.createElement('div'); heading.className = 'ss-helper-llm-log-error-heading';
        if (diagnostic.code) heading.append(badge(diagnostic.code, 'error'));
        if (diagnostic.message) { const message = document.createElement('p'); message.textContent = diagnostic.message; heading.append(message); }
        section.append(heading);
    }
    const failure = asRecord(response.failure);
    const diagnostics = Object.fromEntries(Object.entries({
        httpStatus: failure.httpStatus,
        providerErrorCode: failure.providerErrorCode,
        providerErrorType: failure.providerErrorType,
        providerErrorParam: failure.providerErrorParam,
        stage: failure.stage,
        batchIndex: failure.batchIndex,
        requestId: failure.requestId ?? row.requestId,
        providerResponse: Object.keys(asRecord(response.providerResponseMeta)).length ? response.providerResponseMeta : failure.httpStatus === undefined ? '未收到 HTTP 响应。' : undefined,
        parseMeta: response.parseMeta,
        truncated: row.truncated,
        redactions: row.redactions,
    }).filter(([, value]) => value !== undefined && value !== null && value !== false && (!Array.isArray(value) || value.length > 0)));
    if (Object.keys(diagnostics).length) section.append(jsonEditorBlock(diagnostics, registerCleanup));
    return section;
}

export function workflowGroups(rows: readonly LogRow[]): WorkflowGroup[] {
    const grouped = new Map<string, LogRow[]>();
    for (const row of rows) {
        const workflowId = text(asRecord(row.workflow).workflowId, '');
        if (!workflowId) continue;
        const bucket = grouped.get(workflowId) ?? [];
        bucket.push(row);
        grouped.set(workflowId, bucket);
    }
    return [...grouped.entries()].map(([id, entries]) => {
        const sorted = [...entries].sort((left, right) => Number(left.startedAt ?? left.queuedAt ?? 0) - Number(right.startedAt ?? right.queuedAt ?? 0));
        const latestAgent = [...sorted].reverse().find(row => row.entryKind === 'agent_turn');
        const awaitingTools = asRecord(latestAgent?.agent).state === 'tool_calls';
        const state = sorted.some(row => row.state === 'failed') ? 'failed'
            : sorted.some(row => row.state === 'running' || row.state === 'queued') || awaitingTools ? 'running'
                : sorted.at(-1)?.state === 'cancelled' ? 'cancelled' : 'completed';
        return {
            id,
            workflow: asRecord(sorted[0]?.workflow),
            entries: sorted,
            state,
            createdAt: Math.max(...sorted.map(row => Number(row.finishedAt ?? row.startedAt ?? row.queuedAt ?? 0))),
        };
    });
}

export function workflowToolRows(group: WorkflowGroup): readonly Record<string, unknown>[] {
    const calls = new Map<string, Record<string, unknown>>();
    for (const row of group.entries) {
        const agent = asRecord(row.agent);
        for (const item of Array.isArray(agent.toolCalls) ? agent.toolCalls : []) {
            const call = asRecord(item);
            const callId = text(call.callId, '');
            const toolName = text(call.name, '工具调用');
            if (callId) calls.set(callId, { callId, tool: toolName, purpose: toolName, argumentBytes: call.argumentBytes, arguments: call.arguments, requestId: row.requestId, round: agent.toolSessionRound });
        }
        for (const item of Array.isArray(agent.toolResults) ? agent.toolResults : []) {
            const result = asRecord(item);
            const callId = text(result.callId, '');
            if (!callId) continue;
            calls.set(callId, definedRecord({
                ...(calls.get(callId) ?? { callId, tool: result.name, purpose: text(result.name, '工具调用') }),
                ok: result.ok,
                resultBytes: result.resultBytes,
                readCount: result.readCount,
                resultCount: result.resultCount,
                truncated: result.truncated,
                reasonCode: result.reasonCode,
                content: result.content,
                resultRequestId: row.requestId,
                resultRound: agent.toolSessionRound,
            }));
        }
    }
    return [...calls.values()];
}

function workflowDetailValue(group: WorkflowGroup, tab: DetailTab): unknown {
    const stages = group.entries.map(row => {
        const workflow = asRecord(row.workflow);
        const agent = asRecord(row.agent);
        const view = presentLogRow(row);
        return definedRecord({
            stage: workflow.stageDescription ?? view.purpose,
            stageKey: workflow.stageKey ?? view.taskKey,
            turn: agent.toolSessionRound,
            state: STATUS_LABEL[view.state] ?? view.state,
            toolCalls: Array.isArray(agent.toolCalls) ? agent.toolCalls.length : 0,
            resource: view.source,
            model: view.model,
            latencyMs: view.latencyMs,
            usage: view.usage,
            requestId: row.requestId,
        });
    });
    if (tab === 'stages') return stages;
    if (tab === 'tools') return workflowToolRows(group);
    if (tab === 'result') return presentWorkflowResults(group.entries);
    if (tab === 'errors') return group.entries.flatMap(row => {
        const failure = asRecord(asRecord(row.response).failure);
        if (!Object.keys(failure).length) return [];
        const diagnostic = isSSHelperReasonCode(failure.reasonCode) ? describeSSHelperFailure(failure) : undefined;
        return [definedRecord({
            code: diagnostic?.reasonCode ?? failure.reasonCode,
            title: diagnostic?.title,
            reason: diagnostic?.reason,
            action: diagnostic?.action,
            stage: failure.stage,
            batchIndex: failure.batchIndex,
            requestId: failure.requestId ?? row.requestId,
        })];
    });
    const workflow = group.workflow;
    const tools = workflowToolRows(group);
    return definedRecord({
        workflowLabel: workflow.workflowLabel,
        workflowKind: workflow.workflowKind,
        jobId: workflow.jobId,
        batch: workflow.batchIndex === undefined ? undefined : `${Number(workflow.batchIndex) + 1} / ${text(workflow.batchCount, '?')}`,
        status: STATUS_LABEL[group.state] ?? group.state,
        stages: new Set(group.entries.map(row => text(asRecord(row.workflow).stageKey, text(row.taskKey, '')))).size,
        agentTurns: group.entries.filter(row => row.entryKind === 'agent_turn').length,
        requestRecords: group.entries.length,
        toolCalls: tools.length,
        startedAt: formatDate(Math.min(...group.entries.map(row => Number(row.startedAt ?? row.queuedAt ?? 0)))),
        finishedAt: formatDate(group.createdAt),
    });
}

function workflowDetailContent(group: WorkflowGroup, tab: DetailTab, registerCleanup: (cleanup: () => void) => void): HTMLElement {
    if (tab === 'result') return resultContent(workflowDetailValue(group, tab), registerCleanup);
    return jsonEditorBlock(workflowDetailValue(group, tab), registerCleanup, tab === 'errors' ? '流程没有错误诊断' : '暂无记录');
}

export interface RequestLogViewerOptions {
    readonly ui?: PopupUiContext;
    readonly notify?: (notification: { level: ToastLevel; title: string; message: string; code: string }) => void;
    readonly describeTask?: (consumer: string, taskKey: string, taskKind?: 'generation' | 'embedding' | 'rerank') => { readonly consumerDisplayName?: string; readonly taskDescription: string };
}

export async function renderRequestLogViewer(container: HTMLElement, repository: LlmWorkspaceRepository, options: RequestLogViewerOptions = {}): Promise<() => void> {
    const root = document.createElement('section'); root.className = 'ss-helper-llm-log-viewer'; root.setAttribute('aria-label', 'LLM 请求日志查看器');
    const filters = document.createElement('div'); filters.className = 'ss-helper-llm-log-filters';
    const primaryFilters = document.createElement('div'); primaryFilters.className = 'ss-helper-llm-log-filter-primary';
    primaryFilters.append(field('搜索日志', 'input', 'search', '中文用途、任务键、工具名或错误码'), field('状态', 'select', 'state'), field('任务', 'select', 'taskKind'), field('调用类型', 'select', 'callScope'), field('时间', 'select', 'time'));
    const advancedFilters = document.createElement('div'); advancedFilters.className = 'ss-helper-llm-log-filter-advanced'; advancedFilters.id = `ss-helper-llm-log-more-${Math.random().toString(36).slice(2)}`; advancedFilters.hidden = true;
    advancedFilters.append(field('来源/资源', 'input', 'resource', '来源或资源 ID'), field('插件', 'input', 'plugin', '插件 ID'), field('模型', 'input', 'model', '模型名称'), field('错误码', 'input', 'reasonCode', '例如 INVALID_JSON'));
    const actions = document.createElement('div'); actions.className = 'ss-helper-llm-log-actions';
    const more = button('更多筛选', 'advanced'); more.setAttribute('aria-expanded', 'false'); more.setAttribute('aria-controls', advancedFilters.id);
    actions.append(more, button('刷新', 'refresh'), button('导出结果', 'export', 'primary'), button('清空', 'clear', 'danger'));
    filters.append(primaryFilters, actions, advancedFilters);
    const state = filters.querySelector<HTMLSelectElement>('[data-log-filter="state"]')!; renderSelectOptions(state, [['all', '全部状态'], ['completed', '已完成'], ['failed', '失败'], ['cancelled', '已取消'], ['queued', '排队中'], ['running', '运行中']]);
    const task = filters.querySelector<HTMLSelectElement>('[data-log-filter="taskKind"]')!; renderSelectOptions(task, [['all', '全部任务'], ['generation', '生成'], ['embedding', '向量化'], ['rerank', '重排序']]);
    const callScope = filters.querySelector<HTMLSelectElement>('[data-log-filter="callScope"]')!; renderSelectOptions(callScope, [['all', '全部调用'], ['ordinary', '普通请求'], ['agent_workflow', 'Agent 流程']]);
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
    const expandedWorkflows = new Set<string>();
    const tabIdPrefix = `ss-helper-llm-log-detail-${Math.random().toString(36).slice(2)}`;
    let editorCleanups: Array<() => void> = [];
    const disposeEditors = (): void => {
        for (const cleanup of editorCleanups.splice(0)) cleanup();
    };

    const notify = (level: ToastLevel, title: string, message: string, code: string): void => { options.notify?.({ level, title, message, code }); };
    const query = (): Record<string, string | undefined> => ({
        search: root.querySelector<HTMLInputElement>('[data-log-filter="search"]')?.value.trim() || undefined,
        state: root.querySelector<HTMLSelectElement>('[data-log-filter="state"]')?.value || 'all',
        taskKind: root.querySelector<HTMLSelectElement>('[data-log-filter="taskKind"]')?.value || 'all',
        callScope: root.querySelector<HTMLSelectElement>('[data-log-filter="callScope"]')?.value || 'all',
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
        const groups = workflowGroups(entries);
        const groupedIds = new Set(groups.flatMap(group => group.entries.map(row => text(row.logId, ''))));
        const ordinary = entries.filter(row => !groupedIds.has(text(row.logId, '')));
        list.replaceChildren(); listCount.textContent = `${ordinary.length} 条请求 · ${groups.length} 个流程`;
        if (!entries.length) { const empty = document.createElement('div'); empty.className = 'ss-helper-llm-log-empty'; empty.textContent = '没有符合条件的请求日志'; list.append(empty); return; }
        const renderRow = (row: LogRow, child = false, inheritedMode?: 'agent' | 'agent_shadow', parent: HTMLElement = list): void => {
            const view = presentLogRow(row);
            const mode = inheritedMode ?? workflowMode(row.workflow);
            const modeText = modeLabel(mode);
            const item = button('', 'select', 'neutral'); item.className = `ss-helper-llm-log-item${child ? ' is-child' : ''}${text(row.logId) === selectedId ? ' is-selected' : ''}`; item.dataset.logId = text(row.logId);
            const retry = isRetryAttempt(row);
            item.setAttribute('aria-label', `${modeText ? `${modeText} 模式，` : ''}${retry ? '重试，' : ''}${view.purpose}，${STATUS_LABEL[view.state] ?? view.state}，${formatDate(view.createdAt)}`);
            const top = document.createElement('div'); top.className = 'ss-helper-llm-log-item-top';
            const titleGroup = document.createElement('span'); titleGroup.className = 'ss-helper-llm-log-item-title';
            const statusIcon = document.createElement('span'); statusIcon.className = 'ss-helper-llm-log-item-status'; statusIcon.dataset.state = view.state; statusIcon.setAttribute('aria-hidden', 'true');
            titleGroup.append(statusIcon); appendModeTag(titleGroup, mode); appendRetryTag(titleGroup, retry); const title = document.createElement('strong'); title.textContent = view.purpose; titleGroup.append(title);
            const time = document.createElement('time'); time.textContent = formatDate(view.createdAt); top.append(titleGroup, time);
            const metaParts = [view.consumer, view.source, view.model, view.latencyMs === undefined ? '' : `${view.latencyMs} ms`, `Token ${view.usage?.totalTokens ?? '未返回'}`, view.taskKey].filter(Boolean);
            const meta = document.createElement('small'); meta.textContent = metaParts.join(' · ');
            const summary = document.createElement('span'); summary.className = 'ss-helper-llm-log-item-summary'; summary.textContent = errorSummary(row); item.append(top, meta, summary); parent.append(item);
        };
        const combined = [
            ...groups.map(group => ({ kind: 'workflow' as const, createdAt: group.createdAt, group })),
            ...ordinary.map(row => ({ kind: 'request' as const, createdAt: Number(presentLogRow(row).createdAt ?? 0), row })),
        ].sort((left, right) => right.createdAt - left.createdAt);
        for (const [itemIndex, item] of combined.entries()) {
            if (item.kind === 'request') { renderRow(item.row); continue; }
            const group = item.group;
            const workflowId = `workflow:${group.id}`;
            const expanded = expandedWorkflows.has(group.id);
            const workflow = group.workflow;
            const mode = workflowMode(workflow);
            const modeText = modeLabel(mode);
            const tools = workflowToolRows(group);
            const agentTurns = group.entries.filter(row => row.entryKind === 'agent_turn').length;
            const hasRetries = group.entries.some(isRetryAttempt);
            const rootItem = button('', 'select-workflow', 'neutral');
            rootItem.className = `ss-helper-llm-log-item is-workflow${selectedId === workflowId ? ' is-selected' : ''}`;
            rootItem.dataset.workflowId = group.id;
            rootItem.setAttribute('aria-expanded', String(expanded));
            const childrenId = `${tabIdPrefix}-workflow-children-${itemIndex}`;
            rootItem.setAttribute('aria-controls', childrenId);
            rootItem.setAttribute('aria-label', `${modeText ? `${modeText} 模式，` : ''}${hasRetries ? '包含重试，' : ''}${text(workflow.workflowLabel, 'LLM 流程')}，${STATUS_LABEL[group.state] ?? group.state}，${agentTurns} 个 Agent 轮次，${group.entries.length} 条请求记录`);
            const top = document.createElement('div'); top.className = 'ss-helper-llm-log-item-top';
            const titleGroup = document.createElement('span'); titleGroup.className = 'ss-helper-llm-log-item-title';
            const statusIcon = document.createElement('span'); statusIcon.className = 'ss-helper-llm-log-item-status'; statusIcon.dataset.state = group.state; statusIcon.setAttribute('aria-hidden', 'true');
            titleGroup.append(statusIcon); appendModeTag(titleGroup, mode); appendRetryTag(titleGroup, hasRetries); const title = document.createElement('strong'); title.textContent = `${expanded ? '▾' : '▸'} ${text(workflow.workflowLabel, 'LLM 流程')}`;
            titleGroup.append(title);
            const time = document.createElement('time'); time.textContent = formatDate(group.createdAt); top.append(titleGroup, time);
            const stageCount = new Set(group.entries.map(row => text(asRecord(row.workflow).stageKey, text(row.taskKey, '')))).size;
            const knownTotals = group.entries.map(row => presentLogRow(row).usage?.totalTokens).filter((value): value is number => value !== undefined);
            const tokenText = knownTotals.length === group.entries.length
                ? `Token ${knownTotals.reduce((sum, value) => sum + value, 0)}`
                : `Token ${knownTotals.reduce((sum, value) => sum + value, 0)}（${knownTotals.length}/${group.entries.length} 次有返回）`;
            const meta = document.createElement('small'); meta.textContent = `${text(workflow.workflowKind, 'workflow')} · ${stageCount} 阶段 · ${agentTurns} 个 Agent 轮次 · ${group.entries.length} 条请求 · ${tools.length} 次工具调用 · ${tokenText}`;
            const summary = document.createElement('span'); summary.className = 'ss-helper-llm-log-item-summary'; summary.textContent = workflow.batchIndex === undefined ? (STATUS_LABEL[group.state] ?? group.state) : `第 ${Number(workflow.batchIndex) + 1} / ${text(workflow.batchCount, '?')} 批`;
            rootItem.append(top, meta, summary); list.append(rootItem);
            const children = document.createElement('div'); children.id = childrenId; children.hidden = !expanded;
            if (expanded) for (const row of group.entries) renderRow(row, true, mode, children);
            list.append(children);
        }
    };
    const renderDetail = (): void => {
        disposeEditors();
        const group = workflowGroups(entries).find(item => `workflow:${item.id}` === selectedId);
        const row = entries.find((item) => text(item.logId) === selectedId);
        detailPane.replaceChildren();
        if (!row && !group) { const empty = document.createElement('div'); empty.className = 'ss-helper-llm-log-detail-empty'; empty.textContent = '选择一条请求或一个 LLM 流程查看诊断'; detailPane.append(empty); return; }
        const view = row ? presentLogRow(row) : undefined;
        const header = document.createElement('header'); header.className = 'ss-helper-llm-log-detail-header'; const title = document.createElement('div'); const heading = document.createElement('h4'); heading.textContent = group ? text(group.workflow.workflowLabel, 'LLM 流程') : view!.purpose; const subtitle = document.createElement('p'); subtitle.textContent = group ? `${formatDate(group.createdAt)} · ${group.entries.filter(item => item.entryKind === 'agent_turn').length} 个 Agent 轮次 · ${group.entries.length} 条请求记录` : `${formatDate(view!.createdAt)} · ${view!.taskKey} · ${text(row!.requestId)}`; title.append(heading, subtitle); const headerActions = document.createElement('div'); headerActions.append(button('复制区块', 'copy', 'neutral'), button(group ? '导出流程' : '导出此条', 'export-selected', 'neutral'), button('删除', 'delete', 'danger')); header.append(title, headerActions); detailPane.append(header);
        const tabs = document.createElement('nav'); tabs.className = 'ss-helper-llm-log-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-orientation', 'horizontal');
        const tabLabels: readonly [DetailTab, string][] = group
            ? [['overview', '流程概览'], ['stages', '阶段与轮次'], ['tools', '工具调用'], ['result', '返回结果'], ['errors', '错误诊断']]
            : [['overview', '概览'], ['input', '发送信息'], ['raw', 'API 响应'], ['parsed', '解析与校验'], ['result', '返回结果'], ['route', '路由与尝试'], ['errors', '错误诊断']];
        if (!tabLabels.some(([key]) => key === activeTab)) activeTab = 'overview';
        const panelId = `${tabIdPrefix}-panel`;
        for (const [key, label] of tabLabels) {
            const tab = button(label, 'tab');
            const active = activeTab === key;
            tab.id = `${tabIdPrefix}-tab-${key}`;
            tab.dataset.tab = key;
            tab.classList.toggle('is-active', active);
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(active));
            tab.setAttribute('aria-controls', panelId);
            tab.tabIndex = active ? 0 : -1;
            tabs.append(tab);
        }
        detailPane.append(tabs);
        const content = group ? workflowDetailContent(group, activeTab, cleanup => editorCleanups.push(cleanup)) : detailContent(row!, activeTab, cleanup => editorCleanups.push(cleanup));
        content.id = panelId;
        content.setAttribute('role', 'tabpanel');
        content.setAttribute('aria-labelledby', `${tabIdPrefix}-tab-${activeTab}`);
        content.tabIndex = 0;
        detailPane.append(content);
    };
    const load = async (announce = false): Promise<void> => {
        try {
            const filter = query(); const now = Date.now(); const fromTs = filter.time === 'day' ? now - 86_400_000 : filter.time === 'week' ? now - 7 * 86_400_000 : filter.time === 'month' ? now - 30 * 86_400_000 : undefined;
            const settings = await repository.loadSettings();
            const resources = new Map((settings.resources ?? []).map(resource => [resource.id, resource.label] as const));
            const rows = (await repository.queryLogs({
                limit: 500,
                state: filter.state as RequestState | 'all' | undefined,
                taskKind: filter.taskKind === 'all' ? undefined : filter.taskKind as CapabilityKind,
                callScope: filter.callScope === 'all' ? undefined : filter.callScope as 'ordinary' | 'agent_workflow',
                resourceId: filter.resourceId,
                sourcePluginId: filter.sourcePluginId,
                model: filter.model,
                reasonCode: isSSHelperReasonCode(filter.reasonCode) ? filter.reasonCode : undefined,
                fromTs,
            })).map(asRecord).map(row => {
                const view = presentLogRow(row);
                const description = options.describeTask?.(text(row.consumer ?? row.sourcePluginId, ''), view.taskKey, view.taskKind as 'generation' | 'embedding' | 'rerank');
                return {
                    ...row,
                    taskDescription: row.taskDescription ?? description?.taskDescription,
                    consumerDisplayName: row.consumerDisplayName ?? description?.consumerDisplayName,
                    resourceLabel: row.resourceLabel ?? resources.get(text(row.resourceId ?? asRecord(asRecord(row.response).meta).resourceId, '')),
                };
            });
            const search = filter.search?.toLowerCase();
            entries = search ? rows.filter(row => JSON.stringify(row).toLowerCase().includes(search)) : rows;
            const groups = workflowGroups(entries);
            const selectionExists = entries.some(row => text(row.logId) === selectedId) || groups.some(group => `workflow:${group.id}` === selectedId);
            if (!selectionExists) {
                const firstGroup = groups[0];
                selectedId = firstGroup ? `workflow:${firstGroup.id}` : text(entries[0]?.logId, '');
                if (firstGroup) expandedWorkflows.add(firstGroup.id);
            }
            renderList(); renderDetail(); renderStats(await repository.getLogStats());
            if (announce) notify('success', '日志已加载', entries.length ? `已加载 ${entries.length} 条日志；完整返回内容仅保存在本机 Workspace。` : '当前筛选结果为空。', 'LLM_LOG_LOAD_SUCCESS');
            options.ui?.refreshControls(root);
        } catch { disposeEditors(); detailPane.replaceChildren(); if (announce) notify('error', '日志加载失败', '无法读取本机 Workspace 日志，请检查 Workspace 状态后重试。', 'LLM_LOG_LOAD_FAILED'); }
    };
    root.addEventListener('click', (event) => {
        const target = event.target as HTMLElement; const action = target.closest<HTMLElement>('[data-log-action]')?.dataset.logAction;
        if (!action) return;
        if (action === 'select') { selectedId = target.closest<HTMLElement>('[data-log-id]')?.dataset.logId ?? selectedId; activeTab = 'overview'; renderList(); renderDetail(); return; }
        if (action === 'select-workflow') { const id = target.closest<HTMLElement>('[data-workflow-id]')?.dataset.workflowId; if (!id) return; selectedId = `workflow:${id}`; activeTab = 'overview'; if (expandedWorkflows.has(id)) expandedWorkflows.delete(id); else expandedWorkflows.add(id); renderList(); renderDetail(); return; }
        if (action === 'tab') { activeTab = (target.closest<HTMLElement>('[data-tab]')?.dataset.tab as DetailTab | undefined) ?? 'overview'; renderDetail(); return; }
        if (action === 'advanced') return;
        if (action === 'refresh') { void load(true); return; }
        if (action === 'copy' || action === 'export-selected' || action === 'delete') { void handleSelected(action); return; }
        if (action === 'export') { void confirmAction('export'); return; }
        if (action === 'clear') { void confirmAction('clear'); }
    }, { signal: controller.signal });
    root.addEventListener('keydown', (event) => {
        const current = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-log-action="tab"]');
        if (!current || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = Array.from(current.closest<HTMLElement>('[role="tablist"]')!.querySelectorAll<HTMLButtonElement>('[data-log-action="tab"]'));
        const index = tabs.indexOf(current);
        const next = event.key === 'Home' ? tabs[0]
            : event.key === 'End' ? tabs.at(-1)
                : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
        const nextTab = next?.dataset.tab as DetailTab | undefined;
        if (!nextTab) return;
        activeTab = nextTab;
        renderDetail();
        detailPane.querySelector<HTMLButtonElement>(`[data-tab="${nextTab}"]`)?.focus();
        event.preventDefault();
    }, { signal: controller.signal });
    root.addEventListener('input', () => { if (filterTimer !== undefined) window.clearTimeout(filterTimer); filterTimer = window.setTimeout(() => void load(), 220); }, { signal: controller.signal });
    root.addEventListener('change', () => void load(), { signal: controller.signal });

    const exportRows = async (rows: readonly LogRow[], label: string): Promise<void> => {
        if (!rows.length) { notify('info', '没有可导出的日志', '当前筛选结果为空。', 'LLM_LOG_EXPORT_EMPTY'); return; }
        const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json;charset=utf-8' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `ss-helper-llm-${label}-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(url); notify('success', '日志已导出', `已导出 ${rows.length} 条日志，文件可能包含模型返回内容。`, 'LLM_LOG_EXPORT_SUCCESS');
    };
    const selectedRows = (): readonly LogRow[] => {
        const group = workflowGroups(entries).find(item => `workflow:${item.id}` === selectedId);
        return group?.entries ?? entries.filter(row => text(row.logId) === selectedId);
    };
    const confirmAction = async (action: 'clear' | 'delete' | 'export' | 'export-selected'): Promise<void> => {
        const exportAction = action === 'export' || action === 'export-selected';
        const confirmed = await options.ui?.confirm({
            title: action === 'clear' ? '清空全部 LLM 日志？' : exportAction ? '导出本机日志？' : '删除选中的日志？',
            message: action === 'clear'
                ? '全部诊断与模型返回内容会一并删除，操作不可恢复。'
                : exportAction
                    ? '导出文件可能包含完整模型返回内容，请只保存到可信位置。'
                    : '选中流程会删除它包含的全部模型轮次，操作不可恢复。',
            danger: !exportAction,
        });
        if (!confirmed) return;
        try {
            if (action === 'clear') {
                const count = await repository.clearLogs(); selectedId = '';
                notify('success', '日志已清空', `已删除 ${count} 条记录。`, 'LLM_LOG_CLEAR_SUCCESS'); await load(); return;
            }
            if (action === 'delete') {
                const ids = selectedRows().map(row => text(row.logId, '')).filter(Boolean);
                const count = await repository.deleteLogs(ids); selectedId = '';
                notify('success', '日志已删除', `已删除 ${count} 条记录。`, 'LLM_LOG_DELETE_SUCCESS'); await load(); return;
            }
            const rows = action === 'export' ? entries : selectedRows();
            await exportRows(rows, action === 'export' ? '筛选结果' : rows.length > 1 ? '选中流程' : '选中记录');
        } catch {
            notify('error', action === 'clear' ? '清空失败' : action === 'delete' ? '删除失败' : '导出失败', '操作未完成，请检查 Workspace 状态后重试。', 'LLM_LOG_ACTION_FAILED');
        }
    };
    const handleSelected = async (action: string): Promise<void> => {
        const group = workflowGroups(entries).find(item => `workflow:${item.id}` === selectedId);
        const row = entries.find((item) => text(item.logId) === selectedId);
        if (!row && !group) { notify('info', '尚未选择日志', '请先从左侧选择一条请求或一个 Agent 流程。', 'LLM_LOG_NOT_SELECTED'); return; }
        if (action === 'copy') {
            const value = group ? workflowDetailValue(group, activeTab) : detailValue(row!, activeTab);
            const content = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
            await options.ui?.copyText(content);
            notify('success', '已复制', '当前诊断区块已复制到剪贴板。', 'LLM_LOG_COPY_SUCCESS'); return;
        }
        await confirmAction(action === 'export-selected' ? 'export-selected' : 'delete');
    };
    await load(true);
    return () => { controller.abort(); disposeEditors(); if (filterTimer !== undefined) window.clearTimeout(filterTimer); container.replaceChildren(); };
}
