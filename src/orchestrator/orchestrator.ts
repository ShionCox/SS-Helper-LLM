/**
 * 全局 LLM 请求编排器。
 *
 * 只保留真实存在的生命周期：排队、执行、完成、失败、取消。
 * 展示由调用方自己的 UI 负责；编排器不再等待不存在的覆层关闭事件。
 */

import { logger, safeFailureLogDetail } from '../runtime/logger';
import {
    createSSHelperError,
    describeSSHelperFailure,
    isSSHelperReasonCode,
    readSSHelperFailure,
    type SSHelperFailureContext,
} from '@ss-helper/sdk';
import type {
    CapabilityKind,
    LLMRunMeta,
    LLMRunResult,
    RequestEnqueueOptions,
    RequestRecord,
    RequestState,
} from '../schema/types';

let globalRequestCounter = 0;
let globalLlmTaskCounter = 0;

function generateRequestId(): string {
    return `req_${Date.now()}_${++globalRequestCounter}`;
}

function generateLlmTaskId(): string {
    return `llm_task_${Date.now()}_${++globalLlmTaskCounter}`;
}

function getRunResultReasonCode<T>(result: LLMRunResult<T>): string | undefined {
    return result.ok ? undefined : result.reasonCode;
}

export class RequestOrchestrator {
    private readonly queue: RequestRecord[] = [];
    private readonly history: RequestRecord[] = [];
    private readonly archived = new WeakSet<RequestRecord>();
    private readonly activeRequests = new Map<string, RequestRecord>();
    private readonly activeCount: Record<CapabilityKind, number> = { generation: 0, embedding: 0, rerank: 0 };
    private readonly limits: Readonly<Record<CapabilityKind, number>> = Object.freeze({ generation: 2, embedding: 1, rerank: 1 });
    private scheduling = false;
    private disposed = false;
    private executeCallback: ((record: RequestRecord) => Promise<LLMRunResult<unknown>>) | null = null;
    private archiveCallback: ((record: RequestRecord) => void) | null = null;
    private readonly maxHistory = 50;

    setExecuteCallback(callback: (record: RequestRecord) => Promise<LLMRunResult<unknown>>): void {
        this.executeCallback = callback;
    }

    setArchiveCallback(callback: (record: RequestRecord) => void): void {
        this.archiveCallback = callback;
    }

    enqueue<T>(
        consumer: string,
        taskKey: string,
        taskKind: CapabilityKind,
        options: RequestEnqueueOptions = {},
        requestArgs?: unknown,
        taskDescription?: string,
    ): RequestRecord<T> {
        if (this.disposed) {
            throw createSSHelperError('LLM_DISABLED', {
                stage: 'llm.orchestrator.enqueue',
            });
        }

        const llmTaskId = generateLlmTaskId();
        const requestId = String(options.requestId || '').trim() || generateRequestId();
        if (options.dedupeKey) {
            const existing = this.findPendingByKey(options.dedupeKey);
            if (existing) {
                logger.info(`请求 ${requestId} 已去重：dedupeKey=${options.dedupeKey}，复用 ${existing.requestId}`);
                return existing as RequestRecord<T>;
            }
        }
        if (options.replacePendingByKey) this.replacePending(options.replacePendingByKey);

        let resolveResult!: (value: LLMRunResult<T>) => void;
        const resultPromise = new Promise<LLMRunResult<T>>((resolve) => { resolveResult = resolve; });
        const record: RequestRecord<T> = {
            llmTaskId,
            requestId,
            consumer,
            taskKey,
            ...(taskDescription === undefined ? {} : { taskDescription }),
            taskKind,
            ...(requestArgs === undefined ? {} : { requestArgs }),
            state: 'queued',
            validity: { isCancelled: false, isSuperseded: false },
            enqueueOptions: { ...options },
            ...(options.scope === undefined ? {} : { scope: options.scope }),
            queuedAt: Date.now(),
            attemptIndex: 1,
            resultPromise,
            resolveResult,
        };

        this.queue.push(record as RequestRecord);
        logger.info(`请求 ${requestId} 入队：consumer=${consumer}, task=${taskKey}, llmTaskId=${llmTaskId}, kind=${taskKind}`);
        void this.processQueue();
        return record;
    }

    /** 为同一逻辑任务开始下一次 Provider 尝试。 */
    advanceAttempt(record: RequestRecord): string {
        record.attemptIndex = Math.max(1, Number(record.attemptIndex || 1)) + 1;
        record.startedAt = undefined;
        record.finishedAt = undefined;
        record.meta = undefined;
        record.debug = undefined;
        record.activeAttemptRequestId = undefined;
        return record.requestId;
    }

