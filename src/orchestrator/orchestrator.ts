/**
 * 请求编排器
 * 职责：
 * - 全局串行执行队列
 * - 双 Promise 分离（resultPromise / overlayClosedPromise）
 * - 请求状态机（queued → running → result_ready → overlay_waiting → completed / failed / cancelled）
 * - dedupeKey / replacePendingByKey / cancelOnScopeChange 语义
 * - 最终有效性校验（isCancelled / isSuperseded / isObsolete）
 * - scope 作为取消与作废判断的唯一上下文单位
 */

import { logger } from '../runtime/logger';
import type {
    RequestRecord,
    RequestState,
    RequestScope,
    RequestEnqueueOptions,
    LLMRunResult,
    LLMRunMeta,
    CapabilityKind,
    DisplayMode,
} from '../schema/types';


let globalRequestCounter = 0;
let globalLlmTaskCounter = 0;
function generateRequestId(): string {
    return `req_${Date.now()}_${++globalRequestCounter}`;
}

function generateLlmTaskId(): string {
    return `llm_task_${Date.now()}_${++globalLlmTaskCounter}`;
}

/**
 * 功能：读取统一执行结果中的原因码。
 * @param result 执行结果
 * @returns 原因码
 */
function getRunResultReasonCode<T>(result: LLMRunResult<T>): string | undefined {
    if (!result.ok) {
        return result.reasonCode;
    }
    return undefined;
}

export interface OrchestratorConfig {
    /** generation 默认 blockNextUntilOverlayClose=true */
    defaultBlockForGeneration: boolean;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
    defaultBlockForGeneration: true,
};

export class RequestOrchestrator {
    private queue: RequestRecord[] = [];
    private activeRequest: RequestRecord | null = null;
    private processing = false;
    private config: OrchestratorConfig;

    /** 外部注入的执行回调 */
    private executeCallback: ((record: RequestRecord) => Promise<LLMRunResult<any>>) | null = null;
    /** 外部注入的展示回调 */
    private displayCallback: ((record: RequestRecord, result: LLMRunResult<any>) => void) | null = null;
    /** 外部注入的运行中遮罩回调 */
    private pendingDisplayCallback: ((record: RequestRecord) => void) | null = null;
    /** 归档记录时触发的外部回调 */
    private archiveCallback: ((record: RequestRecord) => void) | null = null;
    /** 外部注入的 scope 变更监听注册 */
    private scopeChangeCallback: ((listener: (scope: RequestScope) => void) => () => void) | null = null;

    private scopeChangeUnsubscribe: (() => void) | null = null;
    /** 请求历史（最近 N 条，用于设置页展示） */
    private history: RequestRecord[] = [];
    private readonly MAX_HISTORY = 50;

