import {
    createSSHelperError,
    describeSSHelperFailure,
    readSSHelperFailure,
    type GenerationChunk,
    type GenerationRequest,
    type GenerationResult,
} from '@ss-helper/sdk';
import { structuredOutputIdentityFromSource, type StructuredOutputIdentity } from '../schema/structured-output-plan';
import type {
    LLMProvider,
    LLMRequest,
    LLMResponse,
    ProviderConnectionResult,
    ProviderModelListResult,
    StructuredOutputCapability,
} from './types';
import { providerModelListFailure } from './provider-errors';
import { OpenAiChatToolAdapter, OPENAI_CHAT_DIALECT_POLICIES } from '../tools/openai-chat-tool-adapter';
import type { JsonHttpTransport } from '../tools/tool-adapter';

export interface TavernGenerationAdapter {
    available(): Promise<boolean>;
    models(): Promise<readonly string[]>;
    current(): Promise<{ readonly provider?: string; readonly model?: string; readonly mainApi?: string }>;
    generate(request: GenerationRequest): Promise<GenerationResult>;
    test(request: GenerationRequest): Promise<GenerationResult>;
    execute?(request: GenerationRequest, onChunk?: (chunk: GenerationChunk) => void | Promise<void>): Promise<GenerationResult>;
    cancel?(taskId: string): Promise<void>;
}

export class TavernProvider implements LLMProvider {
    id: string;
    kind: 'tavern' = 'tavern';
    capabilities: LLMProvider['capabilities'];

    constructor(config: { id: string; generation?: TavernGenerationAdapter }) {
        this.id = config.id;
        this.generation = config.generation;
        this.capabilities = {
            chat: true,
            json: true,
            tools: this.generation?.execute !== undefined,
            embeddings: false,
            structuredOutput: { transports: ['tavern_json_schema', 'prompt_only'] as const, preferred: 'tavern_json_schema' as const },
        };
    }

    private readonly generation?: TavernGenerationAdapter;

    async request(req: LLMRequest): Promise<LLMResponse> {
        if (!this.generation) {
            throw createSSHelperError('PROVIDER_UNAVAILABLE', {
                stage: 'llm.provider.tavern',
                providerKind: this.kind,
                resourceId: this.id,
            });
        }
        const prompt = req.messages.map((message) => `${message.role}: ${message.content}`).join('\n');
        const model = typeof req.model === 'string' ? req.model.trim() : '';
        const request: GenerationRequest = {
            prompt,
            quiet: true,
            ...(req.structuredOutput?.transport === 'prompt_only' ? { contextMode: 'isolated' as const } : {}),
            ...(model ? { model } : {}),
            ...(req.signal === undefined ? {} : { signal: req.signal }),
            ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
            ...(req.maxTokens === undefined ? {} : { maxTokens: req.maxTokens }),
            ...(req.reasoning === undefined ? {} : { reasoning: req.reasoning }),
            ...(req.structuredOutput?.transport === 'tavern_json_schema'
                ? {
                    jsonSchema: {
                        name: req.structuredOutput.spec.name,
                        value: req.structuredOutput.spec.schema as Record<string, never>,
                        strict: true,
                        returnInvalid: true,
                    },
                }
                : {}),
        };
        let result: GenerationResult;
        try {
            result = await this.generation.generate(request);
        } catch (error) {
            const failure = readSSHelperFailure(error, {
                reasonCode: 'INTERNAL_ERROR',
                stage: 'llm.provider.tavern',
                providerKind: this.kind,
                resourceId: this.id,
            })!;
            throw createSSHelperError(failure.reasonCode, failure);
        }
        return {
            content: result.text,
            finishReason: 'stop',
            ...(req.structuredOutput === undefined ? {} : { structuredOutput: { plannedTransport: req.structuredOutput.transport, actualTransport: req.structuredOutput.transport } }),
            debugRequest: {
                providerKind: this.kind,
                resourceId: this.id,
                requestFormat: request.contextMode === 'isolated' ? 'tavern_generate_raw' : 'tavern_generate_quiet_prompt',
                contextMode: request.contextMode ?? 'chat',
                nativeSchemaSent: request.jsonSchema !== undefined,
                ...(req.structuredOutput === undefined ? {} : { structuredOutput: req.structuredOutput }),
            },
        };
    }

    async testConnection(signal?: AbortSignal): Promise<ProviderConnectionResult> {
        signal?.throwIfAborted();
        if (!this.generation) {
            const diagnostic = describeSSHelperFailure(createSSHelperError('PROVIDER_UNAVAILABLE', {
                stage: 'llm.provider.tavern.test',
                providerKind: this.kind,
                resourceId: this.id,
            }));
            return { ok: false, message: diagnostic.reason, failure: diagnostic };
        }
        const startedAt = Date.now();
        try {
            const result = await this.generation.test({ prompt: 'Reply with OK.', quiet: true, ...(signal === undefined ? {} : { signal }) });
            signal?.throwIfAborted();
            return { ok: true, message: '连接成功', model: result.model, latencyMs: Date.now() - startedAt };
        } catch (error) {
            const diagnostic = describeSSHelperFailure(readSSHelperFailure(error, {
                reasonCode: 'INTERNAL_ERROR',
                stage: 'llm.provider.tavern.test',
                providerKind: this.kind,
                resourceId: this.id,
            }));
            return { ok: false, message: diagnostic.reason, failure: diagnostic, latencyMs: Date.now() - startedAt };
        }
    }