    cancel(requestId: string, reason = '请求已取消'): void {
        const record = this.findRecord(requestId);
        if (!record || record.state === 'completed' || record.state === 'failed' || record.state === 'cancelled') return;
        record.validity.isCancelled = true;
        if (record.state === 'queued') {
            record.state = 'cancelled';
            record.finishedAt = Date.now();
            const failure = readSSHelperFailure(createSSHelperError('CANCELLED', { stage: 'llm.orchestrator.cancel', requestId: record.requestId }))!;
            record.resolveResult?.({ ok: false, reasonCode: failure.reasonCode, failure });
            this.removeFromQueue(requestId);
            this.archiveRecord(record);
        }
        logger.info(`请求 ${requestId} 已标记取消：${reason}`);
    }

    getQueueSnapshot(): {
        pending: Array<{ requestId: string; consumer: string; taskKey: string; taskDescription?: string; queuedAt: number }>;
        active: { requestId: string; consumer: string; taskKey: string; taskDescription?: string; state: RequestState } | null;
        recentHistory: Array<{
            requestId: string;
            consumer: string;
            taskKey: string;
            taskDescription?: string;
            state: RequestState;
            finishedAt?: number;
            rawResponseText?: string;
            parsedResponse?: unknown;
            normalizedResponse?: unknown;
            validationErrors?: string[];
            failure?: SSHelperFailureContext;
            inputCharCount?: number;
            outputCharCount?: number;
        }>;
    } {
        return {
            pending: this.queue.map((record) => ({
                requestId: record.requestId,
                consumer: record.consumer,
                taskKey: record.taskKey,
                ...(record.taskDescription === undefined ? {} : { taskDescription: record.taskDescription }),
                queuedAt: record.queuedAt,
            })),
            active: (() => {
                const active = this.activeRequests.values().next().value as RequestRecord | undefined;
                return active === undefined ? null : {
                    requestId: active.requestId,
                    consumer: active.consumer,
                    taskKey: active.taskKey,
                    ...(active.taskDescription === undefined ? {} : { taskDescription: active.taskDescription }),
                    state: active.state,
                };
            })(),
            recentHistory: this.history.slice(-20).map((record) => ({
                requestId: record.requestId,
                consumer: record.consumer,
                taskKey: record.taskKey,
                ...(record.taskDescription === undefined ? {} : { taskDescription: record.taskDescription }),
                state: record.state,
                ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
                ...(record.debug?.rawResponseText === undefined ? {} : { rawResponseText: record.debug.rawResponseText }),
                ...(record.debug?.parsedResponse === undefined ? {} : { parsedResponse: record.debug.parsedResponse }),
                ...(record.debug?.normalizedResponse === undefined ? {} : { normalizedResponse: record.debug.normalizedResponse }),
                ...(record.debug?.validationErrors === undefined ? {} : { validationErrors: record.debug.validationErrors }),
                ...(record.debug?.failure === undefined ? {} : { failure: record.debug.failure }),
                ...(record.requestLogSnapshot?.metrics?.inputCharCount === undefined ? {} : { inputCharCount: record.requestLogSnapshot.metrics.inputCharCount }),
                ...(record.requestLogSnapshot?.metrics?.outputCharCount === undefined ? {} : { outputCharCount: record.requestLogSnapshot.metrics.outputCharCount }),
            })),
        };
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        const pending = [...this.queue];
        this.queue.length = 0;
        for (const record of pending) this.finishCancelled(record);
        for (const activeRequest of this.activeRequests.values()) {
            activeRequest.validity.isCancelled = true;
            const failure = readSSHelperFailure(createSSHelperError('CANCELLED', { stage: 'llm.orchestrator.dispose', requestId: activeRequest.requestId }))!;
            activeRequest.resolveResult?.({ ok: false, reasonCode: failure.reasonCode, failure });
        }
        this.executeCallback = null;
        this.archiveCallback = null;
    }

    private async processQueue(): Promise<void> {
        if (this.disposed || this.scheduling) return;
        this.scheduling = true;
        try {
            while (!this.disposed) {
                const index = this.queue.findIndex((candidate) => this.activeCount[candidate.taskKind] < this.limits[candidate.taskKind]);
                if (index < 0) break;
                const [record] = this.queue.splice(index, 1);
                if (!record) break;
                if (this.isInvalid(record)) {
                    this.finishCancelled(record);
                    continue;
                }
                this.activeRequests.set(record.requestId, record);
                this.activeCount[record.taskKind] += 1;
                void this.executeRecord(record);
            }
        } finally {
            this.scheduling = false;
        }
    }

