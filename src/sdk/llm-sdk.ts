import type { LLMRequest } from '../providers/types';
import { TaskRouter } from '../router/router';
import { BudgetManager } from '../budget/budget-manager';
import {
    parseJsonOutput,
    validateZodSchema,
    WorldTemplateSchema,
    ProposalEnvelopeSchema,
    normalizeProposalEnvelopeInput,
    normalizeWorldTemplateInput,
} from '../schema/validator';
import { normalizeStructuredCategoryBuckets } from '../schema/structured-output-classifier';
import { ProfileManager } from '../profile/profile-manager';
import { inferReasonCode } from '../schema/error-codes';
import {
    isStrictJsonSchemaCompatible,
    processProviderStrictJsonSchema,
    type SchemaCompatOptions,
} from '../schema/strict-json-schema';
import { resolveMaxTokens } from './max-tokens';
import { RequestOrchestrator } from '../orchestrator/orchestrator';
import { DisplayController } from '../display/display-controller';
import { ConsumerRegistry } from '../registry/consumer-registry';
import { logger } from '../runtime/logger';
import { RequestLogService } from '../log/requestLogService';
import type {
    LLMRunResult,
    LLMRunMeta,
    CapabilityKind,
    ConsumerRegistration,
    LLMInspectApi,
    OverlayPatch,
    RunTaskArgs,
    EmbedArgs,
    RerankArgs,
    RequestRecord,
    RequestEnqueueOptions,
    LLMRequestLogRequestSnapshot,
    LLMTaskLifecycleEvent,
    LLMHubSettings,
} from '../schema/types';
import type { ZodType } from 'zod';
import type { ApiType } from '../schema/types';

/**
 * 功能：判断输入是否为普通对象，便于拼装 generation 用户消息。
 * @param value 待判断的值。
 * @returns 是否为普通对象。
 */
function isPlainGenerationInputRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 功能：为 generation 请求构建用户消息，避免把 systemPrompt 再次重复写进 user 载荷。
 * @param input 原始 generation 输入。
 * @returns 适合放入 user 消息的文本。
 */
function buildGenerationUserContent(input: unknown): string {
    if (typeof input === 'string') {
        return input;
    }
    if (!isPlainGenerationInputRecord(input)) {
        return JSON.stringify(input);
    }
    const {
        systemPrompt: _systemPrompt,
        temperature: _temperature,
        ...rest
    } = input;
    if (
        typeof rest.events === 'string'
        && typeof rest.schemaContext === 'string'
        && Object.keys(rest).length <= 2
    ) {
        return [
            '事件窗口：',
            rest.events,
            '',
            'Schema 上下文：',
            rest.schemaContext,
        ].join('\n');
    }
    return JSON.stringify(rest);
}


/**
 * LLMSDK 门面层
 * 整合四层架构：注册中心、路由、编排、展示。
 *
 * 异步接口：runTask, embed, rerank, waitForOverlayClose
 * 同步接口：registerConsumer, unregisterConsumer, updateOverlay, closeOverlay
 */
export class LLMSDKImpl {
    private router: TaskRouter;
    private budgetManager: BudgetManager;
    private profileManager: ProfileManager;
    private orchestrator: RequestOrchestrator;
    private displayController: DisplayController;
    private registry: ConsumerRegistry;
    private requestLogService: RequestLogService;
    private globalProfileId: string;
    private settingsResolver: (() => LLMHubSettings) | null = null;
    public inspect?: LLMInspectApi;

    constructor(
        router: TaskRouter,
        budgetManager: BudgetManager,
        orchestrator: RequestOrchestrator,
        displayController: DisplayController,
        registry: ConsumerRegistry,
        requestLogService: RequestLogService,
    ) {
        this.router = router;
        this.budgetManager = budgetManager;
        this.profileManager = new ProfileManager();
        this.orchestrator = orchestrator;
        this.displayController = displayController;
        this.registry = registry;
        this.requestLogService = requestLogService;
        this.globalProfileId = 'balanced';

        // 连接编排器与展示控制器
        this.orchestrator.setPendingDisplayCallback((record) => {
            this.displayController.openPendingOverlay(record);
        });
        this.orchestrator.setExecuteCallback((record) => this.executeRequest(record));
        this.orchestrator.setDisplayCallback((record, result) => {
            this.displayController.createOverlay(record, result);
        });
        this.orchestrator.setArchiveCallback((record) => {
            void this.requestLogService.archiveRecord(record).catch((error) => {
                logger.warn(`请求日志归档失败: ${record.requestId}`, error);
            });
        });
        this.displayController.setNotifyOrchestratorClosed((requestId) => {
            this.orchestrator.notifyOverlayClosed(requestId);
        });
    }

    // ─── 同步命令式接口 ───

    /** 幂等 upsert 注册。同步返回，内部异步落盘。 */
    registerConsumer(registration: ConsumerRegistration): void {
        this.registry.registerConsumer(registration);
    }

    /** 注销消费方。同步返回。 */
    unregisterConsumer(pluginId: string, opts?: { keepPersistent?: boolean }): void {
        this.registry.unregisterConsumer(pluginId, opts);
    }

    /** 更新覆层。同步返回。 */
    updateOverlay(requestId: string, patch: OverlayPatch): void {
        this.displayController.updateOverlay(requestId, patch);
    }

    /** 关闭覆层。同步返回。 */
    closeOverlay(requestId: string, reason?: string): void {
        this.displayController.closeOverlay(requestId, reason);
    }

    // ─── 异步接口 ───

    setGlobalProfile(profileId: string): void {
        const profile = this.profileManager.get(profileId);
        if (!profile) {
            throw new Error(`Profile 不存在: ${profileId}`);
        }
        this.globalProfileId = profileId;
    }

    getGlobalProfile(): string {
        return this.globalProfileId;
    }

    setSettingsResolver(resolver: () => LLMHubSettings): void {
        this.settingsResolver = resolver;
    }

    private readSettings(): LLMHubSettings {
        try {
            return this.settingsResolver?.() || {};
        } catch {
            return {};
        }
    }

    private emitLifecycle(
        args: RunTaskArgs | EmbedArgs | RerankArgs,
        record: Pick<RequestRecord, 'requestId' | 'llmTaskId' | 'consumer' | 'taskKey' | 'taskKind'>,
        event: Omit<LLMTaskLifecycleEvent, 'requestId' | 'llmTaskId' | 'consumer' | 'taskKey' | 'taskKind' | 'ts'>,
    ): void {
        if (typeof args.onLifecycle !== 'function') {
            return;
        }

        try {
            args.onLifecycle({
                requestId: record.requestId,
                llmTaskId: record.llmTaskId,
                consumer: record.consumer,
                taskKey: record.taskKey,
                taskKind: record.taskKind,
                ts: Date.now(),
                ...event,
            });
        } catch (error) {
            logger.warn(`生命周期回调执行失败: ${record.requestId}`, error);
        }
    }

    private formatRetryReason(result: LLMRunResult<unknown>): string {
        if (result.ok) {
            return '';
        }
        const errorText = String(result.error || '').trim();
        const reasonCode = String(result.reasonCode || '').trim();
        if (errorText && reasonCode) {
            return `${errorText}\n原因码：${reasonCode}`;
        }
        if (errorText) {
            return errorText;
        }
        if (reasonCode) {
            return `原因码：${reasonCode}`;
        }
        return '未提供更详细的失败原因。';
    }

