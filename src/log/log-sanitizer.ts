import type { PlainData } from '@ss-helper/sdk';
import type { LLMLogDetailMode } from '../schema/types';

export const LOG_FORMAT_VERSION = 3 as const;
export const MAX_SINGLE_LOG_BYTES = 4 * 1024 * 1024;
const RESPONSE_PREVIEW_CHARS = 64 * 1024;

const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|private[-_]?key|password|passwd|secret|credential|credentials|headers|requestheaders)$/iu;
const SENSITIVE_QUERY = /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password)=)[^&#\s]*/giu;
const SENSITIVE_AUTH = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu;
const SENSITIVE_DOUBLE_QUOTED_FIELD = /("(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|private[-_]?key|password|passwd|secret|credential|credentials|headers|requestheaders)"\s*:\s*)"(?:\\.|[^"\\])*"/giu;
const SENSITIVE_SINGLE_QUOTED_FIELD = /('(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|private[-_]?key|password|passwd|secret|credential|credentials|headers|requestheaders)'\s*:\s*)'(?:\\.|[^'\\])*'/giu;
const SENSITIVE_TEXT_ASSIGNMENT = /\b(authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|private[-_]?key|password|passwd|secret|credential|credentials|headers|requestheaders)\b(\s*[:=]\s*)(?![\[{])[^\s,;}&]+/giu;
const INTERNAL_REASONING_KEY = /^(?:reasoning_content|reasoningContent|reasoning|thinking)$/iu;
const PROVIDER_REQUEST_ECHO_KEY = 'debugRequest';
const INTERNAL_REASONING_DOUBLE_QUOTED_FIELD = /("(?:reasoning_content|reasoningContent|reasoning|thinking)"\s*:\s*)"(?:\\.|[^"\\])*"/giu;
const INTERNAL_REASONING_SINGLE_QUOTED_FIELD = /('(?:reasoning_content|reasoningContent|reasoning|thinking)'\s*:\s*)'(?:\\.|[^'\\])*'/giu;
const INTERNAL_REASONING_ESCAPED_FIELD = /(\\"(?:reasoning_content|reasoningContent|reasoning|thinking)\\"\s*:\s*\\")(?:\\\\.|[^"\\])*(\\")/giu;
const STREAM_CONTENT_FIELD = /"(?:content|text)"\s*:\s*"((?:\\.|[^"\\])*)"/gu;
const ESCAPED_STREAM_CONTENT_FIELD = /\\"(?:content|text)\\"\s*:\s*\\"((?:\\\\.|[^"\\])*)\\"/gu;
const NO_DISPLAYABLE_STREAM_CONTENT = 'Provider 已返回流式响应，但没有可展示的 assistant content；内部推理与协议字段未记录。';

export interface StoredLogResult {
    readonly value: PlainData;
    readonly storageBytes: number;
    readonly contentMode: 'full' | 'summary';
    readonly redactions: readonly string[];
    readonly truncated?: Record<string, PlainData>;
}

function safeText(value: string): string {
    return value
        .replace(SENSITIVE_QUERY, '$1[已脱敏]')
        .replace(SENSITIVE_AUTH, '$1 [已脱敏]')
        .replace(SENSITIVE_DOUBLE_QUOTED_FIELD, '$1"[已脱敏]"')
        .replace(SENSITIVE_SINGLE_QUOTED_FIELD, "$1'[已脱敏]'")
        .replace(SENSITIVE_TEXT_ASSIGNMENT, '$1$2[已脱敏]')
        .replace(INTERNAL_REASONING_DOUBLE_QUOTED_FIELD, '$1"[未记录]"')
        .replace(INTERNAL_REASONING_SINGLE_QUOTED_FIELD, "$1'[未记录]'")
        .replace(INTERNAL_REASONING_ESCAPED_FIELD, '$1[未记录]$2');
}

function decodeJsonString(value: string): string {
    try { return JSON.parse(`"${value}"`) as string; }
    catch { return value; }
}

function displayableResponseText(raw: string): string {
    if (!/(?:^|\r?\n|\s)data:\s*/u.test(raw)) return raw;
    const content: string[] = [];
    for (const pattern of [STREAM_CONTENT_FIELD, ESCAPED_STREAM_CONTENT_FIELD]) {
        pattern.lastIndex = 0;
        for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) {
            const value = decodeJsonString(match[1] ?? '');
            if (value) content.push(value);
        }
    }
    return content.join('') || NO_DISPLAYABLE_STREAM_CONTENT;
}

