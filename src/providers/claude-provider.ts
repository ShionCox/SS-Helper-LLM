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
import { providerHttpError } from './provider-errors';

export class ClaudeProvider implements LLMProvider {
    id: string;
    kind: 'claude' = 'claude';
    capabilities: LLMProviderCapabilities;
    public readonly apiType = 'claude' as const;

    private apiKey: string;
    private baseUrl: string;
    private model: string;
    private anthropicVersion: string;
    private customParams: Record<string, unknown>;
    private fetchImpl: typeof fetch;

    constructor(config: {
        id: string;
        apiKey: string;
        baseUrl?: string;
        model?: string;
        anthropicVersion?: string;
        customParams?: Record<string, unknown>;
        fetchImpl?: typeof fetch;
    }) {
        this.id = config.id;
        this.apiKey = config.apiKey;
        this.baseUrl = (config.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
        this.model = config.model || 'claude-sonnet-4-5';
        this.anthropicVersion = config.anthropicVersion || '2023-06-01';
        this.capabilities = {
            chat: true,
            json: true,
            tools: true,
            embeddings: false,
            rerank: false,
        };
        this.fetchImpl = config.fetchImpl ?? fetch;
        this.customParams = config.customParams && typeof config.customParams === 'object' && !Array.isArray(config.customParams)
            ? { ...config.customParams }
            : {};
    }

    private buildHeaders(): Record<string, string> {
        return {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': this.anthropicVersion,
        };
    }

    private withCustomParams<T extends Record<string, any>>(payload: T): T {
        return {
            ...this.customParams,
            ...payload,
        };
    }

    private splitMessages(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): {
        system?: string;
        messages: Array<{ role: 'user' | 'assistant'; content: Array<{ type: 'text'; text: string }> }>;
    } {
        const systemParts: string[] = [];
        const conversation: Array<{ role: 'user' | 'assistant'; content: Array<{ type: 'text'; text: string }> }> = [];

        for (const message of messages) {
            if (message.role === 'system') {
                if (String(message.content || '').trim()) {
                    systemParts.push(String(message.content));
                }
                continue;
            }
            conversation.push({
                role: message.role === 'assistant' ? 'assistant' : 'user',
                content: [{ type: 'text', text: String(message.content || '') }],
            });
        }

        return {
            ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
            messages: conversation.length > 0
                ? conversation
                : [{ role: 'user', content: [{ type: 'text', text: '' }] }],
        };
    }

    private extractMessageContent(data: any): string {
        const blocks = Array.isArray(data?.content) ? data.content : [];
        return blocks
            .map((block: any) => (block?.type === 'text' ? String(block?.text || '') : ''))
            .join('')
            .trim();
    }

    async request(req: LLMRequest): Promise<LLMResponse> {
        const split = this.splitMessages(req.messages);
        const body: Record<string, any> = this.withCustomParams({
            model: req.model || this.model,
            max_tokens: req.maxTokens ?? 2048,
            messages: split.messages,
            ...(split.system ? { system: split.system } : {}),
            ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
            ...(req.jsonMode && req.schema
                ? {
                    output_config: {
                        format: {
                            type: 'json_schema',
                            schema: req.schema,
                        },
                    },
                }
                : {}),
        });

        const response = await this.fetchImpl(`${this.baseUrl}/messages`, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
            signal: req.signal,
        });

        if (!response.ok) {
            await response.text().catch(() => undefined);
            throw providerHttpError('Claude', response.status);
        }

        const data = await response.json();
        const promptTokens = Number(data?.usage?.input_tokens ?? 0);
        const completionTokens = Number(data?.usage?.output_tokens ?? 0);

        return {
            content: this.extractMessageContent(data),
            usage: {
                promptTokens,
                completionTokens,
                totalTokens: promptTokens + completionTokens,
            },
            finishReason: data?.stop_reason,
            debugRequest: {
                providerKind: this.kind,
                apiType: this.apiType,
                resourceId: this.id,
                requestFormat: 'claude_messages',
                payload: body,
            },
        };
    }

    async embed(_req: EmbedRequest): Promise<EmbedResponse> {
        throw new Error('ClaudeProvider 不支持 embedding');
    }

    async rerank(_req: RerankRequest): Promise<RerankResponse> {
        throw new Error('ClaudeProvider 不支持 rerank');
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
            const res = await this.fetchImpl(`${this.baseUrl}/models`, {
                method: 'GET',
                headers: this.buildHeaders(),
            });

            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return { ok: false, models: [], message: `获取模型列表失败 (${res.status})`, detail: text };
            }

            const json = await res.json();
            const list = Array.isArray(json?.data) ? json.data : [];
            const models = list.map((m: any, index: number) => {
                const rawId = m?.id ?? m?.name ?? m?.model;
                const id = String(rawId ?? `model-${index + 1}`);
                return { id, label: String(m?.display_name ?? m?.id ?? m?.name ?? id) };
            });

            return { ok: true, models, message: `共 ${models.length} 个模型` };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            return { ok: false, models: [], message: `网络错误: ${msg}`, errorCode: 'NETWORK_ERROR', detail: msg };
        }
    }
}
