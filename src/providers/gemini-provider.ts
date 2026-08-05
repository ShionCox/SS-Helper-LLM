import { createSSHelperError } from '@ss-helper/sdk';
import type {
    LLMProvider,
    LLMProviderCapabilities,
    LLMRequest,
    LLMResponse,
    EmbedRequest,
    EmbedResponse,
    RerankRequest,
    RerankResponse,
    ProviderConnectionResult,
    ProviderModelListResult, ProviderFetch,
} from './types';
import { providerConnectionFailure, providerHttpErrorFromResponse, providerModelListFailure } from './provider-errors';
import type { StructuredOutputIdentity } from '../schema/structured-output-plan';
import { GeminiInteractionsToolAdapter } from '../tools/gemini-interactions-tool-adapter';
import { compileReasoningFields } from './reasoning-policy';
import type { ProviderToolAdapter } from '../tools/tool-adapter';
import { parseSseJson } from './sse';
import { responseDiagnostics } from './provider-response-diagnostics';

export class GeminiProvider implements LLMProvider {
    id: string;
    kind: 'gemini' = 'gemini';
    capabilities: LLMProviderCapabilities;
    public readonly apiType = 'gemini' as const;

    private apiKey: string;
    private baseUrl: string;
    private model: string;
    private customParams: Record<string, unknown>;
    private fetchImpl: ProviderFetch;
    private readonly structuredOutputIdentity: StructuredOutputIdentity;
    private readonly embeddingDimensions?: number;
    private readonly streamingEnabled: boolean;

