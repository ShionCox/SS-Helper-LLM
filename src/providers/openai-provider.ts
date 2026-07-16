import type {
    LLMProvider, LLMProviderCapabilities, LLMRequest, LLMResponse, EmbedRequest, EmbedResponse,
    RerankRequest, RerankResponse,
    ProviderConnectionResult, ProviderModelListResult,
} from './types';
import type { ApiType } from '../schema/types';
import { buildStructuredOutputSystemInstruction } from '../schema/structured-output';

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

    constructor(config: {
        id: string;
        apiKey: string;
        baseUrl?: string;
        model?: string;
        apiType?: ApiType;
        enableRerank?: boolean;
        customParams?: Record<string, unknown>;
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
        };
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

    private extractJsonObject(raw: string): any {
        const text = String(raw || '').trim();
        if (!text) return null;

        const candidates = [text];
        const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fencedMatch?.[1]) candidates.push(fencedMatch[1].trim());

        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            candidates.push(text.slice(firstBrace, lastBrace + 1));
        }

        for (const candidate of candidates) {
            try {
                return JSON.parse(candidate);
            } catch {
                // continue
            }
        }

        return null;
    }

    private normalizeRerankResponse(data: any, req: RerankRequest): RerankResponse {
        const rawResults = Array.isArray(data?.results)
            ? data.results
            : Array.isArray(data?.ranked)
                ? data.ranked
                : Array.isArray(data)
                    ? data
                    : [];

        const normalized = rawResults.map((item: any, fallbackIndex: number) => {
            const rawIndex = Number(item?.index ?? item?.document_index ?? fallbackIndex);
            const index = Number.isFinite(rawIndex) && rawIndex >= 0 ? rawIndex : fallbackIndex;
            const rawScore = Number(item?.score ?? item?.relevance_score ?? item?.similarity ?? 0);
            return {
                index,
                score: Number.isFinite(rawScore) ? rawScore : 0,
                doc: req.docs[index] ?? req.docs[fallbackIndex] ?? '',
            };
        });

        const sorted = normalized.sort(
            (a: { index: number; score: number; doc: string }, b: { index: number; score: number; doc: string }) => b.score - a.score,
        );
        return {
            results: typeof req.topK === 'number' && req.topK > 0 ? sorted.slice(0, req.topK) : sorted,
        };
    }

    private sanitizeSchemaName(name?: string): string {
        const normalized = String(name || 'structured_output')
            .trim()
            .replace(/[^a-zA-Z0-9_-]+/g, '_')
            .replace(/^_+|_+$/g, '');
        return normalized || 'structured_output';
    }

    private buildSystemStructuredOutputInstruction(req: LLMRequest): string {
        return buildStructuredOutputSystemInstruction({
            schema: req.schema,
            schemaName: req.schemaName,
        });
    }

    private ensureStructuredOutputMessages(
        messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
        req: LLMRequest,
        mode: 'json_hint' | 'system_schema',
    ): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
        const hasJsonHint = messages.some((message: { content: string }) => /json/i.test(String(message.content || '')));
        const injectedSystem = mode === 'system_schema'
            ? this.buildSystemStructuredOutputInstruction(req)
            : '请始终输出合法 JSON（json）对象，不要输出额外说明。示例：{"ok":true}';

        if (!hasJsonHint && messages.length > 0 && messages[0]?.role === 'system') {
            return [{ ...messages[0], content: `${messages[0].content}\n\n${injectedSystem}` }, ...messages.slice(1)];
        }

        if (!hasJsonHint || mode === 'system_schema') {
            return [
                {
                    role: 'system',
                    content: injectedSystem,
                },
                ...messages,
            ];
        }

        if (hasJsonHint) {
            return messages;
        }

        return messages;
    }

    private buildResponseFormat(req: LLMRequest): { payload?: Record<string, any>; formatType: 'none' | 'json_object' | 'json_schema' | 'system_json' } {
        if (!req.jsonMode) {
            return { formatType: 'none' };
        }

        if (this.apiType === 'deepseek') {
            return {
                payload: { type: 'json_object' },
                formatType: 'json_object',
            };
        }

        if (this.apiType === 'claude' || this.apiType === 'generic') {
            return {
                formatType: 'system_json',
            };
        }

        if (req.schema && req.preferredResponseFormat === 'json_schema') {
            return {
                payload: {
                    type: 'json_schema',
                    json_schema: {
                        name: this.sanitizeSchemaName(req.schemaName),
                        strict: true,
                        schema: req.schema,
                    },
                },
                formatType: 'json_schema',
            };
        }

        return {
            payload: { type: 'json_object' },
            formatType: 'json_object',
        };
    }

    private async sendChatCompletion(body: Record<string, any>, signal?: AbortSignal): Promise<any> {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
            signal,
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenAI API 请求失败: ${response.status} ${errText}`);
        }

        return response.json();
    }

    async request(req: LLMRequest): Promise<LLMResponse> {
        const messages = (this.apiType === 'deepseek' || this.apiType === 'generic' || this.apiType === 'claude') && req.jsonMode
                ? this.ensureStructuredOutputMessages(req.messages, req, 'system_schema')
                : req.messages;

        const baseBody: Record<string, any> = {
            model: req.model || this.model,
            messages,
            temperature: req.temperature ?? 0.7,
            max_tokens: req.maxTokens ?? 2048,
        };
        const { payload: responseFormat, formatType } = this.buildResponseFormat(req);
        const body: Record<string, any> = this.withCustomParams({
            ...baseBody,
            ...(responseFormat ? { response_format: responseFormat } : {}),
        });

        let data: any;
        let finalBody: Record<string, any> = body;
        try {
            data = await this.sendChatCompletion(body, req.signal);
        } catch (error) {
            if (formatType === 'json_schema' && req.jsonMode) {
                const fallbackBody = this.withCustomParams({
                    ...baseBody,
                    response_format: { type: 'json_object' },
                });
                finalBody = fallbackBody;
                data = await this.sendChatCompletion(fallbackBody, req.signal);
            } else {
                throw error;
            }
        }
        const choice = data.choices?.[0];

        return {
            content: this.extractMessageContent(choice),
            usage: data.usage ? {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
            } : undefined,
            finishReason: choice?.finish_reason,
            debugRequest: {
                providerKind: this.kind,
                apiType: this.apiType,
                resourceId: this.id,
                requestFormat: 'openai_chat_completions',
                payload: finalBody,
            },
        };
    }

    async embed(req: EmbedRequest): Promise<EmbedResponse> {
        const response = await fetch(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(this.withCustomParams({
                model: req.model || 'text-embedding-ada-002',
                input: req.texts,
            })),
            signal: req.signal,
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Embedding 请求失败: ${response.status} ${errText}`);
        }

        const data = await response.json();
        return {
            embeddings: data.data.map((d: any) => d.embedding),
        };
    }

    async rerank(req: RerankRequest): Promise<RerankResponse> {
        if (this.capabilities.rerank !== true) {
            throw new Error('当前资源未启用 rerank 能力');
        }

        const userPayload = JSON.stringify({
            query: req.query,
            documents: req.docs.map((doc: string, index: number) => ({ index, doc })),
            topK: req.topK ?? req.docs.length,
        });

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
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
            const errText = await response.text();
            throw new Error(`LLM 重排请求失败: ${response.status} ${errText}`);
        }

        const data = await response.json();
        const choice = data.choices?.[0];
        const content = this.extractMessageContent(choice);
        const parsed = this.extractJsonObject(content);
        const normalized = this.normalizeRerankResponse(parsed, req);
        if (!Array.isArray(normalized.results) || normalized.results.length === 0) {
            throw new Error('LLM 重排返回为空或格式异常');
        }
        return normalized;
    }

    async testConnection(): Promise<ProviderConnectionResult> {
        const start = Date.now();
        try {
            const res = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: this.buildHeaders(),
                body: JSON.stringify(this.withCustomParams({
                    model: this.model,
                    messages: [{ role: 'user', content: 'Hi' }],
                    max_tokens: 1,
                })),
            });
            const latencyMs = Date.now() - start;

            if (!res.ok) {
                const text = await res.text().catch(() => '');
                const code = res.status === 401 || res.status === 403
                    ? 'AUTH_ERROR'
                    : res.status === 404
                        ? 'ENDPOINT_NOT_FOUND'
                        : `HTTP_${res.status}`;
                return { ok: false, message: `连接失败 (${res.status})`, errorCode: code, detail: text, latencyMs };
            }

            return { ok: true, message: '连接成功', model: this.model, latencyMs };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
                ok: false,
                message: `网络错误: ${msg}`,
                errorCode: 'NETWORK_ERROR',
                detail: msg,
                latencyMs: Date.now() - start,
            };
        }
    }

    async listModels(): Promise<ProviderModelListResult> {
        try {
            const res = await fetch(`${this.baseUrl}/models`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${this.apiKey}` },
            });

            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return { ok: false, models: [], message: `获取模型列表失败 (${res.status})`, detail: text };
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
            const msg = error instanceof Error ? error.message : String(error);
            return { ok: false, models: [], message: `网络错误: ${msg}`, errorCode: 'NETWORK_ERROR', detail: msg };
        }
    }
}