function toPlain(value: unknown, path: string, redactions: string[], seen: WeakSet<object>): PlainData {
    if (value === undefined) return null;
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return safeText(value);
    if (typeof value !== 'object') return String(value);
    if (seen.has(value as object)) {
        redactions.push(`${path}:循环引用`);
        return '[循环引用]';
    }
    seen.add(value as object);
    if (Array.isArray(value)) {
        const result = value.map((item, index) => toPlain(item, `${path}[${index}]`, redactions, seen));
        seen.delete(value as object);
        return result;
    }
    const result: Record<string, PlainData> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (nested === undefined) continue;
        const nestedPath = path ? `${path}.${key}` : key;
        if (SENSITIVE_KEY.test(key)) {
            result[key] = '[已脱敏]';
            redactions.push(nestedPath);
            continue;
        }
        if (path === 'response.providerResponse' && key === PROVIDER_REQUEST_ECHO_KEY) {
            result[key] = '[未记录]';
            redactions.push(`${nestedPath}:请求回显`);
            continue;
        }
        if (path.startsWith('response.providerResponse') && INTERNAL_REASONING_KEY.test(key)) {
            result[key] = '[未记录]';
            redactions.push(`${nestedPath}:内部推理`);
            continue;
        }
        result[key] = toPlain(nested, nestedPath, redactions, seen);
    }
    seen.delete(value as object);
    return result;
}

function jsonBytes(value: PlainData): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function usageMetadata(value: unknown): Record<string, unknown> | undefined {
    const usage = record(value);
    if (!usage) return undefined;
    return {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
    };
}

function workflowMetadata(value: unknown): Record<string, unknown> | undefined {
    const workflow = record(value);
    if (!workflow) return undefined;
    return {
        workflowId: workflow.workflowId,
        workflowLabel: workflow.workflowLabel,
        workflowKind: workflow.workflowKind,
        jobId: workflow.jobId,
        batchIndex: workflow.batchIndex,
        batchCount: workflow.batchCount,
        stageKey: workflow.stageKey,
        stageDescription: workflow.stageDescription,
    };
}

function providerRequestMetadata(value: unknown): Record<string, unknown> | undefined {
    const meta = record(value);
    if (!meta) return undefined;
    return {
        requestFormat: meta.requestFormat,
        providerKind: meta.providerKind,
        apiType: meta.apiType,
        operation: meta.operation,
        method: meta.method,
        resourceId: meta.resourceId,
        model: meta.model,
        endpointOrigin: meta.endpointOrigin,
        endpointPath: meta.endpointPath,
        queryParameterNames: meta.queryParameterNames,
        headerNames: meta.headerNames,
        authScheme: meta.authScheme,
        streaming: meta.streaming,
        timeoutMs: meta.timeoutMs,
        idleTimeoutMs: meta.idleTimeoutMs,
        sentAt: meta.sentAt,
        messageCount: meta.messageCount,
        messageRoles: meta.messageRoles,
        inputCharCount: meta.inputCharCount,
        toolCount: meta.toolCount,
        toolNames: meta.toolNames,
        schemaHash: meta.schemaHash,
        structuredTransport: meta.structuredTransport,
        maxTokens: meta.maxTokens,
        temperature: meta.temperature,
        embeddingTextCount: meta.embeddingTextCount,
        rerankDocCount: meta.rerankDocCount,
        dimensions: meta.dimensions,
        topK: meta.topK,
        payloadBytes: meta.payloadBytes,
        customParameterNames: meta.customParameterNames,
    };
}

function providerResponseMetadata(value: unknown): Record<string, unknown> | undefined {
    const meta = record(value);
    if (!meta) return undefined;
    return {
        outcome: meta.outcome,
        httpStatus: meta.httpStatus,
        contentType: meta.contentType,
        receivedBytes: meta.receivedBytes,
        streamed: meta.streamed,
        streamEventCount: meta.streamEventCount,
        finishReason: meta.finishReason,
        usage: usageMetadata(meta.usage),
        latencyMs: meta.latencyMs,
        receivedAt: meta.receivedAt,
        providerErrorCode: meta.providerErrorCode,
        providerErrorType: meta.providerErrorType,
        providerErrorParam: meta.providerErrorParam,
    };
}

function validationIssues(value: unknown): readonly Record<string, unknown>[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.map((item) => {
        const issue = record(item) ?? {};
        return { path: issue.path, keyword: issue.keyword, expected: issue.expected };
    });
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
    const meta = record(value);
    if (!meta) return undefined;
    return {
        stage: meta.stage,
        outcome: meta.outcome,
        responseCharCount: meta.responseCharCount,
        candidateJsonCount: meta.candidateJsonCount,
        parsedRootType: meta.parsedRootType,
        validationIssueCount: meta.validationIssueCount,
        itemRejectionCount: meta.itemRejectionCount,
        issues: validationIssues(meta.issues),
    };
}

