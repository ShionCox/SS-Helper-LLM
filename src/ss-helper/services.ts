import {
    LLM_COMPLETION_V1, LLM_EMBEDDING_V1, LLM_RERANK_V1, LLM_ROUTE_CHANGED_V1,
    LLM_ROUTE_DIAGNOSTICS_V1, LLM_STRUCTURED_TASK_V1, SSHelperError,
    type LlmCompletionRequest, type LlmCompletionResponse, type LlmEmbeddingRequest,
    type LlmEmbeddingResponse, type LlmRerankRequest, type LlmRerankResponse,
    type LlmRouteDiagnostic, type LlmRouteDiagnosticsResponse, type LlmRouteMetadata,
    type LlmStructuredTaskRequest, type LlmStructuredTaskResponse, type PlainData, type PluginSession,
} from '@ss-helper/sdk';
import type { EmbedArgs, LLMRunResult, RerankArgs, RunTaskArgs } from '../schema/types';

export type CompletionHandler = (request: LlmCompletionRequest, signal: AbortSignal) => Promise<LlmCompletionResponse>;
export interface LlmServiceHandlers {
    readonly completion: CompletionHandler;
    readonly runTask: (request: LlmStructuredTaskRequest, signal: AbortSignal) => Promise<LlmStructuredTaskResponse>;
    readonly embed: (request: LlmEmbeddingRequest, signal: AbortSignal) => Promise<LlmEmbeddingResponse>;
    readonly rerank: (request: LlmRerankRequest, signal: AbortSignal) => Promise<LlmRerankResponse>;
    readonly diagnostics: () => Promise<LlmRouteDiagnosticsResponse> | LlmRouteDiagnosticsResponse;
    readonly dispose?: () => void;
}
export interface LlmSdkServicePort {
    runTask<T>(args: RunTaskArgs<T>): Promise<LLMRunResult<T>>;
    embed(args: EmbedArgs): Promise<unknown>;
    rerank(args: RerankArgs): Promise<unknown>;
}