    private isReasonCodeRetryable(reasonCode?: string): boolean {
        const normalizedReasonCode = String(reasonCode || '').trim();
        return normalizedReasonCode === 'timeout'
            || normalizedReasonCode === 'rate_limited'
            || normalizedReasonCode === 'network_error'
            || normalizedReasonCode === 'circuit_open'
            || normalizedReasonCode === 'provider_unavailable'
            || normalizedReasonCode === 'unknown'
            || normalizedReasonCode === 'token_limit_exceeded'
            || normalizedReasonCode === 'invalid_json'
            || normalizedReasonCode === 'schema_validation_failed';
    }

    private shouldOfferRetry(result: LLMRunResult<unknown>): boolean {
        if (result.ok) {
            return false;
        }
        if (result.retryable === true) {
            return true;
        }
        const inferredReasonCode = String(result.reasonCode || '').trim() || inferReasonCode(String(result.error || ''));
        return this.isReasonCodeRetryable(inferredReasonCode);
    }

    private confirmRetryableFailure(record: RequestRecord, result: LLMRunResult<unknown>, retryCount: number): boolean {
        if (typeof window === 'undefined' || typeof window.confirm !== 'function' || result.ok || !this.shouldOfferRetry(result)) {
            return false;
        }
        const taskLabel = String(record.taskDescription || record.taskKey || 'LLM 任务').trim() || 'LLM 任务';
        const reasonText = this.formatRetryReason(result);
        const retryPrompt = retryCount <= 0
            ? '是否立即重试？'
            : `当前已重试 ${retryCount} 次，是否继续重试？`;
        return window.confirm(
            `LLMHub 请求失败：${taskLabel}\n\n失败原因：\n${reasonText}\n\n${retryPrompt}`,
        );
    }

    private async executeWithRetryLoop<T>(
        record: RequestRecord,
        args: RunTaskArgs | EmbedArgs | RerankArgs,
        executor: () => Promise<LLMRunResult<T>>,
    ): Promise<LLMRunResult<T>> {
        let retryCount = 0;

        while (true) {
            const attemptRequestId = this.generateAttemptRequestId(record);
            const currentResult = await executor();
            if (record.validity.isCancelled || record.validity.isSuperseded || record.validity.isObsolete) {
                return { ok: false, error: '请求结果已作废', reasonCode: 'cancelled' };
            }
            const shouldOfferRetry = !currentResult.ok && this.shouldOfferRetry(currentResult);
            const shouldRetry = shouldOfferRetry
                ? this.confirmRetryableFailure(record, currentResult, retryCount)
                : false;

            await this.recordAttemptLog(record, attemptRequestId, currentResult, !shouldRetry);

            if (!shouldRetry) {
                return currentResult;
            }

            retryCount += 1;
            this.emitLifecycle(args, record, {
                stage: 'running',
                message: retryCount === 1
                    ? '用户已确认重试，正在重新请求'
                    : `用户已确认第 ${retryCount} 次重试，正在重新请求`,
                progress: 0.35,
            });
            this.orchestrator.advanceAttempt(record);
        }
    }

    private resolveTaskDescription(consumer: string, taskKey: string, explicit?: string): string {
        const explicitText = String(explicit || '').trim();
        if (explicitText) {
            return explicitText;
        }
        const registered = this.registry.getTaskDescriptor(consumer, taskKey)?.description;
        const registeredText = String(registered || '').trim();
        return registeredText || taskKey;
    }

    private summarizeSchema(schema: unknown): string | undefined {
        if (!schema) return undefined;
        if (typeof schema === 'string') return schema;
        const value = schema as Record<string, unknown>;
        if (typeof value.description === 'string' && value.description.trim()) {
            return value.description.trim();
        }
        if (typeof value.name === 'string' && value.name.trim()) {
            return value.name.trim();
        }
        const ctorName = (schema as { constructor?: { name?: string } })?.constructor?.name;
        return ctorName && ctorName !== 'Object' ? ctorName : 'schema';
    }

    private isZodSchema(schema: unknown): schema is ZodType<any> {
        return Boolean(schema) && typeof (schema as { safeParse?: unknown }).safeParse === 'function';
    }

    private sanitizeSchemaName(name?: string): string {
        const normalized = String(name || 'structured_output')
            .trim()
            .replace(/[^a-zA-Z0-9_-]+/g, '_')
            .replace(/^_+|_+$/g, '');
        return normalized || 'structured_output';
    }

    private normalizeApiType(value: unknown): ApiType {
        switch (value) {
            case 'deepseek':
            case 'gemini':
            case 'claude':
            case 'generic':
                return value;
            default:
                return 'openai';
        }
    }

    private buildRequestLogSnapshot(
        taskKind: CapabilityKind,
        taskDescription: string,
        args: RunTaskArgs | EmbedArgs | RerankArgs,
    ): LLMRequestLogRequestSnapshot {
        if (taskKind === 'embedding') {
            const embedArgs = args as EmbedArgs;
            return {
                taskKind,
                taskDescription,
                routeHint: embedArgs.routeHint,
                enqueue: embedArgs.enqueue,
                embeddingTexts: Array.isArray(embedArgs.texts) ? embedArgs.texts.slice() : [],
                metrics: { embeddingTextCount: Array.isArray(embedArgs.texts) ? embedArgs.texts.length : 0 },
            };
        }

        if (taskKind === 'rerank') {
            const rerankArgs = args as RerankArgs;
            return {
                taskKind,
                taskDescription,
                routeHint: rerankArgs.routeHint,
                enqueue: rerankArgs.enqueue,
                rerankQuery: rerankArgs.query,
                rerankDocs: Array.isArray(rerankArgs.docs) ? rerankArgs.docs.slice() : [],
                rerankTopK: rerankArgs.topK,
                metrics: { rerankDocCount: Array.isArray(rerankArgs.docs) ? rerankArgs.docs.length : 0 },
            };
        }

        const runArgs = args as RunTaskArgs;
        const messageCount = Array.isArray(runArgs.input?.messages) ? runArgs.input.messages.length : undefined;
        return {
            taskKind,
            taskDescription,
            routeHint: runArgs.routeHint,
            budget: runArgs.budget,
            enqueue: runArgs.enqueue,
            schemaSummary: this.summarizeSchema(runArgs.schema),
            schema: runArgs.schema,
            generationInput: runArgs.input,
            metrics: { messageCount },
        };
    }

    private resolveRequestChatKey(args: RunTaskArgs | EmbedArgs | RerankArgs): string {
        const explicitChatKey = String(args.enqueue?.scope?.chatKey || '').trim();
        if (explicitChatKey) {
            return explicitChatKey;
        }
        return 'ss-helper.llm:unscoped';
    }

    /**
     * 执行 AI 任务。
     * 只等待 AI 结果返回，不等待展示关闭。
     */
    async runTask<T>(args: RunTaskArgs<T>): Promise<LLMRunResult<T>> {
        const taskKind: CapabilityKind = args.taskKind;
        const taskDescription = this.resolveTaskDescription(args.consumer, args.taskKey, args.taskDescription);

        const record = this.orchestrator.enqueue<T>(
            args.consumer,
            args.taskKey,
            taskKind,
            {
                ...args.enqueue,
                displayMode: args.enqueue?.displayMode || (taskKind === 'generation' ? 'fullscreen' : 'silent'),
                scope: args.enqueue?.scope || { pluginId: args.consumer },
            },
            args,
            taskDescription,
        );
        record.chatKey = this.resolveRequestChatKey(args);
        record.requestLogSnapshot = this.buildRequestLogSnapshot(taskKind, taskDescription, args);
        this.emitLifecycle(args, record, {
            stage: 'queued',
            message: '请求已进入队列',
            progress: 0.1,
        });

        // 将执行参数附到 record 上供 executeCallback 使用
        return this.waitForResult(record, args.signal);
    }