function failureMetadata(value: unknown): Record<string, unknown> | undefined {
    const failure = record(value);
    if (!failure) return undefined;
    return {
        reasonCode: failure.reasonCode,
        stage: failure.stage,
        requestId: failure.requestId,
        attemptId: failure.attemptId,
        batchIndex: failure.batchIndex,
        collection: failure.collection,
        path: failure.path,
        keyword: failure.keyword,
        expected: failure.expected,
        httpStatus: failure.httpStatus,
        providerKind: failure.providerKind,
        providerErrorCode: failure.providerErrorCode,
        providerErrorType: failure.providerErrorType,
        providerErrorParam: failure.providerErrorParam,
        resourceId: failure.resourceId,
        model: failure.model,
    };
}

function runMetadata(value: unknown): Record<string, unknown> | undefined {
    const meta = record(value);
    if (!meta) return undefined;
    return {
        requestId: meta.requestId,
        resourceId: meta.resourceId,
        model: meta.model,
        capabilityKind: meta.capabilityKind,
        queuedAt: meta.queuedAt,
        startedAt: meta.startedAt,
        finishedAt: meta.finishedAt,
        latencyMs: meta.latencyMs,
        attemptCount: meta.attemptCount,
        repairCount: meta.repairCount,
        transport: meta.transport,
        validationOutcome: meta.validationOutcome,
        parentRequestId: meta.parentRequestId,
        usage: usageMetadata(meta.usage),
    };
}

function metadata(entry: Record<string, unknown>, response: Record<string, unknown> | undefined): Record<string, unknown> {
    const meta = response?.meta && typeof response.meta === 'object' && !Array.isArray(response.meta) ? response.meta as Record<string, unknown> : undefined;
    const workflow = workflowMetadata(entry.workflow);
    return {
        logId: entry.logId,
        llmTaskId: entry.llmTaskId,
        requestId: entry.requestId,
        parentRequestId: entry.parentRequestId,
        attemptId: entry.attemptId,
        sourcePluginId: entry.sourcePluginId,
        consumer: entry.consumer,
        consumerDisplayName: entry.consumerDisplayName,
        taskKey: entry.taskKey,
        taskDescription: entry.taskDescription,
        taskKind: entry.taskKind,
        entryKind: entry.entryKind ?? 'provider_attempt',
        workflow,
        workflowId: workflow?.workflowId,
        state: entry.state,
        attemptIndex: entry.attemptIndex,
        attemptPhase: entry.attemptPhase,
        plannedTransport: entry.plannedTransport,
        actualTransport: entry.actualTransport,
        attemptTag: entry.attemptTag,
        attemptOutcome: entry.attemptOutcome,
        isFinalAttempt: entry.isFinalAttempt,
        queuedAt: entry.queuedAt,
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt,
        latencyMs: entry.latencyMs,
        createdAt: entry.createdAt ?? entry.finishedAt ?? entry.queuedAt ?? Date.now(),
        resourceId: entry.resourceId ?? meta?.resourceId,
        resourceLabel: entry.resourceLabel,
        model: entry.model ?? meta?.model,
        providerKind: entry.providerKind ?? meta?.provider,
        capabilityKind: meta?.capabilityKind,
        reasonCode: response?.failure && typeof response.failure === 'object' && !Array.isArray(response.failure)
            ? (response.failure as Record<string, unknown>).reasonCode
            : undefined,
    };
}

function summaryValue(entry: Record<string, unknown>, response: Record<string, unknown> | undefined): Record<string, unknown> {
    const request = entry.request && typeof entry.request === 'object' && !Array.isArray(entry.request) ? entry.request as Record<string, unknown> : undefined;
    const responseMeta = response?.meta && typeof response.meta === 'object' && !Array.isArray(response.meta)
        ? response.meta as Record<string, unknown>
        : undefined;
    const schemaHash = typeof request?.schemaHash === 'string' ? request.schemaHash : undefined;
    const failure = failureMetadata(response?.failure);
    return {
        ...metadata(entry, response),
        request: request ? {
            taskKind: request.taskKind,
            schemaHash,
        } : undefined,
        response: response ? {
            usage: responseMeta?.usage,
            failure,
        } : undefined,
        agent: agentMetadata(entry.agent),
    };
}

