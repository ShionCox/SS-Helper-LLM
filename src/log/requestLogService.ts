import { logger } from '../runtime/logger';
import {
    isSSHelperReasonCode,
    type LlmToolTurnRequest,
    type LlmToolTurnResponse,
    type SSHelperFailureContext,
} from '@ss-helper/sdk';
import type { LlmWorkspaceRepository } from '../storage/llm-workspace-repository';
import { buildStoredLog, sanitizeStoredLogForRead } from './log-sanitizer';
import type {
    LLMRequestLogEntry,
    LLMRequestLogQueryOptions,
    LLMRequestLogRequestSnapshot,
    LLMRequestLogResponseSnapshot,
    LLMRunResult,
    RequestRecord,
    RequestState,
    LLMRequestLogRouteSnapshot,
    LLMProviderRequestMetadata,
    LLMProviderResponseMetadata,
    LLMParseMetadata,
    LLMRequestLogValueMetadata,
    LLMLogDetailMode,
} from '../schema/types';

const REQUEST_LOG_MAX_RECORDS = 2000;
const ARCHIVABLE_STATES = new Set<RequestState>(['cancelled']);
const FALLBACK_SOURCE_PLUGIN_ID = 'stx_llmhub';
const memoryLogs: LLMRequestLogEntry[] = [];

function normalizeOptionalText(value: unknown): string | undefined {
    const normalized = String(value || '').trim();
    return normalized || undefined;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function jsonBytes(value: unknown): number {
    try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return 0; }
}

