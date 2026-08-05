import { createSSHelperError, type LlmReasoningEffort, type LlmReasoningMode, type LlmReasoningPolicy, type ProviderToolDialect } from '@ss-helper/sdk';

export const DEFAULT_REASONING_POLICY: LlmReasoningPolicy = Object.freeze({ mode: 'provider_default', effort: 'provider_default' });

export type ReasoningProvider = 'openai' | 'claude' | 'gemini' | 'deepseek' | 'kimi' | 'glm' | 'xai' | 'generic' | 'tavern';
export type ReasoningExecution = 'completion' | 'structured' | 'tool_turn';
export type ReasoningTransport = 'openai_chat' | 'openai_responses' | 'claude_adaptive' | 'claude_budget' | 'gemini_level' | 'gemini_budget' | 'thinking_object' | 'tavern';

export interface ReasoningCompileContext {
    readonly provider: ReasoningProvider;
    readonly dialect?: ProviderToolDialect;
    readonly policy?: LlmReasoningPolicy;
    readonly execution: ReasoningExecution;
    readonly transport?: ReasoningTransport;
}

export function normalizeReasoningPolicy(policy?: LlmReasoningPolicy): LlmReasoningPolicy {
    const resolved = policy ?? DEFAULT_REASONING_POLICY;
    if (!['provider_default', 'enabled', 'disabled'].includes(resolved.mode)
        || !['provider_default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(resolved.effort)) {
        throw createSSHelperError('LLM_REASONING_CONFIGURATION_UNSUPPORTED', { stage: 'llm.reasoning.policy' });
    }
    if (resolved.mode === 'disabled' && resolved.effort !== 'provider_default') {
        throw createSSHelperError('LLM_REASONING_CONFIGURATION_UNSUPPORTED', { stage: 'llm.reasoning.policy' });
    }
    return resolved;
}

function explicitEffort(policy: LlmReasoningPolicy): LlmReasoningEffort | undefined {
    return policy.effort === 'provider_default' ? undefined : policy.effort;
}

function mapEffort(provider: ReasoningProvider, effort: LlmReasoningEffort): string {
    if (effort === 'provider_default') return 'high';
    if (provider === 'deepseek') return effort === 'max' || effort === 'xhigh' ? 'max' : 'high';
    if (provider === 'kimi') return effort === 'minimal' || effort === 'low' ? 'low' : effort === 'medium' || effort === 'high' ? 'high' : 'max';
    if (provider === 'gemini') return effort === 'minimal' || effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'high';
    if (provider === 'xai') return effort === 'minimal' ? 'low' : effort === 'xhigh' || effort === 'max' ? 'high' : effort;
    return effort;
}

function thinkingObject(policy: LlmReasoningPolicy): Record<string, unknown> | undefined {
    if (policy.mode === 'provider_default' && policy.effort === 'provider_default') return undefined;
    if (policy.mode === 'disabled') return { type: 'disabled' };
    if (policy.mode === 'enabled') return { type: 'enabled' };
    return undefined;
}

/** Provider-native request fields for direct LLM requests and tool adapters. */
export function compileReasoningFields(context: ReasoningCompileContext): Record<string, unknown> {
    const policy = normalizeReasoningPolicy(context.policy);
    const effort = explicitEffort(policy);
    const mappedEffort = effort === undefined ? undefined : mapEffort(context.provider, effort);
    if (context.provider === 'generic' || context.provider === 'tavern') return {};
    if (context.provider === 'xai' && policy.mode === 'disabled') {
        throw createSSHelperError('LLM_REASONING_CONFIGURATION_UNSUPPORTED', { stage: 'llm.reasoning.compile', providerKind: context.provider });
    }
    if (context.provider === 'openai') {
        if (policy.mode === 'provider_default' && effort === undefined) return {};
        if (context.transport === 'openai_responses' || context.dialect === 'openai_responses') {
            return { reasoning: { effort: policy.mode === 'disabled' ? 'none' : mappedEffort ?? 'high' } };
        }
        return { reasoning_effort: policy.mode === 'disabled' ? 'none' : mappedEffort ?? 'high' };
    }
    if (context.provider === 'claude') {
        if (policy.mode === 'provider_default' && effort === undefined) return {};
        if (policy.mode === 'disabled') return { thinking: { type: 'disabled' } };
        return {
            thinking: { type: context.transport === 'claude_budget' ? 'enabled' : 'adaptive' },
            ...(mappedEffort === undefined ? {} : { output_config: { effort: mappedEffort } }),
        };
    }
    if (context.provider === 'gemini') {
        if (policy.mode === 'provider_default' && effort === undefined) return {};
        const thinkingConfig = policy.mode === 'disabled'
            ? { thinkingBudget: 0 }
            : context.transport === 'gemini_budget'
                ? { thinkingBudget: policy.effort === 'provider_default' ? -1 : ({ minimal: 512, low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 24576 }[policy.effort] ?? 8192) }
                : { thinkingLevel: policy.effort === 'provider_default' ? 'HIGH' : mappedEffort?.toUpperCase() ?? 'HIGH' };
        return { thinkingConfig };
    }
    if (context.provider === 'xai') {
        return { ...(mappedEffort === undefined ? {} : { reasoning_effort: mappedEffort }) };
    }
    // DeepSeek V4 treats omitted reasoning fields as an agent-sensitive
    // default: complex tool requests may be promoted to `max`, consuming the
    // Beta endpoint's 8K output allowance before the first tool call.  The
    // documented provider default is thinking enabled at `high`; send that
    // equivalent explicitly so provider-default remains semantically stable
    // while tool turns are deterministic and cannot truncate before a call.
    if (context.provider === 'deepseek' && policy.mode !== 'disabled' && effort === undefined) {
        return { thinking: { type: 'enabled' }, reasoning_effort: 'high' };
    }
    const thinking = thinkingObject(policy);
    return {
        ...(thinking === undefined ? {} : { thinking }),
        ...(mappedEffort === undefined ? {} : { reasoning_effort: mappedEffort }),
    };
}

/** Canonical fields understood by the host source/model mapper. */
export function compileTavernReasoning(policy?: LlmReasoningPolicy): { readonly includeReasoning?: boolean; readonly reasoningEffort?: string } {
    const normalized = normalizeReasoningPolicy(policy);
    return {
        ...(normalized.mode === 'provider_default' ? {} : { includeReasoning: normalized.mode === 'enabled' }),
        ...(normalized.effort === 'provider_default' ? {} : { reasoningEffort: normalized.effort === 'minimal' ? 'min' : normalized.effort === 'xhigh' ? 'max' : normalized.effort }),
    };
}