function agentMetadata(value: unknown, retainContent = false): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const agent = value as Record<string, unknown>;
    const finalOutputMeta = record(agent.finalOutputMeta);
    const calls = Array.isArray(agent.toolCalls) ? agent.toolCalls.map((item) => {
        const call = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
        return {
            callId: call.callId,
            name: call.name,
            argumentBytes: call.argumentBytes ?? jsonBytes(toPlain(call.arguments, '', [], new WeakSet<object>())),
            ...(retainContent && Object.hasOwn(call, 'arguments') ? { arguments: call.arguments } : {}),
        };
    }) : undefined;
    const results = Array.isArray(agent.toolResults) ? agent.toolResults.map((item) => {
        const result = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
        return {
            callId: result.callId,
            name: result.name,
            ok: result.ok,
            resultBytes: result.resultBytes ?? jsonBytes(toPlain(result.content, '', [], new WeakSet<object>())),
            readCount: result.readCount,
            resultCount: result.resultCount,
            truncated: result.truncated,
            reasonCode: result.reasonCode,
            ...(retainContent && Object.hasOwn(result, 'content') ? { content: result.content } : {}),
        };
    }) : undefined;
    return {
        state: agent.state,
        toolSessionId: agent.toolSessionId,
        toolSessionRound: agent.toolSessionRound,
        totalCalls: agent.totalCalls,
        capabilitySnapshotId: agent.capabilitySnapshotId,
        usage: usageMetadata(agent.usage),
        ...(calls ? { toolCalls: calls } : {}),
        ...(results ? { toolResults: results } : {}),
        ...(finalOutputMeta ? { finalOutputMeta: {
            valueType: finalOutputMeta.valueType,
            serializedBytes: finalOutputMeta.serializedBytes,
            itemCount: finalOutputMeta.itemCount,
            keyCount: finalOutputMeta.keyCount,
        } } : Object.hasOwn(agent, 'finalOutput') ? { finalOutputMeta: { valueType: Array.isArray(agent.finalOutput) ? 'array' : typeof agent.finalOutput, serializedBytes: jsonBytes(toPlain(agent.finalOutput, '', [], new WeakSet<object>())) } } : {}),
        ...(retainContent && Object.hasOwn(agent, 'finalOutput') ? { finalOutput: agent.finalOutput } : {}),
    };
}

function fullEntry(entry: Record<string, unknown>): Record<string, unknown> {
    const request = entry.request && typeof entry.request === 'object' && !Array.isArray(entry.request)
        ? entry.request as Record<string, unknown>
        : undefined;
    const response = entry.response && typeof entry.response === 'object' && !Array.isArray(entry.response)
        ? entry.response as Record<string, unknown>
        : undefined;
    const structuredOutput = record(request?.structuredOutput);
    const manualRetryRepair = record(structuredOutput?.manualRetryRepair);
    const resolvedMaxTokens = record(request?.resolvedMaxTokens);
    const metrics = record(request?.metrics);
    const rawResponseText = typeof response?.rawResponseText === 'string'
        ? displayableResponseText(response.rawResponseText)
        : undefined;
    return {
        ...metadata(entry, response),
        ...(request ? { request: {
            taskKind: request.taskKind,
            taskDescription: request.taskDescription,
            schemaHash: request.schemaHash,
            structuredOutput: structuredOutput ? {
                vendor: structuredOutput.vendor,
                confidence: structuredOutput.confidence,
                transport: structuredOutput.transport,
                strictSchemaCompatible: structuredOutput.strictSchemaCompatible,
                contextMode: structuredOutput.contextMode,
                nativeJsonMode: structuredOutput.nativeJsonMode,
                nativeSchemaSent: structuredOutput.nativeSchemaSent,
                manualRetryRepair: manualRetryRepair ? {
                    reasonCode: manualRetryRepair.reasonCode,
                    state: manualRetryRepair.state,
                } : undefined,
            } : undefined,
            resolvedMaxTokens: resolvedMaxTokens ? { value: resolvedMaxTokens.value, source: resolvedMaxTokens.source } : undefined,
            providerRequestMeta: providerRequestMetadata(request.providerRequestMeta),
            normalizeMode: request.normalizeMode,
            rerankTopK: request.rerankTopK,
            metrics: metrics ? {
                messageCount: metrics.messageCount,
                embeddingTextCount: metrics.embeddingTextCount,
                rerankDocCount: metrics.rerankDocCount,
                schemaCharCount: metrics.schemaCharCount,
                inputCharCount: metrics.inputCharCount,
                outputCharCount: metrics.outputCharCount,
            } : undefined,
        } } : {}),
        ...(response ? { response: {
            meta: runMetadata(response.meta),
            failure: failureMetadata(response.failure),
            validationIssues: validationIssues(response.validationIssues),
            rawResponseText,
            providerResponse: response.providerResponse,
            parsedResponse: response.parsedResponse,
            normalizedResponse: response.normalizedResponse,
            providerResponseMeta: providerResponseMetadata(response.providerResponseMeta),
            parseMeta: parseMetadata(response.parseMeta),
        } } : {}),
        agent: agentMetadata(entry.agent, true),
    };
}

