import type { PlainData } from '@ss-helper/sdk';
import type { LLMLogDetailMode } from '../schema/types';

export const LOG_FORMAT_VERSION = 2 as const;
export const MAX_SINGLE_LOG_BYTES = 4 * 1024 * 1024;

const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|private[-_]?key|password|passwd|secret|credential|credentials|headers|requestheaders)$/iu;
const SENSITIVE_QUERY = /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password)=)[^&#\s]*/giu;
const SENSITIVE_AUTH = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu;

export interface StoredLogResult {
    readonly value: PlainData;
    readonly storageBytes: number;
    readonly contentMode: 'full' | 'summary';
    readonly redactions: readonly string[];
    readonly truncated?: Record<string, PlainData>;
}

function safeText(value: string): string {
    return value.replace(SENSITIVE_QUERY, '$1[已脱敏]').replace(SENSITIVE_AUTH, '$1 [已脱敏]');
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
        result[key] = toPlain(nested, nestedPath, redactions, seen);
    }
    seen.delete(value as object);
    return result;
}

function jsonBytes(value: PlainData): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function metadata(entry: Record<string, unknown>, response: Record<string, unknown> | undefined): Record<string, unknown> {
    const meta = response?.meta && typeof response.meta === 'object' && !Array.isArray(response.meta) ? response.meta as Record<string, unknown> : undefined;
    return {
        logId: entry.logId,
        llmTaskId: entry.llmTaskId,
        requestId: entry.requestId,
        sourcePluginId: entry.sourcePluginId,
        consumer: entry.consumer,
        taskKey: entry.taskKey,
        taskDescription: entry.taskDescription,
        taskKind: entry.taskKind,
        state: entry.state,
        attemptIndex: entry.attemptIndex,
        attemptTag: entry.attemptTag,
        attemptOutcome: entry.attemptOutcome,
        isFinalAttempt: entry.isFinalAttempt,
        chatKey: entry.chatKey,
        sessionId: entry.sessionId,
        queuedAt: entry.queuedAt,
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt,
        latencyMs: entry.latencyMs,
        createdAt: entry.createdAt ?? entry.finishedAt ?? entry.queuedAt ?? Date.now(),
        resourceId: meta?.resourceId,
        model: meta?.model,
        provider: meta?.provider,
        capabilityKind: meta?.capabilityKind,
        reasonCode: response?.reasonCode,
    };
}

function summaryValue(entry: Record<string, unknown>, response: Record<string, unknown> | undefined): Record<string, unknown> {
    const request = entry.request && typeof entry.request === 'object' && !Array.isArray(entry.request) ? entry.request as Record<string, unknown> : undefined;
    const metrics = request?.metrics && typeof request.metrics === 'object' && !Array.isArray(request.metrics) ? request.metrics : undefined;
    return {
        ...metadata(entry, response),
        request: request ? {
            taskKind: request.taskKind,
            taskDescription: request.taskDescription,
            routeHint: request.routeHint,
            budget: request.budget,
            schemaSummary: request.schemaSummary,
            responseFormatResolved: request.responseFormatResolved,
            resolvedMaxTokens: request.resolvedMaxTokens,
            normalizeMode: request.normalizeMode,
            metrics,
        } : undefined,
        response: response ? {
            meta: response.meta,
            reasonCode: response.reasonCode,
            finalError: response.finalError,
            validationErrors: response.validationErrors,
        } : undefined,
    };
}

export function buildStoredLog(entry: Record<string, unknown>, mode: LLMLogDetailMode): StoredLogResult | null {
    if (mode === 'off') return null;
    const response = entry.response && typeof entry.response === 'object' && !Array.isArray(entry.response) ? entry.response as Record<string, unknown> : undefined;
    const full = mode === 'full' || (mode === 'failed-full' && entry.state === 'failed');
    const redactions: string[] = [];
    const raw = full ? {
        ...metadata(entry, response),
        request: entry.request,
        response,
    } : summaryValue(entry, response);
    const value = toPlain({
        ...raw,
        logFormatVersion: LOG_FORMAT_VERSION,
        contentMode: full ? 'full' : 'summary',
    }, '', redactions, new WeakSet<object>()) as Record<string, PlainData>;
    let size = jsonBytes(value);
    if (full && size > MAX_SINGLE_LOG_BYTES) {
        const fallback = toPlain({
            ...summaryValue(entry, response),
            logFormatVersion: LOG_FORMAT_VERSION,
            contentMode: 'summary',
            truncated: {
                reason: 'single_record_limit',
                originalBytes: size,
                maxBytes: MAX_SINGLE_LOG_BYTES,
                omitted: ['request.generationInput', 'request.embeddingTexts', 'request.rerankDocs', 'request.providerRequest', 'response.rawResponseText', 'response.providerResponse', 'response.parsedResponse', 'response.normalizedResponse'],
            },
        }, '', redactions, new WeakSet<object>()) as Record<string, PlainData>;
        size = jsonBytes(fallback);
        return { value: fallback, storageBytes: size, contentMode: 'summary', redactions, truncated: { reason: 'single_record_limit', originalBytes: value.storageBytes ?? size, maxBytes: MAX_SINGLE_LOG_BYTES } };
    }
    value.redactions = redactions.length ? redactions : [];
    value.storageBytes = size;
    size = jsonBytes(value);
    value.storageBytes = size;
    return { value, storageBytes: size, contentMode: full ? 'full' : 'summary', redactions };
}
