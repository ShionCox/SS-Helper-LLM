import type { GenerationRequest, GenerationResult } from '@ss-helper/sdk';
import { inferReasonCode } from '../schema/error-codes';
import type { LLMProvider, LLMRequest, LLMResponse, ProviderConnectionResult, ProviderModelListResult } from './types';

export interface TavernGenerationAdapter {
    available(): Promise<boolean>;
    models(): Promise<readonly string[]>;
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
        const result = await this.generation.generate({ prompt, model: req.model, quiet: true });
        return { content: result.text, finishReason: 'stop', debugRequest: { providerKind: this.kind, resourceId: this.id } };
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
}
