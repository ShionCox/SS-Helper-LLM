import { createSSHelperError, readSSHelperFailure, type LlmReasoningPolicy, type LlmToolDefinition, type ProviderPrivacyPolicy, type VerifiedToolCapabilities } from '@ss-helper/sdk';
import type { ProviderToolAdapter } from './tool-adapter';
import { ToolSchemaCompiler } from './tool-schema-compiler';
import { TOOL_CAPABILITY_FAILURE_TTL_MS, TOOL_CAPABILITY_SUCCESS_TTL_MS, stableToolDigest } from './tool-capability-cache';

export const TOOL_CAPABILITY_PROBE_VERSION = 6;
export const TOOL_CAPABILITY_PROBE_MAX_TOKENS = 512;

const PROBE_TOOL: LlmToolDefinition = Object.freeze({
    name: 'ss_helper_tool_probe',
    description: 'Call this read-only echo tool twice in the same assistant turn, once for each allowed value.',
    strict: true,
    parameters: Object.freeze({
        type: 'object',
        properties: { value: { type: 'string', enum: ['probe-a', 'probe-b'] } },
        required: ['value'],
        additionalProperties: false,
    }),
});
const NON_STRICT_PROBE_TOOL: LlmToolDefinition = Object.freeze({ ...PROBE_TOOL, strict: false });

export interface ToolCapabilityProbeInput {
    readonly resourceId: string;
    readonly model: string;
    readonly requestId: string;
    readonly adapter: ProviderToolAdapter;
    readonly privacyPolicy: ProviderPrivacyPolicy;
    readonly signal: AbortSignal;
    readonly beforeRequest?: () => Promise<void>;
    readonly reasoning?: LlmReasoningPolicy;
}

export class ToolCapabilityProbe {
    private readonly compiler = new ToolSchemaCompiler();