    /**
     * 向量化接口。
     * AI 结果返回时立即完成。
     */
    async embed(args: EmbedArgs): Promise<any> {
        const taskDescription = this.resolveTaskDescription(args.consumer, args.taskKey, args.taskDescription);
        const record = this.orchestrator.enqueue(
            args.consumer,
            args.taskKey,
            'embedding',
            {
                ...args.enqueue,
                displayMode: args.enqueue?.displayMode || 'silent',
                scope: args.enqueue?.scope || { pluginId: args.consumer },
            },
            args,
            taskDescription,
        );
        record.chatKey = this.resolveRequestChatKey(args);
        record.requestLogSnapshot = this.buildRequestLogSnapshot('embedding', taskDescription, args);
        this.emitLifecycle(args, record, {
            stage: 'queued',
            message: '向量任务已进入队列',
            progress: 0.1,
        });

        return this.waitForResult(record, args.signal);
    }

    /**
     * 重排序接口。
     * AI 结果返回时立即完成。
     */
    async rerank(args: RerankArgs): Promise<any> {
        const taskDescription = this.resolveTaskDescription(args.consumer, args.taskKey, args.taskDescription);
        const record = this.orchestrator.enqueue(
            args.consumer,
            args.taskKey,
            'rerank',
            {
                ...args.enqueue,
                displayMode: args.enqueue?.displayMode || 'silent',
                scope: args.enqueue?.scope || { pluginId: args.consumer },
            },
            args,
            taskDescription,
        );
        record.chatKey = this.resolveRequestChatKey(args);
        record.requestLogSnapshot = this.buildRequestLogSnapshot('rerank', taskDescription, args);
        this.emitLifecycle(args, record, {
            stage: 'queued',
            message: '重排任务已进入队列',
            progress: 0.1,
        });

        return this.waitForResult(record, args.signal);
    }

    private waitForResult<T>(record: RequestRecord<T>, signal?: AbortSignal): Promise<LLMRunResult<T>> {
        if (!signal) return record.resultPromise;
        const onAbort = (): void => this.orchestrator.cancel(record.requestId, '调用方已取消');
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        return record.resultPromise.finally(() => signal.removeEventListener('abort', onAbort));
    }

    /**
     * 等待展示关闭。
     */
    async waitForOverlayClose(requestId: string): Promise<void> {
        return this.orchestrator.waitForOverlayClose(requestId);
    }

    // ─── 编排器执行回调（内部） ───

    private async executeRequest(record: RequestRecord): Promise<LLMRunResult<any>> {
        const args = record.requestArgs;
        if (!args) {
            return { ok: false, error: '请求参数缺失', reasonCode: 'unknown' };
        }

        switch (record.taskKind) {
            case 'generation':
                if (!this.isGenerationArgs(args)) {
                    return { ok: false, error: 'generation 请求参数不合法', reasonCode: 'unknown' };
                }
                if (this.readSettings().enabled === false) {
                    this.emitLifecycle(args, record, {
                        stage: 'failed',
                        message: 'LLMHub 未启用，请先在设置中启用 LLMHub。',
                        error: 'LLMHub 未启用',
                        reasonCode: 'llmhub_disabled',
                    });
                    return { ok: false, error: 'LLMHub 未启用', retryable: false, reasonCode: 'llmhub_disabled' };
                }
                this.emitLifecycle(args, record, {
                    stage: 'running',
                    message: '任务开始执行',
                    progress: 0.25,
                });
                return this.executeWithRetryLoop(record, args, () => this.executeGeneration(args, record));
            case 'embedding':
                if (!this.isEmbedArgs(args)) {
                    return { ok: false, error: 'embedding 请求参数不合法', reasonCode: 'unknown' };
                }
                if (this.readSettings().enabled === false) {
                    this.emitLifecycle(args, record, {
                        stage: 'failed',
                        message: 'LLMHub 未启用，请先在设置中启用 LLMHub。',
                        error: 'LLMHub 未启用',
                        reasonCode: 'llmhub_disabled',
                    });
                    return { ok: false, error: 'LLMHub 未启用', retryable: false, reasonCode: 'llmhub_disabled' };
                }
                this.emitLifecycle(args, record, {
                    stage: 'running',
                    message: '向量任务开始执行',
                    progress: 0.25,
                });
                return this.executeWithRetryLoop(record, args, () => this.executeEmbed(args, record));
            case 'rerank':
                if (!this.isRerankArgs(args)) {
                    return { ok: false, error: 'rerank 请求参数不合法', reasonCode: 'unknown' };
                }
                if (this.readSettings().enabled === false) {
                    this.emitLifecycle(args, record, {
                        stage: 'failed',
                        message: 'LLMHub 未启用，请先在设置中启用 LLMHub。',
                        error: 'LLMHub 未启用',
                        reasonCode: 'llmhub_disabled',
                    });
                    return { ok: false, error: 'LLMHub 未启用', retryable: false, reasonCode: 'llmhub_disabled' };
                }
                this.emitLifecycle(args, record, {
                    stage: 'running',
                    message: '重排任务开始执行',
                    progress: 0.25,
                });
                return this.executeWithRetryLoop(record, args, () => this.executeRerank(args, record));
            default:
                return { ok: false, error: `未知任务类型: ${record.taskKind}`, reasonCode: 'unknown' };
        }
    }

    private hasBaseRequestArgs(args: unknown): args is { consumer: string; taskKey: string } {
        if (!args || typeof args !== 'object') {
            return false;
        }

        const value = args as Record<string, unknown>;
        return typeof value.consumer === 'string' && typeof value.taskKey === 'string';
    }

    private isGenerationArgs(args: unknown): args is RunTaskArgs {
        if (!this.hasBaseRequestArgs(args)) {
            return false;
        }

        const value = args as Record<string, unknown>;
        return typeof value.taskKind === 'string' && 'input' in value;
    }

    private isEmbedArgs(args: unknown): args is EmbedArgs {
        if (!this.hasBaseRequestArgs(args)) {
            return false;
        }

        const value = args as Record<string, unknown>;
        return Array.isArray(value.texts) && value.texts.every((text) => typeof text === 'string');
    }

    private isRerankArgs(args: unknown): args is RerankArgs {
        if (!this.hasBaseRequestArgs(args)) {
            return false;
        }

        const value = args as Record<string, unknown>;
        return typeof value.query === 'string'
            && Array.isArray(value.docs)
            && value.docs.every((doc) => typeof doc === 'string');
    }

