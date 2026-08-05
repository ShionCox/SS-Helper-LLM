import {
    describeSSHelperFailure,
    isSSHelperReasonCode,
    type PlainData,
} from '@ss-helper/sdk';

export type LogRow = Record<string, unknown>;

export interface LogPresentation {
    readonly taskKind: string;
    readonly taskLabel: string;
    readonly taskKey: string;
    readonly purpose: string;
    readonly consumer: string;
    readonly entryKind: 'provider_attempt' | 'agent_turn';
    readonly state: string;
    readonly source: string;
    readonly model: string;
    readonly latencyMs?: number;
    readonly createdAt: unknown;
    readonly attempt: string;
    readonly usage?: LogUsagePresentation;
}

export interface LogUsagePresentation {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
}

export const STATUS_LABEL: Record<string, string> = { completed: '已完成', failed: '失败', queued: '排队中', running: '运行中', cancelled: '已取消' };
const TASK_LABEL: Record<string, string> = { generation: '生成', embedding: '向量化', rerank: '重排序' };
const ATTEMPT_PHASE_LABEL: Record<string, string> = {
    initial: '首次请求',
    schema_repair: 'Schema 修复',
    transient_retry: '瞬态重试',
};

export function asRecord(value: PlainData | unknown): LogRow {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as LogRow : {};
}

export function text(value: unknown, fallback = '—'): string {
    if (value === undefined || value === null || value === '') return fallback;
    return String(value);
}

export type LogResultStatus = 'validated' | 'invalid' | 'awaiting_tools' | 'failed' | 'unavailable' | 'truncated';

export interface LogResultPresentation {
    readonly status: LogResultStatus;
    readonly contentStatus: string;
    readonly content?: unknown;
    readonly validationIssues?: unknown;
    readonly diagnostic?: { readonly code?: string; readonly message?: string };
    readonly omittedPaths?: readonly string[];
}

export function compactLogDetail(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value
            .filter((item) => item !== undefined)
            .map((item) => compactLogDetail(item));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([, item]) => item !== undefined)
                .map(([key, item]) => [key, compactLogDetail(item)]),
        );
    }
    return value;
}

function safeUsage(value: unknown): LogUsagePresentation | undefined {
    const usage = asRecord(value);
    if (!Object.keys(usage).length) return undefined;
    const normalized = compactLogDetail({
        inputTokens: finiteNumber(usage.inputTokens ?? usage.promptTokens),
        outputTokens: finiteNumber(usage.outputTokens ?? usage.completionTokens),
        totalTokens: finiteNumber(usage.totalTokens),
    }) as LogUsagePresentation;
    return Object.keys(normalized).length ? normalized : undefined;
}

function safeAgentToolCalls(value: unknown): readonly LogRow[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.map((item) => {
        const call = asRecord(item);
        return compactLogDetail({
            name: typeof call.name === 'string' ? call.name : undefined,
            argumentBytes: finiteNumber(call.argumentBytes),
            arguments: Object.hasOwn(call, 'arguments') ? call.arguments : undefined,
        }) as LogRow;
    });
}

function safeAgentToolResults(value: unknown): readonly LogRow[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.map((item) => {
        const result = asRecord(item);
        return compactLogDetail({
            name: typeof result.name === 'string' ? result.name : undefined,
            ok: typeof result.ok === 'boolean' ? result.ok : undefined,
            resultBytes: finiteNumber(result.resultBytes),
            readCount: finiteNumber(result.readCount),
            resultCount: finiteNumber(result.resultCount),
            truncated: typeof result.truncated === 'boolean' ? result.truncated : undefined,
            reasonCode: isSSHelperReasonCode(result.reasonCode) ? result.reasonCode : undefined,
            content: Object.hasOwn(result, 'content') ? result.content : undefined,
        }) as LogRow;
    });
}

