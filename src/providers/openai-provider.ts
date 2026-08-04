import { createSSHelperError, type ProviderToolDialect } from '@ss-helper/sdk';
import type {
    LLMProvider, LLMProviderCapabilities, LLMRequest, LLMResponse, EmbedRequest, EmbedResponse,
    RerankRequest, RerankResponse,
    ProviderConnectionResult, ProviderModelListResult, ProviderFetch, ProviderResponseDiagnostics,
} from './types';
import { providerConnectionFailure, providerHttpErrorFromResponse, providerModelListFailure } from './provider-errors';
import type { ApiType } from '../schema/types';
import { detectStructuredOutputIdentity, type StructuredOutputIdentity } from '../schema/structured-output-plan';
import { validateJsonSchema, type JsonSchemaIssue } from '../schema/json-schema-validator';
import { OpenAiChatToolAdapter, OPENAI_CHAT_DIALECT_POLICIES } from '../tools/openai-chat-tool-adapter';
import { OpenAiResponsesToolAdapter } from '../tools/openai-responses-tool-adapter';
import type { ProviderToolAdapter } from '../tools/tool-adapter';
import { OpenAiToolStreamAssembler } from '../tools/tool-stream-assembler';
import { parseSseJson } from './sse';
import { responseDiagnostics } from './provider-response-diagnostics';

const RERANK_RESPONSE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
        results: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['index', 'score'],
                properties: {
                    index: { type: 'integer', minimum: 0 },
                    score: { type: 'number', minimum: 0, maximum: 1 },
                },
            },
        },
    },
} as const;

/**
 * OpenAI 兼容 Provider 实现
 * 支持 OpenAI API 以及 OpenAI 兼容的中转服务（如 One API、LocalAI 等）
 */
export class OpenAIProvider implements LLMProvider {
    id: string;
    kind: 'openai' = 'openai';
    capabilities: LLMProviderCapabilities;

    private apiKey: string;
    private baseUrl: string;
    private model: string;
    public readonly apiType: ApiType;
    private customParams: Record<string, unknown>;
    private fetchImpl: ProviderFetch;
    private structuredOutputIdentity: StructuredOutputIdentity;
    private readonly toolDialect?: ProviderToolDialect;
    private readonly requireReasoningContent: boolean;
    private readonly enableToolStream: boolean;
    private readonly streamingEnabled: boolean;
    private readonly embeddingPath: string;
    private readonly embeddingDimensions?: number;

    constructor(config: {
        id: string;
        apiKey: string;
        baseUrl?: string;
        model?: string;
        apiType?: ApiType;
        enableRerank?: boolean;
        customParams?: Record<string, unknown>;
        fetchImpl?: ProviderFetch;
        structuredOutputIdentity?: StructuredOutputIdentity;
        toolDialect?: ProviderToolDialect;
        requireReasoningContent?: boolean;
        enableToolStream?: boolean;
        streamingEnabled?: boolean;
        embeddingPath?: string;
        embeddingDimensions?: number;
    }) {
        this.id = config.id;
        this.apiKey = config.apiKey;
        this.baseUrl = (config.baseUrl || (config.apiType === 'xai' ? 'https://api.x.ai/v1' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
        this.model = config.model || 'gpt-4o-mini';
        this.apiType = config.apiType === 'xai' || config.apiType === 'deepseek' || config.apiType === 'kimi' || config.apiType === 'glm'
            ? config.apiType
            : config.apiType === 'gemini'
                ? 'gemini'
                : config.apiType === 'claude'
                    ? 'claude'
                    : config.apiType === 'generic'
                        ? 'generic'
                        : 'openai';
        this.capabilities = {
            chat: true,
            json: true,
            tools: true,
            embeddings: true,
            rerank: config.enableRerank === true,
            structuredOutput: this.apiType === 'deepseek'
                ? { transports: ['json_object', 'prompt_only'], preferred: 'json_object' }
                : this.apiType === 'generic' || this.apiType === 'xai'
                    ? { transports: ['prompt_only'], preferred: 'prompt_only' }
                    : { transports: ['json_schema', 'json_object', 'prompt_only'], preferred: 'json_schema' },
        };
        this.fetchImpl = config.fetchImpl ?? fetch;
        const manualVendor = this.apiType === 'openai' || this.apiType === 'deepseek' || this.apiType === 'gemini' || this.apiType === 'claude'
            ? this.apiType
            : undefined;
        this.structuredOutputIdentity = config.structuredOutputIdentity ?? (manualVendor
            ? detectStructuredOutputIdentity({ manualVendor, model: this.model })
            : { vendor: 'unknown', evidence: 'manual', confidence: 'high', model: this.model });
        this.customParams = config.customParams && typeof config.customParams === 'object' && !Array.isArray(config.customParams)
            ? { ...config.customParams }
            : {};
        this.toolDialect = config.toolDialect;
        this.requireReasoningContent = config.requireReasoningContent === true;
        this.enableToolStream = config.enableToolStream === true;
        this.streamingEnabled = config.streamingEnabled !== false;
        this.embeddingPath = this.normalizeOperationPath(config.embeddingPath ?? '/embeddings');
        this.embeddingDimensions = config.embeddingDimensions;
    }

    private normalizeOperationPath(path: string): string {
        const value = String(path || '').trim() || '/embeddings';
        return value.startsWith('/') ? value : `/${value}`;
    }

    private operationUrl(path: string): string {
        try {
            const base = new URL(this.baseUrl);
            const basePath = base.pathname.replace(/\/+$/u, '');
            if (basePath.toLocaleLowerCase() === path.toLocaleLowerCase()) return base.toString().replace(/\/+$/u, '');
            if (basePath && path.toLocaleLowerCase().startsWith(`${basePath.toLocaleLowerCase()}/`)) return `${base.origin}${path}`;
        } catch { /* validated resource URLs use the normal branch */ }
        return this.baseUrl.toLocaleLowerCase().endsWith(path.toLocaleLowerCase()) ? this.baseUrl : `${this.baseUrl}${path}`;
    }

    private buildHeaders(): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
        };
    }