    private serializeSchemaForLog(schema: unknown): unknown {
        if (!schema) return undefined;
        if (!this.isZodSchema(schema)) {
            return schema;
        }

        const visit = (node: any, depth: number): unknown => {
            if (!node) return undefined;
            if (depth >= 6) return '[MaxDepthSchema]';

            const def = node._def || {};
            const typeName = String(def.typeName || def.type || node.type || 'unknown');
            const description = typeof node.description === 'string' && node.description.trim()
                ? node.description.trim()
                : typeof def.description === 'string' && def.description.trim()
                    ? def.description.trim()
                    : undefined;

            if (def.innerType) {
                const inner = visit(def.innerType, depth + 1);
                if (typeName.includes('Optional')) {
                    return { type: 'optional', inner, ...(description ? { description } : {}) };
                }
                if (typeName.includes('Nullable')) {
                    return { type: 'nullable', inner, ...(description ? { description } : {}) };
                }
                if (typeName.includes('Default')) {
                    return { type: 'default', inner, ...(description ? { description } : {}) };
                }
                return inner;
            }

            if (def.schema) {
                return visit(def.schema, depth + 1);
            }

            if (typeName.includes('Object')) {
                const rawShape = typeof def.shape === 'function' ? def.shape() : (def.shape || node.shape || {});
                const properties = Object.fromEntries(
                    Object.entries(rawShape).map(([key, value]) => [key, visit(value, depth + 1)]),
                );
                return {
                    type: 'object',
                    properties,
                    ...(description ? { description } : {}),
                };
            }

            if (typeName.includes('Array')) {
                return {
                    type: 'array',
                    items: visit(def.type || def.element || def.itemType, depth + 1),
                    ...(description ? { description } : {}),
                };
            }

            if (typeName.includes('Enum')) {
                const values = Array.isArray(def.values) ? def.values : Object.values(def.values || {});
                return {
                    type: 'enum',
                    values,
                    ...(description ? { description } : {}),
                };
            }

            if (typeName.includes('Record')) {
                return {
                    type: 'record',
                    valueType: visit(def.valueType, depth + 1),
                    ...(description ? { description } : {}),
                };
            }

            if (typeName.includes('Literal')) {
                return {
                    type: 'literal',
                    value: def.value,
                    ...(description ? { description } : {}),
                };
            }

            if (typeName.includes('Union')) {
                return {
                    type: 'union',
                    options: Array.isArray(def.options)
                        ? def.options.map((option: unknown) => visit(option, depth + 1))
                        : [],
                    ...(description ? { description } : {}),
                };
            }

            const primitiveType = typeName.replace(/^Zod/i, '').toLowerCase() || 'unknown';
            return {
                type: primitiveType,
                ...(description ? { description } : {}),
            };
        };

        return visit(schema, 0);
    }

    private buildGenerationProviderRequestSnapshot(
        resourceId: string,
        llmReq: LLMRequest,
        runtimeSchema: unknown,
        normalizeMode: 'proposal' | 'world_template' | 'none',
        args: RunTaskArgs,
        schemaSummary?: string,
        maxTokensSource?: string,
        requestMeta?: {
            originalStrictSchemaCompatible?: boolean;
            providerSchemaCompatible?: boolean;
            schemaAutofillApplied?: boolean;
            schemaCompatMode?: string;
            originalStrictIncompatibilityPath?: string;
            originalStrictIncompatibilityReason?: string;
            providerStrictIncompatibilityPath?: string;
            providerStrictIncompatibilityReason?: string;
            responseFormatBeforeCompat?: string;
            responseFormatAfterCompat?: string;
        },
    ): Record<string, unknown> {
        const provider = this.router.getProvider(resourceId) as ({ kind?: string; apiType?: ApiType } | undefined);
        const providerKind = provider?.kind || 'unknown';
        const providerApiType: ApiType | undefined = provider ? this.normalizeApiType(provider.apiType ?? (providerKind === 'openai' ? 'openai' : undefined)) : undefined;
        const requestedOutputSchema = this.serializeSchemaForLog(runtimeSchema);
        const requestParams = {
            model: llmReq.model,
            temperature: llmReq.temperature,
            maxTokens: llmReq.maxTokens,
            maxTokensSource,
            jsonMode: Boolean(llmReq.jsonMode),
            apiType: providerApiType,
            preferredResponseFormat: llmReq.preferredResponseFormat,
            schemaCompat: llmReq.schemaCompat,
            normalizeMode,
            schemaSummary,
            routeHint: args.routeHint,
            budget: args.budget,
            originalStrictSchemaCompatible: requestMeta?.originalStrictSchemaCompatible,
            providerSchemaCompatible: requestMeta?.providerSchemaCompatible,
            schemaAutofillApplied: requestMeta?.schemaAutofillApplied,
            schemaCompatMode: requestMeta?.schemaCompatMode,
            originalStrictIncompatibilityPath: requestMeta?.originalStrictIncompatibilityPath,
            originalStrictIncompatibilityReason: requestMeta?.originalStrictIncompatibilityReason,
            providerStrictIncompatibilityPath: requestMeta?.providerStrictIncompatibilityPath,
            providerStrictIncompatibilityReason: requestMeta?.providerStrictIncompatibilityReason,
            responseFormatBeforeCompat: requestMeta?.responseFormatBeforeCompat,
            responseFormatAfterCompat: requestMeta?.responseFormatAfterCompat,
        };
        const genericPayload: Record<string, unknown> = {
            messages: llmReq.messages,
            model: llmReq.model,
            temperature: llmReq.temperature,
            maxTokens: llmReq.maxTokens,
            jsonMode: llmReq.jsonMode,
            apiType: providerApiType,
            jsonSchema: llmReq.schema,
            requestedOutputSchema,
            normalizeMode,
        };

        const openAiLikePayload: Record<string, unknown> = {
            model: llmReq.model,
            messages: llmReq.messages,
            temperature: llmReq.temperature ?? 0.7,
            max_tokens: llmReq.maxTokens ?? 2048,
            requested_output_schema: requestedOutputSchema,
            normalize_mode: normalizeMode,
            api_type: providerApiType,
        };
        if (llmReq.jsonMode) {
            if ((providerApiType === 'openai' || providerApiType === 'gemini') && llmReq.schema && llmReq.preferredResponseFormat === 'json_schema') {
                openAiLikePayload.response_format = {
                    type: 'json_schema',
                    json_schema: {
                        name: llmReq.schemaName || 'structured_output',
                        strict: true,
                        schema: llmReq.schema,
                    },
                };
            } else if (llmReq.preferredResponseFormat === 'system_json') {
                openAiLikePayload.response_format = '[system_prompt_enforced_json_only]';
            } else {
                openAiLikePayload.response_format = { type: 'json_object' };
            }
        }

        return {
            providerKind,
            resourceId,
            requestFormat: providerKind === 'openai'
                ? 'openai_chat_completions'
                : providerKind === 'tavern'
                    ? 'tavern_raw_messages'
                    : 'generic_generation',
            requestParams,
            payload: providerKind === 'openai' ? openAiLikePayload : genericPayload,
            messageCount: llmReq.messages.length,
        };
    }

