import { buildStructuredOutputSystemInstruction } from './structured-output';
import { isStrictJsonSchemaCompatible } from './strict-json-schema';
import { createSSHelperError } from '@ss-helper/sdk';

export type StructuredOutputVendor = 'openai' | 'deepseek' | 'gemini' | 'claude' | 'unknown';
export type StructuredOutputTransport = 'json_schema' | 'json_object' | 'tavern_json_schema' | 'prompt_only';
export type StructuredOutputDetectionEvidence = 'manual' | 'tavern_source' | 'unknown';

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

const sourceVendor = (value?: string): StructuredOutputVendor | undefined => {
    const normalized = String(value || '').trim().toLowerCase();
    const sourceMap: Readonly<Record<string, StructuredOutputVendor>> = {
        openai: 'openai', deepseek: 'deepseek', gemini: 'gemini', google: 'gemini',
        claude: 'claude', anthropic: 'claude',
    };
    return sourceMap[normalized];
};

export function structuredOutputIdentityFromSource(input: {
    readonly manualVendor?: Exclude<StructuredOutputVendor, 'unknown'> | 'auto';
    readonly provider?: string;
    readonly model?: string;
}): StructuredOutputIdentity {
    const manual = input.manualVendor;
    if (manual && manual !== 'auto') {
        return { vendor: manual, evidence: 'manual', confidence: 'high', ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}) };
    }
    const fromSource = sourceVendor(input.provider);
    if (fromSource) return { vendor: fromSource, evidence: 'tavern_source', confidence: 'high', ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}) };
    return { vendor: 'unknown', evidence: 'unknown', confidence: 'low', ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}) };
}

export function createStructuredOutputPlan(input: {
    readonly identity: StructuredOutputIdentity;
    readonly spec: StructuredOutputSpec;
    readonly capability: {
        readonly transports: readonly StructuredOutputTransport[];
        readonly preferred: StructuredOutputTransport;
    };
    readonly strictSchemaUnavailable?: boolean;
    readonly requireNative?: boolean;
}): StructuredOutputPlan {
    const strictSchemaCompatible = isStrictJsonSchemaCompatible(input.spec.schema);
    const declared = new Set(input.capability.transports);
    let transport = input.capability.preferred;
    if (!declared.has(transport)) transport = 'prompt_only';
    if (transport === 'json_schema' && (!strictSchemaCompatible || input.strictSchemaUnavailable)) {
        transport = declared.has('json_object') ? 'json_object' : 'prompt_only';
    }
    if (!declared.has(transport)) transport = 'prompt_only';
    if (input.requireNative && transport === 'prompt_only') {
        const native = (['json_schema', 'json_object', 'tavern_json_schema'] as const).find((candidate) => declared.has(candidate) && (candidate !== 'json_schema' || (strictSchemaCompatible && !input.strictSchemaUnavailable)));
        if (!native) throw createSSHelperError('LLM_TASK_REQUIREMENT_UNSUPPORTED', { stage: 'llm.structured.requirements', expected: 'nativeStructured' });
        transport = native;
    }
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