function numeric(value: unknown): number | undefined {
    const result = Number(value);
    return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function isAgentWorkflow(entry: Pick<LLMRequestLogEntry, 'workflow'>): boolean {
    return entry.workflow?.workflowKind === 'agent';
}

function valueMetadata(value: unknown): LLMRequestLogValueMetadata {
    const record = plainRecord(value);
    const valueType = value === null ? 'null'
        : Array.isArray(value) ? 'array'
            : typeof value === 'object' ? 'object'
                : ['string', 'number', 'boolean'].includes(typeof value) ? typeof value as 'string' | 'number' | 'boolean'
                    : 'unknown';
    return {
        valueType,
        serializedBytes: jsonBytes(value),
        ...(Array.isArray(value) ? { itemCount: value.length } : {}),
        ...(record ? { keyCount: Object.keys(record).length } : {}),
    };
}

function requestMetadata(record: RequestRecord, plannedTransport?: string): LLMProviderRequestMetadata {
    const snapshot = record.requestLogSnapshot;
    const providerRequest = plainRecord(snapshot?.providerRequest);
    const requestParams = plainRecord(providerRequest?.requestParams);
    const payload = plainRecord(providerRequest?.payload) ?? providerRequest;
    const generationInput = plainRecord(snapshot?.generationInput);
    const budget = plainRecord(snapshot?.budget);
    const messages = Array.isArray(payload?.messages)
        ? payload.messages
        : Array.isArray(generationInput?.messages) ? generationInput.messages : [];
    const messageRecords = messages.map(plainRecord).filter((item): item is Record<string, unknown> => item !== undefined);
    const tools = Array.isArray(payload?.tools) ? payload.tools.map(plainRecord).filter((item): item is Record<string, unknown> => item !== undefined) : [];
    const embeddingTexts = Array.isArray(snapshot?.embeddingTexts) ? snapshot.embeddingTexts : [];
    const rerankDocs = Array.isArray(snapshot?.rerankDocs) ? snapshot.rerankDocs : [];
    const route = record.routeSnapshot;
    const authScheme = route?.resourceId === 'tavern:active' ? 'none'
        : route?.apiType === 'claude' || route?.apiType === 'gemini' ? 'api_key'
            : route?.apiType ? 'bearer' : 'unknown';
    const headerNames = authScheme === 'none' ? []
        : authScheme === 'api_key' ? ['content-type', route?.apiType === 'claude' ? 'x-api-key' : 'x-goog-api-key']
            : authScheme === 'bearer' ? ['authorization', 'content-type'] : [];
    const inputCharCount = numeric(snapshot?.metrics?.inputCharCount)
        ?? messageRecords.reduce((sum, message) => sum + String(message.content ?? '').length, 0)
        + embeddingTexts.reduce((sum, text) => sum + text.length, 0)
        + String(snapshot?.rerankQuery ?? '').length
        + rerankDocs.reduce((sum, text) => sum + text.length, 0);
    return {
        requestFormat: normalizeOptionalText(providerRequest?.requestFormat) ?? `${record.taskKind}_request`,
        operation: record.taskKind === 'embedding' ? 'embeddings' : record.taskKind === 'rerank' ? 'rerank' : 'generation',
        method: 'POST',
        ...(route?.providerKind ? { providerKind: route.providerKind } : {}),
        ...(route?.apiType ? { apiType: route.apiType } : {}),
        ...(route?.resourceId ? { resourceId: route.resourceId } : {}),
        ...(route?.model ? { model: route.model } : normalizeOptionalText(payload?.model ?? requestParams?.model) ? { model: String(payload?.model ?? requestParams?.model) } : {}),
        ...(route?.endpointOrigin ? { endpointOrigin: route.endpointOrigin } : {}),
        ...(route?.endpointPath ? { endpointPath: route.endpointPath } : {}),
        ...(route?.queryParameterNames?.length ? { queryParameterNames: [...route.queryParameterNames] } : {}),
        ...(headerNames.length ? { headerNames } : {}),
        authScheme,
        ...(route?.streaming === undefined ? {} : { streaming: route.streaming }),
        ...(numeric(requestParams?.timeoutMs ?? budget?.maxLatencyMs) === undefined ? {} : { timeoutMs: numeric(requestParams?.timeoutMs ?? budget?.maxLatencyMs)! }),
        ...(route?.streaming === true ? { idleTimeoutMs: 30_000 } : {}),
        ...(record.startedAt ? { sentAt: record.startedAt } : {}),
        ...(messageRecords.length ? { messageCount: messageRecords.length, messageRoles: messageRecords.map(item => String(item.role ?? 'unknown')) } : {}),
        inputCharCount,
        ...(tools.length ? { toolCount: tools.length, toolNames: tools.map(tool => String(plainRecord(tool.function)?.name ?? tool.name ?? 'unknown')) } : {}),
        ...(snapshot?.schemaHash ? { schemaHash: snapshot.schemaHash } : {}),
        ...(plannedTransport ?? snapshot?.structuredOutput?.transport ? { structuredTransport: plannedTransport ?? snapshot?.structuredOutput?.transport } : {}),
        ...(numeric(payload?.max_tokens ?? payload?.maxTokens ?? requestParams?.maxTokens) === undefined ? {} : { maxTokens: numeric(payload?.max_tokens ?? payload?.maxTokens ?? requestParams?.maxTokens)! }),
        ...(numeric(payload?.temperature ?? requestParams?.temperature) === undefined ? {} : { temperature: numeric(payload?.temperature ?? requestParams?.temperature)! }),
        ...(embeddingTexts.length ? { embeddingTextCount: embeddingTexts.length } : numeric(snapshot?.metrics?.embeddingTextCount) === undefined ? {} : { embeddingTextCount: numeric(snapshot?.metrics?.embeddingTextCount)! }),
        ...(rerankDocs.length ? { rerankDocCount: rerankDocs.length } : numeric(snapshot?.metrics?.rerankDocCount) === undefined ? {} : { rerankDocCount: numeric(snapshot?.metrics?.rerankDocCount)! }),
        ...(numeric(payload?.dimensions) === undefined ? {} : { dimensions: numeric(payload?.dimensions)! }),
        ...(numeric(snapshot?.rerankTopK ?? payload?.topK ?? payload?.top_n) === undefined ? {} : { topK: numeric(snapshot?.rerankTopK ?? payload?.topK ?? payload?.top_n)! }),
        ...(providerRequest ? { payloadBytes: jsonBytes(providerRequest) } : {}),
        ...(route?.customParameterNames?.length ? { customParameterNames: [...route.customParameterNames] } : {}),
    };
}

function responseOutcome(failure?: SSHelperFailureContext): LLMProviderResponseMetadata['outcome'] {
    if (!failure) return 'success';
    if (failure.reasonCode === 'STRUCTURED_OUTPUT_EMPTY') return 'empty';
    if (failure.reasonCode === 'INVALID_JSON') return 'invalid_json';
    if (failure.reasonCode === 'SCHEMA_VALIDATION_FAILED') return 'schema_error';
    if (failure.reasonCode === 'HTTP_REQUEST_TIMEOUT') return 'timeout';
    if (failure.reasonCode === 'REQUEST_ABORTED' || failure.reasonCode === 'HTTP_REQUEST_ABORTED' || failure.reasonCode === 'BUS_CALLER_ABORTED' || failure.reasonCode === 'CANCELLED') return 'cancelled';
    if (failure.reasonCode === 'PROVIDER_RESPONSE_INVALID' || failure.reasonCode === 'HTTP_RESPONSE_PROTOCOL_INVALID') return 'protocol_error';
    if (failure.httpStatus !== undefined) return 'http_error';
    if (failure.stage.includes('network') || failure.stage.includes('connection')) return 'network_error';
    return 'unknown_error';
}

function responseMetadata(record: RequestRecord, failure?: SSHelperFailureContext, meta?: LLMRequestLogResponseSnapshot['meta']): LLMProviderResponseMetadata {
    const providerResponse = plainRecord(record.debug?.providerResponse);
    const usage = plainRecord(providerResponse?.usage);
    const diagnostics = plainRecord(providerResponse?.diagnostics);
    const receivedBytes = numeric(diagnostics?.receivedBytes) ?? (record.debug?.rawResponseText !== undefined
        ? new TextEncoder().encode(record.debug.rawResponseText).byteLength
        : record.debug?.providerResponse === undefined ? undefined : jsonBytes(record.debug.providerResponse));
    return {
        outcome: responseOutcome(failure),
        ...(failure?.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : numeric(diagnostics?.httpStatus) === undefined ? {} : { httpStatus: numeric(diagnostics?.httpStatus)! }),
        ...(normalizeOptionalText(diagnostics?.contentType) ? { contentType: String(diagnostics?.contentType) } : {}),
        ...(receivedBytes === undefined ? {} : { receivedBytes }),
        ...(typeof diagnostics?.streamed === 'boolean' ? { streamed: diagnostics.streamed } : record.routeSnapshot?.streaming === undefined ? {} : { streamed: record.routeSnapshot.streaming }),
        ...(numeric(diagnostics?.streamEventCount) === undefined ? {} : { streamEventCount: numeric(diagnostics?.streamEventCount)! }),
        ...(normalizeOptionalText(providerResponse?.finishReason ?? providerResponse?.finish_reason) ? { finishReason: String(providerResponse?.finishReason ?? providerResponse?.finish_reason) } : {}),
        ...(meta?.usage ? { usage: meta.usage } : usage ? { usage: {
            ...(numeric(usage.promptTokens ?? usage.prompt_tokens) === undefined ? {} : { promptTokens: numeric(usage.promptTokens ?? usage.prompt_tokens) }),
            ...(numeric(usage.completionTokens ?? usage.completion_tokens) === undefined ? {} : { completionTokens: numeric(usage.completionTokens ?? usage.completion_tokens) }),
            ...(numeric(usage.totalTokens ?? usage.total_tokens) === undefined ? {} : { totalTokens: numeric(usage.totalTokens ?? usage.total_tokens) }),
        } } : {}),
        ...(meta?.latencyMs === undefined ? {} : { latencyMs: meta.latencyMs }),
        receivedAt: numeric(diagnostics?.receivedAt) ?? meta?.finishedAt ?? record.finishedAt ?? Date.now(),
        ...(failure?.providerErrorCode ? { providerErrorCode: failure.providerErrorCode } : {}),
        ...(failure?.providerErrorType ? { providerErrorType: failure.providerErrorType } : {}),
        ...(failure?.providerErrorParam ? { providerErrorParam: failure.providerErrorParam } : {}),
    };
}

function parseMetadata(record: RequestRecord, failure?: SSHelperFailureContext): LLMParseMetadata {
    const reason = failure?.reasonCode;
    const outcome: LLMParseMetadata['outcome'] = record.taskKind !== 'generation' ? 'not_applicable'
        : reason === 'STRUCTURED_OUTPUT_EMPTY' ? 'empty'
            : reason === 'INVALID_JSON' ? 'invalid_json'
                : reason === 'SCHEMA_VALIDATION_FAILED' ? 'schema_error'
                    : reason === 'PROVIDER_RESPONSE_INVALID' || reason === 'HTTP_RESPONSE_PROTOCOL_INVALID' ? 'protocol_error'
                        : failure ? 'not_applicable' : 'success';
    const issues = (record.debug?.validationIssues ?? []).map(issue => ({ path: issue.path, keyword: issue.keyword, expected: issue.expected }));
    return {
        stage: failure?.stage ?? (record.taskKind === 'generation' ? 'llm.provider.response' : `llm.${record.taskKind}.response`),
        outcome,
        ...(numeric(record.requestLogSnapshot?.metrics?.outputCharCount) === undefined ? {} : { responseCharCount: numeric(record.requestLogSnapshot?.metrics?.outputCharCount)! }),
        ...(record.taskKind === 'generation' ? { candidateJsonCount: outcome === 'success' || outcome === 'schema_error' ? 1 : 0 } : {}),
        ...(record.debug?.parsedResponse !== undefined ? { parsedRootType: Array.isArray(record.debug.parsedResponse) ? 'array' : record.debug.parsedResponse !== null && typeof record.debug.parsedResponse === 'object' ? 'object' : 'scalar' } : {}),
        ...(issues.length ? { validationIssueCount: issues.length, issues } : {}),
        ...(record.debug?.itemRejections?.length ? { itemRejectionCount: record.debug.itemRejections.length } : {}),
    };
}

interface MemoryLogPolicy {
    readonly mode: LLMLogDetailMode;
    readonly maxEntries: number;
    readonly retentionDays?: number;
    readonly maxBytes?: number;
}

function upsertMemoryLog(entry: LLMRequestLogEntry, policy: MemoryLogPolicy): void {
    const existing = memoryLogs.findIndex((row) => row.logId === entry.logId);
    if (existing >= 0) memoryLogs.splice(existing, 1, entry);
    else memoryLogs.unshift(entry);
    const cutoff = policy.retentionDays === undefined ? undefined : Date.now() - policy.retentionDays * 86_400_000;
    if (cutoff !== undefined) {
        for (let index = memoryLogs.length - 1; index >= 0; index -= 1) {
            const createdAt = numeric((memoryLogs[index] as unknown as Record<string, unknown>).createdAt);
            if (createdAt !== undefined && createdAt < cutoff) memoryLogs.splice(index, 1);
        }
    }
    const maxEntries = Math.max(1, Math.min(REQUEST_LOG_MAX_RECORDS, policy.maxEntries));
    if (memoryLogs.length > maxEntries) memoryLogs.length = maxEntries;
    if (policy.maxBytes !== undefined) {
        let totalBytes = memoryLogs.reduce((sum, row) => sum + (numeric((row as unknown as Record<string, unknown>).storageBytes) ?? jsonBytes(row)), 0);
        while (memoryLogs.length > 1 && totalBytes > policy.maxBytes) {
            const removed = memoryLogs.pop()!;
            totalBytes -= numeric((removed as unknown as Record<string, unknown>).storageBytes) ?? jsonBytes(removed);
        }
    }
}

function upsertSanitizedMemoryLog(entry: LLMRequestLogEntry, policy: MemoryLogPolicy): void {
    const stored = buildStoredLog(entry as unknown as Record<string, unknown>, policy.mode);
    if (stored) upsertMemoryLog(stored.value as unknown as LLMRequestLogEntry, policy);
}

function filterMemoryLogs(opts?: LLMRequestLogQueryOptions): LLMRequestLogEntry[] {
    return memoryLogs
        .filter((row) => !opts?.sourcePluginId || row.sourcePluginId === opts.sourcePluginId)
        .filter((row) => !opts?.state || opts.state === 'all' || row.state === opts.state)
        .filter((row) => !opts?.taskKind || row.taskKind === opts.taskKind)
        .filter((row) => !opts?.resourceId || row.resourceId === opts.resourceId)
        .filter((row) => !opts?.model || row.model === opts.model)
        .filter((row) => !opts?.entryKind || opts.entryKind === 'all' || (row.entryKind ?? 'provider_attempt') === opts.entryKind)
        .filter((row) => !opts?.callScope || opts.callScope === 'all' || (opts.callScope === 'agent_workflow' ? isAgentWorkflow(row) : !isAgentWorkflow(row)))
        .filter((row) => !opts?.workflowId || row.workflow?.workflowId === opts.workflowId)
        .filter((row) => !opts?.reasonCode || row.response.failure?.reasonCode === opts.reasonCode)
        .filter((row) => !opts?.search || JSON.stringify(row).toLowerCase().includes(opts.search.toLowerCase()));
}




type AttemptTag = LLMRequestLogEntry['attemptTag'];
type AttemptOutcome = NonNullable<LLMRequestLogEntry['attemptOutcome']>;
type AttemptPhase = LLMRequestLogEntry['attemptPhase'];

export interface RecordAttemptInput {
    record: RequestRecord;
    requestId: string;
    result: LLMRunResult<unknown>;
    attemptTag: AttemptTag;
    attemptOutcome: AttemptOutcome;
    isFinalAttempt: boolean;
    attemptPhase?: AttemptPhase;
    plannedTransport?: LLMRequestLogEntry['plannedTransport'];
    actualTransport?: LLMRequestLogEntry['actualTransport'];
}

export class RequestLogService {
    constructor(private readonly workspaceRepository?: LlmWorkspaceRepository) {}

    private async memoryLogPolicy(): Promise<MemoryLogPolicy> {
        if (!this.workspaceRepository) return { mode: 'full', maxEntries: REQUEST_LOG_MAX_RECORDS };
        try {
            const logging = (await this.workspaceRepository.loadSettings()).requestLogging;
            return {
                mode: logging?.enabled === false ? 'off' : logging?.detailMode ?? 'full',
                maxEntries: logging?.maxEntries ?? REQUEST_LOG_MAX_RECORDS,
                retentionDays: logging?.retentionDays,
                maxBytes: logging?.maxBytes,
            };
        } catch {
            return { mode: 'summary', maxEntries: REQUEST_LOG_MAX_RECORDS };
        }
    }

    async listLogs(opts?: LLMRequestLogQueryOptions): Promise<LLMRequestLogEntry[]> {
        const persisted = this.workspaceRepository && typeof this.workspaceRepository.queryLogs === 'function'
            ? (await this.workspaceRepository.queryLogs(opts)).filter((row) => Boolean((row as Record<string, unknown>).requestId && (row as Record<string, unknown>).logId)) as unknown as LLMRequestLogEntry[]
            : [];
        const rows = new Map<string, LLMRequestLogEntry>(persisted.map((row) => [row.logId, sanitizeStoredLogForRead(row) as unknown as LLMRequestLogEntry]));
        for (const row of filterMemoryLogs(opts)) rows.set(row.logId, sanitizeStoredLogForRead(row) as unknown as LLMRequestLogEntry);
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 100;
        return [...rows.values()].sort((left, right) => right.queuedAt - left.queuedAt).slice(offset, offset + limit);
    }

    async clearLogs(): Promise<number> {
        const localCount = memoryLogs.length;
        memoryLogs.length = 0;
        if (this.workspaceRepository && typeof this.workspaceRepository.clearLogs === 'function') {
            return (await this.workspaceRepository.clearLogs()) + localCount;
        }
        return localCount;
    }

    async beginAttempt(input: {
        record: RequestRecord;
        attemptId: string;
        attemptPhase: AttemptPhase;
        plannedTransport?: LLMRequestLogEntry['plannedTransport'];
    }): Promise<void> {
        const entry = this.buildAttemptEntry({
            record: input.record,
            attemptId: input.attemptId,
            state: 'queued',
            attemptPhase: input.attemptPhase,
            plannedTransport: input.plannedTransport,
            isFinalAttempt: false,
        });
        await this.persistLogEntry(entry);
    }

    async markAttemptRunning(input: {
        record: RequestRecord;
        attemptId: string;
        attemptPhase: AttemptPhase;
        plannedTransport?: LLMRequestLogEntry['plannedTransport'];
    }): Promise<void> {
        const entry = this.buildAttemptEntry({
            record: input.record,
            attemptId: input.attemptId,
            state: 'running',
            attemptPhase: input.attemptPhase,
            plannedTransport: input.plannedTransport,
            isFinalAttempt: false,
        });
        await this.persistLogEntry(entry);
    }

    async recordAttempt(input: RecordAttemptInput): Promise<void> {
        const { record, requestId: attemptId, result, attemptTag, attemptOutcome, isFinalAttempt } = input;
        const logEntry = this.buildAttemptEntry({
            record,
            attemptId,
            state: result.ok ? 'completed' : result.reasonCode === 'CANCELLED' ? 'cancelled' : 'failed',
            attemptPhase: input.attemptPhase ?? record.activeAttemptPhase ?? (record.attemptIndex > 1 ? 'transient_retry' : 'initial'),
            plannedTransport: input.plannedTransport,
            actualTransport: input.actualTransport,
            attemptOutcome,
            isFinalAttempt,
            response: this.buildResultResponseSnapshot(record, result),
        });
        logEntry.attemptTag = attemptTag;
        await this.persistLogEntry(logEntry);
    }

    async recordUnattemptedRequest(record: RequestRecord, result: LLMRunResult<unknown>): Promise<void> {
        if (record.activeAttemptRequestId) return;
        const attemptId = record.requestId;
        const logEntry = this.buildAttemptEntry({
            record,
            attemptId,
            state: result.ok ? 'completed' : result.reasonCode === 'CANCELLED' ? 'cancelled' : 'failed',
            attemptPhase: 'initial',
            attemptOutcome: result.ok ? '成功' : result.reasonCode === 'CANCELLED' ? '取消' : '失败',
            isFinalAttempt: true,
            response: this.buildResultResponseSnapshot(record, result),
        });
        await this.persistLogEntry(logEntry);
    }

    async recordAgentTurn(input: {
        request: LlmToolTurnRequest;
        response?: LlmToolTurnResponse;
        failure?: SSHelperFailureContext;
        parsedResponse?: unknown;
        rawResponseText?: string;
        providerResponse?: unknown;
        validationIssues?: LLMRequestLogResponseSnapshot['validationIssues'];
        callerPluginId: string;
        consumerDisplayName?: string;
        taskDescription: string;
        requestId: string;
        route?: LLMRequestLogRouteSnapshot;
        toolSessionRound?: number;
        startedAt: number;
        finishedAt?: number;
        phase?: 'started' | 'finished';
    }): Promise<void> {
        const pending = input.phase === 'started';
        const finishedAt = pending ? undefined : input.finishedAt ?? Date.now();
        const response = input.response;
        const providerResponse = plainRecord(input.providerResponse);
        const providerDiagnostics = plainRecord(providerResponse?.diagnostics);
        const providerUsage = plainRecord(providerResponse?.usage);
        const parsedResponse = input.parsedResponse !== undefined
            ? input.parsedResponse
            : response?.state === 'final' ? response.output : undefined;
        const round = response?.diagnostics.toolSessionRound ?? input.toolSessionRound ?? (input.request.toolSessionId ? 2 : 1);
        const route: LLMRequestLogRouteSnapshot | undefined = input.route ?? (response ? {
            resourceId: response.route.resourceId ?? 'unknown',
            resourceLabel: response.route.resourceId ?? 'unknown',
            ...(response.route.model === undefined ? {} : { model: response.route.model }),
            ...(response.route.provider === undefined ? {} : { providerKind: response.route.provider }),
        } : undefined);
        const workflow = input.request.trace ?? {
            workflowId: input.request.pipelineRunId,
            workflowLabel: 'Agent 工具流程',
            workflowKind: 'agent',
            stageKey: input.request.task,
            stageDescription: input.taskDescription,
        };
        const cancelled = input.failure?.reasonCode === 'CANCELLED'
            || input.failure?.reasonCode === 'REQUEST_ABORTED'
            || input.failure?.reasonCode === 'HTTP_REQUEST_ABORTED'
            || input.failure?.reasonCode === 'BUS_CALLER_ABORTED';
        const state: RequestState = pending ? 'running' : input.failure ? (cancelled ? 'cancelled' : 'failed') : 'completed';
        const toolCalls = response?.state === 'tool_calls' ? response.calls.map(call => ({
            callId: call.callId,
            name: call.name,
            argumentBytes: jsonBytes(call.arguments),
            arguments: call.arguments,
        })) : undefined;
        const toolResults = input.request.toolResults?.map(result => {
            const content = plainRecord(result.content);
            return {
                callId: result.callId,
                name: result.name,
                ok: result.ok,
                resultBytes: jsonBytes(result.content),
                ...(Array.isArray(content?.readSet) ? { readCount: content.readSet.length } : {}),
                ...(Array.isArray(plainRecord(content?.data)?.items) ? { resultCount: (plainRecord(content?.data)!.items as unknown[]).length } : {}),
                ...(typeof content?.truncated === 'boolean' ? { truncated: content.truncated } : {}),
                ...(normalizeOptionalText(plainRecord(content?.failure)?.reasonCode) ? { reasonCode: String(plainRecord(content?.failure)?.reasonCode) } : {}),
                content: result.content,
            };
        });
        const requestMessages = Array.isArray(plainRecord(input.request.input)?.messages)
            ? (plainRecord(input.request.input)!.messages as unknown[]).map(plainRecord).filter((item): item is Record<string, unknown> => item !== undefined)
            : [];
        const requestMeta: LLMProviderRequestMetadata = {
            requestFormat: 'agent_tool_turn',
            operation: 'tool_turn',
            method: 'POST',
            ...(route?.providerKind ? { providerKind: route.providerKind } : {}),
            ...(route?.apiType ? { apiType: route.apiType } : {}),
            ...(route?.resourceId ? { resourceId: route.resourceId } : {}),
            ...(route?.model ? { model: route.model } : {}),
            ...(route?.endpointOrigin ? { endpointOrigin: route.endpointOrigin } : {}),
            ...(route?.endpointPath ? { endpointPath: route.endpointPath } : {}),
            ...(route?.queryParameterNames?.length ? { queryParameterNames: [...route.queryParameterNames] } : {}),
            ...(route?.customParameterNames?.length ? { customParameterNames: [...route.customParameterNames] } : {}),
            ...(route?.streaming === undefined ? {} : { streaming: route.streaming }),
            timeoutMs: 180_000,
            ...(route?.streaming === true ? { idleTimeoutMs: 30_000 } : {}),
            headerNames: route?.apiType === 'claude' ? ['content-type', 'x-api-key']
                : route?.apiType === 'gemini' ? ['content-type', 'x-goog-api-key']
                    : ['authorization', 'content-type'],
            authScheme: route?.apiType === 'claude' || route?.apiType === 'gemini' ? 'api_key' : 'bearer',
            sentAt: input.startedAt,
            ...(requestMessages.length ? {
                messageCount: requestMessages.length,
                messageRoles: requestMessages.map(message => String(message.role ?? 'unknown')),
                inputCharCount: requestMessages.reduce((sum, message) => sum + String(message.content ?? '').length, 0),
            } : { inputCharCount: input.request.input === undefined ? 0 : JSON.stringify(input.request.input).length }),
            ...(input.request.tools?.length ? { toolCount: input.request.tools.length, toolNames: input.request.tools.map(tool => tool.name) } : {}),
            payloadBytes: jsonBytes(input.request.input),
        };
        const responseMeta: LLMProviderResponseMetadata = {
            outcome: responseOutcome(input.failure),
            ...(input.failure?.httpStatus === undefined ? {} : { httpStatus: input.failure.httpStatus }),
            ...(typeof providerDiagnostics?.contentType === 'string' ? { contentType: providerDiagnostics.contentType } : {}),
            ...(response ? { receivedBytes: jsonBytes(response), finishReason: response.state }
                : typeof input.rawResponseText === 'string' ? { receivedBytes: new TextEncoder().encode(input.rawResponseText).byteLength }
                    : typeof providerDiagnostics?.receivedBytes === 'number' ? { receivedBytes: providerDiagnostics.receivedBytes } : {}),
            ...(route?.streaming === undefined ? {} : { streamed: route.streaming }),
            ...(response?.usage ? { usage: response.usage } : providerUsage ? { usage: {
                ...(numeric(providerUsage.inputTokens ?? providerUsage.promptTokens ?? providerUsage.prompt_tokens) === undefined ? {} : { promptTokens: numeric(providerUsage.inputTokens ?? providerUsage.promptTokens ?? providerUsage.prompt_tokens) }),
                ...(numeric(providerUsage.outputTokens ?? providerUsage.completionTokens ?? providerUsage.completion_tokens) === undefined ? {} : { completionTokens: numeric(providerUsage.outputTokens ?? providerUsage.completionTokens ?? providerUsage.completion_tokens) }),
                ...(numeric(providerUsage.totalTokens ?? providerUsage.total_tokens) === undefined ? {} : { totalTokens: numeric(providerUsage.totalTokens ?? providerUsage.total_tokens) }),
            } } : {}),
            ...(finishedAt === undefined ? {} : { latencyMs: Math.max(0, finishedAt - input.startedAt), receivedAt: finishedAt }),
            ...(input.failure?.providerErrorCode ? { providerErrorCode: input.failure.providerErrorCode } : {}),
            ...(input.failure?.providerErrorType ? { providerErrorType: input.failure.providerErrorType } : {}),
            ...(input.failure?.providerErrorParam ? { providerErrorParam: input.failure.providerErrorParam } : {}),
        };
        const parseMeta: LLMParseMetadata = {
            stage: input.failure?.stage ?? 'llm.tools.turn.final',
            outcome: input.failure?.reasonCode === 'INVALID_JSON' ? 'invalid_json'
                : input.failure?.reasonCode === 'SCHEMA_VALIDATION_FAILED' ? 'schema_error'
                    : input.failure?.reasonCode === 'STRUCTURED_OUTPUT_EMPTY' ? 'empty'
                        : (input.failure?.reasonCode === 'PROVIDER_RESPONSE_INVALID' || input.failure?.reasonCode === 'HTTP_RESPONSE_PROTOCOL_INVALID') ? 'protocol_error'
                            : response?.state === 'final' ? 'success' : 'not_applicable',
            ...(parsedResponse === undefined ? {} : { responseCharCount: JSON.stringify(parsedResponse).length }),
        };
        const logEntry: LLMRequestLogEntry = {
            entryKind: 'agent_turn',
            logId: input.requestId,
            llmTaskId: `${workflow.workflowId}:${input.request.task}:${round}`,
            requestId: input.requestId,
            ...(input.request.parentRequestId ? { parentRequestId: input.request.parentRequestId } : {}),
            attemptId: input.requestId,
            sourcePluginId: input.callerPluginId || FALLBACK_SOURCE_PLUGIN_ID,
            consumer: input.callerPluginId || FALLBACK_SOURCE_PLUGIN_ID,
            ...(input.consumerDisplayName ? { consumerDisplayName: input.consumerDisplayName } : {}),
            taskKey: input.request.task,
            taskDescription: input.taskDescription,
            taskKind: 'generation',
            ...(route?.resourceId ? { resourceId: route.resourceId } : {}),
            ...(route?.resourceLabel ? { resourceLabel: route.resourceLabel } : {}),
            ...(route?.model ? { model: route.model } : {}),
            ...(route?.providerKind ? { providerKind: route.providerKind } : {}),
            workflow,
            ...(pending ? {} : { agent: {
                state: input.failure ? (cancelled ? 'cancelled' : 'failed') : response!.state,
                ...(response?.state === 'tool_calls' ? { toolSessionId: response.toolSessionId } : {}),
                ...(toolCalls?.length ? { toolCalls } : {}),
                ...(input.request.toolSessionId ? { toolSessionId: input.request.toolSessionId } : {}),
                ...(toolResults?.length ? { toolResults } : {}),
                ...(!input.failure && response?.state === 'final' ? { finalOutputMeta: valueMetadata(response.output), finalOutput: response.output } : {}),
                toolSessionRound: round,
                totalCalls: response?.diagnostics.totalCalls ?? 0,
                ...(response?.diagnostics.capabilitySnapshotId ? { capabilitySnapshotId: response.diagnostics.capabilitySnapshotId } : {}),
                ...(response?.usage ? { usage: response.usage } : {}),
            } }),
            state,
            attemptIndex: round,
            attemptPhase: round > 1 ? 'transient_retry' : 'initial',
            attemptTag: round > 1 ? '重试' : '初次请求',
            ...(pending ? {} : { attemptOutcome: input.failure ? (cancelled ? '取消' : '失败') : '成功' }),
            isFinalAttempt: pending ? false : Boolean(input.failure || response?.state === 'final'),
            chatKey: input.request.chatKey,
            queuedAt: input.startedAt,
            startedAt: input.startedAt,
            ...(finishedAt === undefined ? {} : { finishedAt, latencyMs: Math.max(0, finishedAt - input.startedAt) }),
            request: {
                taskKind: 'generation',
                taskDescription: input.taskDescription,
                providerRequestMeta: requestMeta,
                metrics: {
                    inputCharCount: requestMeta.inputCharCount ?? 0,
                },
            },
            response: pending ? {} : {
                ...(route ? { meta: { requestId: input.requestId, resourceId: route.resourceId, model: route.model, capabilityKind: 'generation', startedAt: input.startedAt, finishedAt: finishedAt!, latencyMs: Math.max(0, finishedAt! - input.startedAt) } } : {}),
                ...(input.failure ? { failure: input.failure } : {}),
                ...(input.validationIssues?.length ? { validationIssues: input.validationIssues } : {}),
                ...(input.rawResponseText === undefined ? {} : { rawResponseText: input.rawResponseText }),
                ...(input.providerResponse === undefined ? {} : { providerResponse: input.providerResponse }),
                ...(parsedResponse === undefined ? {} : { parsedResponse }),
                ...(!input.failure && response?.state === 'final' ? { normalizedResponse: response.output } : {}),
                providerResponseMeta: responseMeta,
                parseMeta,
            },
        };
        await this.persistLogEntry(logEntry);
    }

    private buildAttemptEntry(input: {
        record: RequestRecord;
        attemptId: string;
        state: RequestState;
        attemptPhase: AttemptPhase;
        plannedTransport?: LLMRequestLogEntry['plannedTransport'];
        actualTransport?: LLMRequestLogEntry['actualTransport'];
        attemptOutcome?: AttemptOutcome;
        isFinalAttempt: boolean;
        response?: LLMRequestLogResponseSnapshot;
    }): LLMRequestLogEntry {
        const { record, attemptId } = input;
        const sourcePluginId = normalizeOptionalText(record.scope?.pluginId) || normalizeOptionalText(record.consumer) || FALLBACK_SOURCE_PLUGIN_ID;
        const chatKey = normalizeOptionalText(record.chatKey);
        const sessionId = normalizeOptionalText(record.scope?.sessionId);
        const requestSnapshot = this.buildRequestSnapshot(record, input.plannedTransport);
        const finishedAt = input.state === 'completed' || input.state === 'failed' || input.state === 'cancelled'
            ? (record.finishedAt ?? Date.now())
            : undefined;
        const latencyMs = finishedAt && record.startedAt ? Math.max(0, finishedAt - record.startedAt) : undefined;
        return {
            entryKind: 'provider_attempt',
            logId: attemptId,
            llmTaskId: record.llmTaskId,
            requestId: record.requestId,
            parentRequestId: record.enqueueOptions.parentRequestId,
            attemptId,
            sourcePluginId,
            consumer: record.consumer,
            ...(record.consumerDisplayName ? { consumerDisplayName: record.consumerDisplayName } : {}),
            taskKey: record.taskKey,
            taskDescription: record.taskDescription,
            taskKind: record.taskKind,
            ...(record.routeSnapshot?.resourceId ? { resourceId: record.routeSnapshot.resourceId } : {}),
            ...(record.routeSnapshot?.resourceLabel ? { resourceLabel: record.routeSnapshot.resourceLabel } : {}),
            ...(record.routeSnapshot?.model ? { model: record.routeSnapshot.model } : {}),
            ...(record.routeSnapshot?.providerKind ? { providerKind: record.routeSnapshot.providerKind } : {}),
            ...(record.workflow ? { workflow: record.workflow } : {}),
            state: input.state,
            attemptIndex: Math.max(1, Number(record.attemptIndex || 1)),
            attemptPhase: input.attemptPhase,
            attemptTag: record.attemptIndex > 1 ? '重试' : '初次请求',
            attemptOutcome: input.attemptOutcome,
            isFinalAttempt: input.isFinalAttempt,
            plannedTransport: input.plannedTransport,
            actualTransport: input.actualTransport,
            chatKey,
            sessionId,
            queuedAt: record.queuedAt,
            startedAt: record.startedAt,
            finishedAt,
            latencyMs,
            request: requestSnapshot,
            response: input.response ?? {},
        };
    }

    async archiveRecord(record: RequestRecord): Promise<void> {
        if (!ARCHIVABLE_STATES.has(record.state as RequestState)) return;

        const sourcePluginId = normalizeOptionalText(record.scope?.pluginId) || normalizeOptionalText(record.consumer) || FALLBACK_SOURCE_PLUGIN_ID;
        const chatKey = normalizeOptionalText(record.chatKey);
        const sessionId = normalizeOptionalText(record.scope?.sessionId);
        const requestSnapshot = this.buildRequestSnapshot(record);
        const responseSnapshot = this.buildLogResponseSnapshot(record);
        const latencyMs = record.finishedAt && record.startedAt ? Math.max(0, record.finishedAt - record.startedAt) : undefined;
        const logEntry: LLMRequestLogEntry = {
            entryKind: 'provider_attempt',
            // An active Provider attempt already owns a queued/running row. Cancellation
            // terminalizes that row instead of appending a second row with the same attemptId.
            logId: record.activeAttemptRequestId ?? `${record.requestId}_${record.finishedAt || Date.now()}`,
            llmTaskId: record.llmTaskId,
            requestId: record.requestId,
            parentRequestId: record.enqueueOptions.parentRequestId,
            attemptId: record.activeAttemptRequestId ?? record.requestId,
            sourcePluginId,
            consumer: record.consumer,
            ...(record.consumerDisplayName ? { consumerDisplayName: record.consumerDisplayName } : {}),
            taskKey: record.taskKey,
            taskDescription: record.taskDescription,
            taskKind: record.taskKind,
            ...(record.routeSnapshot?.resourceId ? { resourceId: record.routeSnapshot.resourceId } : {}),
            ...(record.routeSnapshot?.resourceLabel ? { resourceLabel: record.routeSnapshot.resourceLabel } : {}),
            ...(record.routeSnapshot?.model ? { model: record.routeSnapshot.model } : {}),
            ...(record.routeSnapshot?.providerKind ? { providerKind: record.routeSnapshot.providerKind } : {}),
            ...(record.workflow ? { workflow: record.workflow } : {}),
            state: record.state as RequestState,
            attemptIndex: Math.max(1, Number(record.attemptIndex || 1)),
            attemptPhase: record.activeAttemptPhase ?? (record.attemptIndex > 1 ? 'transient_retry' : 'initial'),
            attemptTag: record.attemptIndex > 1 ? '重试' : '初次请求',
            attemptOutcome: '取消',
            isFinalAttempt: true,
            chatKey,
            sessionId,
            queuedAt: record.queuedAt,
            startedAt: record.startedAt,
            finishedAt: record.finishedAt,
            latencyMs,
            request: requestSnapshot,
            response: responseSnapshot,
        };

        await this.persistLogEntry(logEntry);
    }

    private buildLogResponseSnapshot(record: RequestRecord): LLMRequestLogResponseSnapshot {
        const meta = record.meta
            ? {
                requestId: record.meta.requestId,
                resourceId: record.meta.resourceId,
                model: record.meta.model,
                capabilityKind: record.meta.capabilityKind,
                queuedAt: record.meta.queuedAt,
                startedAt: record.meta.startedAt,
                finishedAt: record.meta.finishedAt,
                latencyMs: record.meta.latencyMs,
                usage: record.meta.usage,
            }
            : undefined;

        const failure = record.debug?.failure;
        return {
            meta,
            ...(failure === undefined ? {} : { failure }),
            ...(record.debug?.rawResponseText === undefined ? {} : { rawResponseText: record.debug.rawResponseText }),
            ...(record.debug?.providerResponse === undefined ? {} : { providerResponse: record.debug.providerResponse }),
            ...(record.debug?.parsedResponse === undefined ? {} : { parsedResponse: record.debug.parsedResponse }),
            ...(record.debug?.normalizedResponse === undefined ? {} : { normalizedResponse: record.debug.normalizedResponse }),
            providerResponseMeta: responseMetadata(record, failure, meta),
            parseMeta: parseMetadata(record, failure),
        };
    }

    private buildResultResponseSnapshot(record: RequestRecord, result: LLMRunResult<unknown>): LLMRequestLogResponseSnapshot {
        const meta = result.meta
            ? {
                requestId: result.meta.requestId,
                resourceId: result.meta.resourceId,
                model: result.meta.model,
                capabilityKind: result.meta.capabilityKind,
                queuedAt: result.meta.queuedAt,
                startedAt: result.meta.startedAt,
                finishedAt: result.meta.finishedAt,
                latencyMs: result.meta.latencyMs,
                usage: result.meta.usage,
            }
            : undefined;

        const failure: SSHelperFailureContext | undefined = !result.ok
            ? result.failure ?? record.debug?.failure ?? {
                reasonCode: isSSHelperReasonCode(result.reasonCode) ? result.reasonCode : 'INTERNAL_ERROR',
                stage: 'llm.request',
                requestId: record.requestId,
                ...(record.activeAttemptRequestId ? { attemptId: record.activeAttemptRequestId } : {}),
            }
            : undefined;
        return {
            meta,
            ...(failure !== undefined ? { failure } : {}),
            ...(record.debug?.rawResponseText === undefined ? {} : { rawResponseText: record.debug.rawResponseText }),
            ...(record.debug?.providerResponse === undefined ? {} : { providerResponse: record.debug.providerResponse }),
            ...(record.debug?.parsedResponse === undefined ? {} : { parsedResponse: record.debug.parsedResponse }),
            ...(record.debug?.normalizedResponse === undefined ? {} : { normalizedResponse: record.debug.normalizedResponse }),
            providerResponseMeta: responseMetadata(record, failure, meta),
            parseMeta: parseMetadata(record, failure),
        };
    }

    private buildRequestSnapshot(record: RequestRecord, plannedTransport?: string): LLMRequestLogRequestSnapshot {
        const snapshot = record.requestLogSnapshot;
        return {
            taskKind: record.taskKind,
            ...(record.taskDescription ? { taskDescription: record.taskDescription } : {}),
            ...(snapshot?.schemaSummary ? { schemaSummary: snapshot.schemaSummary } : {}),
            ...(snapshot?.schemaHash ? { schemaHash: snapshot.schemaHash } : {}),
            ...(snapshot?.structuredOutput ? { structuredOutput: snapshot.structuredOutput } : {}),
            ...(snapshot?.resolvedMaxTokens ? { resolvedMaxTokens: { value: snapshot.resolvedMaxTokens.value, source: snapshot.resolvedMaxTokens.source } } : {}),
            providerRequestMeta: requestMetadata(record, plannedTransport),
            metrics: {
                ...(snapshot?.metrics?.messageCount === undefined ? {} : { messageCount: snapshot.metrics.messageCount }),
                ...(snapshot?.metrics?.embeddingTextCount === undefined ? {} : { embeddingTextCount: snapshot.metrics.embeddingTextCount }),
                ...(snapshot?.metrics?.rerankDocCount === undefined ? {} : { rerankDocCount: snapshot.metrics.rerankDocCount }),
                ...(snapshot?.metrics?.schemaCharCount === undefined ? {} : { schemaCharCount: snapshot.metrics.schemaCharCount }),
                ...(snapshot?.metrics?.inputCharCount === undefined ? {} : { inputCharCount: snapshot.metrics.inputCharCount }),
                ...(snapshot?.metrics?.outputCharCount === undefined ? {} : { outputCharCount: snapshot.metrics.outputCharCount }),
            },
        };
    }

    private async persistLogEntry(logEntry: LLMRequestLogEntry): Promise<void> {
        logger.info('[RequestLog][PersistStart]', {
            llmTaskId: logEntry.llmTaskId,
            requestId: logEntry.requestId,
            logId: logEntry.logId,
            sourcePluginId: logEntry.sourcePluginId,
            consumer: logEntry.consumer,
            taskKey: logEntry.taskKey,
            state: logEntry.state,
            attemptIndex: logEntry.attemptIndex,
            attemptTag: logEntry.attemptTag,
            attemptOutcome: logEntry.attemptOutcome,
            chatKey: logEntry.chatKey || '(none)',
            reasonCode: logEntry.response?.failure?.reasonCode,
        });

        try {
            if (this.workspaceRepository) {
                await this.workspaceRepository.saveLog(logEntry as unknown as Record<string, unknown> as never);
            } else {
                upsertSanitizedMemoryLog(logEntry, await this.memoryLogPolicy());
            }
            logger.info('[RequestLog][Persisted]', {
                llmTaskId: logEntry.llmTaskId,
                requestId: logEntry.requestId,
                logId: logEntry.logId,
                state: logEntry.state,
                taskKey: logEntry.taskKey,
                attemptIndex: logEntry.attemptIndex,
                attemptTag: logEntry.attemptTag,
                attemptOutcome: logEntry.attemptOutcome,
            });
        } catch (error: unknown) {
            logger.error('[RequestLog][PersistFail]', {
                llmTaskId: logEntry.llmTaskId,
                requestId: logEntry.requestId,
                logId: logEntry.logId,
                state: logEntry.state,
                taskKey: logEntry.taskKey,
                attemptIndex: logEntry.attemptIndex,
                reasonCode: 'LOG_UNAVAILABLE',
            });
            // Logging is diagnostic infrastructure.  Keep a bounded local
            // copy for this session, but never discard a provider result or
            // issue a duplicate paid request solely because SQLite is down.
            upsertSanitizedMemoryLog(logEntry, await this.memoryLogPolicy());
        }
    }
}