    async listModels(signal?: AbortSignal): Promise<ProviderModelListResult> {
        const context = {
            stage: 'llm.provider.models',
            providerKind: this.kind,
            resourceId: this.id,
        } as const;
        try {
            signal?.throwIfAborted();
            if (!this.generation || !(await this.generation.available())) {
                return providerModelListFailure(createSSHelperError('PROVIDER_UNAVAILABLE', context), context);
            }
            signal?.throwIfAborted();
            const models = await this.generation.models();
            signal?.throwIfAborted();
            return { ok: true, models: models.map((id) => ({ id, label: id })), message: '读取成功' };
        } catch (error) {
            const failure = signal?.aborted
                ? createSSHelperError('REQUEST_ABORTED', context)
                : error;
            return providerModelListFailure(failure, context);
        }
    }

    async getStructuredOutputIdentity(model?: string): Promise<StructuredOutputIdentity> {
        const current = this.generation ? await this.generation.current() : {};
        return structuredOutputIdentityFromSource({ provider: current.provider, model: model || current.model });
    }

    getStructuredOutputCapability(identity: StructuredOutputIdentity): StructuredOutputCapability {
        const source = String(identity.provider || '').trim().toLowerCase();
        // The host only exposes `jsonSchema` through its public generation
        // helpers. Native provider branches translate that hint for their own
        // protocol (DeepSeek becomes json_object), but Custom forwards it as
        // OpenAI json_schema. A model name cannot make that host transport safe.
        if (source === 'custom' || identity.vendor === 'unknown') {
            return { transports: ['prompt_only'], preferred: 'prompt_only' };
        }
        return this.capabilities.structuredOutput;
    }

    createToolAdapter() {
        if (this.generation?.execute === undefined) throw createSSHelperError('LLM_CAPABILITY_UNAVAILABLE', { stage: 'llm.tools.tavern.adapter', resourceId: this.id });
        const generation = this.generation;
        const transport: JsonHttpTransport = {
            resourceId: this.id,
            defaultModel: '',
            send: async (body, signal) => {
                const taskId = `tavern-tool-${crypto.randomUUID()}`;
                const abort = () => { void generation.cancel?.(taskId); };
                signal.addEventListener('abort', abort, { once: true });
                try {
                    const result = await generation.execute!({
                        taskId,
                        model: typeof body.model === 'string' ? body.model : undefined,
                        messages: Array.isArray(body.messages) ? body.messages as GenerationRequest['messages'] : undefined,
                        tools: Array.isArray(body.tools) ? body.tools.flatMap((tool) => {
                            if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) return [];
                            const fn = (tool as Record<string, unknown>).function;
                            if (typeof fn !== 'object' || fn === null || Array.isArray(fn)) return [];
                            const value = fn as Record<string, unknown>;
                            return typeof value.name === 'string' && typeof value.description === 'string' && value.parameters !== undefined
                                ? [{ name: value.name, description: value.description, parameters: value.parameters as never, strict: value.strict === true }]
                                : [];
                        }) : undefined,
                        toolChoice: body.tool_choice as never,
                        reasoning: body.__ss_helper_reasoning as GenerationRequest['reasoning'],
                        stream: body.stream === true,
                        maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
                        signal,
                    }, undefined);
                    return (result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : {}) as Record<string, unknown>;
                } finally { signal.removeEventListener('abort', abort); }
            },
            sendStream: async (body, signal) => {
                const taskId = `tavern-tool-${crypto.randomUUID()}`;
                const chunks: Record<string, unknown>[] = [];
                const abort = () => { void generation.cancel?.(taskId); };
                signal.addEventListener('abort', abort, { once: true });
                try {
                    await generation.execute!({
                        taskId,
                        model: typeof body.model === 'string' ? body.model : undefined,
                        messages: Array.isArray(body.messages) ? body.messages as GenerationRequest['messages'] : undefined,
                        tools: Array.isArray(body.tools) ? body.tools.flatMap((tool) => {
                            if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) return [];
                            const fn = (tool as Record<string, unknown>).function;
                            if (typeof fn !== 'object' || fn === null || Array.isArray(fn)) return [];
                            const value = fn as Record<string, unknown>;
                            return typeof value.name === 'string' && typeof value.description === 'string' && value.parameters !== undefined
                                ? [{ name: value.name, description: value.description, parameters: value.parameters as never, strict: value.strict === true }]
                                : [];
                        }) : undefined,
                        toolChoice: body.tool_choice as never,
                        reasoning: body.__ss_helper_reasoning as GenerationRequest['reasoning'],
                        stream: true,
                        maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
                        signal,
                    }, (chunk) => { if (chunk.data && typeof chunk.data === 'object' && !Array.isArray(chunk.data)) chunks.push(chunk.data as Record<string, unknown>); });
                    return chunks;
                } finally { signal.removeEventListener('abort', abort); }
            },
        };
        return new OpenAiChatToolAdapter(transport, OPENAI_CHAT_DIALECT_POLICIES.standard, { reasoningProvider: 'tavern' });
    }
}
