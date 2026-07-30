import { createSSHelperError } from '@ss-helper/sdk';
import type {
    LLMProvider, LLMProviderCapabilities, LLMRequest, LLMResponse, EmbedRequest, EmbedResponse,
    RerankRequest, RerankResponse,
    ProviderConnectionResult, ProviderModelListResult,
} from './types';
import { providerConnectionFailure, providerHttpErrorFromResponse, providerModelListFailure } from './provider-errors';
import type { ApiType } from '../schema/types';
import { detectStructuredOutputIdentity, type StructuredOutputIdentity } from '../schema/structured-output-plan';
import { validateJsonSchema, type JsonSchemaIssue } from '../schema/json-schema-validator';

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
    private fetchImpl: typeof fetch;
    private structuredOutputIdentity: StructuredOutputIdentity;

    constructor(config: {
        id: string;
        apiKey: string;
        baseUrl?: string;
        model?: string;
        apiType?: ApiType;
        enableRerank?: boolean;
        customParams?: Record<string, unknown>;
        fetchImpl?: typeof fetch;
        structuredOutputIdentity?: StructuredOutputIdentity;
    }) {
        this.id = config.id;
        this.apiKey = config.apiKey;
        this.baseUrl = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
        this.model = config.model || 'gpt-4o-mini';
        this.apiType = config.apiType === 'deepseek'
            ? 'deepseek'
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
                : this.apiType === 'generic'
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

    private async sendChatCompletion(body: Record<string, any>, signal?: AbortSignal): Promise<any> {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
            signal,
        });

        if (!response.ok) throw await providerHttpErrorFromResponse('OpenAI', response);

        return response.json();
    }

    async request(req: LLMRequest): Promise<LLMResponse> {
        const baseBody: Record<string, any> = {
            model: req.model || this.model,
            messages: req.messages,
            temperature: req.temperature ?? 0.7,
            max_tokens: req.maxTokens ?? 2048,
            // Some OpenAI-compatible gateways default to SSE unless callers
            // explicitly opt out. The provider consumes one complete JSON
            // response, so make that wire contract deterministic.
            stream: false,
        };
        const responseFormat = this.buildResponseFormat(req);
        const body: Record<string, any> = this.withCustomParams({
            ...baseBody,
            ...(responseFormat ? { response_format: responseFormat } : {}),
        });

        const data: any = await this.sendChatCompletion(body, req.signal);
        const choice = data.choices?.[0];

        return {
            content: this.extractMessageContent(choice),
            usage: data.usage ? {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
            } : undefined,
            finishReason: choice?.finish_reason,
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
        const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(this.withCustomParams({
                model: req.model || 'text-embedding-ada-002',
                input: req.texts,
            })),
            signal: req.signal,
        });

        if (!response.ok) {
            throw await providerHttpErrorFromResponse('Embedding', response);
        }

        const data = await response.json();
        return {
            embeddings: data.data.map((d: any) => d.embedding),
        };
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
        return this.parseRerankResponse(content, req);
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
