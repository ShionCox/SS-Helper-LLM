import type { LLMRequest } from '../providers/types';
import { TaskRouter } from '../router/router';
import { BudgetManager } from '../budget/budget-manager';
import {
    parseJsonOutput,
} from '../schema/validator';
import {
    preflightJsonSchema,
    validateJsonSchema,
    validateJsonSchemaItemized,
    type JsonSchemaItemRejection,
} from '../schema/json-schema-validator';
import { ProfileManager } from '../profile/profile-manager';
import {
    createSSHelperError,
    describeSSHelperFailure,
    isSSHelperReasonCode,
    readSSHelperFailure,
    SS_HELPER_DIAGNOSTICS,
    type SSHelperFailureContext,
    type SSHelperReasonCode,
} from '@ss-helper/sdk';
import { createStructuredOutputPlan, withStructuredOutputInstruction, type StructuredOutputIdentity } from '../schema/structured-output-plan';
import { resolveMaxTokens, type ResolvedMaxTokensResult } from './max-tokens';
import { RequestOrchestrator } from '../orchestrator/orchestrator';
import { ConsumerRegistry } from '../registry/consumer-registry';
import { logger, safeFailureLogDetail } from '../runtime/logger';
import { RequestLogService } from '../log/requestLogService';
import { RequestRateLimiter } from '../runtime/request-rate-limiter';
import { DEFAULT_REASONING_POLICY } from '../providers/reasoning-policy';
import type {
    LLMRunResult,
    LLMRunMeta,
    CapabilityKind,
    ConsumerRegistration,
    LLMInspectApi,
    RunTaskArgs,
    EmbedArgs,
    RerankArgs,
    RequestRecord,
    LLMRequestLogRequestSnapshot,
    LLMTaskLifecycleEvent,
    LLMHubSettings,
    LLMExecution,
} from '../schema/types';

function canonicalSchemaValue(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const canonical = Array.isArray(value)
        ? value.map((item) => canonicalSchemaValue(item, seen))
        : Object.fromEntries(Object.entries(value as Record<string, unknown>)
            .filter(([, nested]) => nested !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, canonicalSchemaValue(nested, seen)]));
    seen.delete(value);
    return canonical;
}