    private async executeGeneration(args: RunTaskArgs, record: RequestRecord): Promise<LLMRunResult<any>> {
        // 预算检查
        const budgetCheck = this.budgetManager.canRequest(args.consumer);
        if (!budgetCheck.allowed) {
            this.emitLifecycle(args, record, {
                stage: 'failed',
                message: budgetCheck.reason || '请求被限流/熔断',
                error: budgetCheck.reason || '请求被限流/熔断',
                reasonCode: 'circuit_open',
            });
            return {
                ok: false,
                error: budgetCheck.reason || '请求被限流/熔断',
                retryable: true,
                reasonCode: 'circuit_open',
            };
        }

        // 路由解析（新版）
        let resolved;
        try {
            resolved = this.router.resolveRoute({
                consumer: args.consumer,
                taskKind: 'generation',
                taskKey: args.taskKey,
                routeHint: args.routeHint ? {
                    resourceId: args.routeHint.resource,
                    model: args.routeHint.model,
                    profileId: args.routeHint.profile,
                } : undefined,
            });
            this.emitLifecycle(args, record, {
                stage: 'route_resolved',
                message: `已路由到资源 ${resolved.resourceId}`,
                resourceId: resolved.resourceId,
                model: resolved.model,
                progress: 0.4,
            });
        } catch (error) {
            this.emitLifecycle(args, record, {
                stage: 'failed',
                message: (error as Error).message,
                error: (error as Error).message,
                reasonCode: 'provider_unavailable',
            });
            return {
                ok: false,
                error: (error as Error).message,
                retryable: false,
                reasonCode: 'provider_unavailable',
            };
        }

        const profileId = resolved.profileId || this.globalProfileId;
        const profile = this.profileManager.get(profileId);
        const consumerBudget = this.budgetManager.getConfig(args.consumer);
        const settings = this.readSettings();
        const taskDescriptor = this.registry.getTaskDescriptor(args.consumer, args.taskKey);
        const taskAssignment = this.router.getTaskAssignment(args.consumer, args.taskKey);
        const resolvedProvider = this.router.getProvider(resolved.resourceId) as ({ apiType?: ApiType } | undefined);
        const resolvedApiType: ApiType = this.normalizeApiType(resolvedProvider?.apiType);

        const hasCustomSchema = Boolean(args.schema);
        const runtimeSchema = hasCustomSchema
            ? args.schema
            : args.taskKey === 'world.template.build'
                ? WorldTemplateSchema
                : (args.taskKey === 'memory.extract' || args.taskKey === 'world.update' || args.taskKey === 'memory.summarize')
                    ? ProposalEnvelopeSchema
                    : undefined;
        const originalProviderSchema = hasCustomSchema && !this.isZodSchema(args.schema)
            ? args.schema
            : undefined;
        const promptSchema = (originalProviderSchema ?? this.serializeSchemaForLog(args.schema ?? runtimeSchema)) as object | undefined;
        const normalizeMode = hasCustomSchema
            ? 'none'
            : args.taskKey === 'world.template.build'
                ? 'world_template'
                : (args.taskKey === 'memory.extract' || args.taskKey === 'world.update' || args.taskKey === 'memory.summarize')
                    ? 'proposal'
                    : 'none';

        const resolvedMaxTokens = resolveMaxTokens(args, {
            globalControl: settings.maxTokensControl,
            taskAssignment: taskAssignment?.isStale ? undefined : taskAssignment,
            taskRegisteredMaxTokens: taskDescriptor?.maxTokens,
            consumerBudgetMaxTokens: consumerBudget?.maxTokens,
            profileMaxTokens: profile?.maxTokens,
        });
        const schemaCompat: SchemaCompatOptions = {
            strictAutofill: args.schemaCompat?.strictAutofill ?? 'default',
            onIncompatible: args.schemaCompat?.onIncompatible ?? 'downgrade',
        };
        const responseFormatBeforeCompat = (resolvedApiType === 'openai' || resolvedApiType === 'gemini')
            ? (runtimeSchema ? 'json_schema' : 'none')
            : (runtimeSchema ? 'system_json' : 'none');
        const strictSchemaProcessing = (resolvedApiType === 'openai' || resolvedApiType === 'gemini') && originalProviderSchema
            ? processProviderStrictJsonSchema(originalProviderSchema as object, schemaCompat)
            : {
                schema: originalProviderSchema as object | undefined,
                originalCompatible: originalProviderSchema ? isStrictJsonSchemaCompatible(originalProviderSchema) : false,
                autofillApplied: false,
                providerCompatible: originalProviderSchema ? isStrictJsonSchemaCompatible(originalProviderSchema) : false,
                originalDiagnostic: {
                    compatible: originalProviderSchema ? isStrictJsonSchemaCompatible(originalProviderSchema) : false,
                },
                providerDiagnostic: {
                    compatible: originalProviderSchema ? isStrictJsonSchemaCompatible(originalProviderSchema) : false,
                },
            };
        const providerSchema = strictSchemaProcessing.schema;
        const canUseStrictJsonSchema = providerSchema
            ? strictSchemaProcessing.providerCompatible
            : false;
        const responseFormatAfterCompat = resolvedApiType === 'openai' || resolvedApiType === 'gemini'
            ? (canUseStrictJsonSchema ? 'json_schema' : (runtimeSchema ? 'json_object' : 'none'))
            : (runtimeSchema ? 'system_json' : 'none');

        if (
            (resolvedApiType === 'openai' || resolvedApiType === 'gemini')
            && originalProviderSchema
            && !canUseStrictJsonSchema
            && schemaCompat.onIncompatible === 'error'
        ) {
            const diagnostic = strictSchemaProcessing.providerDiagnostic.compatible
                ? strictSchemaProcessing.originalDiagnostic
                : strictSchemaProcessing.providerDiagnostic;
            const diagnosticSuffix = diagnostic.reason
                ? ` (${diagnostic.path || '$'} -> ${diagnostic.reason})`
                : '';
            const reasonCode = strictSchemaProcessing.autofillApplied
                ? 'schema_strict_autofill_incompatible'
                : 'schema_strict_incompatible';
            const error = strictSchemaProcessing.autofillApplied
                ? 'Schema 自动填充后仍不兼容严格 json_schema，已按请求配置阻止降级'
                : 'Schema 不兼容严格 json_schema，已按请求配置阻止降级';
            this.emitLifecycle(args, record, {
                stage: 'failed',
                message: error,
                error,
                reasonCode,
            });
            return {
                ok: false,
                error,
                retryable: false,
                reasonCode,
            };
        }

        const llmReq: LLMRequest = {
            messages: Array.isArray(args.input?.messages)
                ? args.input.messages
                : [
                    {
                        role: 'system',
                        content: args.input?.systemPrompt || '你是一个专业的数据提取助手，请输出 JSON 格式',
                    },
                    {
                        role: 'user',
                        content: buildGenerationUserContent(args.input),
                    },
                ],
            model: resolved.model,
            maxTokens: resolvedMaxTokens.value,
            jsonMode: !!runtimeSchema || profile?.jsonMode === true,
            schema: providerSchema ?? promptSchema,
            schemaName: this.sanitizeSchemaName(this.summarizeSchema(args.schema ?? runtimeSchema)),
            preferredResponseFormat: resolvedApiType === 'openai' || resolvedApiType === 'gemini'
                ? (canUseStrictJsonSchema ? 'json_schema' : (runtimeSchema ? 'json_object' : undefined))
                : (runtimeSchema ? 'system_json' : undefined),
            schemaCompat,
            temperature: args.input?.temperature ?? profile?.temperature ?? 0.3,
        };

        const schemaSummary = this.summarizeSchema(args.schema ?? runtimeSchema);
        const schemaForLog = this.serializeSchemaForLog(originalProviderSchema ?? args.schema ?? runtimeSchema);
        const schemaCharCount = schemaForLog ? JSON.stringify(schemaForLog).length : 0;
        const inputCharCount = llmReq.messages.reduce((sum, msg) => sum + String(msg.content || '').length, 0);
        record.requestLogSnapshot = {
            ...(record.requestLogSnapshot || {
                taskKind: record.taskKind,
                taskDescription: record.taskDescription,
            }),
            schemaSummary,
            schema: schemaForLog,
            jsonMode: llmReq.jsonMode,
            strictSchemaCompatible: canUseStrictJsonSchema,
            originalStrictSchemaCompatible: strictSchemaProcessing.originalCompatible,
            providerSchemaCompatible: strictSchemaProcessing.providerCompatible,
            schemaAutofillApplied: strictSchemaProcessing.autofillApplied,
            schemaCompatMode: `${schemaCompat.strictAutofill}:${schemaCompat.onIncompatible}`,
            originalStrictIncompatibilityPath: strictSchemaProcessing.originalDiagnostic.path,
            originalStrictIncompatibilityReason: strictSchemaProcessing.originalDiagnostic.reason,
            providerStrictIncompatibilityPath: strictSchemaProcessing.providerDiagnostic.path,
            providerStrictIncompatibilityReason: strictSchemaProcessing.providerDiagnostic.reason,
            responseFormatResolved: llmReq.preferredResponseFormat || 'none',
            responseFormatBeforeCompat,
            responseFormatAfterCompat,
            resolvedMaxTokens: {
                value: resolvedMaxTokens.value,
                source: resolvedMaxTokens.source,
                detail: resolvedMaxTokens.detail,
            },
            normalizeMode,
            providerRequest: this.buildGenerationProviderRequestSnapshot(
                resolved.resourceId,
                llmReq,
                runtimeSchema,
                normalizeMode,
                args,
                schemaSummary,
                resolvedMaxTokens.source,
                {
                    originalStrictSchemaCompatible: strictSchemaProcessing.originalCompatible,
                    providerSchemaCompatible: strictSchemaProcessing.providerCompatible,
                    schemaAutofillApplied: strictSchemaProcessing.autofillApplied,
                    schemaCompatMode: `${schemaCompat.strictAutofill}:${schemaCompat.onIncompatible}`,
                    originalStrictIncompatibilityPath: strictSchemaProcessing.originalDiagnostic.path,
                    originalStrictIncompatibilityReason: strictSchemaProcessing.originalDiagnostic.reason,
                    providerStrictIncompatibilityPath: strictSchemaProcessing.providerDiagnostic.path,
                    providerStrictIncompatibilityReason: strictSchemaProcessing.providerDiagnostic.reason,
                    responseFormatBeforeCompat,
                    responseFormatAfterCompat,
                },
            ),
            metrics: {
                ...(record.requestLogSnapshot?.metrics || {}),
                schemaCharCount,
                inputCharCount,
            },
        };

        const maxLatencyMs = args.budget?.maxLatencyMs ?? consumerBudget?.maxLatencyMs;
        this.emitLifecycle(args, record, {
            stage: 'provider_requesting',
            message: '正在请求模型',
            resourceId: resolved.resourceId,
            model: resolved.model,
            progress: 0.6,
        });

        // 主 Provider 尝试
        const primaryResult = await this.tryProvider(
            resolved.resourceId,
            llmReq,
            runtimeSchema,
            normalizeMode,
            args.consumer,
            args.taskKey,
            maxLatencyMs,
            args.signal,
        );

        this.attachProviderRequestSnapshot(record, primaryResult.providerRequest);
        this.attachRecordDebug(record, primaryResult);

        if (primaryResult.ok) {
            const meta: LLMRunMeta = {
                requestId: this.getActiveAttemptRequestId(record),
                resourceId: resolved.resourceId,
                model: resolved.model,
                capabilityKind: 'generation',
                queuedAt: record.queuedAt,
                startedAt: record.startedAt,
                finishedAt: Date.now(),
                latencyMs: Date.now() - (record.startedAt || record.queuedAt),
            };
            this.emitLifecycle(args, record, {
                stage: 'completed',
                message: '任务执行完成',
                resourceId: resolved.resourceId,
                model: resolved.model,
                progress: 1,
            });
            return { ok: true, data: primaryResult.data, meta };
        }

        // Fallback: 资源不可用
        if (resolved.fallbackResourceId) {
            this.emitLifecycle(args, record, {
                stage: 'fallback_started',
                message: `主资源失败，切换到备用资源 ${resolved.fallbackResourceId}`,
                resourceId: resolved.fallbackResourceId,
                model: resolved.model,
                fallbackUsed: true,
                progress: 0.75,
            });
            this.emitLifecycle(args, record, {
                stage: 'provider_requesting',
                message: '正在请求备用资源',
                resourceId: resolved.fallbackResourceId,
                model: resolved.model,
                fallbackUsed: true,
                progress: 0.85,
            });
            const fallbackResult = await this.tryProvider(
                resolved.fallbackResourceId,
                llmReq,
                runtimeSchema,
                normalizeMode,
                args.consumer,
                args.taskKey,
                maxLatencyMs,
                args.signal,
            );
            this.attachProviderRequestSnapshot(record, fallbackResult.providerRequest);
            this.attachRecordDebug(record, fallbackResult);
            if (fallbackResult.ok) {
                const meta: LLMRunMeta = {
                    requestId: this.getActiveAttemptRequestId(record),
                    resourceId: resolved.fallbackResourceId,
                    model: resolved.model,
                    capabilityKind: 'generation',
                    queuedAt: record.queuedAt,
                    startedAt: record.startedAt,
                    finishedAt: Date.now(),
                    latencyMs: Date.now() - (record.startedAt || record.queuedAt),
                    fallbackUsed: true,
                };
                this.emitLifecycle(args, record, {
                    stage: 'completed',
                    message: '备用资源执行完成',
                    resourceId: resolved.fallbackResourceId,
                    model: resolved.model,
                    fallbackUsed: true,
                    progress: 1,
                });
                return { ok: true, data: fallbackResult.data, meta };
            }
            this.emitLifecycle(args, record, {
                stage: 'failed',
                message: `主备资源均失败: ${primaryResult.error} / ${fallbackResult.error}`,
                error: `主备资源均失败: ${primaryResult.error} / ${fallbackResult.error}`,
                reasonCode: fallbackResult.reasonCode || primaryResult.reasonCode || 'unknown',
                fallbackUsed: true,
            });
            return {
                ok: false,
                error: `主备资源均失败: ${primaryResult.error} / ${fallbackResult.error}`,
                retryable: true,
                fallbackUsed: true,
                reasonCode: fallbackResult.reasonCode || primaryResult.reasonCode || 'unknown',
            };
        }

        this.emitLifecycle(args, record, {
            stage: 'failed',
            message: primaryResult.error || '未知错误',
            error: primaryResult.error || '未知错误',
            reasonCode: primaryResult.reasonCode,
        });

        return {
            ok: false,
            error: primaryResult.error || '未知错误',
            retryable: primaryResult.retryable,
            reasonCode: primaryResult.reasonCode,
        };
    }

