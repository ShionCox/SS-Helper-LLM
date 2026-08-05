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
    ProviderModelListResult, ProviderFetch, ProviderResponseDiagnostics,
} from './types';
import { providerConnectionFailure, providerHttpErrorFromResponse, providerModelListFailure } from './provider-errors';
import type { StructuredOutputIdentity } from '../schema/structured-output-plan';
import { AnthropicMessagesToolAdapter } from '../tools/anthropic-messages-tool-adapter';
import { compileReasoningFields } from './reasoning-policy';
import type { ProviderToolAdapter } from '../tools/tool-adapter';
import { createSSHelperError } from '@ss-helper/sdk';
import { parseSseJson } from './sse';
import { responseDiagnostics } from './provider-response-diagnostics';

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
    private fetchImpl: ProviderFetch;
    private readonly structuredOutputIdentity: StructuredOutputIdentity;
    private readonly streamingEnabled: boolean;

    constructor(config: {
        id: string;
        apiKey: string;
        baseUrl?: string;
        model?: string;
        anthropicVersion?: string;
        customParams?: Record<string, unknown>;
        fetchImpl?: ProviderFetch;
        streamingEnabled?: boolean;
    }) {
        this.id = config.id;
        this.apiKey = config.apiKey;
        this.baseUrl = (config.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
        if (!config.model?.trim()) throw createSSHelperError('MODEL_NOT_FOUND', { stage: 'llm.provider.configure.model', resourceId: config.id });
        this.model = config.model.trim();
        this.anthropicVersion = config.anthropicVersion || '2023-06-01';
        this.capabilities = {
            chat: true,
            json: true,
            tools: true,
            embeddings: false,
            rerank: false,
            structuredOutput: { transports: ['json_schema', 'prompt_only'], preferred: 'json_schema' },
        };
        this.fetchImpl = config.fetchImpl ?? fetch;
        this.structuredOutputIdentity = { vendor: 'claude', evidence: 'manual', confidence: 'high', model: this.model };
        this.streamingEnabled = config.streamingEnabled !== false;
        this.customParams = config.customParams && typeof config.customParams === 'object' && !Array.isArray(config.customParams)
            ? { ...config.customParams }
            : {};
    }

    getStructuredOutputIdentity(model?: string): StructuredOutputIdentity {
        return model && model !== this.structuredOutputIdentity.model ? { ...this.structuredOutputIdentity, model } : this.structuredOutputIdentity;
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

    private assembleMessageStream(chunks: readonly Record<string, unknown>[]): Record<string, unknown> {
        const complete = chunks.find((chunk) => Array.isArray(chunk.content));
        if (complete) return complete;
        const blocks = new Map<number, Record<string, unknown>>();
        const partialJson = new Map<number, string>();
        let inputTokens = 0;
        let outputTokens = 0;
        let stopReason: unknown;
        for (const chunk of chunks) {
            const event = String(chunk.__event ?? chunk.type ?? '');
            if (event === 'error') throw createSSHelperError('PROVIDER_RESPONSE_INVALID', { stage: 'llm.provider.claude_stream.error', resourceId: this.id });
            const message = chunk.message && typeof chunk.message === 'object' && !Array.isArray(chunk.message) ? chunk.message as Record<string, unknown> : undefined;
            const messageUsage = message?.usage as Record<string, unknown> | undefined;
            if (messageUsage) inputTokens = Number(messageUsage.input_tokens ?? inputTokens);
            const index = Number(chunk.index);
            const block = chunk.content_block && typeof chunk.content_block === 'object' && !Array.isArray(chunk.content_block) ? chunk.content_block as Record<string, unknown> : undefined;
            if (block && Number.isInteger(index)) blocks.set(index, { ...block });
            const delta = chunk.delta && typeof chunk.delta === 'object' && !Array.isArray(chunk.delta) ? chunk.delta as Record<string, unknown> : undefined;
            if (delta && Number.isInteger(index)) {
                const current = blocks.get(index) ?? {};
                if (delta.type === 'text_delta' && typeof delta.text === 'string') current.text = `${String(current.text ?? '')}${delta.text}`;
                if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') partialJson.set(index, `${partialJson.get(index) ?? ''}${delta.partial_json}`);
                blocks.set(index, current);
            }
            if (event === 'content_block_stop' && Number.isInteger(index) && partialJson.has(index)) {
                try { blocks.set(index, { ...(blocks.get(index) ?? {}), input: JSON.parse(partialJson.get(index)!) }); }
                catch { throw createSSHelperError('PROVIDER_RESPONSE_INVALID', { stage: 'llm.provider.claude_stream.tool_json', resourceId: this.id }); }
            }
            if (delta?.stop_reason !== undefined) stopReason = delta.stop_reason;
            const usage = chunk.usage && typeof chunk.usage === 'object' && !Array.isArray(chunk.usage) ? chunk.usage as Record<string, unknown> : undefined;
            if (usage?.output_tokens !== undefined) outputTokens = Number(usage.output_tokens);
        }
        if (blocks.size === 0) throw createSSHelperError('PROVIDER_RESPONSE_INVALID', { stage: 'llm.provider.claude_stream.empty', resourceId: this.id });
        return { content: [...blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => block), usage: { input_tokens: inputTokens, output_tokens: outputTokens }, stop_reason: stopReason };
    }

    private async sendMessageStream(body: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 180_000): Promise<{ data: Record<string, unknown>; diagnostics: ProviderResponseDiagnostics }> {
        const response = await this.fetchImpl(`${this.baseUrl}/messages`, {
            method: 'POST', headers: this.buildHeaders(), body: JSON.stringify({ ...body, stream: true }),
            signal, timeoutMs, idleTimeoutMs: 30_000,
        });
        if (!response.ok) throw await providerHttpErrorFromResponse('Claude stream', response);
        const text = await response.text();
        const chunks = parseSseJson(text, 'llm.provider.claude_stream.parse', this.id);
        return { data: this.assembleMessageStream(chunks), diagnostics: responseDiagnostics(response, text, { streamed: true, streamEventCount: chunks.length }) };
    }

    createToolAdapter(): ProviderToolAdapter {
        return new AnthropicMessagesToolAdapter({
            resourceId: this.id,
            defaultModel: this.model,
            send: async (body, signal) => {
                const response = await this.fetchImpl(`${this.baseUrl}/messages`, {
                    method: 'POST',
                    headers: this.buildHeaders(),
                    body: JSON.stringify(this.withCustomParams(body)),
                    signal,
                });
                if (!response.ok) throw await providerHttpErrorFromResponse('Claude', response);
                return await response.json() as Record<string, unknown>;
            },
            ...(this.streamingEnabled ? { sendStream: async (body: Record<string, unknown>, signal?: AbortSignal) => [(await this.sendMessageStream(this.withCustomParams(body), signal)).data] } : {}),
        });
    }

    async request(req: LLMRequest): Promise<LLMResponse> {
        const split = this.splitMessages(req.messages);
        const reasoningFields = compileReasoningFields({ provider: 'claude', dialect: 'anthropic_messages', policy: req.reasoning, execution: req.structuredOutput === undefined ? 'completion' : 'structured' });
        const reasoningOutputConfig = reasoningFields.output_config && typeof reasoningFields.output_config === 'object' && !Array.isArray(reasoningFields.output_config)
            ? reasoningFields.output_config as Record<string, unknown> : {};
        const schemaOutputConfig = req.structuredOutput?.transport === 'json_schema'
            ? {
                format: {
                    type: 'json_schema',
                    schema: req.structuredOutput.spec.schema,
                },
            } : {};
        const body: Record<string, any> = this.withCustomParams({
            model: req.model || this.model,
            max_tokens: req.maxTokens ?? 2048,
            messages: split.messages,
            ...(split.system ? { system: split.system } : {}),
            ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
            ...reasoningFields,
            ...(Object.keys({ ...reasoningOutputConfig, ...schemaOutputConfig }).length > 0
                ? { output_config: { ...reasoningOutputConfig, ...schemaOutputConfig } }
                : {}),
            stream: this.streamingEnabled,
        });

        const transport = this.streamingEnabled
            ? await this.sendMessageStream(body, req.signal, req.timeoutMs)
            : await (async () => {
                const response = await this.fetchImpl(`${this.baseUrl}/messages`, {
                    method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(body), signal: req.signal, timeoutMs: req.timeoutMs,
                });
                if (!response.ok) throw await providerHttpErrorFromResponse('Claude', response);
                const data = await response.json();
                return { data, diagnostics: responseDiagnostics(response, data, { streamed: false }) };
            })();
        const data: any = transport.data;
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
            diagnostics: transport.diagnostics,
            ...(req.structuredOutput === undefined ? {} : { structuredOutput: { plannedTransport: req.structuredOutput.transport, actualTransport: req.structuredOutput.transport } }),
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
            const list = Array.isArray(json?.data) ? json.data : [];
            const models = list.map((m: any, index: number) => {
                const rawId = m?.id ?? m?.name ?? m?.model;
                const id = String(rawId ?? `model-${index + 1}`);
                return { id, label: String(m?.display_name ?? m?.id ?? m?.name ?? id) };
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