const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
const routeFrom = (value: unknown): LlmRouteMetadata => { const meta = record(record(value).meta); return { route: String(meta.resourceId || 'default'), ...(typeof meta.resourceId === 'string' ? { provider: meta.resourceId } : {}), ...(typeof meta.model === 'string' ? { model: meta.model } : {}), ...(meta.fallbackUsed === true ? { fallback: true } : {}) }; };
const requireSuccess = <T>(value: unknown): T => { const result = record(value); if (result.ok !== true) throw new SSHelperError('PAYLOAD_INVALID', typeof result.error === 'string' ? result.error : 'LLM provider request failed', { phase: 'handler' }); return value as T; };
const abortable = async <T>(signal: AbortSignal, operation: () => Promise<T>, notifyAbort?: () => void): Promise<T> => {
    if (signal.aborted) {
        notifyAbort?.();
        throw new SSHelperError('CALL_ABORTED', 'LLM service call was aborted');
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
            notifyAbort?.();
            reject(new SSHelperError('CALL_ABORTED', 'LLM service call was aborted'));
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
    readonly reasonCode?: string;
}

export function createLlmSdkServiceHandlers(sdk: LlmSdkServicePort): LlmServiceHandlers {
    const diagnostics: LlmRouteDiagnostic[] = [];
    const lifecycle = (event: ServiceLifecycleEvent): void => {
        const state = event.stage === 'failed' ? 'failed' : event.stage === 'completed' ? 'completed' : event.stage === 'aborted' || event.stage === 'cancelled' ? 'aborted' : event.stage === 'queued' ? 'queued' : 'running';
        diagnostics.push({ requestId: event.requestId, state, ...(event.resourceId === undefined ? {} : { route: { route: event.resourceId, provider: event.resourceId, ...(event.model === undefined ? {} : { model: event.model }) } }), ...(event.reasonCode === undefined ? {} : { errorCode: event.reasonCode }) });
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
            if (latest !== undefined) lifecycle({ ...latest, stage: 'aborted', ts: Date.now(), reasonCode: 'cancelled' });
        });
    };
    const run = <T>(args: RunTaskArgs<T>, signal: AbortSignal): Promise<LLMRunResult<T>> => invoke(signal, (onLifecycle) => sdk.runTask<T>({ ...args, signal, onLifecycle }));
    return {
        completion: async (request, signal) => { const result = requireSuccess<Extract<LLMRunResult<unknown>, { ok: true }>>(await run({ consumer: 'ss-helper.llm.contract', taskKey: 'completion', taskKind: 'generation', input: { messages: request.messages }, routeHint: request.route === undefined ? undefined : { resource: request.route }, budget: { maxTokens: request.maxTokens }, enqueue: { displayMode: 'silent' } }, signal)); const data = record(result.data); return { text: typeof result.data === 'string' ? result.data : String(data.text ?? data.content ?? ''), route: String(result.meta.resourceId), model: String(result.meta.model ?? result.meta.resourceId), provider: result.meta.resourceId, ...(result.meta.fallbackUsed === undefined ? {} : { finishReason: result.meta.fallbackUsed ? 'fallback' : 'stop' }) }; },
        runTask: async (request, signal) => { const result = requireSuccess<Extract<LLMRunResult<PlainData>, { ok: true }>>(await run({ consumer: 'ss-helper.llm.contract', taskKey: request.task, taskDescription: request.task, taskKind: 'generation', input: request.input, schema: request.outputSchema, routeHint: request.route === undefined ? undefined : { resource: request.route }, budget: request.timeoutMs === undefined ? undefined : { maxLatencyMs: request.timeoutMs }, enqueue: { displayMode: 'silent' } }, signal)); return { output: result.data, route: routeFrom(result) }; },
        embed: async (request, signal) => { const raw = requireSuccess<Record<string, unknown>>(await invoke(signal, (onLifecycle) => sdk.embed({ consumer: 'ss-helper.llm.contract', taskKey: 'embedding', texts: typeof request.input === 'string' ? [request.input] : [...request.input], routeHint: { ...(request.route === undefined ? {} : { resource: request.route }), ...(request.model === undefined ? {} : { model: request.model }) }, signal, onLifecycle }))); const vectors = raw.vectors; if (!Array.isArray(vectors)) throw new SSHelperError('PAYLOAD_INVALID', 'Embedding provider returned no vectors', { phase: 'handler' }); return { embeddings: vectors as readonly (readonly number[])[], route: routeFrom(raw) }; },
        rerank: async (request, signal) => { const raw = requireSuccess<Record<string, unknown>>(await invoke(signal, (onLifecycle) => sdk.rerank({ consumer: 'ss-helper.llm.contract', taskKey: 'rerank', query: request.query, docs: request.documents.map((item) => item.text), topK: request.topN, routeHint: { ...(request.route === undefined ? {} : { resource: request.route }), ...(request.model === undefined ? {} : { model: request.model }) }, signal, onLifecycle }))); const route = routeFrom(raw); if (route.fallback === true || route.route.endsWith(':fallback')) throw new SSHelperError('PAYLOAD_INVALID', 'A native rerank provider is required', { phase: 'handler' }); const results = Array.isArray(raw.results) ? raw.results : []; return { results: results.map((item) => { const value = record(item); const index = Number(value.index); return { id: request.documents[index]?.id ?? String(index), score: Number(value.score), index }; }), route }; },
        diagnostics: () => ({ entries: [...diagnostics] }),
    };
}

export function exposeLlmServices(session: PluginSession, handlers: LlmServiceHandlers): () => void {
    const cleanups = [
        session.services.expose(LLM_COMPLETION_V1, (request, context) => handlers.completion(request, context.signal)),
        session.services.expose(LLM_STRUCTURED_TASK_V1, (request, context) => handlers.runTask(request, context.signal)),
        session.services.expose(LLM_EMBEDDING_V1, (request, context) => handlers.embed(request, context.signal)),
        session.services.expose(LLM_RERANK_V1, (request, context) => handlers.rerank(request, context.signal)),
        session.services.expose(LLM_ROUTE_DIAGNOSTICS_V1, () => handlers.diagnostics()),
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
    session.events.publish(LLM_ROUTE_CHANGED_V1, { previousRoute, route, reason });
}
