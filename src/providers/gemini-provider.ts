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
    ProviderModelListResult,
} from './types';

export class GeminiProvider implements LLMProvider {
    id: string;
    kind: 'gemini' = 'gemini';
    capabilities: LLMProviderCapabilities;
    public readonly apiType = 'gemini' as const;

    private apiKey: string;
    private baseUrl: string;
    private model: string;
    private customParams: Record<string, unknown>;

    constructor(config: {
        id: string;
        apiKey: string;
        baseUrl?: string;
        model?: string;
        enableRerank?: boolean;
        customParams?: Record<string, unknown>;
    }) {
        this.id = config.id;
        this.apiKey = config.apiKey;
        this.baseUrl = (config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
        this.model = config.model || 'gemini-2.5-flash';
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

    async request(req: LLMRequest): Promise<LLMResponse> {
        const split = this.splitMessages(req.messages);
        const generationConfig: Record<string, unknown> = {
            ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
            ...(typeof req.maxTokens === 'number' ? { maxOutputTokens: req.maxTokens } : {}),
            ...(req.jsonMode ? { responseMimeType: 'application/json' } : {}),
            ...(req.schema && req.preferredResponseFormat === 'json_schema' ? { responseJsonSchema: req.schema } : {}),
        };

        const body = this.withCustomParams({
            contents: split.contents,
            ...(split.systemInstruction ? { systemInstruction: split.systemInstruction } : {}),
            ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
        });

        const response = await fetch(`${this.baseUrl}/models/${encodeURIComponent(req.model || this.model)}:generateContent`, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
            signal: req.signal,
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Gemini API 请求失败: ${response.status} ${errText}`);
        }

        const data = await response.json();
        const promptTokens = Number(data?.usageMetadata?.promptTokenCount ?? 0);
        const completionTokens = Number(data?.usageMetadata?.candidatesTokenCount ?? 0);
        const totalTokens = Number(data?.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens);

        return {
            content: this.extractText(data),
            usage: {
                promptTokens,
                completionTokens,
                totalTokens,
            },
            finishReason: data?.candidates?.[0]?.finishReason,
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
        const model = req.model || this.model || 'gemini-embedding-001';
        const body = this.withCustomParams({
            contents: req.texts,
        });

        const response = await fetch(`${this.baseUrl}/models/${encodeURIComponent(model)}:embedContent`, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
            signal: req.signal,
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Gemini Embedding 请求失败: ${response.status} ${errText}`);
        }

        const data = await response.json();
        const rawEmbeddings = Array.isArray(data?.embeddings)
            ? data.embeddings
            : data?.embedding
                ? [data.embedding]
                : [];

        return {
            embeddings: rawEmbeddings.map((item: any) => Array.isArray(item?.values) ? item.values : Array.isArray(item) ? item : []),
        };
    }

    async rerank(_req: RerankRequest): Promise<RerankResponse> {
        throw new Error('GeminiProvider 暂未提供原生 rerank，请改用重排资源或生成资源兜底。');
    }

    async testConnection(): Promise<ProviderConnectionResult> {
        const start = Date.now();
        try {
            await this.request({
                messages: [{ role: 'user', content: 'Hi' }],
                model: this.model,
                maxTokens: 8,
            });
            return {
                ok: true,
                message: '连接成功',
                model: this.model,
                latencyMs: Date.now() - start,
            };
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
                headers: this.buildHeaders(),
            });

            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return { ok: false, models: [], message: `获取模型列表失败 (${res.status})`, detail: text };
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
            const msg = error instanceof Error ? error.message : String(error);
            return { ok: false, models: [], message: `网络错误: ${msg}`, errorCode: 'NETWORK_ERROR', detail: msg };
        }
    }
}
