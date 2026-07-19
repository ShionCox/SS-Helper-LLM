import { buildStructuredOutputSystemInstruction } from './structured-output';
import { isStrictJsonSchemaCompatible } from './strict-json-schema';

export type StructuredOutputVendor = 'openai' | 'deepseek' | 'gemini' | 'claude' | 'unknown';
export type StructuredOutputTransport = 'json_schema' | 'json_object' | 'tavern_json_schema' | 'prompt_only';
export type StructuredOutputDetectionEvidence = 'manual' | 'tavern_source' | 'api_url' | 'model_name' | 'unknown';

export interface StructuredOutputIdentity {
    readonly vendor: StructuredOutputVendor;
    readonly evidence: StructuredOutputDetectionEvidence;
    readonly confidence: 'high' | 'medium' | 'low';
    readonly provider?: string;
    readonly model?: string;
}

export interface StructuredOutputSpec {
    readonly schema: object;
    readonly name: string;
}

export interface StructuredOutputPlan {
    readonly identity: StructuredOutputIdentity;
    readonly transport: StructuredOutputTransport;
    readonly spec: StructuredOutputSpec;
    readonly promptInstruction: string;
    readonly strictSchemaCompatible: boolean;
}

const modelVendor = (value?: string): StructuredOutputVendor | undefined => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return undefined;
    if (/(?:^|[/:_-])deepseek(?:[/:_-]|$)/u.test(normalized) || normalized.startsWith('deepseek')) return 'deepseek';
    if (/(?:^|[/:_-])(?:gpt|o[1-9]|chatgpt)(?:[/:_-]|$)/u.test(normalized) || normalized.startsWith('gpt-')) return 'openai';
    if (/(?:^|[/:_-])gemini(?:[/:_-]|$)/u.test(normalized) || normalized.startsWith('gemini')) return 'gemini';
    if (/(?:^|[/:_-])claude(?:[/:_-]|$)/u.test(normalized) || normalized.startsWith('claude')) return 'claude';
    return undefined;
};

const sourceVendor = (value?: string): StructuredOutputVendor | undefined => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return undefined;
    if (normalized.includes('deepseek')) return 'deepseek';
    if (normalized === 'openai' || normalized.includes('openrouter') || normalized.includes('openai')) return 'openai';
    if (normalized.includes('gemini') || normalized.includes('makersuite') || normalized.includes('google')) return 'gemini';
    if (normalized.includes('claude') || normalized.includes('anthropic')) return 'claude';
    return undefined;
};

export function detectStructuredOutputIdentity(input: {
    readonly manualVendor?: Exclude<StructuredOutputVendor, 'unknown'> | 'auto';
    readonly provider?: string;
    readonly baseUrl?: string;
    readonly model?: string;
}): StructuredOutputIdentity {
    const manual = input.manualVendor;
    if (manual && manual !== 'auto') {
        return { vendor: manual, evidence: 'manual', confidence: 'high', ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}) };
    }
    const fromSource = sourceVendor(input.provider);
    const providerIsAggregator = /openrouter|router|proxy|gateway|custom|generic/u.test(String(input.provider || '').toLowerCase());
    if (fromSource && !providerIsAggregator) return { vendor: fromSource, evidence: 'tavern_source', confidence: 'high', ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}) };
    const fromUrl = sourceVendor(input.baseUrl);
    const urlIsAggregator = /openrouter|router|proxy|gateway|custom|generic/u.test(String(input.baseUrl || '').toLowerCase());
    if (fromUrl && !urlIsAggregator) return { vendor: fromUrl, evidence: 'api_url', confidence: 'high', ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}) };
    const fromModel = modelVendor(input.model);
    if (fromModel) return { vendor: fromModel, evidence: 'model_name', confidence: 'medium', ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}) };
    if (fromSource) return { vendor: fromSource, evidence: 'tavern_source', confidence: 'medium', ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}) };
    if (fromUrl) return { vendor: fromUrl, evidence: 'api_url', confidence: 'medium', ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}) };
    return { vendor: 'unknown', evidence: 'unknown', confidence: 'low', ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}) };
}

export function createStructuredOutputPlan(input: {
    readonly providerKind: string;
    readonly identity: StructuredOutputIdentity;
    readonly spec: StructuredOutputSpec;
    readonly strictSchemaUnavailable?: boolean;
}): StructuredOutputPlan {
    const strictSchemaCompatible = isStrictJsonSchemaCompatible(input.spec.schema);
    const tavernSource = String(input.identity.provider || '').trim().toLowerCase();
    // 酒馆的 Custom 来源只是一个代理配置，并不能证明底层供应商支持
    // 酒馆的 jsonSchema 参数。模型名同样不足以证明这一点，因此 Custom 一律走
    // 无聊天上下文的 Schema Prompt 链路，避免角色卡或后端协议干扰结构化结果。
    const tavernRequiresPromptOnly = input.providerKind === 'tavern'
        && (tavernSource === 'custom' || input.identity.vendor === 'unknown');
    const transport: StructuredOutputTransport = input.providerKind === 'tavern'
        ? (tavernRequiresPromptOnly ? 'prompt_only' : 'tavern_json_schema')
        : input.identity.vendor === 'deepseek'
            ? 'json_object'
            : input.identity.vendor === 'openai'
                ? (strictSchemaCompatible && !input.strictSchemaUnavailable ? 'json_schema' : 'json_object')
                : input.identity.vendor === 'gemini' || input.identity.vendor === 'claude'
                    ? 'json_schema'
                    : 'prompt_only';
    return {
        identity: input.identity,
        transport,
        spec: input.spec,
        strictSchemaCompatible,
        promptInstruction: buildStructuredOutputSystemInstruction({ schema: input.spec.schema, name: input.spec.name }),
    };
}

export const withStructuredOutputInstruction = (
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    plan: StructuredOutputPlan,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> => {
    if (plan.transport === 'json_schema') return messages;
    const [first, ...rest] = messages;
    return first?.role === 'system'
        ? [{ ...first, content: `${first.content}\n\n${plan.promptInstruction}` }, ...rest]
        : [{ role: 'system', content: plan.promptInstruction }, ...messages];
};