    private async executeRecord(record: RequestRecord): Promise<void> {
        record.state = 'running';
        record.startedAt = Date.now();
        logger.info('[RequestLifecycle][Running]', {
            requestId: record.requestId,
            consumer: record.consumer,
            taskKey: record.taskKey,
            chatKey: record.chatKey,
        });

        try {
            if (!this.executeCallback) {
                throw createSSHelperError('INTERNAL_ERROR', {
                    stage: 'llm.orchestrator.execute',
                    requestId: record.requestId,
                });
            }
            const result = await this.executeCallback(record);
            record.finishedAt = Date.now();
            // A validated successful attempt is the linearization point for completion.
            // A cancellation arriving after that point must not retroactively replace the
            // persisted completed attempt with a second cancelled terminal record.
            if (this.isInvalid(record) && !result.ok) {
                this.finishCancelled(record);
            } else {
                record.state = result.ok ? 'completed' : 'failed';
                if (!result.ok) {
                    const failure = readSSHelperFailure(result, {
                        reasonCode: isSSHelperReasonCode(result.reasonCode) ? result.reasonCode : 'INTERNAL_ERROR',
                        stage: 'llm.orchestrator.result',
                        requestId: record.requestId,
                    })!;
                    record.debug = {
                        ...(record.debug ?? {}),
                        failure,
                    };
                }
                if (result.ok || result.meta) {
                    const meta: LLMRunMeta = {
                        ...(result.meta ?? {}),
                        requestId: record.requestId,
                        resourceId: result.meta?.resourceId ?? '',
                        ...(result.meta?.model === undefined ? {} : { model: result.meta.model }),
                        capabilityKind: record.taskKind,
                        queuedAt: record.queuedAt,
                        startedAt: record.startedAt,
                        finishedAt: record.finishedAt,
                        latencyMs: record.finishedAt - (record.startedAt ?? record.queuedAt),
                    };
                    record.meta = meta;
                    if (result.ok) result.meta = meta;
                }
                logger.info('[RequestLifecycle][Completed]', {
                    requestId: record.requestId,
                    consumer: record.consumer,
                    taskKey: record.taskKey,
                    ok: result.ok,
                    reasonCode: getRunResultReasonCode(result),
                    latencyMs: record.finishedAt - (record.startedAt ?? record.queuedAt),
                });
                record.resolveResult?.(result);
                this.archiveRecord(record);
            }
        } catch (error) {
            record.state = 'failed';
            record.finishedAt = Date.now();
            const failure = readSSHelperFailure(error, {
                reasonCode: 'INTERNAL_ERROR',
                stage: 'llm.orchestrator.execute',
                requestId: record.requestId,
            })!;
            const diagnostic = describeSSHelperFailure(failure);
            record.debug = { ...(record.debug ?? {}), failure };
            record.resolveResult?.({
                ok: false,
                retryable: diagnostic.retryable,
                reasonCode: failure.reasonCode,
                failure,
            });
            this.archiveRecord(record);
            logger.error('[RequestLifecycle][Failed]', {
                requestId: record.requestId,
                consumer: record.consumer,
                taskKey: record.taskKey,
                reasonCode: failure.reasonCode,
                stage: failure.stage,
            });
        } finally {
            if (this.activeRequests.delete(record.requestId)) this.activeCount[record.taskKind] = Math.max(0, this.activeCount[record.taskKind] - 1);
            void this.processQueue();
        }
    }

    private replacePending(key: string): void {
        const targets = this.queue.filter((record) =>
            record.enqueueOptions.dedupeKey === key || record.enqueueOptions.replacePendingByKey === key);
        for (const record of targets) {
            record.validity.isSuperseded = true;
            this.removeFromQueue(record.requestId);
            this.finishCancelled(record);
        }
    }

    private finishCancelled(record: RequestRecord): void {
        record.validity.isCancelled = true;
        record.state = 'cancelled';
        record.finishedAt = Date.now();
        const failure = readSSHelperFailure(createSSHelperError('CANCELLED', { stage: 'llm.orchestrator.cancel', requestId: record.requestId }))!;
        record.resolveResult?.({ ok: false, reasonCode: failure.reasonCode, failure });
        this.archiveRecord(record);
    }

    private isInvalid(record: RequestRecord): boolean {
        return record.validity.isCancelled || record.validity.isSuperseded;
    }

    private findRecord(requestId: string): RequestRecord | undefined {
        const active = this.activeRequests.get(requestId);
        if (active) return active;
        return this.queue.find((record) => record.requestId === requestId);
    }

    private findPendingByKey(key: string): RequestRecord | undefined {
        return this.queue.find((record) => record.state === 'queued'
            && (record.enqueueOptions.dedupeKey === key || record.enqueueOptions.replacePendingByKey === key));
    }

    private removeFromQueue(requestId: string): void {
        const index = this.queue.findIndex((record) => record.requestId === requestId);
        if (index >= 0) this.queue.splice(index, 1);
    }

    private archiveRecord(record: RequestRecord): void {
        if (this.archived.has(record)) return;
        this.archived.add(record);
        logger.info('[RequestLifecycle][ArchiveRecord]', {
            requestId: record.requestId,
            consumer: record.consumer,
            taskKey: record.taskKey,
            state: record.state,
            chatKey: record.chatKey,
            reasonCode: record.debug?.failure?.reasonCode,
            hasArchiveCallback: Boolean(this.archiveCallback),
        });
        this.history.push(record);
        if (this.history.length > this.maxHistory) this.history.shift();
        try { this.archiveCallback?.(record); }
        catch (error) {
            logger.warn(`请求 ${record.requestId} 归档回调失败`, safeFailureLogDetail(error, {
                reasonCode: 'LOG_UNAVAILABLE',
                stage: 'llm.log.archive_callback',
                requestId: record.requestId,
            }));
        }
    }
}
