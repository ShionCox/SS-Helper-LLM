import { logger } from '../runtime/logger';
import { isSSHelperReasonCode } from '@ss-helper/sdk';
import type { LlmWorkspaceRepository } from '../storage/llm-workspace-repository';
import type {
    LLMRequestLogEntry,
    LLMRequestLogQueryOptions,
    LLMRequestLogRequestSnapshot,
    LLMRequestLogResponseSnapshot,
    LLMRunResult,
    RequestRecord,
    RequestState,
} from '../schema/types';

const REQUEST_LOG_MAX_RECORDS = 2000;
const ARCHIVABLE_STATES = new Set<RequestState>(['cancelled']);
const FALLBACK_SOURCE_PLUGIN_ID = 'stx_llmhub';
const memoryLogs: LLMRequestLogEntry[] = [];

function normalizeOptionalText(value: unknown): string | undefined {
    const normalized = String(value || '').trim();
    return normalized || undefined;
}

function upsertMemoryLog(entry: LLMRequestLogEntry): void {
    const existing = memoryLogs.findIndex((row) => row.logId === entry.logId);
    if (existing >= 0) memoryLogs.splice(existing, 1, entry);
    else memoryLogs.unshift(entry);
    if (memoryLogs.length > REQUEST_LOG_MAX_RECORDS) memoryLogs.length = REQUEST_LOG_MAX_RECORDS;
}

function filterMemoryLogs(opts?: LLMRequestLogQueryOptions): LLMRequestLogEntry[] {
    return memoryLogs
        .filter((row) => !opts?.sourcePluginId || row.sourcePluginId === opts.sourcePluginId)
        .filter((row) => !opts?.state || opts.state === 'all' || row.state === opts.state)
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

    async listLogs(opts?: LLMRequestLogQueryOptions): Promise<LLMRequestLogEntry[]> {
        const persisted = this.workspaceRepository && typeof this.workspaceRepository.queryLogs === 'function'
            ? (await this.workspaceRepository.queryLogs(opts)).filter((row) => Boolean((row as Record<string, unknown>).requestId && (row as Record<string, unknown>).logId)) as unknown as LLMRequestLogEntry[]
            : [];
        const rows = new Map<string, LLMRequestLogEntry>(persisted.map((row) => [row.logId, row]));
        for (const row of filterMemoryLogs(opts)) rows.set(row.logId, row);
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
        const requestSnapshot = {
            taskKind: record.taskKind,
            ...(record.requestLogSnapshot?.schemaSummary
                ? { schemaSummary: record.requestLogSnapshot.schemaSummary }
                : {}),
            ...(record.requestLogSnapshot?.schemaHash
                ? { schemaHash: record.requestLogSnapshot.schemaHash }
                : {}),
        } as LLMRequestLogRequestSnapshot;
        const finishedAt = input.state === 'completed' || input.state === 'failed' || input.state === 'cancelled'
            ? (record.finishedAt ?? Date.now())
            : undefined;
        const latencyMs = finishedAt && record.startedAt ? Math.max(0, finishedAt - record.startedAt) : undefined;
        return {
            logId: attemptId,
            llmTaskId: record.llmTaskId,
            requestId: record.requestId,
            parentRequestId: record.enqueueOptions.parentRequestId,
            attemptId,
            sourcePluginId,
            consumer: record.consumer,
            taskKey: record.taskKey,
            taskDescription: record.taskDescription,
            taskKind: record.taskKind,
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
        const requestSnapshot = {
            taskKind: record.taskKind,
            ...(record.requestLogSnapshot?.schemaSummary
                ? { schemaSummary: record.requestLogSnapshot.schemaSummary }
                : {}),
            ...(record.requestLogSnapshot?.schemaHash
                ? { schemaHash: record.requestLogSnapshot.schemaHash }
                : {}),
        } as LLMRequestLogRequestSnapshot;
        const responseSnapshot = this.buildLogResponseSnapshot(record);
        const latencyMs = record.finishedAt && record.startedAt ? Math.max(0, record.finishedAt - record.startedAt) : undefined;
        const logEntry: LLMRequestLogEntry = {
            // An active Provider attempt already owns a queued/running row. Cancellation
            // terminalizes that row instead of appending a second row with the same attemptId.
            logId: record.activeAttemptRequestId ?? `${record.requestId}_${record.finishedAt || Date.now()}`,
            llmTaskId: record.llmTaskId,
            requestId: record.requestId,
            parentRequestId: record.enqueueOptions.parentRequestId,
            attemptId: record.activeAttemptRequestId ?? record.requestId,
            sourcePluginId,
            consumer: record.consumer,
            taskKey: record.taskKey,
            taskDescription: record.taskDescription,
            taskKind: record.taskKind,
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
                fallbackUsed: record.meta.fallbackUsed,
                usage: record.meta.usage,
            }
            : undefined;

        return {
            meta,
            ...(record.debug?.failure === undefined ? {} : { failure: record.debug.failure }),
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
                fallbackUsed: result.meta.fallbackUsed,
                usage: result.meta.usage,
            }
            : undefined;

        const failure = !result.ok ? result.failure ?? record.debug?.failure : undefined;
        return {
            meta,
            ...(failure !== undefined
                ? { failure }
                : !result.ok && isSSHelperReasonCode(result.reasonCode)
                    ? {
                        failure: {
                            reasonCode: result.reasonCode,
                            stage: 'llm.request',
                            requestId: record.requestId,
                            ...(record.activeAttemptRequestId ? { attemptId: record.activeAttemptRequestId } : {}),
                        },
                    }
                    : {}),
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
                upsertMemoryLog(logEntry);
            }
            logger.success('[RequestLog][PersistSuccess]', {
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
            upsertMemoryLog(logEntry);
        }
    }
}