    constructor(config: {
        id: string;
        apiKey: string;
        baseUrl?: string;
        model?: string;
        enableRerank?: boolean;
        embeddingDimensions?: number;
        customParams?: Record<string, unknown>;
        fetchImpl?: ProviderFetch;
        streamingEnabled?: boolean;
    }) {
        this.id = config.id;
        this.apiKey = config.apiKey;
        this.baseUrl = (config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
        if (!config.model?.trim()) throw createSSHelperError('MODEL_NOT_FOUND', { stage: 'llm.provider.configure.model', resourceId: config.id });
        this.model = config.model.trim();
        this.capabilities = {
            chat: true,
            json: true,
            tools: true,
            embeddings: true,
            rerank: false,
            structuredOutput: { transports: ['json_schema', 'prompt_only'], preferred: 'json_schema' },
        };
        this.fetchImpl = config.fetchImpl ?? fetch;
        this.embeddingDimensions = config.embeddingDimensions;
        this.streamingEnabled = config.streamingEnabled !== false;
        this.structuredOutputIdentity = { vendor: 'gemini', evidence: 'manual', confidence: 'high', model: this.model };
        this.customParams = config.customParams && typeof config.customParams === 'object' && !Array.isArray(config.customParams)
            ? { ...config.customParams }
            : {};
    }

    getStructuredOutputIdentity(model?: string): StructuredOutputIdentity {
        return model && model !== this.structuredOutputIdentity.model ? { ...this.structuredOutputIdentity, model } : this.structuredOutputIdentity;
    }

    private buildHeaders(): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
        };
    }

    private withCustomParams<T extends Record<string, any>>(payload: T): T {
        return {
            ...this.customParams,
            ...payload,
        };
    }

    private splitMessages(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): {
        systemInstruction?: { parts: Array<{ text: string }> };
        contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
    } {
        const systemParts: string[] = [];
        const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

        for (const message of messages) {
            if (message.role === 'system') {
                if (String(message.content || '').trim()) {
                    systemParts.push(String(message.content));
                }
                continue;
            }
            contents.push({
                role: message.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: String(message.content || '') }],
            });
        }

        return {
            ...(systemParts.length > 0 ? { systemInstruction: { parts: [{ text: systemParts.join('\n\n') }] } } : {}),
            contents: contents.length > 0
                ? contents
                : [{ role: 'user', parts: [{ text: '' }] }],
        };
    }

    private extractText(data: any): string {
        const parts = Array.isArray(data?.candidates?.[0]?.content?.parts) ? data.candidates[0].content.parts : [];
        return parts
            .map((part: any) => String(part?.text || ''))
            .join('')
            .trim();
    }

    private assembleGenerateStream(chunks: readonly Record<string, unknown>[]): Record<string, unknown> {
        if (chunks.length === 1 && Array.isArray(chunks[0]?.candidates)) return chunks[0]!;
        let text = '';
        let finishReason: unknown;
        let usageMetadata: unknown;
        for (const chunk of chunks) {
            const candidates = Array.isArray(chunk.candidates) ? chunk.candidates as Array<Record<string, unknown>> : [];
            const candidate = candidates[0];
            const content = candidate?.content && typeof candidate.content === 'object' && !Array.isArray(candidate.content) ? candidate.content as Record<string, unknown> : undefined;
            const parts = Array.isArray(content?.parts) ? content.parts as Array<Record<string, unknown>> : [];
            text += parts.map((part) => typeof part.text === 'string' ? part.text : '').join('');
            if (candidate?.finishReason !== undefined) finishReason = candidate.finishReason;
            if (chunk.usageMetadata !== undefined) usageMetadata = chunk.usageMetadata;
        }
        if (!text && finishReason === undefined) throw createSSHelperError('PROVIDER_RESPONSE_INVALID', { stage: 'llm.provider.gemini_stream.empty', resourceId: this.id });
        return { candidates: [{ content: { parts: [{ text }] }, finishReason }], ...(usageMetadata === undefined ? {} : { usageMetadata }) };
    }

    createToolAdapter(): ProviderToolAdapter {
        return new GeminiInteractionsToolAdapter({
            resourceId: this.id,
            defaultModel: this.model,
            send: async (body, signal) => {
                const response = await this.fetchImpl(`${this.baseUrl}/interactions`, {
                    method: 'POST',
                    headers: this.buildHeaders(),
                    body: JSON.stringify(this.withCustomParams(body)),
                    signal,
                });
                if (!response.ok) throw await providerHttpErrorFromResponse('Gemini Interactions', response);
                return await response.json() as Record<string, unknown>;
            },
            ...(this.streamingEnabled ? { sendStream: async (body: Record<string, unknown>, signal?: AbortSignal) => {
                const response = await this.fetchImpl(`${this.baseUrl}/interactions`, {
                    method: 'POST', headers: this.buildHeaders(),
                    body: JSON.stringify(this.withCustomParams({ ...body, stream: true })),
                    signal, timeoutMs: 180_000, idleTimeoutMs: 30_000,
                });
                if (!response.ok) throw await providerHttpErrorFromResponse('Gemini Interactions stream', response);
                return parseSseJson(await response.text(), 'llm.provider.gemini_interactions_stream.parse', this.id);
            } } : {}),
        });
    }

    async request(req: LLMRequest): Promise<LLMResponse> {
        const split = this.splitMessages(req.messages);
        const reasoningFields = compileReasoningFields({ provider: 'gemini', dialect: 'gemini_interactions', policy: req.reasoning, execution: req.structuredOutput === undefined ? 'completion' : 'structured' });
        const thinkingConfig = reasoningFields.thinkingConfig && typeof reasoningFields.thinkingConfig === 'object' && !Array.isArray(reasoningFields.thinkingConfig)
            ? reasoningFields.thinkingConfig as Record<string, unknown> : undefined;
        const generationConfig: Record<string, unknown> = {
            ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
            ...(typeof req.maxTokens === 'number' ? { maxOutputTokens: req.maxTokens } : {}),
            ...(req.structuredOutput?.transport === 'json_object' ? { responseMimeType: 'application/json' } : {}),
            ...(req.structuredOutput?.transport === 'json_schema' ? { responseMimeType: 'application/json', responseJsonSchema: req.structuredOutput.spec.schema } : {}),
            ...(thinkingConfig === undefined ? {} : { thinkingConfig }),
        };

        const body = this.withCustomParams({
            contents: split.contents,
            ...(split.systemInstruction ? { systemInstruction: split.systemInstruction } : {}),
            ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
        });

        const operation = this.streamingEnabled ? 'streamGenerateContent?alt=sse' : 'generateContent';
        const response = await this.fetchImpl(`${this.baseUrl}/models/${encodeURIComponent(req.model || this.model)}:${operation}`, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
            signal: req.signal,
            timeoutMs: req.timeoutMs,
            ...(this.streamingEnabled ? { idleTimeoutMs: 30_000 } : {}),
        });

        if (!response.ok) {
            throw await providerHttpErrorFromResponse('Gemini', response);
        }

        let responseBody: unknown;
        let streamEventCount: number | undefined;
        let resolvedData: any;
        if (this.streamingEnabled) {
            const text = await response.text();
            responseBody = text;
            const chunks = parseSseJson(text, 'llm.provider.gemini_stream.parse', this.id);
            streamEventCount = chunks.length;
            resolvedData = this.assembleGenerateStream(chunks);
        } else {
            resolvedData = await response.json();
            responseBody = resolvedData;
        }
        const promptTokens = Number(resolvedData?.usageMetadata?.promptTokenCount ?? 0);
        const completionTokens = Number(resolvedData?.usageMetadata?.candidatesTokenCount ?? 0);
        const totalTokens = Number(resolvedData?.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens);

        return {
            content: this.extractText(resolvedData),
            usage: {
                promptTokens,
                completionTokens,
                totalTokens,
            },
            finishReason: resolvedData?.candidates?.[0]?.finishReason,
            diagnostics: responseDiagnostics(response, responseBody, { streamed: this.streamingEnabled, ...(streamEventCount === undefined ? {} : { streamEventCount }) }),
            ...(req.structuredOutput === undefined ? {} : { structuredOutput: { plannedTransport: req.structuredOutput.transport, actualTransport: req.structuredOutput.transport } }),
            debugRequest: {
                providerKind: this.kind,
                apiType: this.apiType,
                resourceId: this.id,
                requestFormat: 'gemini_generate_content',
                payload: body,
            },
        };
    }

    async embed(req: EmbedRequest): Promise<EmbedResponse> {
        const model = req.model?.trim() || this.model;
        const batch = req.texts.length > 1;
        const dimensions = req.dimensions ?? this.embeddingDimensions;
        const body = this.withCustomParams(batch
            ? { requests: req.texts.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] }, ...(dimensions === undefined ? {} : { outputDimensionality: dimensions }) })) }
            : { content: { parts: [{ text: req.texts[0] ?? '' }] }, ...(dimensions === undefined ? {} : { outputDimensionality: dimensions }) });

        const modelPath = model.startsWith('models/') ? model : `models/${model}`;
        const response = await this.fetchImpl(`${this.baseUrl}/${modelPath}:${batch ? 'batchEmbedContents' : 'embedContent'}`, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
            signal: req.signal,
        });

        if (!response.ok) {
            throw await providerHttpErrorFromResponse('Gemini Embedding', response);
        }

        const data = await response.json();
        const rawEmbeddings = Array.isArray(data?.embeddings)
            ? data.embeddings
            : data?.embedding
                ? [data.embedding]
                : [];

        const embeddings = rawEmbeddings.map((item: any) => Array.isArray(item?.values) ? item.values : Array.isArray(item) ? item : []);
        const invalidIndex = embeddings.findIndex((vector: unknown[]) => vector.length === 0
            || vector.some((item) => typeof item !== 'number' || !Number.isFinite(item))
            || (dimensions !== undefined && vector.length !== dimensions));
        if (embeddings.length !== req.texts.length || invalidIndex >= 0) {
            throw createSSHelperError('PROVIDER_RESPONSE_INVALID', {
                stage: 'llm.provider.embedding.validate', providerKind: this.kind, resourceId: this.id,
                path: invalidIndex >= 0 ? `$.embeddings[${invalidIndex}]` : '$.embeddings',
                expected: dimensions === undefined
                    ? `${req.texts.length} finite non-empty embedding vectors`
                    : `${req.texts.length} finite embedding vectors with ${dimensions} dimensions`,
            });
        }
        return { embeddings, diagnostics: responseDiagnostics(response, data, { streamed: false }) };
    }

    async rerank(_req: RerankRequest): Promise<RerankResponse> {
        throw new Error('GeminiProvider 暂未提供原生 rerank，请改用重排资源或生成资源兜底。');
    }

    async testConnection(signal?: AbortSignal): Promise<ProviderConnectionResult> {
        const start = Date.now();
        try {
            await this.request({
                messages: [{ role: 'user', content: 'Hi' }],
                model: this.model,
                maxTokens: 8,
                signal,
            });
            return {
                ok: true,
                message: '连接成功',
                model: this.model,
                latencyMs: Date.now() - start,
            };
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
                headers: this.buildHeaders(),
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
            const list = Array.isArray(json?.models) ? json.models : Array.isArray(json?.data) ? json.data : [];
            const models = list.map((m: any, index: number) => {
                const rawId = m?.name ?? m?.id ?? m?.model;
                const id = String(rawId ?? `model-${index + 1}`)
                    .replace(/^models\//, '');
                return { id, label: String(m?.displayName ?? m?.name ?? m?.id ?? id).replace(/^models\//, '') };
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