    private attachRecordDebug(record: RequestRecord, result: {
        rawResponseText?: string;
        providerResponse?: unknown;
        parsedResponse?: unknown;
        normalizedResponse?: unknown;
        validationErrors?: string[];
        error?: string;
        reasonCode?: string;
    }): void {
        const hasDebug = result.rawResponseText != null
            || result.providerResponse !== undefined
            || result.parsedResponse !== undefined
            || result.normalizedResponse !== undefined
            || (Array.isArray(result.validationErrors) && result.validationErrors.length > 0)
            || result.error;
        if (!hasDebug) return;

        record.debug = {
            rawResponseText: result.rawResponseText,
            providerResponse: result.providerResponse,
            parsedResponse: result.parsedResponse,
            normalizedResponse: result.normalizedResponse,
            validationErrors: result.validationErrors,
            finalError: result.error,
            reasonCode: result.reasonCode,
        };

        if (record.requestLogSnapshot?.metrics && result.rawResponseText != null) {
            record.requestLogSnapshot.metrics.outputCharCount = result.rawResponseText.length;
        }
    }

    private attachProviderRequestSnapshot(record: RequestRecord, providerRequest?: unknown): void {
        if (!providerRequest || typeof providerRequest !== 'object') {
            return;
        }

        const cloneForLog = (input: unknown, depth = 0, seen = new WeakSet<object>()): unknown => {
            if (input == null || typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
                return input;
            }
            if (typeof input === 'bigint' || typeof input === 'symbol') {
                return String(input);
            }
            if (typeof input === 'function') {
                return `[Function ${(input as Function).name || 'anonymous'}]`;
            }
            if (depth >= 10) {
                return '[MaxDepth]';
            }
            if (Array.isArray(input)) {
                return input.map((item) => cloneForLog(item, depth + 1, seen));
            }
            if (typeof input === 'object') {
                const objectValue = input as Record<string, unknown>;
                if (seen.has(objectValue)) {
                    return '[Circular]';
                }
                seen.add(objectValue);
                const out: Record<string, unknown> = {};
                for (const [key, value] of Object.entries(objectValue)) {
                    out[key] = cloneForLog(value, depth + 1, seen);
                }
                seen.delete(objectValue);
                return out;
            }
            return String(input);
        };

        record.requestLogSnapshot = {
            ...(record.requestLogSnapshot || {
                taskKind: record.taskKind,
                taskDescription: record.taskDescription,
            }),
            providerRequest: cloneForLog(providerRequest) as Record<string, unknown>,
        };
    }

