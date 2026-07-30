import {
    LLM_COMPLETION_V0, LLM_EMBEDDING_V0, LLM_RERANK_V0, LLM_ROUTE_CHANGED_V0, LLM_CAPABILITY_STATUS_V0,
    LLM_CONSUMER_DECLARE_V0, LLM_CONSUMER_RELEASE_V0,
    LLM_STRUCTURED_TASK_V0, createSSHelperError, isSSHelperReasonCode,
    type LlmCompletionRequest, type LlmCompletionResponse, type LlmEmbeddingRequest,
    type LlmEmbeddingResponse, type LlmRerankRequest, type LlmRerankResponse,
    type LlmRouteDiagnostic, type LlmRouteDiagnosticsResponse, type LlmRouteMetadata,
    type LlmStructuredTaskRequest, type LlmStructuredTaskResponse, type LlmCapabilityStatusRequest, type LlmCapabilityStatusResponse,
    type LlmConsumerRegistration, type PlainData, type PluginSession, type SSHelperReasonCode,
} from '@ss-helper/sdk';
import type { EmbedArgs, LLMRunResult, RerankArgs, RunTaskArgs } from '../schema/types';

export type CompletionHandler = (request: LlmCompletionRequest, signal: AbortSignal, callerPluginId?: string, requestId?: string) => Promise<LlmCompletionResponse>;
export interface LlmServiceHandlers {
    readonly completion: CompletionHandler;
    readonly runTask: (request: LlmStructuredTaskRequest, signal: AbortSignal, callerPluginId?: string, requestId?: string) => Promise<LlmStructuredTaskResponse>;
    readonly embed: (request: LlmEmbeddingRequest, signal: AbortSignal, callerPluginId?: string, requestId?: string) => Promise<LlmEmbeddingResponse>;
    readonly rerank: (request: LlmRerankRequest, signal: AbortSignal, callerPluginId?: string, requestId?: string) => Promise<LlmRerankResponse>;
    readonly registerConsumer?: (request: LlmConsumerRegistration, callerPluginId: string) => void;
    readonly unregisterConsumer?: (request: { keepPersistent?: boolean }, callerPluginId: string) => void;
    readonly diagnostics: () => Promise<LlmRouteDiagnosticsResponse> | LlmRouteDiagnosticsResponse;
    readonly capabilityStatus?: (request: LlmCapabilityStatusRequest, signal: AbortSignal, callerPluginId?: string) => Promise<LlmCapabilityStatusResponse>;
    readonly dispose?: () => void;
}
export interface LlmSdkServicePort {
    runTask<T>(args: RunTaskArgs): Promise<LLMRunResult<T>>;
    embed(args: EmbedArgs): Promise<unknown>;
    rerank(args: RerankArgs): Promise<unknown>;
    registerConsumer(registration: Parameters<import('../sdk/llm-sdk').LLMSDKImpl['registerConsumer']>[0]): void;
    unregisterConsumer(pluginId: string, opts?: { keepPersistent?: boolean }): void;
}