    private withCustomParams<T extends Record<string, any>>(payload: T): T {
        return {
            ...this.customParams,
            ...payload,
        };
    }

    private extractMessageContent(choice: any): string {
        const content = choice?.message?.content;
        if (typeof content === 'string') return content;
        if (content && typeof content === 'object') {
            try { return JSON.stringify(content); } catch { /* skip */ }
        }
        if (Array.isArray(content)) {
            return content
                .map((item: any) => (typeof item?.text === 'string' ? item.text : typeof item?.content === 'string' ? item.content : ''))
                .join('')
                .trim();
        }
        return '';
    }

    private rerankValidationError(issue: JsonSchemaIssue): Error {
        return createSSHelperError('SCHEMA_VALIDATION_FAILED', {
            stage: 'llm.provider.rerank.validate',
            providerKind: this.kind,
            resourceId: this.id,
            path: issue.path,
            keyword: issue.keyword,
            expected: issue.expected,
        });
    }

    private parseRerankResponse(raw: string, req: RerankRequest): RerankResponse {
        let parsed: unknown;
        try {
            parsed = JSON.parse(String(raw || '').trim());
        } catch {
            throw createSSHelperError('INVALID_JSON', {
                stage: 'llm.provider.rerank.parse',
                providerKind: this.kind,
                resourceId: this.id,
            });
        }
        const validation = validateJsonSchema(parsed, RERANK_RESPONSE_SCHEMA);
        if (!validation.valid) throw this.rerankValidationError(validation.issues[0]!);
        const results = (parsed as { results: Array<{ index: number; score: number }> }).results;
        const seen = new Set<number>();
        for (let itemIndex = 0; itemIndex < results.length; itemIndex += 1) {
            const result = results[itemIndex]!;
            if (result.index >= req.docs.length) {
                throw this.rerankValidationError({
                    path: `$.results[${itemIndex}].index`,
                    keyword: 'maximum',
                    expected: `an integer below ${req.docs.length}`,
                });
            }
            if (seen.has(result.index)) {
                throw this.rerankValidationError({
                    path: `$.results[${itemIndex}].index`,
                    keyword: 'uniqueItems',
                    expected: 'a unique document index',
                });
            }
            seen.add(result.index);
        }
        const normalized = results
            .map(({ index, score }) => ({ index, score, doc: req.docs[index]! }))
            .sort((left, right) => right.score - left.score);
        return { results: typeof req.topK === 'number' && req.topK > 0 ? normalized.slice(0, req.topK) : normalized };
    }

    private buildResponseFormat(req: LLMRequest, transport = req.structuredOutput?.transport): Record<string, unknown> | undefined {
        if (transport === 'json_schema' && req.structuredOutput) {
            return {
                type: 'json_schema',
                json_schema: {
                    name: req.structuredOutput.spec.name,
                    strict: true,
                    schema: req.structuredOutput.spec.schema,
                },
            };
        }
        return transport === 'json_object' ? { type: 'json_object' } : undefined;
    }