function responsePreview(value: Record<string, PlainData>): Record<string, PlainData> | undefined {
    const response = record(value.response);
    const raw = response?.rawResponseText;
    if (typeof raw !== 'string' || raw.length === 0) return undefined;
    const prefix = raw.slice(0, RESPONSE_PREVIEW_CHARS);
    const suffix = raw.length > RESPONSE_PREVIEW_CHARS ? raw.slice(-RESPONSE_PREVIEW_CHARS) : undefined;
    const retainedBytes = new TextEncoder().encode(prefix).byteLength
        + (suffix === undefined ? 0 : new TextEncoder().encode(suffix).byteLength);
    return {
        kind: 'truncated_text',
        prefix,
        ...(suffix === undefined ? {} : { suffix }),
        originalBytes: new TextEncoder().encode(raw).byteLength,
        retainedBytes,
    };
}

export function buildStoredLog(entry: Record<string, unknown>, mode: LLMLogDetailMode): StoredLogResult | null {
    if (mode === 'off') return null;
    const response = entry.response && typeof entry.response === 'object' && !Array.isArray(entry.response) ? entry.response as Record<string, unknown> : undefined;
    const redactions: string[] = [];
    const retainFull = mode === 'full' || (mode === 'failed-full' && entry.state === 'failed');
    const raw = retainFull ? { ...fullEntry(entry), ...metadata(entry, response) } : summaryValue(entry, response);
    const value = toPlain({
        ...raw,
        logFormatVersion: LOG_FORMAT_VERSION,
        contentMode: retainFull ? 'full' : 'summary',
    }, '', redactions, new WeakSet<object>()) as Record<string, PlainData>;
    let size = jsonBytes(value);
    if (size > MAX_SINGLE_LOG_BYTES) {
        const originalBytes = size;
        const preview = retainFull ? responsePreview(value) : undefined;
        const omitted = retainFull ? [
            'response.rawResponseText',
            'response.providerResponse',
            'response.parsedResponse',
            'response.normalizedResponse',
            'agent.toolCalls[*].arguments',
            'agent.toolResults[*].content',
            'agent.finalOutput',
            'request.providerRequestMeta',
            'response.providerResponseMeta',
            'response.parseMeta',
        ] : [];
        const fallback = toPlain({
            ...summaryValue(entry, response),
            ...(preview ? { response: {
                ...record(summaryValue(entry, response).response),
                responsePreview: preview,
            } } : {}),
            agent: agentMetadata(entry.agent),
            logFormatVersion: LOG_FORMAT_VERSION,
            contentMode: 'summary',
            truncated: {
                reason: 'single_record_limit',
                originalBytes,
                maxBytes: MAX_SINGLE_LOG_BYTES,
                omitted,
                paths: omitted,
            },
        }, '', redactions, new WeakSet<object>()) as Record<string, PlainData>;
        size = jsonBytes(fallback);
        return { value: fallback, storageBytes: size, contentMode: 'summary', redactions, truncated: { reason: 'single_record_limit', originalBytes, maxBytes: MAX_SINGLE_LOG_BYTES, paths: omitted } };
    }
    value.redactions = redactions.length ? redactions : [];
    value.storageBytes = size;
    size = jsonBytes(value);
    value.storageBytes = size;
    return { value, storageBytes: size, contentMode: retainFull ? 'full' : 'summary', redactions };
}

export function sanitizeStoredLogForRead(value: unknown): PlainData {
    const sanitized = toPlain(value, '', [], new WeakSet<object>());
    const root = record(sanitized);
    const response = record(root?.response);
    if (!response) return sanitized;
    if (typeof response.rawResponseText === 'string') response.rawResponseText = displayableResponseText(response.rawResponseText);
    const preview = record(response.responsePreview);
    if (preview) {
        if (typeof preview.prefix === 'string') preview.prefix = displayableResponseText(preview.prefix);
        if (typeof preview.suffix === 'string') preview.suffix = displayableResponseText(preview.suffix);
    }
    return sanitized;
}