function safeProviderResponseMeta(value: unknown): LogRow | undefined {
    const meta = asRecord(value);
    if (!Object.keys(meta).length) return undefined;
    return compactLogDetail({
        outcome: typeof meta.outcome === 'string' ? meta.outcome : undefined,
        httpStatus: finiteNumber(meta.httpStatus),
        contentType: typeof meta.contentType === 'string' ? meta.contentType : undefined,
        receivedBytes: finiteNumber(meta.receivedBytes),
        streamed: typeof meta.streamed === 'boolean' ? meta.streamed : undefined,
        streamEventCount: finiteNumber(meta.streamEventCount),
        finishReason: typeof meta.finishReason === 'string' ? meta.finishReason : undefined,
        usage: safeUsage(meta.usage),
        latencyMs: finiteNumber(meta.latencyMs),
        receivedAt: finiteNumber(meta.receivedAt),
        providerErrorCode: typeof meta.providerErrorCode === 'string' ? meta.providerErrorCode : undefined,
        providerErrorType: typeof meta.providerErrorType === 'string' ? meta.providerErrorType : undefined,
    }) as LogRow;
}

function finiteNumber(value: unknown): number | undefined {
    const normalized = Number(value);
    return Number.isFinite(normalized) && normalized >= 0 ? normalized : undefined;
}

export function clampLogListWidth(layoutWidth: number, requestedWidth: number, minListWidth = 240, minDetailWidth = 420, splitterWidth = 12): number {
    const safeLayoutWidth = Math.max(0, layoutWidth);
    const maxListWidth = Math.max(minListWidth, safeLayoutWidth - minDetailWidth - splitterWidth);
    return Math.min(maxListWidth, Math.max(minListWidth, requestedWidth));
}

export function presentLogRow(row: LogRow): LogPresentation {
    const request = asRecord(row.request);
    const response = asRecord(row.response);
    const meta = asRecord(response.meta);
    const agent = asRecord(row.agent);
    const providerResponseMeta = asRecord(response.providerResponseMeta);
    const taskKey = text(row.taskKey ?? request.taskKey ?? request.task ?? request.taskKind, '未标记任务');
    const rawKind = text(row.taskKind ?? meta.capabilityKind ?? request.capabilityKind ?? request.kind, '').toLowerCase();
    const taskKind = rawKind in TASK_LABEL
        ? rawKind
        : taskKey.toLowerCase().includes('rerank')
            ? 'rerank'
            : taskKey.toLowerCase().includes('embed')
                ? 'embedding'
                : 'generation';
    const attemptIndex = text(row.attemptIndex, '');
    const attemptTag = ATTEMPT_PHASE_LABEL[text(row.attemptPhase, '')] ?? text(row.attemptTag, '');
    return {
        taskKind,
        taskLabel: TASK_LABEL[taskKind] ?? taskKind,
        taskKey,
        purpose: text(row.taskDescription, taskKind === 'embedding' ? '用途未声明的向量化任务' : taskKind === 'rerank' ? '用途未声明的重排任务' : '用途未声明的生成任务'),
        consumer: text(row.consumerDisplayName ?? row.sourcePluginId ?? row.consumer, '来源未知'),
        entryKind: row.entryKind === 'agent_turn' ? 'agent_turn' : 'provider_attempt',
        state: text(row.state, 'completed'),
        source: text(row.resourceLabel ?? row.providerKind ?? row.provider ?? row.resourceId ?? meta.resourceId, '来源未知'),
        model: text(row.model ?? meta.model, ''),
        latencyMs: finiteNumber(row.latencyMs ?? meta.latencyMs),
        createdAt: row.createdAt ?? row.finishedAt ?? meta.finishedAt ?? row.queuedAt ?? meta.queuedAt,
        attempt: [attemptIndex, attemptTag].filter(Boolean).join(' · ') || '未记录',
        usage: safeUsage(agent.usage)
            ?? safeUsage(providerResponseMeta.usage)
            ?? safeUsage(response.usage)
            ?? safeUsage(meta.usage),
    };
}

export function presentDiagnostic(failure: unknown): { readonly code?: string; readonly message?: string } {
    const code = text(asRecord(failure).reasonCode, '').trim();
    if (!isSSHelperReasonCode(code)) return {};
    const diagnostic = describeSSHelperFailure(failure);
    return {
        code: diagnostic.reasonCode,
        message: `${diagnostic.title}：${diagnostic.reason} ${diagnostic.action}`,
    };
}