function hashSchema(schema: unknown): string | undefined {
    if (schema === undefined) return undefined;
    const bytes = new TextEncoder().encode(JSON.stringify(canonicalSchemaValue(schema)));
    let hash = 0x811c9dc5;
    for (const byte of bytes) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

type StructuredOutputTransport = NonNullable<LLMRequest['structuredOutput']>['transport'];

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

function structuredOutputLogFields(
    plan: NonNullable<LLMRequest['structuredOutput']>,
): NonNullable<LLMRequestLogRequestSnapshot['structuredOutput']> {
    return {
        vendor: plan.identity.vendor,
        detectionEvidence: plan.identity.evidence,
        confidence: plan.identity.confidence,
        transport: plan.transport,
        strictSchemaCompatible: plan.strictSchemaCompatible,
        contextMode: plan.transport === 'prompt_only' ? 'isolated' : 'chat',
        nativeJsonMode: plan.transport !== 'prompt_only',
        nativeSchemaSent: plan.transport === 'json_schema' || plan.transport === 'tavern_json_schema',
    };
}


/**
 * LLMSDK 门面层
 * 整合四层架构：注册中心、路由、编排、展示。
 *
 * 异步接口：runTask、embed、rerank。
 * 同步接口：registerConsumer、unregisterConsumer。
 */
export class LLMSDKImpl {
    private router: TaskRouter;
    private budgetManager: BudgetManager;
    private profileManager: ProfileManager;
    private orchestrator: RequestOrchestrator;
    private registry: ConsumerRegistry;
    private requestLogService: RequestLogService;
    private globalProfileId: string;
    private settingsResolver: (() => LLMHubSettings) | null = null;
    private reasoningCapabilityResolver?: (resourceId: string, model?: string) => string | undefined;
    public inspect?: LLMInspectApi;

    constructor(
        router: TaskRouter,
        budgetManager: BudgetManager,
        orchestrator: RequestOrchestrator,
        registry: ConsumerRegistry,
        requestLogService: RequestLogService,
        private readonly requestRateLimiter: RequestRateLimiter = new RequestRateLimiter(),
    ) {
        this.router = router;
        this.budgetManager = budgetManager;
        this.profileManager = new ProfileManager();
        this.orchestrator = orchestrator;
        this.registry = registry;
        this.requestLogService = requestLogService;
        this.globalProfileId = 'balanced';

        // 连接编排器与展示控制器
        this.orchestrator.setExecuteCallback(async (record) => {
            const result = await this.executeRequest(record);
            if (!record.activeAttemptRequestId) {
                try {
                    await this.requestLogService.recordUnattemptedRequest(record, result);
                } catch (error) {
                    logger.warn(`请求日志写入失败: ${record.requestId}`, safeFailureLogDetail(error, {
                        reasonCode: 'LOG_UNAVAILABLE',
                        stage: 'llm.log.unattempted',
                        requestId: record.requestId,
                    }));
                }
            }
            return result;
        });
        this.orchestrator.setArchiveCallback((record) => {
            void this.requestLogService.archiveRecord(record).catch((error) => {
                logger.warn(`请求日志归档失败: ${record.requestId}`, safeFailureLogDetail(error, {
                    reasonCode: 'LOG_UNAVAILABLE',
                    stage: 'llm.log.archive',
                    requestId: record.requestId,
                }));
            });
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

    // ─── 异步接口 ───

    setGlobalProfile(profileId: string): void {
        const profile = this.profileManager.get(profileId);
        if (!profile) {
            throw createSSHelperError('LLM_PROFILE_NOT_FOUND', {
                stage: 'llm.profile.select',
            });
        }
        this.globalProfileId = profileId;
    }

    getGlobalProfile(): string {
        return this.globalProfileId;
    }

    setSettingsResolver(resolver: () => LLMHubSettings): void {
        this.settingsResolver = resolver;
    }

    setReasoningCapabilityResolver(resolver: (resourceId: string, model?: string) => string | undefined): void {
        this.reasoningCapabilityResolver = resolver;
    }

    resolveTaskMaxTokens(args: RunTaskArgs, profileId?: string): ResolvedMaxTokensResult {
        const settings = this.readSettings();
        const taskAssignment = this.router.getTaskAssignment(args.consumer, args.taskKey);
        return resolveMaxTokens(args, {
            globalControl: settings.maxTokensControl,
            taskAssignment: taskAssignment?.isStale ? undefined : taskAssignment,
            taskRegisteredMaxTokens: this.registry.getTaskDescriptor(args.consumer, args.taskKey)?.maxTokens,
            requestBudgetMaxTokens: args.budget?.maxTokens,
            consumerBudgetMaxTokens: this.budgetManager.getConfig(args.consumer)?.maxTokens,
            profileMaxTokens: this.profileManager.get(profileId || this.globalProfileId)?.maxTokens,
        });
    }

    dispose(): void {
        this.settingsResolver = null;
        this.orchestrator.dispose();
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
            logger.warn(`生命周期回调执行失败: ${record.requestId}`, safeFailureLogDetail(error, {
                reasonCode: 'INTERNAL_ERROR',
                stage: 'llm.lifecycle.callback',
                requestId: record.requestId,
            }));
        }
    }

    private isReasonCodeRetryable(reasonCode?: SSHelperReasonCode): boolean {
        return isSSHelperReasonCode(reasonCode)
            ? SS_HELPER_DIAGNOSTICS[reasonCode].retryable
            : false;
    }

    private failure(
        error: unknown,
        stage: string,
        context: Partial<Omit<SSHelperFailureContext, 'reasonCode' | 'stage'>> = {},
    ): SSHelperFailureContext {
        return readSSHelperFailure(error, {
            reasonCode: 'INTERNAL_ERROR',
            stage,
            ...context,
        })!;
    }

    private failureResult<T>(failure: SSHelperFailureContext): LLMRunResult<T> {
        return {
            ok: false,
            reasonCode: failure.reasonCode,
            retryable: SS_HELPER_DIAGNOSTICS[failure.reasonCode].retryable,
            failure,
        };
    }

    private async executeWithRetryLoop<T>(
        record: RequestRecord,
        args: RunTaskArgs | EmbedArgs | RerankArgs,
        executor: () => Promise<LLMRunResult<T>>,
    ): Promise<LLMRunResult<T>> {
        if ('input' in args) {
            return executor();
        }
        let retryCount = 0;

        while (true) {
            const attemptId = this.generateAttemptRequestId(record);
            record.activeAttemptPhase = retryCount > 0 ? 'transient_retry' : 'initial';
            try {
                await this.requestLogService.beginAttempt({ record, attemptId, attemptPhase: record.activeAttemptPhase });
                await this.requestLogService.markAttemptRunning({ record, attemptId, attemptPhase: record.activeAttemptPhase });
            } catch (error) {
                // A log implementation bug or an exhausted fallback must not
                // turn a business request into a failed Provider call.
                logger.warn('请求日志初始化失败，LLM 请求将继续执行。', safeFailureLogDetail(error, {
                    reasonCode: 'LOG_UNAVAILABLE',
                    stage: 'llm.log.begin',
                    requestId: record.requestId,
                    attemptId,
                }));
            }
            let currentResult: LLMRunResult<T>;
            try {
                currentResult = await executor();
            } catch (error) {
                currentResult = this.failureResult(this.failure(error, 'llm.request.execute', {
                    requestId: record.requestId,
                    attemptId,
                }));
            }
            if (record.validity.isCancelled || record.validity.isSuperseded) {
                const cancelled = this.failureResult<T>({
                    reasonCode: 'CANCELLED',
                    stage: 'llm.request.cancelled',
                    requestId: record.requestId,
                    attemptId,
                });
                await this.recordAttemptLog(record, attemptId, cancelled, true);
                return cancelled;
            }
            const reasonCode: SSHelperReasonCode | undefined = currentResult.ok
                ? undefined
                : isSSHelperReasonCode(currentResult.reasonCode)
                    ? currentResult.reasonCode
                    : 'INTERNAL_ERROR';
            const shouldRetry = !currentResult.ok
                && retryCount < 1
                && currentResult.retryable !== false
                && this.isReasonCodeRetryable(reasonCode);

            await this.recordAttemptLog(record, attemptId, currentResult, !shouldRetry);

            if (!shouldRetry) {
                return currentResult;
            }

            retryCount += 1;
            this.emitLifecycle(args, record, {
                stage: 'running',
                message: '检测到临时故障，正在自动重试一次',
                progress: 0.35,
            });
            this.orchestrator.advanceAttempt(record);
        }
    }

    private resolveTaskDescription(consumer: string, taskKey: string, taskKind: CapabilityKind, explicit?: string): string {
        const registered = this.registry.getTaskDescriptor(consumer, taskKey)?.description;
        const registeredText = String(registered || '').trim();
        if (registeredText) return registeredText;
        const explicitText = String(explicit || '').trim();
        if (explicitText) return explicitText;
        return taskKind === 'embedding'
            ? '用途未声明的向量化任务'
            : taskKind === 'rerank'
                ? '用途未声明的重排任务'
                : '用途未声明的生成任务';
    }

    private expectedExecution(consumer: string, taskKey: string, taskKind: CapabilityKind): LLMExecution {
        if (taskKey === 'completion') return 'completion';
        const descriptor = this.registry.getTaskDescriptor(consumer, taskKey);
        if (descriptor?.execution) return descriptor.execution;
        if (taskKind === 'embedding') return 'embedding';
        if (taskKind === 'rerank') return 'rerank';
        return descriptor?.requiredCapabilities.includes('tools') ? 'tool_turn' : 'structured';
    }

    private setRouteSnapshot(record: RequestRecord, resourceId: string, model: string | undefined, taskKind: CapabilityKind): void {
        const provider = this.router.getProvider(resourceId) as ({ kind?: string } | undefined);
        const resource = this.readSettings().resources?.find((item) => item.id === resourceId);
        let endpointOrigin: string | undefined;
        let endpointPath: string | undefined;
        let queryParameterNames: string[] | undefined;
        if (resource?.baseUrl) {
            try {
                const endpoint = new URL(resource.baseUrl);
                endpointOrigin = endpoint.origin;
                queryParameterNames = [...new Set(endpoint.searchParams.keys())].sort();
                const operationPath = taskKind === 'embedding'
                    ? resource.apiType === 'gemini'
                        ? `/models/${encodeURIComponent(model ?? resource.model ?? '')}:embedContent`
                        : resource.embeddingPath ?? '/embeddings'
                    : taskKind === 'rerank'
                        ? resource.rerankProtocol === 'chat' ? '/chat/completions' : resource.rerankPath ?? '/rerank'
                        : resource.apiType === 'claude' ? '/messages'
                            : resource.apiType === 'gemini'
                                ? `/models/${encodeURIComponent(model ?? resource.model ?? '')}:${this.readSettings().streamingEnabled === false ? 'generateContent' : 'streamGenerateContent'}`
                                : '/chat/completions';
                const basePath = (endpoint.pathname || '/').replace(/\/+$/u, '');
                const normalizedOperation = operationPath.startsWith('/') ? operationPath : `/${operationPath}`;
                endpointPath = basePath.endsWith(normalizedOperation) ? basePath : `${basePath}${normalizedOperation}`;
                if (resource.apiType === 'gemini' && taskKind === 'generation' && this.readSettings().streamingEnabled !== false) {
                    queryParameterNames = [...new Set([...(queryParameterNames ?? []), 'alt'])].sort();
                }
            } catch {
                endpointPath = String(resource.baseUrl).split(/[?#]/u, 1)[0];
            }
        }
        record.routeSnapshot = {
            resourceId,
            resourceLabel: resource?.label ?? (resourceId === 'tavern:active' ? '酒馆当前连接' : resourceId),
            ...(model ? { model } : {}),
            ...(provider?.kind ? { providerKind: provider.kind } : {}),
            ...(resource?.apiType ? { apiType: resource.apiType } : {}),
            ...(endpointOrigin ? { endpointOrigin } : {}),
            ...(endpointPath ? { endpointPath } : {}),
            ...(queryParameterNames?.length ? { queryParameterNames } : {}),
            ...(resource?.customParams ? { customParameterNames: Object.keys(resource.customParams).sort() } : {}),
            streaming: this.readSettings().streamingEnabled !== false,
        };
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

    private sanitizeSchemaName(name?: string): string {
        const normalized = String(name || 'structured_output')
            .trim()
            .replace(/[^a-zA-Z0-9_-]+/g, '_')
            .replace(/^_+|_+$/g, '');
        return normalized || 'structured_output';
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
            budget: runArgs.budget,
            enqueue: runArgs.enqueue,
            schemaSummary: this.summarizeSchema(runArgs.schema),
            schemaHash: hashSchema(runArgs.schema),
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
    async runTask<T>(args: RunTaskArgs): Promise<LLMRunResult<T>> {
        const taskKind: CapabilityKind = args.taskKind;
        const expectedExecution = this.expectedExecution(args.consumer, args.taskKey, taskKind);
        if (args.execution !== undefined && args.execution !== expectedExecution) {
            return this.failureResult({
                reasonCode: 'LLM_EXECUTION_MISMATCH',
                stage: 'llm.request.execution',
                ...(args.enqueue?.requestId ? { requestId: args.enqueue.requestId } : {}),
            }) as LLMRunResult<T>;
        }
        if (expectedExecution === 'tool_turn') {
            return this.failureResult({ reasonCode: 'LLM_EXECUTION_MISMATCH', stage: 'llm.request.tool_turn' }) as LLMRunResult<T>;
        }
        const taskDescription = this.resolveTaskDescription(args.consumer, args.taskKey, taskKind, args.taskDescription);

        const record = this.orchestrator.enqueue<T>(
            args.consumer,
            args.taskKey,
            taskKind,
            { ...args.enqueue, scope: args.enqueue?.scope || { pluginId: args.consumer } },
            args,
            taskDescription,
        );
        record.chatKey = this.resolveRequestChatKey(args);
        record.consumerDisplayName = this.registry.getConsumerRegistration(args.consumer)?.displayName;
        record.workflow = args.trace;
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
        const taskDescription = this.resolveTaskDescription(args.consumer, args.taskKey, 'embedding', args.taskDescription);
        const record = this.orchestrator.enqueue(
            args.consumer,
            args.taskKey,
            'embedding',
            { ...args.enqueue, scope: args.enqueue?.scope || { pluginId: args.consumer } },
            args,
            taskDescription,
        );
        record.chatKey = this.resolveRequestChatKey(args);
        record.consumerDisplayName = this.registry.getConsumerRegistration(args.consumer)?.displayName;
        record.workflow = args.trace;
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
        const taskDescription = this.resolveTaskDescription(args.consumer, args.taskKey, 'rerank', args.taskDescription);
        const record = this.orchestrator.enqueue(
            args.consumer,
            args.taskKey,
            'rerank',
            { ...args.enqueue, scope: args.enqueue?.scope || { pluginId: args.consumer } },
            args,
            taskDescription,
        );
        record.chatKey = this.resolveRequestChatKey(args);
        record.consumerDisplayName = this.registry.getConsumerRegistration(args.consumer)?.displayName;
        record.workflow = args.trace;
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

    // ─── 编排器执行回调（内部） ───

    private async executeRequest(record: RequestRecord): Promise<LLMRunResult<any>> {
        const args = record.requestArgs;
        if (!args) {
            return this.failureResult({ reasonCode: 'LLM_REQUEST_INVALID', stage: 'llm.request.validate', requestId: record.requestId });
        }

        switch (record.taskKind) {
            case 'generation':
                if (!this.isGenerationArgs(args)) {
                    return this.failureResult({ reasonCode: 'LLM_REQUEST_INVALID', stage: 'llm.request.validate', requestId: record.requestId });
                }
                if (this.readSettings().enabled === false) {
                    this.emitLifecycle(args, record, {
                        stage: 'failed',
                        message: 'LLMHub 未启用，请先在设置中启用 LLMHub。',
                        reasonCode: 'LLM_DISABLED',
                        failure: { reasonCode: 'LLM_DISABLED', stage: 'llm.request.enabled', requestId: record.requestId },
                    });
                    return this.failureResult({ reasonCode: 'LLM_DISABLED', stage: 'llm.request.enabled', requestId: record.requestId });
                }
                this.emitLifecycle(args, record, {
                    stage: 'running',
                    message: '任务开始执行',
                    progress: 0.25,
                });
                return this.executeWithRetryLoop(record, args, () => this.executeGeneration(args, record));
            case 'embedding':
                if (!this.isEmbedArgs(args)) {
                    return this.failureResult({ reasonCode: 'LLM_REQUEST_INVALID', stage: 'llm.request.validate', requestId: record.requestId });
                }
                if (this.readSettings().enabled === false) {
                    this.emitLifecycle(args, record, {
                        stage: 'failed',
                        message: 'LLMHub 未启用，请先在设置中启用 LLMHub。',
                        reasonCode: 'LLM_DISABLED',
                        failure: { reasonCode: 'LLM_DISABLED', stage: 'llm.request.enabled', requestId: record.requestId },
                    });
                    return this.failureResult({ reasonCode: 'LLM_DISABLED', stage: 'llm.request.enabled', requestId: record.requestId });
                }
                this.emitLifecycle(args, record, {
                    stage: 'running',
                    message: '向量任务开始执行',
                    progress: 0.25,
                });
                return this.executeWithRetryLoop(record, args, () => this.executeEmbed(args, record));
            case 'rerank':
                if (!this.isRerankArgs(args)) {
                    return this.failureResult({ reasonCode: 'LLM_REQUEST_INVALID', stage: 'llm.request.validate', requestId: record.requestId });
                }
                if (this.readSettings().enabled === false) {
                    this.emitLifecycle(args, record, {
                        stage: 'failed',
                        message: 'LLMHub 未启用，请先在设置中启用 LLMHub。',
                        reasonCode: 'LLM_DISABLED',
                        failure: { reasonCode: 'LLM_DISABLED', stage: 'llm.request.enabled', requestId: record.requestId },
                    });
                    return this.failureResult({ reasonCode: 'LLM_DISABLED', stage: 'llm.request.enabled', requestId: record.requestId });
                }
                this.emitLifecycle(args, record, {
                    stage: 'running',
                    message: '重排任务开始执行',
                    progress: 0.25,
                });
                return this.executeWithRetryLoop(record, args, () => this.executeRerank(args, record));
            default:
                return this.failureResult({ reasonCode: 'LLM_REQUEST_INVALID', stage: 'llm.request.task_kind', requestId: record.requestId });
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

    private serializeSchemaForLog(schema: object): object {
        return structuredClone(schema);
    }

    private buildGenerationProviderRequestSnapshot(
        resourceId: string,
        llmReq: LLMRequest,
        args: RunTaskArgs,
        schemaSummary: string | undefined,
        maxTokensSource: string,
    ): Record<string, unknown> {
        const provider = this.router.getProvider(resourceId) as ({ kind?: string } | undefined);
        const providerKind = provider?.kind || 'unknown';
        const plan = llmReq.structuredOutput;
        return {
            providerKind,
            resourceId,
            requestFormat: providerKind === 'tavern'
                ? (plan?.transport === 'prompt_only' ? 'tavern_generate_raw' : 'tavern_generate_quiet_prompt')
                : `${providerKind}_generation`,
            requestParams: {
                model: llmReq.model,
                temperature: llmReq.temperature,
                maxTokens: llmReq.maxTokens,
                timeoutMs: llmReq.timeoutMs,
                maxTokensSource,
                schemaSummary,
                budget: args.budget,
                ...(llmReq.reasoning === undefined ? {} : { reasoningMode: llmReq.reasoning.mode, reasoningEffort: llmReq.reasoning.effort }),
                ...(this.reasoningCapabilityResolver?.(resourceId, llmReq.model) ? { reasoningCapabilityDigest: this.reasoningCapabilityResolver(resourceId, llmReq.model) } : {}),
                ...(plan === undefined ? {} : { structuredOutput: structuredOutputLogFields(plan) }),
            },
            payload: {
                messages: llmReq.messages,
                model: llmReq.model,
                temperature: llmReq.temperature,
                maxTokens: llmReq.maxTokens,
                ...(plan === undefined ? {} : { structuredOutput: plan }),
            },
            messageCount: llmReq.messages.length,
        };
    }

    private async executeGeneration(args: RunTaskArgs, record: RequestRecord): Promise<LLMRunResult<any>> {
        // 预算检查
        const budgetCheck = this.budgetManager.canRequest(args.consumer);
        if (!budgetCheck.allowed) {
            const failure: SSHelperFailureContext = { reasonCode: 'CIRCUIT_OPEN', stage: 'llm.budget.check', requestId: record.requestId };
            this.emitLifecycle(args, record, {
                stage: 'failed',
                message: budgetCheck.reason || '请求被限流/熔断',
                reasonCode: 'CIRCUIT_OPEN',
                failure,
            });
            return {
                ok: false,
                retryable: true,
                reasonCode: 'CIRCUIT_OPEN',
                failure,
            };
        }

        // 路由解析（新版）
        let resolved;
        try {
            resolved = this.router.resolveRoute({
                consumer: args.consumer,
                taskKind: 'generation',
                taskKey: args.taskKey,
            });
            this.setRouteSnapshot(record, resolved.resourceId, resolved.model, 'generation');
            this.emitLifecycle(args, record, {
                stage: 'route_resolved',
                message: `已路由到资源 ${resolved.resourceId}`,
                resourceId: resolved.resourceId,
                model: resolved.model,
                progress: 0.4,
            });
        } catch (error) {
            const failure = this.failure(error, 'llm.route.resolve', {
                requestId: record.requestId,
            });
            const diagnostic = describeSSHelperFailure(failure);
            this.emitLifecycle(args, record, {
                stage: 'failed',
                message: diagnostic.reason,
                reasonCode: failure.reasonCode,
                failure,
            });
            return this.failureResult(failure);
        }

        const profile = this.profileManager.get(this.globalProfileId);
        const consumerBudget = this.budgetManager.getConfig(args.consumer);
        const settings = this.readSettings();
        const taskDescriptor = this.registry.getTaskDescriptor(args.consumer, args.taskKey);
        const taskAssignment = this.router.getTaskAssignment(args.consumer, args.taskKey);
        const resolvedProvider = this.router.getProvider(resolved.resourceId);
        if (!resolvedProvider) {
            const failure: SSHelperFailureContext = {
                reasonCode: 'PROVIDER_UNAVAILABLE',
                stage: 'llm.route.provider',
                requestId: record.requestId,
                resourceId: resolved.resourceId,
            };
            const diagnostic = describeSSHelperFailure(failure);
            this.emitLifecycle(args, record, { stage: 'failed', message: diagnostic.reason, reasonCode: failure.reasonCode, failure });
            return this.failureResult(failure);
        }
        const schema = args.schema && typeof args.schema === 'object' && !Array.isArray(args.schema) ? args.schema : undefined;
        if (schema !== undefined) {
            const schemaCheck = preflightJsonSchema(schema);
            if (!schemaCheck.valid) {
                return {
                    ok: false,
                    retryable: false,
                    reasonCode: 'LLM_REQUEST_INVALID',
                    failure: { reasonCode: 'LLM_REQUEST_INVALID', stage: 'llm.schema.preflight', requestId: record.requestId },
                };
            }
        }
        const identity: StructuredOutputIdentity | undefined = schema === undefined ? undefined : (resolvedProvider.getStructuredOutputIdentity
            ? await resolvedProvider.getStructuredOutputIdentity(resolved.model)
            : { vendor: 'unknown', evidence: 'manual', confidence: 'high', model: resolved.model });
        const structuredCapability = identity === undefined
            ? resolvedProvider.capabilities.structuredOutput
            : await (resolvedProvider.getStructuredOutputCapability?.(identity)
                ?? resolvedProvider.capabilities.structuredOutput);
        const structuredName = schema === undefined ? undefined : this.sanitizeSchemaName(args.taskKey);
        const structuredOutput = schema === undefined || identity === undefined || structuredName === undefined ? undefined : createStructuredOutputPlan({
            identity,
            spec: { schema, name: structuredName },
            capability: structuredCapability,
        });

        const resolvedMaxTokens = this.resolveTaskMaxTokens(args);
        const baseMessages = Array.isArray(args.input?.messages)
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
                ];
        const buildStructuredMessages = (plan: NonNullable<LLMRequest['structuredOutput']>) =>
            withStructuredOutputInstruction(baseMessages, plan);
        const maxLatencyMs = args.budget?.maxLatencyMs ?? consumerBudget?.maxLatencyMs ?? settings.timeoutMs;
        const llmReq: LLMRequest = {
            messages: structuredOutput === undefined ? baseMessages : buildStructuredMessages(structuredOutput),
            model: resolved.model,
            maxTokens: resolvedMaxTokens.value,
            structuredOutput,
            temperature: args.input?.temperature ?? profile?.temperature ?? 0.3,
            ...(maxLatencyMs === undefined ? {} : { timeoutMs: maxLatencyMs }),
            reasoning: settings.resourcePolicies?.[resolved.resourceId] ?? DEFAULT_REASONING_POLICY,
        };

        const schemaSummary = schema === undefined ? undefined : this.summarizeSchema(schema);
        const schemaForLog = schema === undefined ? undefined : this.serializeSchemaForLog(schema);
        const schemaCharCount = schemaForLog ? JSON.stringify(schemaForLog).length : 0;
        const inputCharCount = llmReq.messages.reduce((sum, msg) => sum + String(msg.content || '').length, 0);
        record.requestLogSnapshot = {
            ...(record.requestLogSnapshot || {
                taskKind: record.taskKind,
                taskDescription: record.taskDescription,
            }),
            schemaSummary,
            schema: schemaForLog,
            ...(structuredOutput === undefined ? {} : { structuredOutput: structuredOutputLogFields(structuredOutput) }),
            resolvedMaxTokens: {
                value: resolvedMaxTokens.value,
                source: resolvedMaxTokens.source,
                detail: resolvedMaxTokens.detail,
            },
            providerRequest: this.buildGenerationProviderRequestSnapshot(
                resolved.resourceId,
                llmReq,
                args,
                schemaSummary,
                resolvedMaxTokens.source,
            ),
            metrics: {
                ...(record.requestLogSnapshot?.metrics || {}),
                schemaCharCount,
                inputCharCount,
            },
        };

        this.emitLifecycle(args, record, {
            stage: 'provider_requesting',
            message: '正在请求模型',
            resourceId: resolved.resourceId,
            model: resolved.model,
            progress: 0.6,
        });

        type AttemptPhase = NonNullable<RequestRecord['activeAttemptPhase']>;
        type AttemptResult = Awaited<ReturnType<LLMSDKImpl['tryProvider']>>;
        let attemptCount = 0;
        let repairCount = 0;
        let totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

        const addUsage = (usage?: { promptTokens: number; completionTokens: number; totalTokens: number }): void => {
            if (!usage) return;
            totalUsage = {
                promptTokens: totalUsage.promptTokens + Number(usage.promptTokens || 0),
                completionTokens: totalUsage.completionTokens + Number(usage.completionTokens || 0),
                totalTokens: totalUsage.totalTokens + Number(usage.totalTokens || 0),
            };
        };
        const runProviderAttempt = async (
            resourceId: string,
            request: LLMRequest,
            phase: AttemptPhase,
        ): Promise<{ result: AttemptResult; attemptId: string } | { blocked: LLMRunResult<never> }> => {
            attemptCount += 1;
            record.attemptIndex = attemptCount;
            record.activeAttemptPhase = phase;
            const attemptId = this.generateAttemptRequestId(record);
            const plannedTransport = request.structuredOutput?.transport;
            try {
                await this.requestLogService.beginAttempt({ record, attemptId, attemptPhase: phase, plannedTransport });
                await this.requestLogService.markAttemptRunning({ record, attemptId, attemptPhase: phase, plannedTransport });
            } catch (error) {
                logger.warn('请求日志初始化失败，Provider 请求将继续执行。', safeFailureLogDetail(error, {
                    reasonCode: 'LOG_UNAVAILABLE',
                    stage: 'llm.log.begin',
                    requestId: record.requestId,
                    attemptId,
                }));
            }
            const rawResult = await this.tryProvider(
                resourceId,
                request,
                schema,
                args.consumer,
                taskDescriptor?.structuredPolicy,
                maxLatencyMs,
                args.signal,
                record.requestId,
                attemptId,
            );
            const result = !rawResult.ok && rawResult.failure === undefined && isSSHelperReasonCode(rawResult.reasonCode)
                ? {
                    ...rawResult,
                    failure: {
                        reasonCode: rawResult.reasonCode,
                        stage: 'llm.provider.response',
                        requestId: record.requestId,
                        attemptId,
                        resourceId,
                    },
                }
                : rawResult;
            addUsage(result.usage);
            this.attachProviderRequestSnapshot(record, result.providerRequest);
            this.attachRecordDebug(record, result);
            return { result, attemptId };
        };
        const finishAttempt = async (
            attempt: { result: AttemptResult; attemptId: string },
            final: boolean,
        ): Promise<void> => {
            const attemptReasonCode = isSSHelperReasonCode(attempt.result.reasonCode)
                ? attempt.result.reasonCode
                : 'INTERNAL_ERROR';
            const result: LLMRunResult<unknown> = attempt.result.ok
                ? { ok: true, data: attempt.result.data, meta: {
                    requestId: record.requestId,
                    resourceId: String(attempt.result.resourceId || resolved.resourceId),
                    capabilityKind: 'generation',
                    provider: resolvedProvider.kind,
                    source: resolvedProvider.kind === 'tavern' ? 'tavern' : 'custom',
                    execution: args.execution ?? this.expectedExecution(args.consumer, args.taskKey, 'generation'),
                    resolvedBy: resolved.resolvedBy === 'task_assignment' ? 'task_assignment' : 'execution_default',
                    ...(this.reasoningCapabilityResolver?.(resolved.resourceId, resolved.model) ? { capabilityDigest: this.reasoningCapabilityResolver(resolved.resourceId, resolved.model) } : {}),
                    queuedAt: record.queuedAt,
                } }
                : {
                    ok: false,
                    reasonCode: attemptReasonCode,
                    retryable: attempt.result.retryable,
                    failure: attempt.result.failure ?? {
                        reasonCode: attemptReasonCode,
                        stage: 'llm.provider.response',
                        requestId: record.requestId,
                        attemptId: attempt.attemptId,
                    },
                };
            await this.recordAttemptLog(
                record,
                attempt.attemptId,
                result,
                final,
                record.activeAttemptPhase,
                attempt.result.structuredOutput?.plannedTransport as NonNullable<LLMRequest['structuredOutput']>['transport'] | undefined,
                attempt.result.structuredOutput?.actualTransport as NonNullable<LLMRequest['structuredOutput']>['transport'] | undefined,
            );
        };

        const first = await runProviderAttempt(resolved.resourceId, llmReq, 'initial');
        if ('blocked' in first) return first.blocked;
        const repairReasons = new Set(taskDescriptor?.structuredPolicy?.repairOn ?? ['INVALID_JSON', 'SCHEMA_VALIDATION_FAILED']);
        const reasonCode: SSHelperReasonCode = isSSHelperReasonCode(first.result.reasonCode)
            ? first.result.reasonCode
            : 'INTERNAL_ERROR';
        const maxProviderAttempts = taskDescriptor?.structuredPolicy?.maxProviderAttempts ?? 2;
        const envelopeRepairAllowed = taskDescriptor?.structuredPolicy?.envelopeFailure !== 'fail';
        const wantsRepair = schema !== undefined
            && envelopeRepairAllowed
            && repairReasons.has(reasonCode as 'INVALID_JSON' | 'SCHEMA_VALIDATION_FAILED');
        const transientReasons = new Set<SSHelperReasonCode>([
            'HTTP_DNS_FAILED',
            'HTTP_CONNECT_FAILED',
            'HTTP_REQUEST_TIMEOUT',
            'HTTP_TRANSPORT_ERROR',
            'RATE_LIMITED',
            'PROVIDER_SERVICE_UNAVAILABLE',
        ]);
        const wantsTransientRetry = isSSHelperReasonCode(reasonCode)
            && transientReasons.has(reasonCode);
        const needsSecondAttempt = !first.result.ok
            && attemptCount < maxProviderAttempts
            && (wantsRepair || wantsTransientRetry);
        await finishAttempt(first, !needsSecondAttempt);

        if (first.result.ok) {
            const meta: LLMRunMeta = {
                requestId: record.requestId,
                resourceId: resolved.resourceId,
                model: resolved.model,
                capabilityKind: 'generation',
                provider: resolvedProvider.kind,
                source: resolvedProvider.kind === 'tavern' ? 'tavern' : 'custom',
                execution: args.execution ?? this.expectedExecution(args.consumer, args.taskKey, 'generation'),
                resolvedBy: resolved.resolvedBy === 'task_assignment' ? 'task_assignment' : 'execution_default',
                queuedAt: record.queuedAt,
                startedAt: record.startedAt,
                finishedAt: Date.now(),
                latencyMs: Date.now() - (record.startedAt || record.queuedAt),
                attemptCount,
                repairCount,
                transport: (first.result.structuredOutput?.actualTransport ?? llmReq.structuredOutput?.transport) as LLMRunMeta['transport'],
                reasoning: llmReq.reasoning,
                validationOutcome: first.result.itemRejections?.length ? 'partial' : 'complete',
                itemRejections: first.result.itemRejections ?? [],
                usage: totalUsage,
            };
            this.emitLifecycle(args, record, { stage: 'completed', message: '任务执行完成', resourceId: resolved.resourceId, model: resolved.model, progress: 1 });
            return { ok: true, data: first.result.data, meta };
        }
        if (!needsSecondAttempt) {
            const failure = first.result.failure ?? { reasonCode, stage: 'llm.provider.response', requestId: record.requestId };
            this.emitLifecycle(args, record, { stage: 'failed', message: describeSSHelperFailure(failure).reason, reasonCode, failure });
            return {
                ok: false,
                retryable: false,
                reasonCode,
                failure,
            };
        }

        let secondResourceId = resolved.resourceId;
        let secondRequest = llmReq;
        let secondPhase: AttemptPhase = 'transient_retry';

        if (wantsRepair && schema !== undefined && structuredOutput !== undefined) {
            repairCount = 1;
            secondPhase = 'schema_repair';
            const safeIssues = (first.result.validationIssues ?? []).slice(0, 16);
            const repairInstruction = [
                '上一轮输出未通过结构校验。重新生成一个完整 JSON 根对象；不要解释、不要 Markdown、不要复用上一轮文本。',
                `安全校验问题：${JSON.stringify(safeIssues)}`,
            ].join('\n');
            const repairBaseMessages = [
                ...baseMessages,
                { role: 'user' as const, content: repairInstruction },
            ];
            secondRequest = {
                ...llmReq,
                messages: withStructuredOutputInstruction(repairBaseMessages, structuredOutput),
                structuredOutput,
            };
        }

        this.orchestrator.advanceAttempt(record);
        const second = await runProviderAttempt(secondResourceId, secondRequest, secondPhase);
        if ('blocked' in second) return second.blocked;
        await finishAttempt(second, true);
        if (!second.result.ok) {
            const secondReasonCode = isSSHelperReasonCode(second.result.reasonCode)
                ? second.result.reasonCode
                : 'INTERNAL_ERROR';
            const failure = second.result.failure ?? { reasonCode: secondReasonCode, stage: 'llm.provider.response', requestId: record.requestId };
            this.emitLifecycle(args, record, { stage: 'failed', message: describeSSHelperFailure(failure).reason, reasonCode: secondReasonCode, failure });
            return {
                ok: false,
                retryable: false,
                reasonCode: secondReasonCode,
                failure,
            };
        }
        const meta: LLMRunMeta = {
            requestId: record.requestId,
            resourceId: secondResourceId,
            model: resolved.model,
            capabilityKind: 'generation',
            provider: resolvedProvider.kind,
            source: resolvedProvider.kind === 'tavern' ? 'tavern' : 'custom',
            execution: args.execution ?? this.expectedExecution(args.consumer, args.taskKey, 'generation'),
            resolvedBy: resolved.resolvedBy === 'task_assignment' ? 'task_assignment' : 'execution_default',
            ...(this.reasoningCapabilityResolver?.(secondResourceId, resolved.model) ? { capabilityDigest: this.reasoningCapabilityResolver(secondResourceId, resolved.model) } : {}),
            queuedAt: record.queuedAt,
            startedAt: record.startedAt,
            finishedAt: Date.now(),
            latencyMs: Date.now() - (record.startedAt || record.queuedAt),
            attemptCount,
            repairCount,
                transport: (second.result.structuredOutput?.actualTransport ?? secondRequest.structuredOutput?.transport) as LLMRunMeta['transport'],
                reasoning: secondRequest.reasoning,
            validationOutcome: second.result.itemRejections?.length ? 'partial' : 'complete',
            itemRejections: second.result.itemRejections ?? [],
            usage: totalUsage,
        };
        this.emitLifecycle(args, record, { stage: 'completed', message: secondPhase === 'schema_repair' ? '结构化修复完成' : '第二次尝试完成', resourceId: secondResourceId, model: resolved.model, progress: 1 });
        return { ok: true, data: second.result.data, meta };
    }

    private attachRecordDebug(record: RequestRecord, result: {
        rawResponseText?: string;
        providerResponse?: unknown;
        parsedResponse?: unknown;
        normalizedResponse?: unknown;
        validationErrors?: string[];
        validationIssues?: Array<{ path: string; keyword: string; expected: string }>;
        itemRejections?: import('@ss-helper/sdk').LlmStructuredItemRejection[];
        reasonCode?: SSHelperReasonCode;
        failure?: SSHelperFailureContext;
    }): void {
        const hasDebug = result.rawResponseText != null
            || result.providerResponse !== undefined
            || result.parsedResponse !== undefined
            || result.normalizedResponse !== undefined
            || (Array.isArray(result.validationErrors) && result.validationErrors.length > 0)
            || (Array.isArray(result.validationIssues) && result.validationIssues.length > 0)
            || (Array.isArray(result.itemRejections) && result.itemRejections.length > 0)
            || result.failure !== undefined;
        if (!hasDebug) return;

        record.debug = {
            rawResponseText: result.rawResponseText,
            providerResponse: result.providerResponse,
            parsedResponse: result.parsedResponse,
            normalizedResponse: result.normalizedResponse,
            validationErrors: result.validationErrors,
            validationIssues: result.validationIssues,
            itemRejections: result.itemRejections,
            ...(result.failure ? {
                failure: result.failure,
            } : isSSHelperReasonCode(result.reasonCode) ? {
                failure: {
                    reasonCode: result.reasonCode,
                    stage: 'llm.provider.response',
                    requestId: record.requestId,
                    ...(record.activeAttemptRequestId ? { attemptId: record.activeAttemptRequestId } : {}),
                },
            } : {}),
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
            });
            this.setRouteSnapshot(record, resolved.resourceId, resolved.model, 'embedding');
            this.emitLifecycle(args, record, {
                stage: 'route_resolved',
                message: `已路由到向量资源 ${resolved.resourceId}`,
                resourceId: resolved.resourceId,
                model: resolved.model,
                progress: 0.4,
            });
        } catch (error) {
            const failure = this.failure(error, 'llm.embedding.route', { requestId: record.requestId });
            const diagnostic = describeSSHelperFailure(failure);
            this.emitLifecycle(args, record, {
                stage: 'failed',
                message: diagnostic.reason,
                reasonCode: failure.reasonCode,
                failure,
            });
            return this.failureResult(failure);
        }

        const provider = this.router.getProvider(resolved.resourceId);
        if (!provider?.embed) {
            const failure = this.failure(createSSHelperError('LLM_CAPABILITY_UNAVAILABLE', {
                stage: 'llm.embedding.capability', requestId: record.requestId, resourceId: resolved.resourceId, model: resolved.model,
            }), 'llm.embedding.capability', { requestId: record.requestId, resourceId: resolved.resourceId, model: resolved.model });
            const diagnostic = describeSSHelperFailure(failure);
            this.attachRecordDebug(record, {
                reasonCode: failure.reasonCode,
                failure,
            });
            this.emitLifecycle(args, record, {
                stage: 'failed',
                message: diagnostic.reason,
                reasonCode: failure.reasonCode,
                failure,
            });
            return this.failureResult(failure);
        }

        try {
            const timeoutMs = this.readSettings().timeoutMs;
            this.attachProviderRequestSnapshot(record, {
                texts: args.texts,
                model: resolved.model,
                dimensions: args.dimensions,
                timeoutMs,
            });
            this.emitLifecycle(args, record, {
                stage: 'provider_requesting',
                message: '正在执行向量请求',
                resourceId: resolved.resourceId,
                model: resolved.model,
                progress: 0.65,
            });
            await this.refreshRunningAttemptLog(record);
            await this.requestRateLimiter.acquire(args.signal, record.requestId);
            const response = await provider.embed({ texts: args.texts, model: resolved.model, dimensions: args.dimensions, signal: args.signal, timeoutMs });
            this.attachRecordDebug(record, {
                providerResponse: response,
            });
            const meta: LLMRunMeta = {
                requestId: this.getActiveAttemptRequestId(record),
                resourceId: resolved.resourceId,
                model: resolved.model,
                capabilityKind: 'embedding',
                provider: provider.kind,
                source: provider.kind === 'tavern' ? 'tavern' : 'custom',
                execution: 'embedding',
                resolvedBy: resolved.resolvedBy === 'task_assignment' ? 'task_assignment' : 'execution_default',
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
            const failure = this.failure(error, 'llm.embedding.provider', {
                requestId: record.requestId,
                resourceId: resolved.resourceId,
                model: resolved.model,
            });
            const diagnostic = describeSSHelperFailure(failure);
            this.attachRecordDebug(record, {
                reasonCode: failure.reasonCode,
                failure,
            });
            this.emitLifecycle(args, record, {
                stage: 'failed',
                message: diagnostic.reason,
                reasonCode: failure.reasonCode,
                failure,
            });
            return this.failureResult(failure);
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

    private async refreshRunningAttemptLog(record: RequestRecord): Promise<void> {
        const attemptId = String(record.activeAttemptRequestId || '').trim();
        if (!attemptId || !record.activeAttemptPhase) return;
        try {
            await this.requestLogService.markAttemptRunning({
                record,
                attemptId,
                attemptPhase: record.activeAttemptPhase,
            });
        } catch (error) {
            logger.warn('Provider 发送前刷新诊断元数据失败，请求将继续执行。', safeFailureLogDetail(error, {
                reasonCode: 'LOG_UNAVAILABLE',
                stage: 'llm.log.before_provider',
                requestId: record.requestId,
                attemptId,
            }));
        }
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
        attemptPhase = record.activeAttemptPhase,
        plannedTransport?: NonNullable<LLMRequest['structuredOutput']>['transport'],
        actualTransport?: NonNullable<LLMRequest['structuredOutput']>['transport'],
    ): Promise<void> {
        await this.requestLogService.recordAttempt({
            record,
            requestId,
            result,
            attemptTag: record.attemptIndex > 1 ? '重试' : '初次请求',
            attemptOutcome: result.ok ? '成功' : '失败',
            isFinalAttempt,
            attemptPhase,
            plannedTransport,
            actualTransport,
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
            });
            this.setRouteSnapshot(record, resolved.resourceId, resolved.model, 'rerank');
            this.emitLifecycle(args, record, {
                stage: 'route_resolved',
                message: `已路由到重排资源 ${resolved.resourceId}`,
                resourceId: resolved.resourceId,
                model: resolved.model,
                progress: 0.4,
            });
        } catch (error) {
            const failure = this.failure(error, 'llm.rerank.route', { requestId: record.requestId });
            const diagnostic = describeSSHelperFailure(failure);
            this.emitLifecycle(args, record, {
                stage: 'failed',
                message: diagnostic.reason,
                reasonCode: failure.reasonCode,
                failure,
            });
            return this.failureResult(failure);
        }

        const provider = this.router.getProvider(resolved.resourceId);
        if (provider?.rerank) {
            try {
                const timeoutMs = this.readSettings().timeoutMs;
                this.attachProviderRequestSnapshot(record, {
                    query: args.query,
                    docs: args.docs,
                    topK: args.topK,
                    model: resolved.model,
                    timeoutMs,
                });
                this.emitLifecycle(args, record, {
                    stage: 'provider_requesting',
                    message: '正在执行重排请求',
                    resourceId: resolved.resourceId,
                    model: resolved.model,
                    progress: 0.65,
                });
                await this.refreshRunningAttemptLog(record);
                await this.requestRateLimiter.acquire(args.signal, record.requestId);
                const response = await provider.rerank({
                    query: args.query,
                    docs: args.docs,
                    topK: args.topK,
                    model: resolved.model,
                    signal: args.signal,
                    timeoutMs,
                });
                this.attachRecordDebug(record, {
                    providerResponse: response,
                });
                const meta: LLMRunMeta = {
                    requestId: this.getActiveAttemptRequestId(record),
                    resourceId: resolved.resourceId,
                    model: resolved.model,
                    capabilityKind: 'rerank',
                    provider: provider.kind,
                    source: provider.kind === 'tavern' ? 'tavern' : 'custom',
                    execution: 'rerank',
                    resolvedBy: resolved.resolvedBy === 'task_assignment' ? 'task_assignment' : 'execution_default',
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
                const failure = this.failure(error, 'llm.rerank.provider', {
                    requestId: record.requestId,
                    resourceId: resolved.resourceId,
                    model: resolved.model,
                });
                const diagnostic = describeSSHelperFailure(failure);
                this.attachRecordDebug(record, {
                    reasonCode: failure.reasonCode,
                    failure,
                });
                this.emitLifecycle(args, record, {
                    stage: 'failed',
                    message: diagnostic.reason,
                    reasonCode: failure.reasonCode,
                    failure,
                });
                return this.failureResult(failure);
            }
        }

        const failure = this.failure(createSSHelperError('LLM_CAPABILITY_UNAVAILABLE', {
            stage: 'llm.rerank.capability', requestId: record.requestId, resourceId: resolved.resourceId, model: resolved.model,
        }), 'llm.rerank.capability', { requestId: record.requestId, resourceId: resolved.resourceId, model: resolved.model });
        const diagnostic = describeSSHelperFailure(failure);
        this.emitLifecycle(args, record, {
            stage: 'failed',
            message: diagnostic.reason,
            reasonCode: failure.reasonCode,
            failure,
            resourceId: resolved.resourceId,
            model: resolved.model,
        });
        this.attachRecordDebug(record, {
            reasonCode: failure.reasonCode,
            failure,
        });
        return this.failureResult(failure);
    }

    /** 尝试单个资源执行请求 */
    private async tryProvider(
        resourceId: string,
        req: LLMRequest,
        schema: object | undefined,
        consumer: string,
        structuredPolicy?: import('@ss-helper/sdk').LlmStructuredRepairPolicy,
        maxLatencyMs?: number,
        signal?: AbortSignal,
        requestId?: string,
        attemptId?: string,
    ): Promise<{
        ok: boolean;
        data?: any;
        retryable?: boolean;
        cost?: number;
        reasonCode?: SSHelperReasonCode;
        rawResponseText?: string;
        providerResponse?: unknown;
        parsedResponse?: unknown;
        normalizedResponse?: unknown;
        validationErrors?: string[];
        validationIssues?: Array<{ path: string; keyword: string; expected: string }>;
        itemRejections?: import('@ss-helper/sdk').LlmStructuredItemRejection[];
        providerRequest?: Record<string, unknown>;
        structuredOutput?: { plannedTransport: string; actualTransport: string; fallbackReason?: string };
        resourceId?: string;
        usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
        failure?: SSHelperFailureContext;
    }> {
        try {
            const provider = this.router.getProvider(resourceId);
            if (!provider) {
                return {
                    ok: false,
                    retryable: false,
                    reasonCode: 'PROVIDER_UNAVAILABLE',
                    resourceId,
                    failure: {
                        reasonCode: 'PROVIDER_UNAVAILABLE',
                        stage: 'llm.provider.lookup',
                        ...(requestId ? { requestId } : {}),
                        ...(attemptId ? { attemptId } : {}),
                        resourceId,
                    },
                };
            }

            await this.requestRateLimiter.acquire(signal, requestId);
            const timeoutMs = Number(maxLatencyMs);
            const attemptController = new AbortController();
            const onCallerAbort = (): void => attemptController.abort(signal?.reason);
            if (signal?.aborted) onCallerAbort();
            else signal?.addEventListener('abort', onCallerAbort, { once: true });
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            try {
                const providerRequest = provider.request({
                    ...req,
                    signal: attemptController.signal,
                    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
                });
                const response = Number.isFinite(timeoutMs) && timeoutMs > 0
                    ? await Promise.race([
                        providerRequest,
                        new Promise<never>((_, reject) => {
                            timeoutHandle = setTimeout(() => {
                                attemptController.abort();
                                reject(createSSHelperError('HTTP_REQUEST_TIMEOUT', {
                                    stage: 'llm.provider.request',
                                    resourceId,
                                }));
                            }, timeoutMs);
                        }),
                    ])
                    : await providerRequest;

                const finishReason = String((response as { finishReason?: unknown }).finishReason ?? '').trim().toLowerCase();

                if (finishReason === 'length') {
                this.budgetManager.recordFailure(consumer);
                return {
                    ok: false,
                    retryable: true,
                    reasonCode: schema === undefined ? 'TOKEN_LIMIT_EXCEEDED' : 'STRUCTURED_OUTPUT_TRUNCATED',
                    rawResponseText: response.content,
                    providerResponse: response,
                    providerRequest: response.debugRequest,
                    resourceId,
                    usage: response.usage,
                    failure: {
                        reasonCode: schema === undefined ? 'TOKEN_LIMIT_EXCEEDED' : 'STRUCTURED_OUTPUT_TRUNCATED',
                        stage: 'llm.provider.response',
                        ...(requestId ? { requestId } : {}),
                        ...(attemptId ? { attemptId } : {}),
                        resourceId,
                    },
                };
                }

                if (schema === undefined) {
                this.budgetManager.recordSuccess(consumer);
                return {
                    ok: true,
                    data: response.content,
                    rawResponseText: response.content,
                    providerResponse: response,
                    providerRequest: response.debugRequest,
                    structuredOutput: response.structuredOutput,
                    resourceId,
                    usage: response.usage,
                };
                }

            if (!String(response.content || '').trim()) {
                this.budgetManager.recordFailure(consumer);
                return {
                    ok: false,
                    retryable: true,
                    reasonCode: 'STRUCTURED_OUTPUT_EMPTY',
                    providerResponse: response,
                    providerRequest: response.debugRequest,
                    structuredOutput: response.structuredOutput,
                    resourceId,
                    usage: response.usage,
                    failure: {
                        reasonCode: 'STRUCTURED_OUTPUT_EMPTY',
                        stage: 'llm.provider.response',
                        ...(requestId ? { requestId } : {}),
                        ...(attemptId ? { attemptId } : {}),
                        resourceId,
                    },
                };
            }

            const parsed = parseJsonOutput(response.content);
            if (!parsed.ok) {
                this.budgetManager.recordFailure(consumer);
                return {
                    ok: false,
                    retryable: true,
                    reasonCode: 'INVALID_JSON',
                    rawResponseText: response.content,
                    providerResponse: response,
                    providerRequest: response.debugRequest,
                    structuredOutput: response.structuredOutput,
                    resourceId,
                    usage: response.usage,
                    failure: {
                        reasonCode: 'INVALID_JSON',
                        stage: 'llm.provider.parse',
                        ...(requestId ? { requestId } : {}),
                        ...(attemptId ? { attemptId } : {}),
                        resourceId,
                    },
                };
            }

            const validation = structuredPolicy?.itemFailure === 'return_partial'
                && Array.isArray(structuredPolicy.itemCollections)
                ? validateJsonSchemaItemized(parsed.data, schema, structuredPolicy.itemCollections)
                : validateJsonSchema(parsed.data, schema);
            if (!validation.valid) {
                this.budgetManager.recordFailure(consumer);
                return {
                    ok: false,
                    retryable: true,
                    reasonCode: 'SCHEMA_VALIDATION_FAILED',
                    rawResponseText: response.content,
                    providerResponse: response,
                    parsedResponse: parsed.data,
                    normalizedResponse: parsed.data,
                    validationErrors: validation.errors,
                    validationIssues: validation.issues,
                    providerRequest: response.debugRequest,
                    structuredOutput: response.structuredOutput,
                    resourceId,
                    usage: response.usage,
                    failure: {
                        reasonCode: 'SCHEMA_VALIDATION_FAILED',
                        stage: 'llm.provider.schema',
                        ...(requestId ? { requestId } : {}),
                        ...(attemptId ? { attemptId } : {}),
                        ...(validation.issues[0] ? {
                            path: validation.issues[0].path,
                            keyword: validation.issues[0].keyword,
                            expected: validation.issues[0].expected,
                        } : {}),
                        resourceId,
                    },
                };
            }

            this.budgetManager.recordSuccess(consumer);
            const itemRejections: JsonSchemaItemRejection[] = 'rejections' in validation
                && Array.isArray(validation.rejections)
                ? validation.rejections
                : [];
            const validatedData = 'value' in validation ? validation.value : parsed.data;
            return {
                ok: true,
                data: validatedData,
                rawResponseText: response.content,
                providerResponse: response,
                parsedResponse: parsed.data,
                normalizedResponse: validatedData,
                itemRejections,
                providerRequest: response.debugRequest,
                structuredOutput: response.structuredOutput,
                resourceId,
                usage: response.usage,
            };
            } finally {
                if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
                signal?.removeEventListener('abort', onCallerAbort);
            }
        } catch (error) {
            this.budgetManager.recordFailure(consumer);
            const providerError = error as Error & {
                providerRequest?: Record<string, unknown>;
                providerResponse?: unknown;
                rawResponseText?: string;
            };
            const failure = this.failure(error, 'llm.provider.request', {
                resourceId,
                ...(requestId ? { requestId } : {}),
                ...(attemptId ? { attemptId } : {}),
            });
            const diagnostic = describeSSHelperFailure(failure);
            return {
                ok: false,
                retryable: diagnostic.retryable,
                reasonCode: failure.reasonCode,
                providerRequest: providerError.providerRequest,
                providerResponse: providerError.providerResponse,
                rawResponseText: providerError.rawResponseText,
                failure,
            };
        }
    }

}
