import { logger } from '../runtime/logger';
import type { LlmWorkspaceRepository } from '../storage/llm-workspace-repository';
import type {
    CapabilityKind,
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

function normalizeOptionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 功能：将数据库中的任务类型值归一化为受控类型。
 * @param value 原始任务类型
 * @returns 归一化后的任务类型
 */
function normalizeTaskKind(value: unknown): CapabilityKind {
    const normalized = String(value || '').trim();
    if (normalized === 'embedding' || normalized === 'rerank') {
        return normalized;
    }
    return 'generation';
}

/**
 * 功能：将日志中的中间状态归一化为最终展示状态。
 * @param value 原始状态值。
 * @returns 归一化后的状态。
 */
function normalizeLogState(value: unknown): RequestState {
    const normalized = String(value || '').trim();
    if (normalized === 'overlay_waiting' || normalized === 'result_ready') {
        return 'completed';
    }
    if (normalized === 'queued' || normalized === 'running' || normalized === 'completed' || normalized === 'failed' || normalized === 'cancelled') {
        return normalized;
    }
    return 'completed';
}

type AttemptTag = LLMRequestLogEntry['attemptTag'];
type AttemptOutcome = LLMRequestLogEntry['attemptOutcome'];

export interface RecordAttemptInput {
    record: RequestRecord;
    requestId: string;
    result: LLMRunResult<unknown>;
    attemptTag: AttemptTag;
    attemptOutcome: AttemptOutcome;
    isFinalAttempt: boolean;
}

export class RequestLogService {
    constructor(private readonly workspaceRepository?: LlmWorkspaceRepository) {}

    async listLogs(opts?: LLMRequestLogQueryOptions): Promise<LLMRequestLogEntry[]> {
        if (this.workspaceRepository) return (await this.workspaceRepository.queryLogs(opts)).filter((row) => Boolean((row as Record<string, unknown>).requestId && (row as Record<string, unknown>).logId)) as unknown as LLMRequestLogEntry[];
        const rows = memoryLogs.slice().sort((a, b) => b.queuedAt - a.queuedAt).filter((row) => !opts?.sourcePluginId || row.sourcePluginId === opts.sourcePluginId).filter((row) => !opts?.state || opts.state === 'all' || row.state === opts.state).filter((row) => !opts?.search || JSON.stringify(row).toLowerCase().includes(opts.search.toLowerCase())).slice(opts?.offset ?? 0, (opts?.offset ?? 0) + (opts?.limit ?? 100));
        return rows;
    }

    async clearLogs(): Promise<number> {
        if (this.workspaceRepository) return this.workspaceRepository.clearLogs();
        const count = memoryLogs.length; memoryLogs.length = 0; return count;
    }

    async recordAttempt(input: RecordAttemptInput): Promise<void> {
        const { record, requestId, result, attemptTag, attemptOutcome, isFinalAttempt } = input;
        if (record.validity.isCancelled || record.validity.isSuperseded || record.validity.isObsolete) {
            return;
        }
        const sourcePluginId = normalizeOptionalText(record.scope?.pluginId) || normalizeOptionalText(record.consumer) || FALLBACK_SOURCE_PLUGIN_ID;
        const chatKey = normalizeOptionalText(record.chatKey);
        const sessionId = normalizeOptionalText(record.scope?.sessionId);
        const requestSnapshot = {
            ...(record.requestLogSnapshot || {
                taskKind: record.taskKind,
                taskDescription: record.taskDescription,
            }),
        } as LLMRequestLogRequestSnapshot;
        const responseSnapshot = this.buildResultResponseSnapshot(record, result);
        const latencyMs = record.finishedAt && record.startedAt ? Math.max(0, record.finishedAt - record.startedAt) : undefined;
        const logEntry: LLMRequestLogEntry = {
            logId: `${requestId}_${record.finishedAt || Date.now()}`,
            llmTaskId: record.llmTaskId,
            requestId,
            sourcePluginId,
            consumer: record.consumer,
            taskKey: record.taskKey,
            taskDescription: record.taskDescription,
            taskKind: record.taskKind,
            state: result.ok ? 'completed' : 'failed',
            attemptIndex: Math.max(1, Number(record.attemptIndex || 1)),
            attemptTag,
            attemptOutcome,
            isFinalAttempt,
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

    async archiveRecord(record: RequestRecord): Promise<void> {
        if (!ARCHIVABLE_STATES.has(record.state as RequestState)) {
            logger.info('[RequestLog][PersistSkip]', {
                llmTaskId: record.llmTaskId,
                requestId: record.requestId,
                consumer: record.consumer,
                taskKey: record.taskKey,
                state: record.state,
                reason: 'state_not_archivable',
            });
            return;
        }

        const sourcePluginId = normalizeOptionalText(record.scope?.pluginId) || normalizeOptionalText(record.consumer) || FALLBACK_SOURCE_PLUGIN_ID;
        const chatKey = normalizeOptionalText(record.chatKey);
        const sessionId = normalizeOptionalText(record.scope?.sessionId);
        const requestSnapshot = {
            ...(record.requestLogSnapshot || {
                taskKind: record.taskKind,
                taskDescription: record.taskDescription,
            }),
        } as LLMRequestLogRequestSnapshot;
        const responseSnapshot = this.buildLogResponseSnapshot(record);
        const latencyMs = record.finishedAt && record.startedAt ? Math.max(0, record.finishedAt - record.startedAt) : undefined;
        const logEntry: LLMRequestLogEntry = {
            logId: `${record.requestId}_${record.finishedAt || Date.now()}`,
            llmTaskId: record.llmTaskId,
            requestId: record.requestId,
            sourcePluginId,
            consumer: record.consumer,
            taskKey: record.taskKey,
            taskDescription: record.taskDescription,
            taskKind: record.taskKind,
            state: record.state as RequestState,
            attemptIndex: Math.max(1, Number(record.attemptIndex || 1)),
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
            }
            : undefined;

        return {
            meta,
            finalError: record.debug?.finalError,
            reasonCode: record.debug?.reasonCode,
            validationErrors: Array.isArray(record.debug?.validationErrors) ? record.debug?.validationErrors.slice(0, 50) : undefined,
            rawResponseText: record.debug?.rawResponseText,
            providerResponse: record.debug?.providerResponse,
            parsedResponse: record.debug?.parsedResponse,
            normalizedResponse: record.debug?.normalizedResponse,
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
            }
            : undefined;

        return {
            meta,
            finalError: result.ok ? undefined : result.error,
            reasonCode: result.ok ? undefined : result.reasonCode,
            validationErrors: Array.isArray(record.debug?.validationErrors) ? record.debug?.validationErrors.slice(0, 50) : undefined,
            rawResponseText: record.debug?.rawResponseText,
            providerResponse: record.debug?.providerResponse,
            parsedResponse: record.debug?.parsedResponse,
            normalizedResponse: record.debug?.normalizedResponse,
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
            reasonCode: logEntry.response?.reasonCode,
        });

        try {
            if (this.workspaceRepository) {
                await this.workspaceRepository.saveLog(logEntry as unknown as Record<string, unknown> as never);
                return;
            }
            memoryLogs.unshift(logEntry); if (memoryLogs.length > REQUEST_LOG_MAX_RECORDS) memoryLogs.length = REQUEST_LOG_MAX_RECORDS;
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
                error: String((error as Error)?.message || error),
            });
            // 日志属于诊断旁路；持久化失败不能让已经完成或失败的 LLM 请求再次失败。
            return;
        }
    }
}