export function isRetryAttempt(row: LogRow): boolean {
    return row.attemptTag === '重试' || (finiteNumber(row.attemptIndex) ?? 0) > 1;
}

function resultOmittedPaths(row: LogRow): string[] {
    const paths = asRecord(row.truncated).paths;
    if (!Array.isArray(paths)) return [];
    const resultPaths = new Set(['response.parsedResponse', 'response.normalizedResponse', 'agent.finalOutput']);
    return paths.filter((path): path is string => typeof path === 'string' && resultPaths.has(path));
}

export function presentLogResult(row: LogRow): LogResultPresentation {
    const response = asRecord(row.response);
    const agent = asRecord(row.agent);
    const diagnostic = presentDiagnostic(response.failure);
    const validationIssues = response.validationIssues;
    if (response.normalizedResponse !== undefined) return {
        status: 'validated',
        contentStatus: '结果已通过解析与校验。',
        content: response.normalizedResponse,
    };
    if (agent.finalOutput !== undefined) return {
        status: 'validated',
        contentStatus: '结果已通过解析与校验。',
        content: agent.finalOutput,
    };
    if (response.parsedResponse !== undefined) return {
        status: 'invalid',
        contentStatus: '已显示最后解析内容，但它未通过校验，不能作为有效结果使用。',
        content: response.parsedResponse,
        ...(validationIssues === undefined ? {} : { validationIssues }),
        ...(diagnostic.code || diagnostic.message ? { diagnostic } : {}),
    };
    const responsePreview = response.responsePreview;
    const rawResponseText = typeof response.rawResponseText === 'string' && response.rawResponseText.length > 0
        ? response.rawResponseText
        : undefined;
    if (responsePreview !== undefined || rawResponseText !== undefined) return {
        status: 'failed',
        contentStatus: responsePreview !== undefined
            ? '请求失败；以下是已脱敏的 AI/API 返回开头与结尾片段，可用于定位格式或协议错误，不代表完整输出。'
            : '请求失败；以下是失败前收到并已脱敏的 AI/API 返回内容，可用于定位格式或协议错误。',
        content: responsePreview ?? rawResponseText,
        ...(diagnostic.code || diagnostic.message ? { diagnostic } : {}),
    };
    const omittedPaths = resultOmittedPaths(row);
    if (omittedPaths.length) return {
        status: 'truncated',
        contentStatus: '结果因单条日志大小限制未保存，请查看截断信息。',
        omittedPaths,
    };
    const agentState = text(agent.state, '');
    if (agentState === 'tool_calls') return {
        status: 'awaiting_tools',
        contentStatus: '本轮已返回工具调用，尚非最终结果；请查看后续轮次或流程结果。',
    };
    if (agentState === 'failed' || agentState === 'cancelled' || row.state === 'failed' || row.state === 'cancelled') return {
        status: 'failed',
        contentStatus: agentState === 'cancelled' || row.state === 'cancelled'
            ? '本轮已取消，未产生可展示结果。'
            : '请求失败，Provider 没有返回可展示的最终正文；如果模型只产生推理或非最终片段，这些内容不会作为结果保存。',
        ...(diagnostic.code || diagnostic.message ? { diagnostic } : {}),
    };
    return {
        status: 'unavailable',
        contentStatus: '未记录返回结果。旧日志无法补回；未完成的流程也不会产生结果。',
    };
}