    getStructuredOutputIdentity(model?: string): StructuredOutputIdentity {
        return model && model !== this.structuredOutputIdentity.model
            ? { ...this.structuredOutputIdentity, model }
            : this.structuredOutputIdentity;
    }

    private async sendChatCompletion(body: Record<string, any>, signal?: AbortSignal, timeoutMs = 600_000): Promise<{ data: any; diagnostics: ProviderResponseDiagnostics }> {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
            signal,
            timeoutMs,
            idleTimeoutMs: 120_000,
        });

        if (!response.ok) throw await providerHttpErrorFromResponse('OpenAI', response);

        const data = await response.json();
        return { data, diagnostics: responseDiagnostics(response, data, { streamed: false }) };
    }

    private async sendChatCompletionStream(body: Record<string, any>, signal?: AbortSignal, timeoutMs = 180_000): Promise<{ chunks: readonly Record<string, unknown>[]; diagnostics: ProviderResponseDiagnostics }> {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
            method: 'POST', headers: this.buildHeaders(), body: JSON.stringify({ ...body, stream: true }), signal,
            timeoutMs, idleTimeoutMs: 30_000,
        });
        if (!response.ok) throw await providerHttpErrorFromResponse('OpenAI-compatible stream', response);
        const text = await response.text();
        if (text.length > 8 * 1024 * 1024) throw createSSHelperError('HTTP_RESPONSE_TOO_LARGE', { stage: 'llm.provider.tool_stream', resourceId: this.id });
        const chunks = parseSseJson(text, 'llm.provider.openai_stream.parse', this.id);
        return { chunks, diagnostics: responseDiagnostics(response, text, { streamed: true, streamEventCount: chunks.length }) };
    }

    private assembleChatCompletionStream(chunks: readonly Record<string, unknown>[]): Record<string, unknown> {
        const complete = chunks.find((chunk) => Array.isArray(chunk.choices)
            && (chunk.choices as Array<Record<string, unknown>>).some((choice) => choice.message !== undefined));
        if (complete) return complete;
        const assembler = new OpenAiToolStreamAssembler();
        let content = '';
        let reasoningContent = '';
        let usage: unknown;
        let finishReason: unknown;
        for (const chunk of chunks) {
            if (chunk.usage !== undefined) usage = chunk.usage;
            const choices = Array.isArray(chunk.choices) ? chunk.choices as Array<Record<string, unknown>> : [];
            const choice = choices[0];
            if (choice?.finish_reason !== undefined) finishReason = choice.finish_reason;
            const delta = choice?.delta;
            if (!delta || typeof delta !== 'object' || Array.isArray(delta)) continue;
            const record = delta as Record<string, unknown>;
            if (typeof record.content === 'string') content += record.content;
            if (typeof record.reasoning_content === 'string') reasoningContent += record.reasoning_content;
            if (!Array.isArray(record.tool_calls)) continue;
            for (const raw of record.tool_calls as Array<Record<string, unknown>>) {
                const fn = raw.function && typeof raw.function === 'object' && !Array.isArray(raw.function) ? raw.function as Record<string, unknown> : {};
                assembler.push({ index: Number(raw.index), ...(typeof raw.id === 'string' ? { id: raw.id } : {}), ...(typeof fn.name === 'string' ? { name: fn.name } : {}), ...(typeof fn.arguments === 'string' ? { arguments: fn.arguments } : {}) });
            }
        }
        const calls = assembler.finishRaw();
        return {
            choices: [{ finish_reason: finishReason, message: { role: 'assistant', content, ...(reasoningContent ? { reasoning_content: reasoningContent } : {}), ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.callId, type: 'function', function: { name: call.name, arguments: call.argumentsText } })) } : {}) } }],
            ...(usage === undefined ? {} : { usage }),
        };
    }

    createToolAdapter(): ProviderToolAdapter {
        const configuredDialect = this.toolDialect ?? (this.apiType === 'openai'
            ? 'openai_responses'
            : this.apiType === 'deepseek'
                ? 'deepseek_chat'
                : this.apiType === 'kimi'
                    ? 'kimi_chat'
                    : this.apiType === 'glm'
                        ? 'glm_chat'
                        : 'openai_chat_compatible');
        if (configuredDialect === 'openai_responses') {
            return new OpenAiResponsesToolAdapter({
                resourceId: this.id,
                defaultModel: this.model,
                send: async (body, signal) => {
                    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
                        method: 'POST',
                        headers: this.buildHeaders(),
                        body: JSON.stringify(this.withCustomParams(body)),
                        signal,
                    });
                    if (!response.ok) throw await providerHttpErrorFromResponse('OpenAI Responses', response);
                    return await response.json() as Record<string, unknown>;
                },
                ...(this.streamingEnabled ? { sendStream: async (body: Record<string, unknown>, signal?: AbortSignal) => {
                    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
                        method: 'POST', headers: this.buildHeaders(),
                        body: JSON.stringify(this.withCustomParams({ ...body, stream: true })),
                        signal, timeoutMs: 180_000, idleTimeoutMs: 30_000,
                    });
                    if (!response.ok) throw await providerHttpErrorFromResponse('OpenAI Responses stream', response);
                    return parseSseJson(await response.text(), 'llm.provider.responses_stream.parse', this.id);
                } } : {}),
            });
        }
        const dialect = configuredDialect === 'deepseek_chat' ? 'deepseek'
            : configuredDialect === 'kimi_chat' ? 'kimi'
                : configuredDialect === 'glm_chat' ? 'glm'
                    : configuredDialect === 'openai_chat_compatible' ? 'standard' : undefined;
        if (!dialect) throw createSSHelperError('LLM_CAPABILITY_UNAVAILABLE', {
            stage: 'llm.tools.adapter.resolve', resourceId: this.id,
        });
        return new OpenAiChatToolAdapter({
            resourceId: this.id,
            defaultModel: this.model,
            send: async (body, signal) => (await this.sendChatCompletion(this.withCustomParams(body), signal)).data as Record<string, unknown>,
            ...(this.streamingEnabled ? { sendStream: async (body: Record<string, unknown>, signal?: AbortSignal) => (await this.sendChatCompletionStream(this.withCustomParams(body), signal)).chunks } : {}),
        }, OPENAI_CHAT_DIALECT_POLICIES[dialect], { requireReasoningContent: this.requireReasoningContent, enableToolStream: this.enableToolStream });
    }

    async request(req: LLMRequest): Promise<LLMResponse> {
        // Structured responses can be large enough that token-by-token SSE
        // framing exceeds the Bridge response limit even though the final JSON
        // body is small. Request one complete JSON response for these calls.
        const useStreaming = this.streamingEnabled && req.structuredOutput === undefined;
        const baseBody: Record<string, any> = {
            model: req.model || this.model,
            messages: req.messages,
            temperature: req.temperature ?? 0.7,
            max_tokens: req.maxTokens ?? 2048,
            // Some OpenAI-compatible gateways default to SSE unless callers
            // explicitly opt out. The provider consumes one complete JSON
            // response, so make that wire contract deterministic.
            stream: useStreaming,
        };
        const responseFormat = this.buildResponseFormat(req);
        const body: Record<string, any> = this.withCustomParams({
            ...baseBody,
            ...(responseFormat ? { response_format: responseFormat } : {}),
        });

        const transport = useStreaming
            ? await this.sendChatCompletionStream(body, req.signal, req.timeoutMs)
            : await this.sendChatCompletion(body, req.signal, req.timeoutMs);
        const data: any = 'chunks' in transport ? this.assembleChatCompletionStream(transport.chunks) : transport.data;
        const choice = data.choices?.[0];

        return {
            content: this.extractMessageContent(choice),
            usage: data.usage ? {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
            } : undefined,
            finishReason: choice?.finish_reason,
            diagnostics: transport.diagnostics,
            ...(req.structuredOutput === undefined ? {} : {
                structuredOutput: {
                    plannedTransport: req.structuredOutput.transport,
                    actualTransport: req.structuredOutput.transport,
                },
            }),
            debugRequest: {
                providerKind: this.kind,
                apiType: this.apiType,
                resourceId: this.id,
                requestFormat: 'openai_chat_completions',
                payload: body,
            },
        };
    }

    async embed(req: EmbedRequest): Promise<EmbedResponse> {
        const dimensions = req.dimensions ?? this.embeddingDimensions;
        const response = await this.fetchImpl(this.operationUrl(this.embeddingPath), {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(this.withCustomParams({
                model: req.model || this.model,
                input: req.texts,
                ...(dimensions === undefined ? {} : { dimensions }),
            })),
            signal: req.signal,
        });

        if (!response.ok) {
            throw await providerHttpErrorFromResponse('Embedding', response);
        }
        const data = await response.json();
        const rows = Array.isArray(data?.data) ? [...data.data] : [];
        rows.sort((left: any, right: any) => Number(left?.index ?? 0) - Number(right?.index ?? 0));
        const embeddings = rows.map((row: any) => row?.embedding);
        const invalidIndex = embeddings.findIndex((vector: unknown) => !Array.isArray(vector)
            || vector.length === 0
            || vector.some((item) => typeof item !== 'number' || !Number.isFinite(item))
            || (dimensions !== undefined && vector.length !== dimensions));
        if (embeddings.length !== req.texts.length || invalidIndex >= 0) {
            throw createSSHelperError('PROVIDER_RESPONSE_INVALID', {
                stage: 'llm.provider.embedding.validate',
                providerKind: this.kind,
                resourceId: this.id,
                path: invalidIndex >= 0 ? `$.data[${invalidIndex}].embedding` : '$.data',
                expected: dimensions === undefined
                    ? `${req.texts.length} finite non-empty embedding vectors`
                    : `${req.texts.length} finite embedding vectors with ${dimensions} dimensions`,
            });
        }
        return { embeddings: embeddings as number[][], diagnostics: responseDiagnostics(response, data, { streamed: false }) };
    }

    async rerank(req: RerankRequest): Promise<RerankResponse> {
        if (this.capabilities.rerank !== true) {
            throw createSSHelperError('PROVIDER_UNAVAILABLE', {
                stage: 'llm.provider.rerank.capability',
                providerKind: this.kind,
                resourceId: this.id,
            });
        }

        const userPayload = JSON.stringify({
            query: req.query,
            documents: req.docs.map((doc: string, index: number) => ({ index, doc })),
            topK: req.topK ?? req.docs.length,
        });

        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(this.withCustomParams({
                model: req.model || this.model,
                temperature: 0,
                max_tokens: Math.min(1200, Math.max(300, req.docs.length * 80)),
                response_format: { type: 'json_object' },
                messages: [
                    {
                        role: 'system',
                        content: '你是一个文档重排器。请根据 query 评估 documents 的相关性，返回 JSON 对象，格式为 {"results":[{"index":0,"score":0.98}]}。results 必须按相关性从高到低排序，score 为 0 到 1 之间的数字，不要返回额外解释。',
                    },
                    {
                        role: 'user',
                        content: userPayload,
                    },
                ],
            })),
            signal: req.signal,
        });

        if (!response.ok) {
            throw await providerHttpErrorFromResponse('Rerank', response);
        }

        const data = await response.json();
        const choice = data.choices?.[0];
        const content = this.extractMessageContent(choice);
        return { ...this.parseRerankResponse(content, req), diagnostics: responseDiagnostics(response, data, { streamed: false }) };
    }

    async testConnection(signal?: AbortSignal): Promise<ProviderConnectionResult> {
        const start = Date.now();
        try {
            const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: this.buildHeaders(),
                body: JSON.stringify(this.withCustomParams({
                    model: this.model,
                    messages: [{ role: 'user', content: 'Hi' }],
                    max_tokens: 1,
                })),
                signal,
            });
            const latencyMs = Date.now() - start;

            if (!res.ok) {
                return providerConnectionFailure(await providerHttpErrorFromResponse(this.kind, res), {
                    stage: 'llm.provider.test',
                    providerKind: this.kind,
                    resourceId: this.id,
                    model: this.model,
                }, latencyMs);
            }

            return { ok: true, message: '连接成功', model: this.model, latencyMs };
        } catch (error: unknown) {
            return providerConnectionFailure(error, {
                stage: 'llm.provider.test',
                providerKind: this.kind,
                resourceId: this.id,
                model: this.model,
            }, Date.now() - start);
        }
    }

    async listModels(signal?: AbortSignal): Promise<ProviderModelListResult> {
        try {
            const res = await this.fetchImpl(`${this.baseUrl}/models`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${this.apiKey}` },
                signal,
            });

            if (!res.ok) {
                return providerModelListFailure(await providerHttpErrorFromResponse(this.kind, res), {
                    stage: 'llm.provider.models',
                    providerKind: this.kind,
                    resourceId: this.id,
                });
            }

            const json = await res.json();
            const list = Array.isArray(json?.data) ? json.data : [];
            const models = list.map((m: any, index: number) => {
                const rawId = m?.id ?? m?.model ?? m?.name ?? m?.value;
                const id = String(rawId ?? `model-${index + 1}`);
                return { id, label: String(m?.id ?? m?.model ?? m?.name ?? id) };
            });

            return { ok: true, models, message: `共 ${models.length} 个模型` };
        } catch (error: unknown) {
            return providerModelListFailure(error, {
                stage: 'llm.provider.models',
                providerKind: this.kind,
                resourceId: this.id,
            });
        }
    }
}