    private async executeEmbed(args: EmbedArgs, record: RequestRecord): Promise<any> {
        let resolved;
        try {
            resolved = this.router.resolveRoute({
                consumer: args.consumer,
                taskKind: 'embedding',
                taskKey: args.taskKey,
                requiredCapabilities: ['embeddings'],
                routeHint: args.routeHint ? { resourceId: args.routeHint.resource, model: args.routeHint.model } : undefined,
            });
            this.emitLifecycle(args, record, {
                stage: 'route_resolved',
                message: `已路由到向量资源 ${resolved.resourceId}`,
                resourceId: resolved.resourceId,
                model: resolved.model,
                progress: 0.4,
            });
        } catch (error) {
            this.emitLifecycle(args, record, {
                stage: 'failed',
                message: (error as Error).message,
                error: (error as Error).message,
            });
            return { ok: false, error: (error as Error).message };
        }

        const provider = this.router.getProvider(resolved.resourceId);
        if (!provider?.embed) {
            this.attachRecordDebug(record, {
                error: '当前资源不支持 embedding',
                reasonCode: 'provider_unavailable',
            });
            this.emitLifecycle(args, record, {
                stage: 'failed',
                message: '当前资源不支持 embedding',
                error: '当前资源不支持 embedding',
            });
            return { ok: false, error: '当前资源不支持 embedding' };
        }

        try {
            this.attachProviderRequestSnapshot(record, {
                texts: args.texts,
                model: resolved.model,
            });
            this.emitLifecycle(args, record, {
                stage: 'provider_requesting',
                message: '正在执行向量请求',
                resourceId: resolved.resourceId,
                model: resolved.model,
                progress: 0.65,
            });
            const response = await provider.embed({ texts: args.texts, model: resolved.model, signal: args.signal });
            this.attachRecordDebug(record, {
                providerResponse: response,
            });
            const meta: LLMRunMeta = {
                requestId: this.getActiveAttemptRequestId(record),
                resourceId: resolved.resourceId,
                model: resolved.model,
                capabilityKind: 'embedding',
                queuedAt: record.queuedAt,
                startedAt: record.startedAt,
                finishedAt: Date.now(),
                latencyMs: Date.now() - (record.startedAt || record.queuedAt),
            };
            this.emitLifecycle(args, record, {
                stage: 'completed',
                message: '向量任务完成',
                resourceId: resolved.resourceId,
                model: resolved.model,
                progress: 1,
            });
            return { ok: true, vectors: response.embeddings, model: resolved.model, meta, providerResponse: response };
        } catch (error) {
            const errorMessage = (error as Error).message;
            const reasonCode = inferReasonCode(errorMessage);
            this.attachRecordDebug(record, {
                error: errorMessage,
                reasonCode,
            });
            this.emitLifecycle(args, record, {
                stage: 'failed',
                message: errorMessage,
                error: errorMessage,
            });
            return {
                ok: false,
                error: errorMessage,
                retryable: this.isReasonCodeRetryable(reasonCode),
                reasonCode,
            };
        }
    }

    /**
     * 功能：为一次请求尝试生成新的请求 ID。
     * @param record 请求主记录。
     * @returns 当前尝试使用的请求 ID。
     */
    private generateAttemptRequestId(record: RequestRecord): string {
        const requestId = `${record.llmTaskId}_req_${record.attemptIndex}_${Date.now()}`;
        record.activeAttemptRequestId = requestId;
        return requestId;
    }

    /**
     * 功能：读取当前尝试请求 ID。
     * @param record 请求主记录。
     * @returns 当前尝试请求 ID。
     */
    private getActiveAttemptRequestId(record: RequestRecord): string {
        return String(record.activeAttemptRequestId || '').trim() || this.generateAttemptRequestId(record);
    }

    /**
     * 功能：记录一次尝试日志。
     * @param record 请求主记录。
     * @param requestId 当前尝试请求 ID。
     * @param result 当前尝试结果。
     * @param isFinalAttempt 是否为最终尝试。
     * @returns 异步完成。
     */
    private async recordAttemptLog(
        record: RequestRecord,
        requestId: string,
        result: LLMRunResult<unknown>,
        isFinalAttempt: boolean,
    ): Promise<void> {
        await this.requestLogService.recordAttempt({
            record,
            requestId,
            result,
            attemptTag: record.attemptIndex > 1 ? '重试' : '初次请求',
            attemptOutcome: result.ok ? '成功' : '失败',
            isFinalAttempt,
        });
    }

