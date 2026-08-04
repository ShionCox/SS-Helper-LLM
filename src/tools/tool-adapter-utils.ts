import { createSSHelperError, type NormalizedToolCall, type PlainData } from '@ss-helper/sdk';
import { parseJsonOutput } from '../schema/validator';
import { attachProviderResponseDebug } from '../providers/provider-response-diagnostics';

export interface ProviderToolNameAliases {
    readonly providerByCanonical: Readonly<Record<string, string>>;
    readonly canonicalByProvider: Readonly<Record<string, string>>;
}

export function createProviderToolNameAliases(canonicalNames: readonly string[]): ProviderToolNameAliases {
    const providerByCanonical: Record<string, string> = {};
    const canonicalByProvider: Record<string, string> = {};
    canonicalNames.forEach((canonical, index) => {
        const prefix = `ssht_${index}_`;
        const safeStem = canonical.replace(/[^A-Za-z0-9_-]/gu, '_');
        const provider = `${prefix}${safeStem}`.slice(0, 64);
        providerByCanonical[canonical] = provider;
        canonicalByProvider[provider] = canonical;
    });
    return Object.freeze({
        providerByCanonical: Object.freeze(providerByCanonical),
        canonicalByProvider: Object.freeze(canonicalByProvider),
    });
}

export function providerToolName(aliases: ProviderToolNameAliases, canonical: string): string {
    return aliases.providerByCanonical[canonical] ?? '';
}

export function canonicalToolName(aliases: ProviderToolNameAliases, provider: string): string {
    return aliases.canonicalByProvider[provider] ?? '';
}

export function parseArguments(raw: unknown, path: string): PlainData {
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return raw as PlainData;
    if (typeof raw !== 'string') return invalid(path, 'a JSON object or encoded JSON object');
    try {
        const value = JSON.parse(raw);
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(path, 'one JSON object');
        return value as PlainData;
    } catch {
        return invalid(path, 'complete JSON arguments');
    }
}

export function parseFinalOutput(raw: unknown, stage: string): PlainData {
    const result = parseJsonOutput(raw as string | object);
    if (!result.ok) {
        throw attachProviderResponseDebug(
            createSSHelperError(typeof raw === 'string' && raw.trim().length === 0 ? 'STRUCTURED_OUTPUT_EMPTY' : 'INVALID_JSON', { stage }),
            typeof raw === 'string' ? { rawResponseText: raw } : { providerResponse: raw },
        );
    }
    return result.data as PlainData;
}

export function validateCalls(calls: readonly NormalizedToolCall[], allowedNames: ReadonlySet<string>): readonly NormalizedToolCall[] {
    if (calls.length === 0) return calls;
    const callIds = new Set<string>();
    for (const call of calls) {
        if (!call.callId || callIds.has(call.callId) || !allowedNames.has(call.name)) {
            throw createSSHelperError('LLM_TOOL_CALL_INVALID', {
                stage: 'llm.tools.adapter.parse',
            });
        }
        callIds.add(call.callId);
    }
    return calls;
}

export function estimateJsonBytes(value: unknown): number {
    try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
    catch {
        throw createSSHelperError('LLM_TOOL_CONTEXT_INTEGRITY_FAILED', {
            stage: 'llm.tools.adapter.state_size',
        });
    }
}

export function invalid(path: string, expected: string): never {
    throw createSSHelperError('LLM_TOOL_CALL_INVALID', {
        stage: 'llm.tools.adapter.parse',
        path,
        keyword: 'protocol',
        expected,
    });
}

export function usageFromOpenAi(value: Record<string, unknown>): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined {
    const usage = value.usage;
    if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return undefined;
    const record = usage as Record<string, unknown>;
    const inputTokens = Number(record.input_tokens ?? record.prompt_tokens);
    const outputTokens = Number(record.output_tokens ?? record.completion_tokens);
    const totalTokens = Number(record.total_tokens);
    const result = {
        ...(Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? { inputTokens } : {}),
        ...(Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? { outputTokens } : {}),
        ...(Number.isSafeInteger(totalTokens) && totalTokens >= 0 ? { totalTokens } : {}),
    };
    return Object.keys(result).length > 0 ? result : undefined;
}
