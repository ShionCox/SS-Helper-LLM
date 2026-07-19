import type { GenerationRequest, GenerationResult } from '@ss-helper/sdk';
import { inferReasonCode } from '../schema/error-codes';
import { detectStructuredOutputIdentity, type StructuredOutputIdentity } from '../schema/structured-output-plan';
import type { LLMProvider, LLMRequest, LLMResponse, ProviderConnectionResult, ProviderModelListResult } from './types';

export interface TavernGenerationAdapter {
    available(): Promise<boolean>;
    models(): Promise<readonly string[]>;
    current(): Promise<{ readonly provider?: string; readonly model?: string }>;
    generate(request: GenerationRequest): Promise<GenerationResult>;
    test(request: GenerationRequest): Promise<GenerationResult>;
}

export class TavernProvider implements LLMProvider {
    id: string;
    kind: 'tavern' = 'tavern';
    capabilities = { chat: true, json: true, tools: false, embeddings: false };

    constructor(config: { id: string; generation?: TavernGenerationAdapter }) {
        this.id = config.id;
        this.generation = config.generation;
    }

    private readonly generation?: TavernGenerationAdapter;

    async request(req: LLMRequest): Promise<LLMResponse> {
        if (!this.generation) {
            const error = new Error('Core HostPort generation capability is not configured') as Error & { reasonCode?: string };
            error.reasonCode = inferReasonCode(error.message);
            throw error;
        }
        const prompt = req.messages.map((message) => `${message.role}: ${message.content}`).join('\n');
        const model = typeof req.model === 'string' ? req.model.trim() : '';
        const request: GenerationRequest = {
            prompt,
            quiet: true,
            ...(req.structuredOutput?.transport === 'prompt_only' ? { contextMode: 'isolated' as const } : {}),
            ...(model ? { model } : {}),
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
            const hostError = error as Error & { code?: string };
            if (hostError.code === 'BRIDGE_CORRUPTED' || hostError.message === 'The Tavern host adapter failed') {
                const diagnostic = new Error('酒馆生成调用失败：当前连接或模型后端拒绝了请求') as Error & { reasonCode?: string };
                diagnostic.reasonCode = 'provider_unavailable';
                throw diagnostic;
            }
            throw error;
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

    async testConnection(): Promise<ProviderConnectionResult> {
        if (!this.generation) return { ok: false, message: 'Core HostPort generation capability is not configured' };
        const startedAt = Date.now();
        try {
            const result = await this.generation.test({ prompt: 'Reply with OK.', quiet: true });
            return { ok: true, message: '连接成功', model: result.model, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - startedAt };
        }
    }

    async listModels(): Promise<ProviderModelListResult> {
        if (!this.generation || !(await this.generation.available())) return { ok: false, models: [], message: '酒馆生成服务不可用' };
        const models = await this.generation.models();
        return { ok: true, models: models.map((id) => ({ id, label: id })), message: '读取成功' };
    }

    async getStructuredOutputIdentity(model?: string): Promise<StructuredOutputIdentity> {
        const current = this.generation ? await this.generation.current() : {};
        return detectStructuredOutputIdentity({ manualVendor: 'auto', provider: current.provider, model: model || current.model });
    }
}