    private async executeRerank(args: RerankArgs, record: RequestRecord): Promise<any> {
        let resolved;
        try {
            resolved = this.router.resolveRoute({
                consumer: args.consumer,
                taskKind: 'rerank',
                taskKey: args.taskKey,
                requiredCapabilities: ['rerank'],
                routeHint: args.routeHint ? { resourceId: args.routeHint.resource, model: args.routeHint.model } : undefined,
            });
            this.emitLifecycle(args, record, {
                stage: 'route_resolved',
                message: `已路由到重排资源 ${resolved.resourceId}`,
                resourceId: resolved.resourceId,
                model: resolved.model,
                progress: 0.4,
            });
        } catch (error) {
            this.emitLifecycle(args, record, {
                stage: 'failed',
                message: (error as Error).message,
                error: (error as Error).message,
            });
            return { ok: false, error: (error as Error).message };
        }

        const provider = this.router.getProvider(resolved.resourceId);
        if (provider?.rerank) {
            try {
                this.attachProviderRequestSnapshot(record, {
                    query: args.query,
                    docs: args.docs,
                    topK: args.topK,
                    model: resolved.model,
                });
                this.emitLifecycle(args, record, {
                    stage: 'provider_requesting',
                    message: '正在执行重排请求',
                    resourceId: resolved.resourceId,
                    model: resolved.model,
                    progress: 0.65,
                });
                const response = await provider.rerank({
                    query: args.query,
                    docs: args.docs,
                    topK: args.topK,
                    model: resolved.model,
                    signal: args.signal,
                });
                this.attachRecordDebug(record, {
                    providerResponse: response,
                });
                const meta: LLMRunMeta = {
                    requestId: this.getActiveAttemptRequestId(record),
                    resourceId: resolved.resourceId,
                    model: resolved.model,
                    capabilityKind: 'rerank',
                    queuedAt: record.queuedAt,
                    startedAt: record.startedAt,
                    finishedAt: Date.now(),
                    latencyMs: Date.now() - (record.startedAt || record.queuedAt),
                };
                this.emitLifecycle(args, record, {
                    stage: 'completed',
                    message: '重排任务完成',
                    resourceId: resolved.resourceId,
                    model: resolved.model,
                    progress: 1,
                });
                return { ok: true, results: response.results, resource: resolved.resourceId, meta, providerResponse: response };
        } catch (error) {
            const errorMessage = (error as Error).message;
            const reasonCode = inferReasonCode(errorMessage);
            this.attachRecordDebug(record, {
                error: errorMessage,
                reasonCode,
            });
            this.emitLifecycle(args, record, {
                stage: 'failed',
                message: errorMessage,
                error: errorMessage,
            });
            return {
                ok: false,
                error: errorMessage,
                retryable: this.isReasonCodeRetryable(reasonCode),
                reasonCode,
            };
        }
        }

        // Provider 不支持 rerank：关键词覆盖率兜底
        const tokens = args.query
            .toLowerCase()
            .split(/[\s，。！？,.!?\n]+/)
            .map((token: string) => token.trim())
            .filter((token: string) => token.length > 1);

        const scored = args.docs.map((doc: string, index: number) => {
            const lower = doc.toLowerCase();
            let hit = 0;
            for (const token of tokens) {
                if (lower.includes(token)) hit += 1;
            }
            const score = tokens.length > 0 ? hit / tokens.length : 0;
            return { index, score, doc };
        });
        scored.sort((a, b) => b.score - a.score);
        this.emitLifecycle(args, record, {
            stage: 'completed',
            message: '重排资源不支持原生接口，已使用关键词兜底完成',
            resourceId: `${resolved.resourceId}:fallback`,
            model: resolved.model,
            fallbackUsed: true,
            progress: 1,
        });
        this.attachRecordDebug(record, {
            providerResponse: { results: scored },
        });
        return {
            ok: true,
            results: scored,
            resource: `${resolved.resourceId}:fallback`,
            fallbackUsed: true,
            providerResponse: { results: scored },
        };
    }

    /** 尝试单个资源执行请求 */
    private async tryProvider(
        resourceId: string,
        req: LLMRequest,
        schema: unknown,
        normalizeMode: 'proposal' | 'world_template' | 'none',
        consumer: string,
        taskKey: string,
        maxLatencyMs?: number,
        signal?: AbortSignal,
    ): Promise<{
        ok: boolean;
        data?: any;
        error?: string;
        retryable?: boolean;
        cost?: number;
        reasonCode?: string;
        rawResponseText?: string;
        providerResponse?: unknown;
        parsedResponse?: unknown;
        normalizedResponse?: unknown;
        validationErrors?: string[];
        providerRequest?: Record<string, unknown>;
    }> {
        try {
            const provider = this.router.getProvider(resourceId);
            if (!provider) {
                return { ok: false, error: `资源 "${resourceId}" 未找到`, retryable: false, reasonCode: 'provider_unavailable' };
            }

            const timeoutMs = Number(maxLatencyMs);
            const response = Number.isFinite(timeoutMs) && timeoutMs > 0
                ? await Promise.race([
                    provider.request({ ...req, signal }),
                    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`请求 Provider 超时 (>${timeoutMs}ms)`)), timeoutMs)),
                ])
                : await provider.request({ ...req, signal });

            const runtimeSchema = schema;
            const finishReason = String((response as { finishReason?: unknown }).finishReason ?? '').trim().toLowerCase();

            if (finishReason === 'length') {
                this.budgetManager.recordFailure(consumer);
                return {
                    ok: false,
                    error: `模型输出被截断：已触发 max_tokens=${Number(req.maxTokens ?? 0) || 0} 上限，返回的 JSON 未完整结束`,
                    retryable: true,
                    reasonCode: 'token_limit_exceeded',
                    rawResponseText: response.content,
                    providerResponse: response,
                    providerRequest: response.debugRequest,
                };
            }

            if (runtimeSchema) {
                const parsed = parseJsonOutput(response.content);
                if (!parsed.ok) {
                    this.budgetManager.recordFailure(consumer);
                    return {
                        ok: false,
                        error: `JSON 解析失败: ${parsed.error}`,
                        retryable: true,
                        reasonCode: 'invalid_json',
                        rawResponseText: response.content,
                        providerResponse: response,
                        providerRequest: response.debugRequest,
                    };
                }

                const normalizedInput = normalizeMode === 'proposal'
                    ? normalizeProposalEnvelopeInput(parsed.data)
                    : normalizeMode === 'world_template'
                        ? normalizeWorldTemplateInput(parsed.data)
                        : parsed.data;
                const postProcessedInput = normalizeStructuredCategoryBuckets(normalizedInput);

                if (this.isZodSchema(runtimeSchema)) {
                    const validation = validateZodSchema(postProcessedInput, runtimeSchema);
                    if (!validation.valid) {
                        this.budgetManager.recordFailure(consumer);
                        return {
                            ok: false,
                            error: `Schema Zod 校验失败: ${validation.errors.join('; ')}`,
                            retryable: true,
                            reasonCode: 'schema_validation_failed',
                            rawResponseText: response.content,
                            providerResponse: response,
                            parsedResponse: parsed.data,
                            normalizedResponse: postProcessedInput,
                            validationErrors: validation.errors,
                            providerRequest: response.debugRequest,
                        };
                    }

                    this.budgetManager.recordSuccess(consumer);
                    return {
                        ok: true,
                        data: validation.data,
                        rawResponseText: response.content,
                        providerResponse: response,
                        parsedResponse: parsed.data,
                        normalizedResponse: postProcessedInput,
                        providerRequest: response.debugRequest,
                    };
                }

                this.budgetManager.recordSuccess(consumer);
                return {
                ok: true,
                data: postProcessedInput,
                rawResponseText: response.content,
                providerResponse: response,
                parsedResponse: parsed.data,
                normalizedResponse: postProcessedInput,
                providerRequest: response.debugRequest,
            };
            }

            this.budgetManager.recordSuccess(consumer);
            return {
                ok: true,
                data: response.content,
                rawResponseText: response.content,
                providerResponse: response,
                providerRequest: response.debugRequest,
            };
        } catch (error) {
            this.budgetManager.recordFailure(consumer);
            const providerError = error as Error & {
                reasonCode?: string;
                detail?: string;
                providerRequest?: Record<string, unknown>;
                providerResponse?: unknown;
            };
            const message = providerError.message;
            const reasonCode = providerError.reasonCode || inferReasonCode(message);
            const retryable = reasonCode === 'timeout' || reasonCode === 'rate_limited' || reasonCode === 'network_error';
            return {
                ok: false,
                error: message,
                retryable,
                reasonCode,
                rawResponseText: providerError.detail,
                providerRequest: providerError.providerRequest,
                providerResponse: providerError.providerResponse,
            };
        }
    }

}