    async verify(input: ToolCapabilityProbeInput, now = Date.now()): Promise<VerifiedToolCapabilities> {
        let state: unknown;
        const optionalFailures: import('@ss-helper/sdk').SSHelperFailureContext[] = [];
        const verified = (parallelToolCalls: boolean, transport: 'stream' | 'non_stream', strictToolSchema: VerifiedToolCapabilities['strictToolSchema'], reasoningReplay: VerifiedToolCapabilities['reasoningReplay']): VerifiedToolCapabilities => ({
            status: 'verified',
            resourceId: input.resourceId,
            model: input.model,
            dialect: input.adapter.dialect,
            parallelToolCalls,
            streamingToolCalls: transport === 'stream'
                ? 'incremental'
                : input.adapter.toolStreamCapability === 'unsupported' ? 'unsupported' : 'whole_call',
            strictToolSchema,
            reasoningReplay,
            verifiedAt: now,
            expiresAt: now + TOOL_CAPABILITY_SUCCESS_TTL_MS,
            probeVersion: TOOL_CAPABILITY_PROBE_VERSION,
            capabilityDigest: stableToolDigest([input.resourceId, input.model, input.adapter.dialect, input.adapter.version, TOOL_CAPABILITY_PROBE_VERSION].join('\0')),
            ...(optionalFailures.length ? { optionalFailures } : {}),
        });
        try {
            const strictCandidate = input.adapter.strictToolSchemaCapability
                ?? (input.adapter.dialect === 'openai_responses' || input.adapter.dialect === 'anthropic_messages' ? 'native' : 'unsupported');
            const basicProbeTool = strictCandidate === 'beta' ? NON_STRICT_PROBE_TOOL : PROBE_TOOL;
            const tools = this.compiler.compile([basicProbeTool], input.adapter.dialect);
            await input.beforeRequest?.();
            const first = await input.adapter.start({
                resourceId: input.resourceId,
                model: input.model,
                messages: [{ role: 'system', content: 'Call the provided probe tool twice in one assistant turn: value="probe-a" and value="probe-b". After both results, return exactly the JSON object {"ok":true}.' }, { role: 'user', content: 'Run the two-call tool capability probe now.' }],
                tools,
                outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
                privacyPolicy: input.privacyPolicy,
                // Thinking-capable chat models can spend part of the completion
                // budget before emitting the second parallel call. A 128-token
                // probe was observed truncating the second JSON argument.
                maxTokens: TOOL_CAPABILITY_PROBE_MAX_TOKENS,
                toolChoice: 'required',
                ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
                signal: input.signal,
            });
            state = first.adapterState;
            if (first.state !== 'tool_calls' || first.calls.length < 1 || first.calls.length > 2 || first.calls.some((call) => call.name !== PROBE_TOOL.name)) throw createSSHelperError('LLM_MODEL_PROBE_FAILED', { stage: 'llm.tools.capability_probe.first', resourceId: input.resourceId, model: input.model });
            for (const call of first.calls) this.compiler.validateArguments(PROBE_TOOL, call.arguments);
            const values = first.calls.map((call) => String((call.arguments as Record<string, unknown>).value ?? ''));
            const parallelToolCalls = new Set(values).size === values.length && first.calls.length === 2;
            await input.beforeRequest?.();
            let second: Awaited<ReturnType<ProviderToolAdapter['continue']>> | undefined;
            try {
                second = await input.adapter.continue(first.adapterState, first.calls.map((call) => ({
                    callId: call.callId,
                    name: PROBE_TOOL.name,
                    ok: true,
                    content: { echoed: String((call.arguments as Record<string, unknown>).value) },
                })), input.signal);
                state = second.adapterState;
                if (second.state !== 'final' || (second.output as Record<string, unknown>).ok !== true) {
                    throw createSSHelperError('LLM_MODEL_PROBE_FAILED', { stage: 'llm.tools.capability_probe.continue', resourceId: input.resourceId, model: input.model });
                }
            } catch (error) {
                if (input.signal.aborted) throw error;
                if (input.adapter.dialect === 'deepseek_chat') throw error;
                const failure = readSSHelperFailure(error, { reasonCode: 'LLM_MODEL_PROBE_FAILED', stage: 'llm.tools.capability_probe.continue', requestId: input.requestId, providerKind: input.adapter.dialect, resourceId: input.resourceId, model: input.model })!;
                optionalFailures.push(failure);
            }
            let strictToolSchema: VerifiedToolCapabilities['strictToolSchema'] = strictCandidate === 'native' ? 'native' : 'unsupported';
            if (strictCandidate === 'beta') {
                let strictState: unknown;
                try {
                    await input.beforeRequest?.();
                    const strict = await input.adapter.start({
                        resourceId: input.resourceId,
                        model: input.model,
                        messages: [{ role: 'system', content: 'Call the provided strict probe tool once with value="probe-a". After its result return the JSON object {"ok":true}.' }, { role: 'user', content: 'Run the strict tool Schema probe now.' }],
                        tools: this.compiler.compile([PROBE_TOOL], input.adapter.dialect),
                        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
                        privacyPolicy: input.privacyPolicy,
                        maxTokens: TOOL_CAPABILITY_PROBE_MAX_TOKENS,
                        toolChoice: 'required',
                        ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
                        signal: input.signal,
                    });
                    strictState = strict.adapterState;
                    if (strict.state !== 'tool_calls' || strict.calls.length < 1 || strict.calls.some((call) => call.name !== PROBE_TOOL.name)) {
                        throw createSSHelperError('LLM_MODEL_PROBE_FAILED', { stage: 'llm.tools.capability_probe.strict', resourceId: input.resourceId, model: input.model });
                    }
                    for (const call of strict.calls) this.compiler.validateArguments(PROBE_TOOL, call.arguments);
                    strictToolSchema = 'beta';
                } catch (error) {
                    if (input.signal.aborted) throw error;
                    optionalFailures.push(readSSHelperFailure(error, {
                        reasonCode: 'LLM_MODEL_PROBE_FAILED', stage: 'llm.tools.capability_probe.strict', requestId: input.requestId,
                        providerKind: input.adapter.dialect, resourceId: input.resourceId, model: input.model,
                    })!);
                    strictToolSchema = 'unknown';
                } finally {
                    if (strictState !== undefined) input.adapter.dispose(strictState);
                }
            }
            const reasoningReplay = input.adapter.dialect === 'deepseek_chat' || input.adapter.dialect === 'glm_chat' ? 'required' : input.adapter.dialect === 'openai_responses' || input.adapter.dialect === 'gemini_interactions' ? 'opaque' : 'none';
            return Object.freeze(verified(parallelToolCalls, first.transport === 'stream' || second?.transport === 'stream' ? 'stream' : 'non_stream', strictToolSchema, reasoningReplay));
        } catch (error) {
            if (input.signal.aborted) {
                throw createSSHelperError('REQUEST_ABORTED', {
                    stage: 'llm.tools.capability_probe',
                    requestId: input.requestId,
                    resourceId: input.resourceId,
                    model: input.model,
                });
            }
            const failure = readSSHelperFailure(error, {
                reasonCode: 'LLM_MODEL_PROBE_FAILED',
                stage: 'llm.tools.capability_probe',
                requestId: input.requestId,
                providerKind: input.adapter.dialect,
                resourceId: input.resourceId,
                model: input.model,
            })!;
            return Object.freeze({
                status: 'failed',
                resourceId: input.resourceId,
                model: input.model,
                dialect: input.adapter.dialect,
                parallelToolCalls: false,
                streamingToolCalls: 'unknown',
                strictToolSchema: 'unknown',
                reasoningReplay: 'none',
                verifiedAt: now,
                expiresAt: now + TOOL_CAPABILITY_FAILURE_TTL_MS,
                probeVersion: TOOL_CAPABILITY_PROBE_VERSION,
                failure,
            });
        } finally {
            if (state !== undefined) input.adapter.dispose(state);
        }
    }
}