export function presentAgentApiResponse(row: LogRow): LogRow | undefined {
    const agent = asRecord(row.agent);
    if (row.entryKind !== 'agent_turn' && Object.keys(agent).length === 0) return undefined;
    const response = asRecord(row.response);
    const agentState = text(agent.state, '');
    const toolCalls = safeAgentToolCalls(agent.toolCalls);
    const toolResults = safeAgentToolResults(agent.toolResults);
    const hasToolContent = toolCalls?.some(call => Object.hasOwn(call, 'arguments'))
        || toolResults?.some(result => Object.hasOwn(result, 'content'));
    const contentStatus = agentState === 'tool_calls'
        ? hasToolContent
            ? '本轮已返回工具调用，尚非最终结果；已保存的工具参数如下，执行结果可能记录在后续轮次。'
            : '本轮已返回工具调用，尚非最终结果；摘要模式、旧日志或大小降级不会保存工具参数正文。'
        : agentState === 'final'
            ? hasToolContent
                ? '本轮已返回最终内容；已保存的工具执行结果如下，最终内容请在“返回结果”中查看。'
                : '本轮已返回最终内容，请在“返回结果”中查看。'
            : agentState === 'cancelled'
                ? hasToolContent ? '本轮已取消；仍可查看取消前已保存的工具信息。' : '本轮已取消，未产生可用 API 返回内容。'
                : agentState === 'failed' || row.state === 'failed'
                    ? hasToolContent ? '本轮请求失败；仍可查看失败前已保存的工具信息。' : '本轮请求失败，未产生可用 API 返回内容。'
                    : '旧日志未记录 Agent 轮次响应摘要。';
    return compactLogDetail({
        metadata: safeProviderResponseMeta(response.providerResponseMeta),
        agent: {
            state: ['tool_calls', 'final', 'failed', 'cancelled'].includes(agentState) ? agentState : undefined,
            toolSessionRound: finiteNumber(agent.toolSessionRound),
            totalCalls: finiteNumber(agent.totalCalls),
            toolCalls,
            toolResults,
            usage: safeUsage(agent.usage),
            finalOutputMeta: (() => {
                const meta = asRecord(agent.finalOutputMeta);
                return compactLogDetail({
                    valueType: typeof meta.valueType === 'string' ? meta.valueType : undefined,
                    serializedBytes: finiteNumber(meta.serializedBytes),
                    itemCount: finiteNumber(meta.itemCount),
                    keyCount: finiteNumber(meta.keyCount),
                });
            })(),
        },
        truncated: row.truncated,
        redactions: row.redactions,
        contentStatus,
    }) as LogRow;
}

export function presentWorkflowResults(rows: readonly LogRow[]): LogRow {
    const latestByStage = new Map<string, LogRow>();
    const ordered = [...rows].sort((left, right) => Number(left.startedAt ?? left.queuedAt ?? 0) - Number(right.startedAt ?? right.queuedAt ?? 0));
    for (const row of ordered) {
        const workflow = asRecord(row.workflow);
        latestByStage.set(text(workflow.stageKey ?? row.taskKey, '未标记阶段'), row);
    }
    const stages = [...latestByStage.entries()].map(([stageKey, row]) => {
        const workflow = asRecord(row.workflow);
        const agent = asRecord(row.agent);
        const result = presentLogResult(row);
        return compactLogDetail({
            stageKey,
            stage: workflow.stageDescription ?? presentLogRow(row).purpose,
            round: agent.toolSessionRound,
            status: result.status,
            contentStatus: result.contentStatus,
            content: result.content,
            validationIssues: result.validationIssues,
            diagnostic: result.diagnostic,
            omittedPaths: result.omittedPaths,
        });
    });
    const statuses = stages.map(stage => text(asRecord(stage).status, 'unavailable'));
    const status: LogResultStatus = statuses.includes('invalid') ? 'invalid'
        : statuses.includes('failed') ? 'failed'
            : statuses.includes('truncated') ? 'truncated'
                : statuses.includes('awaiting_tools') ? 'awaiting_tools'
                    : statuses.length > 0 && statuses.every(item => item === 'validated') ? 'validated' : 'unavailable';
    const contentStatus = status === 'validated' ? '所有阶段均已返回通过校验的结果。'
        : status === 'invalid' ? '至少一个阶段返回了未通过校验的解析内容。'
            : status === 'failed' ? '至少一个阶段失败且没有可展示的解析结果。'
                : status === 'truncated' ? '至少一个阶段的结果因日志大小限制未保存。'
                    : status === 'awaiting_tools' ? '流程仍在等待工具续轮或最终结果。'
                        : '流程没有可展示的返回结果。';
    return { status, contentStatus, stages };
}