    constructor(config?: Partial<OrchestratorConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ─── 外部注入 ───

    setExecuteCallback(cb: (record: RequestRecord) => Promise<LLMRunResult<any>>): void {
        this.executeCallback = cb;
    }

    setDisplayCallback(cb: (record: RequestRecord, result: LLMRunResult<any>) => void): void {
        this.displayCallback = cb;
    }

    setPendingDisplayCallback(cb: (record: RequestRecord) => void): void {
        this.pendingDisplayCallback = cb;
    }

    setArchiveCallback(cb: (record: RequestRecord) => void): void {
        this.archiveCallback = cb;
    }

    setScopeChangeCallback(cb: (listener: (scope: RequestScope) => void) => () => void): void {
        // 清理旧监听
        this.scopeChangeUnsubscribe?.();
        this.scopeChangeCallback = cb;
        this.scopeChangeUnsubscribe = cb((scope) => this.handleScopeChange(scope));
    }

    // ─── 入队 ───

    enqueue<T>(
        consumer: string,
        taskKey: string,
        taskKind: CapabilityKind,
        options: RequestEnqueueOptions = {},
        requestArgs?: unknown,
        taskDescription?: string,
    ): RequestRecord<T> {
        const llmTaskId = generateLlmTaskId();
        const requestId = generateRequestId();

        // dedupeKey: 检查重复
        if (options.dedupeKey) {
            const existing = this.findPendingByKey(options.dedupeKey);
            if (existing) {
                logger.info(`请求 ${requestId} 被去重（dedupeKey=${options.dedupeKey}），复用 ${existing.requestId}`);
                return existing as RequestRecord<T>;
            }
        }

        // replacePendingByKey: 替换等待中的请求
        if (options.replacePendingByKey) {
            this.replacePending(options.replacePendingByKey, requestId);
        }

        let displayMode: DisplayMode = options.displayMode || (taskKind === 'generation' ? 'fullscreen' : 'silent');
        // 确定 blockNextUntilOverlayClose 默认值
        const blockNext = options.blockNextUntilOverlayClose ??
            (displayMode === 'compact' || displayMode === 'silent'
                ? false
                : (taskKind === 'generation' ? this.config.defaultBlockForGeneration : false));

        // 展示模式降级：fullscreen + blockNext=false → compact
        if (displayMode === 'fullscreen' && !blockNext) {
            displayMode = 'compact';
        }

        let resolveResult!: (value: LLMRunResult<T>) => void;
        let resolveOverlay!: () => void;

        const resultPromise = new Promise<LLMRunResult<T>>((resolve) => {
            resolveResult = resolve;
        });

        const overlayClosedPromise = new Promise<void>((resolve) => {
            resolveOverlay = resolve;
        });

        const record: RequestRecord<T> = {
            llmTaskId,
            requestId,
            consumer,
            taskKey,
            taskDescription,
            taskKind,
            requestArgs,
            state: 'queued',
            validity: { isCancelled: false, isSuperseded: false, isObsolete: false },
            enqueueOptions: { ...options, blockNextUntilOverlayClose: blockNext, displayMode },
            scope: options.scope,
            queuedAt: Date.now(),
            attemptIndex: 1,
            resultPromise,
            overlayClosedPromise,
            resolveResult,
            resolveOverlay,
        };

        this.queue.push(record as RequestRecord);
        logger.info(`请求 ${requestId} 入队：consumer=${consumer}, task=${taskKey}, llmTaskId=${llmTaskId}, kind=${taskKind}, display=${displayMode}`);

        // 启动队列处理
        this.processQueue();

        return record;
    }

    /**
     * 功能：为同一任务链推进到下一次尝试。
     * @param record 请求主记录。
     * @returns 稳定的任务请求 ID。
     */
    advanceAttempt(record: RequestRecord): string {
        record.attemptIndex = Math.max(1, Number(record.attemptIndex || 1)) + 1;
        record.startedAt = undefined;
        record.finishedAt = undefined;
        record.meta = undefined;
        record.debug = undefined;
        record.activeAttemptRequestId = undefined;
        return record.requestId;
    }

    // ─── 展示关闭通知 ───

    /** 外部通知某个请求的展示已关闭 */
    notifyOverlayClosed(requestId: string): void {
        const record = this.findRecord(requestId);
        if (!record) return;

        if (record.state === 'overlay_waiting') {
            record.state = 'completed';
        }
        record.resolveOverlay?.();
        logger.info(`请求 ${requestId} 展示已关闭，状态 → ${record.state}`);

        // 继续推进队列
        if (this.activeRequest?.requestId === requestId) {
            this.activeRequest = null;
            this.archiveRecord(record);
            this.processQueue();
        }
    }

    // ─── 取消 ───

    /** 取消指定请求 */
    cancel(requestId: string, reason?: string): void {
        const record = this.findRecord(requestId);
        if (!record) return;

        if (record.state === 'queued') {
            // 未开始：直接取消
            record.state = 'cancelled';
            record.validity.isCancelled = true;
            record.resolveResult?.({ ok: false, error: reason || '请求已取消', reasonCode: 'cancelled' });
            record.resolveOverlay?.();
            this.removeFromQueue(requestId);
            this.archiveRecord(record);
            logger.info(`请求 ${requestId} 已取消（未执行）: ${reason || ''}`);
        } else if (record.state === 'running') {
            // 已执行：标记取消但不能真正中止底层请求
            record.validity.isCancelled = true;
            logger.info(`请求 ${requestId} 标记取消（已执行中，结果将作废）: ${reason || ''}`);
        } else if (record.state === 'result_ready' || record.state === 'overlay_waiting') {
            record.validity.isCancelled = true;
            record.resolveOverlay?.();
            record.state = 'cancelled';
            if (this.activeRequest?.requestId === requestId) {
                this.activeRequest = null;
                this.processQueue();
            }
            this.archiveRecord(record);
            logger.info(`请求 ${requestId} 已取消（结果/展示中）: ${reason || ''}`);
        }
    }

    // ─── 查询 ───

    /** 等待展示关闭 */
    waitForOverlayClose(requestId: string): Promise<void> {
        const record = this.findRecord(requestId) || this.findInHistory(requestId);
        if (!record) {
            return Promise.resolve(); // 已完成或不存在
        }
        return record.overlayClosedPromise;
    }

    /** 获取当前队列状态（设置页展示用） */
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
            finalError?: string;
            reasonCode?: string;
            inputCharCount?: number;
            outputCharCount?: number;
        }>;
    } {
        return {
            pending: this.queue.map(r => ({
                requestId: r.requestId,
                consumer: r.consumer,
                taskKey: r.taskKey,
                taskDescription: r.taskDescription,
                queuedAt: r.queuedAt,
            })),
            active: this.activeRequest ? {
                requestId: this.activeRequest.requestId,
                consumer: this.activeRequest.consumer,
                taskKey: this.activeRequest.taskKey,
                taskDescription: this.activeRequest.taskDescription,
                state: this.activeRequest.state,
            } : null,
            recentHistory: this.history.slice(-20).map(r => ({
                requestId: r.requestId,
                consumer: r.consumer,
                taskKey: r.taskKey,
                taskDescription: r.taskDescription,
                state: r.state,
                finishedAt: r.finishedAt,
                rawResponseText: r.debug?.rawResponseText,
                parsedResponse: r.debug?.parsedResponse,
                normalizedResponse: r.debug?.normalizedResponse,
                validationErrors: r.debug?.validationErrors,
                finalError: r.debug?.finalError,
                reasonCode: r.debug?.reasonCode,
                inputCharCount: r.requestLogSnapshot?.metrics?.inputCharCount,
                outputCharCount: r.requestLogSnapshot?.metrics?.outputCharCount,
            })),
        };
    }

    // ─── 内部：队列处理 ───

    private async processQueue(): Promise<void> {
        if (this.processing || this.queue.length === 0) return;

        // 如果当前有活跃请求且需要等待展示关闭
        if (this.activeRequest) {
            const active = this.activeRequest;
            if (active.enqueueOptions.blockNextUntilOverlayClose &&
                (active.state === 'result_ready' || active.state === 'overlay_waiting')) {
                return; // 等待展示关闭后再继续
            }
            if (active.state === 'running') {
                return; // 正在执行中
            }
        }

        this.processing = true;

        const record = this.queue.shift();
        if (!record) {
            this.processing = false;
            return;
        }

        // 最终有效性检查
        if (this.isInvalid(record)) {
            record.state = 'cancelled';
            record.resolveResult?.({ ok: false, error: '请求已作废', reasonCode: 'cancelled' });
            record.resolveOverlay?.();
            this.archiveRecord(record);
            this.processing = false;
            this.processQueue();
            return;
        }

        this.activeRequest = record;
        record.state = 'running';
        record.startedAt = Date.now();
        logger.info('[RequestLifecycle][Running]', {
            requestId: record.requestId,
            consumer: record.consumer,
            taskKey: record.taskKey,
            displayMode: record.enqueueOptions.displayMode || 'fullscreen',
            blockNextUntilOverlayClose: Boolean(record.enqueueOptions.blockNextUntilOverlayClose),
            chatKey: record.chatKey,
        });

        if ((record.enqueueOptions.displayMode || 'fullscreen') !== 'silent' && this.pendingDisplayCallback) {
            this.pendingDisplayCallback(record);
        }

        try {
            if (!this.executeCallback) {
                throw new Error('编排器未设置执行回调');
            }

            const result = await this.executeCallback(record);

            // 执行完成后再次做最终有效性检查
            if (this.isInvalid(record)) {
                record.state = 'cancelled';
                record.finishedAt = Date.now();
                record.resolveResult?.({ ok: false, error: '请求结果已作废（执行期间被取消/替换）', reasonCode: 'cancelled' });
                record.resolveOverlay?.();
                this.activeRequest = null;
                this.archiveRecord(record);
                this.processing = false;
                this.processQueue();
                return;
            }

            record.state = 'result_ready';
            record.finishedAt = Date.now();
            logger.info('[RequestLifecycle][ResultReady]', {
                requestId: record.requestId,
                consumer: record.consumer,
                taskKey: record.taskKey,
                ok: result.ok !== false,
                hasMeta: Boolean(result.meta),
                reasonCode: getRunResultReasonCode(result),
                latencyMs: record.finishedAt - (record.startedAt || record.queuedAt),
            });
            if (!result.ok) {
                record.debug = {
                    ...(record.debug || {}),
                    finalError: result.error,
                    reasonCode: result.reasonCode,
                };
            }

            // 填充 meta
            if (result.ok || result.meta) {
                const meta: LLMRunMeta = {
                    requestId: record.requestId,
                    resourceId: (result as any).meta?.resourceId || '',
                    model: (result as any).meta?.model,
                    capabilityKind: record.taskKind,
                    queuedAt: record.queuedAt,
                    startedAt: record.startedAt,
                    finishedAt: record.finishedAt,
                    latencyMs: record.finishedAt - (record.startedAt || record.queuedAt),
                    fallbackUsed: (result as any).meta?.fallbackUsed || (result as any).fallbackUsed,
                };
                record.meta = meta;

                if (result.ok) {
                    (result as any).meta = meta;
                }
            }

            // 解析 resultPromise（AI 结果立即可用，不等展示）
            record.resolveResult?.(result);

            // 展示处理
            const displayMode = record.enqueueOptions.displayMode || 'fullscreen';
            if (displayMode === 'silent') {
                // 静默：直接完成
                record.state = 'completed';
                logger.info('[RequestLifecycle][CompletedSilent]', {
                    requestId: record.requestId,
                    consumer: record.consumer,
                    taskKey: record.taskKey,
                    reasonCode: getRunResultReasonCode(result),
                });
                record.resolveOverlay?.();
                this.activeRequest = null;
                this.archiveRecord(record);
            } else {
                // 需要展示
                record.state = 'overlay_waiting';
                logger.info('[RequestLifecycle][OverlayWaiting]', {
                    requestId: record.requestId,
                    consumer: record.consumer,
                    taskKey: record.taskKey,
                    blockNextUntilOverlayClose: Boolean(record.enqueueOptions.blockNextUntilOverlayClose),
                });
                if (this.displayCallback) {
                    this.displayCallback(record, result);
                }

                // 如果不阻塞队列，立即推进
                if (!record.enqueueOptions.blockNextUntilOverlayClose) {
                    this.activeRequest = null;
                    this.archiveRecord(record);
                }
                // 否则等待 notifyOverlayClosed 被调用
            }
        } catch (error) {
            record.state = 'failed';
            record.finishedAt = Date.now();
            const errMsg = (error as Error).message;
            logger.error('[RequestLifecycle][Failed]', {
                requestId: record.requestId,
                consumer: record.consumer,
                taskKey: record.taskKey,
                error: errMsg,
            });
            record.debug = {
                ...(record.debug || {}),
                finalError: errMsg,
                reasonCode: 'unknown',
            };
            record.resolveResult?.({ ok: false, error: errMsg, retryable: true, reasonCode: 'unknown' });
            record.resolveOverlay?.();
            this.activeRequest = null;
            this.archiveRecord(record);
            logger.error(`请求 ${record.requestId} 执行失败:`, error);
        }

        this.processing = false;
        this.processQueue();
    }

    // ─── 内部：replacePendingByKey ───

    private replacePending(key: string, newRequestId: string): void {
        const targets = this.queue.filter(r =>
            r.enqueueOptions.dedupeKey === key || r.enqueueOptions.replacePendingByKey === key
        );
        for (const target of targets) {
            if (target.state === 'queued') {
                target.state = 'cancelled';
                target.validity.isSuperseded = true;
                target.resolveResult?.({
                    ok: false,
                    error: `被新请求 ${newRequestId} 替换`,
                    reasonCode: 'cancelled',
                });
                target.resolveOverlay?.();
                this.removeFromQueue(target.requestId);
                this.archiveRecord(target);
                logger.info(`请求 ${target.requestId} 被 ${newRequestId} 替换（replacePendingByKey=${key}）`);
            } else if (target.state === 'running') {
                // 已执行的请求标记 isSuperseded，结果在返回时作废
                target.validity.isSuperseded = true;
                logger.info(`请求 ${target.requestId} 执行中，标记为已被替换`);
            }
        }
    }

    // ─── 内部：scope 变更处理 ───

    private handleScopeChange(changedScope: RequestScope): void {
        // 只影响匹配作用域且标记了 cancelOnScopeChange 的请求
        const toCancel = [...this.queue, ...(this.activeRequest ? [this.activeRequest] : [])].filter(r => {
            if (!r.enqueueOptions.cancelOnScopeChange) return false;
            return this.scopeMatches(r.scope, changedScope);
        });

        for (const record of toCancel) {
            record.validity.isObsolete = true;
            if (record.state === 'queued') {
                record.state = 'cancelled';
                record.resolveResult?.({
                    ok: false,
                    error: '作用域变更，请求已作废',
                    reasonCode: 'cancelled',
                });
                record.resolveOverlay?.();
                this.removeFromQueue(record.requestId);
                this.archiveRecord(record);
            }
            // running 的在结果返回时通过 isInvalid 检查作废
            logger.info(`请求 ${record.requestId} 因 scope 变更作废`);
        }
    }

    private scopeMatches(requestScope: RequestScope | undefined, changedScope: RequestScope): boolean {
        if (!requestScope) return false;
        if (changedScope.chatId && requestScope.chatId === changedScope.chatId) return true;
        if (changedScope.sessionId && requestScope.sessionId === changedScope.sessionId) return true;
        if (changedScope.pluginId && requestScope.pluginId === changedScope.pluginId) return true;
        return false;
    }

    // ─── 内部：有效性判断 ───

    private isInvalid(record: RequestRecord): boolean {
        return record.validity.isCancelled || record.validity.isSuperseded || record.validity.isObsolete;
    }

    // ─── 内部：工具方法 ───

    private findRecord(requestId: string): RequestRecord | undefined {
        if (this.activeRequest?.requestId === requestId) return this.activeRequest;
        return this.queue.find(r => r.requestId === requestId);
    }

    private findInHistory(requestId: string): RequestRecord | undefined {
        return this.history.find(r => r.requestId === requestId);
    }

    private findPendingByKey(key: string): RequestRecord | undefined {
        return this.queue.find(r =>
            r.state === 'queued' &&
            (r.enqueueOptions.dedupeKey === key || r.enqueueOptions.replacePendingByKey === key)
        );
    }

    private removeFromQueue(requestId: string): void {
        const idx = this.queue.findIndex(r => r.requestId === requestId);
        if (idx >= 0) this.queue.splice(idx, 1);
    }

    private archiveRecord(record: RequestRecord): void {
        logger.info('[RequestLifecycle][ArchiveRecord]', {
            requestId: record.requestId,
            consumer: record.consumer,
            taskKey: record.taskKey,
            state: record.state,
            chatKey: record.chatKey,
            reasonCode: record.debug?.reasonCode,
            hasArchiveCallback: Boolean(this.archiveCallback),
        });
        this.history.push(record);
        if (this.history.length > this.MAX_HISTORY) {
            this.history.shift();
        }
        if (this.archiveCallback) {
            try {
                this.archiveCallback(record);
            } catch (error) {
                logger.warn(`请求 ${record.requestId} 归档回调失败`, error);
            }
        }
    }
}