const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
const routeFrom = (value: unknown): LlmRouteMetadata => { const meta = record(record(value).meta); return { route: String(meta.resourceId || 'default'), ...(typeof meta.resourceId === 'string' ? { provider: meta.resourceId } : {}), ...(typeof meta.model === 'string' ? { model: meta.model } : {}), ...(meta.fallbackUsed === true ? { fallback: true } : {}) }; };
const requireSuccess = <T>(value: unknown): T => {
    const result = record(value);
    if (result.ok !== true) {
        const reasonCode = isSSHelperReasonCode(result.reasonCode) ? result.reasonCode : 'INTERNAL_ERROR';
        const meta = record(result.meta);
        throw createSSHelperError(reasonCode, {
            stage: 'llm.service.response',
            ...(typeof meta.requestId === 'string' ? { requestId: meta.requestId } : {}),
        });
    }
    return value as T;
};
const abortable = async <T>(signal: AbortSignal, operation: () => Promise<T>, notifyAbort?: () => void): Promise<T> => {
    if (signal.aborted) {
        notifyAbort?.();
        throw createSSHelperError('REQUEST_ABORTED', { stage: 'llm.service.abort' });
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
            notifyAbort?.();
            reject(createSSHelperError('REQUEST_ABORTED', { stage: 'llm.service.abort' }));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        operation().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
};

interface ServiceLifecycleEvent {
    readonly requestId: string;
    readonly stage: string;
    readonly resourceId?: string;
    readonly model?: string;
    readonly ts: number;
    readonly reasonCode?: SSHelperReasonCode;
}

export function createLlmSdkServiceHandlers(sdk: LlmSdkServicePort): LlmServiceHandlers {
    const diagnostics: LlmRouteDiagnostic[] = [];
    const lifecycle = (event: ServiceLifecycleEvent): void => {
        const state = event.stage === 'failed' ? 'failed' : event.stage === 'completed' ? 'completed' : event.stage === 'aborted' || event.stage === 'cancelled' ? 'aborted' : event.stage === 'queued' ? 'queued' : 'running';
        diagnostics.push({
            requestId: event.requestId,
            state,
            ...(event.resourceId === undefined ? {} : { route: { route: event.resourceId, provider: event.resourceId, ...(event.model === undefined ? {} : { model: event.model }) } }),
            ...(event.reasonCode === undefined ? {} : {
                failure: {
                    reasonCode: event.reasonCode,
                    stage: `llm.service.${event.stage}`,
                    requestId: event.requestId,
                    ...(event.resourceId === undefined ? {} : { resourceId: event.resourceId }),
                    ...(event.model === undefined ? {} : { model: event.model }),
                },
            }),
        });
        if (diagnostics.length > 100) diagnostics.shift();
    };
    const invoke = <T>(signal: AbortSignal, operation: (onLifecycle: (event: ServiceLifecycleEvent) => void) => Promise<T>): Promise<T> => {
        let aborted = false;
        let latest: ServiceLifecycleEvent | undefined;
        const scopedLifecycle = (event: ServiceLifecycleEvent): void => {
            latest = event;
            if (!aborted) lifecycle(event);
        };
        return abortable(signal, () => operation(scopedLifecycle), () => {
            if (aborted) return;
            aborted = true;
            if (latest !== undefined) lifecycle({ ...latest, stage: 'aborted', ts: Date.now(), reasonCode: 'REQUEST_ABORTED' });
        });
    };
    const run = <T>(args: RunTaskArgs, signal: AbortSignal): Promise<LLMRunResult<T>> => invoke(signal, (onLifecycle) => sdk.runTask<T>({ ...args, signal, onLifecycle }));
    return {
        completion: async (request, signal, callerPluginId, requestId) => { const result = requireSuccess<Extract<LLMRunResult<unknown>, { ok: true }>>(await run({ consumer: callerPluginId || 'ss-helper.llm.contract', taskKey: 'completion', taskKind: 'generation', input: { messages: request.messages }, routeHint: request.route === undefined ? undefined : { resource: request.route }, budget: { maxTokens: request.maxTokens }, enqueue: { requestId } }, signal)); const data = record(result.data); return { requestId: String(requestId), text: typeof result.data === 'string' ? result.data : String(data.text ?? data.content ?? ''), route: String(result.meta.resourceId), model: String(result.meta.model ?? result.meta.resourceId), provider: result.meta.resourceId, ...(result.meta.fallbackUsed === undefined ? {} : { finishReason: result.meta.fallbackUsed ? 'fallback' : 'stop' }) }; },
        runTask: async (request, signal, callerPluginId, requestId) => {
            const result = requireSuccess<Extract<LLMRunResult<PlainData>, { ok: true }>>(await run({
                consumer: callerPluginId || 'ss-helper.llm.contract',
                taskKey: request.task,
                taskDescription: request.task,
                taskKind: 'generation',
                input: request.input,
                schema: request.outputSchema,
                routeHint: request.route === undefined && request.model === undefined ? undefined : {
                    ...(request.route === undefined ? {} : { resource: request.route }),
                    ...(request.model === undefined ? {} : { model: request.model }),
                },
                budget: request.timeoutMs === undefined ? undefined : { maxLatencyMs: request.timeoutMs },
                enqueue: {
                    requestId,
                    ...(request.parentRequestId === undefined ? {} : { parentRequestId: request.parentRequestId }),
                },
            }, signal));
            const usage = result.meta.usage;
            return {
                requestId: String(requestId),
                output: result.data,
                route: routeFrom(result),
                diagnostics: {
                    transport: result.meta.transport ?? 'prompt_only',
                    attemptCount: result.meta.attemptCount ?? 1,
                    repairCount: result.meta.repairCount ?? 0,
                    validationOutcome: result.meta.validationOutcome ?? 'complete',
                    itemRejections: result.meta.itemRejections ?? [],
                },
                ...(request.parentRequestId === undefined ? {} : { parentRequestId: request.parentRequestId }),
                ...(usage === undefined ? {} : { usage: {
                    inputTokens: usage.promptTokens,
                    outputTokens: usage.completionTokens,
                    totalTokens: usage.totalTokens,
                } }),
            };
        },
        embed: async (request, signal, callerPluginId, requestId) => { const raw = requireSuccess<Record<string, unknown>>(await invoke(signal, (onLifecycle) => sdk.embed({ consumer: callerPluginId || 'ss-helper.llm.contract', taskKey: 'embedding', texts: typeof request.input === 'string' ? [request.input] : [...request.input], routeHint: { ...(request.route === undefined ? {} : { resource: request.route }), ...(request.model === undefined ? {} : { model: request.model }) }, enqueue: { requestId }, signal, onLifecycle }))); const vectors = raw.vectors; if (!Array.isArray(vectors)) throw createSSHelperError('PROVIDER_RESPONSE_INVALID', { stage: 'llm.service.embedding', requestId }); return { requestId: String(requestId), embeddings: vectors as readonly (readonly number[])[], route: routeFrom(raw) }; },
        rerank: async (request, signal, callerPluginId, requestId) => { const raw = requireSuccess<Record<string, unknown>>(await invoke(signal, (onLifecycle) => sdk.rerank({ consumer: callerPluginId || 'ss-helper.llm.contract', taskKey: 'rerank', query: request.query, docs: request.documents.map((item) => item.text), topK: request.topN, routeHint: { ...(request.route === undefined ? {} : { resource: request.route }), ...(request.model === undefined ? {} : { model: request.model }) }, enqueue: { requestId }, signal, onLifecycle }))); const route = routeFrom(raw); if (route.fallback === true || route.route.endsWith(':fallback')) throw createSSHelperError('LLM_CAPABILITY_UNAVAILABLE', { stage: 'llm.service.rerank', requestId }); const results = Array.isArray(raw.results) ? raw.results : []; return { requestId: String(requestId), results: results.map((item) => { const value = record(item); const index = Number(value.index); return { id: request.documents[index]?.id ?? String(index), score: Number(value.score), index }; }), route }; },
        diagnostics: () => ({ entries: [...diagnostics] }),
        registerConsumer: (request, callerPluginId) => sdk.registerConsumer({ pluginId: callerPluginId, displayName: request.displayName, registrationVersion: request.registrationVersion, tasks: request.tasks.map((task) => ({ ...task, requiredCapabilities: [...(task.requiredCapabilities ?? [])] as never })) as never }),
        unregisterConsumer: (request, callerPluginId) => sdk.unregisterConsumer(callerPluginId, request),
    };
}

export function exposeLlmServices(session: PluginSession, handlers: LlmServiceHandlers): () => void {
    const cleanups = [
        session.bus.handle(LLM_COMPLETION_V0, (request, context) => handlers.completion(request, context.signal, context.callerPluginId, context.requestId)),
        session.bus.handle(LLM_STRUCTURED_TASK_V0, (request, context) => handlers.runTask(request, context.signal, context.callerPluginId, context.requestId)),
        session.bus.handle(LLM_EMBEDDING_V0, (request, context) => handlers.embed(request, context.signal, context.callerPluginId, context.requestId)),
        session.bus.handle(LLM_RERANK_V0, (request, context) => handlers.rerank(request, context.signal, context.callerPluginId, context.requestId)),
        session.bus.handle(LLM_CONSUMER_DECLARE_V0, (request, context) => {
            handlers.registerConsumer?.(request, context.callerPluginId);
            return { ok: true as const };
        }),
        session.bus.handle(LLM_CONSUMER_RELEASE_V0, (request, context) => {
            handlers.unregisterConsumer?.(request, context.callerPluginId);
            return { ok: true as const };
        }),
        ...(handlers.capabilityStatus === undefined ? [] : [session.bus.handle(LLM_CAPABILITY_STATUS_V0, (request, context) => handlers.capabilityStatus!(request, context.signal, context.callerPluginId))]),
    ];
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        cleanups.reverse().forEach((cleanup) => cleanup());
        handlers.dispose?.();
    };
}

export function publishRouteChanged(session: PluginSession, previousRoute: string | undefined, route: string, reason: 'configured' | 'fallback' | 'availability'): void {
    session.bus.publish(LLM_ROUTE_CHANGED_V0, { previousRoute, route, reason });
}
