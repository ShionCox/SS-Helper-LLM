import { createSSHelperError, readSSHelperFailure, type LlmToolDefinition, type ProviderPrivacyPolicy, type VerifiedToolCapabilities } from '@ss-helper/sdk';
import type { ProviderToolAdapter } from './tool-adapter';
import { ToolSchemaCompiler } from './tool-schema-compiler';
import { TOOL_CAPABILITY_FAILURE_TTL_MS, TOOL_CAPABILITY_SUCCESS_TTL_MS, stableToolDigest } from './tool-capability-cache';

export const TOOL_CAPABILITY_PROBE_VERSION = 3;
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

export interface ToolCapabilityProbeInput {
    readonly resourceId: string;
    readonly model: string;
    readonly adapter: ProviderToolAdapter;
    readonly privacyPolicy: ProviderPrivacyPolicy;
    readonly signal: AbortSignal;
    readonly beforeRequest?: () => Promise<void>;
}

export class ToolCapabilityProbe {
    private readonly compiler = new ToolSchemaCompiler();

    async verify(input: ToolCapabilityProbeInput, now = Date.now()): Promise<VerifiedToolCapabilities> {
        let state: unknown;
        try {
            const tools = this.compiler.compile([PROBE_TOOL], input.adapter.dialect);
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
                signal: input.signal,
            });
            state = first.adapterState;
            if (first.state !== 'tool_calls' || first.calls.length < 1 || first.calls.length > 2 || first.calls.some((call) => call.name !== PROBE_TOOL.name)) throw createSSHelperError('LLM_MODEL_PROBE_FAILED', { stage: 'llm.tools.capability_probe.first', resourceId: input.resourceId, model: input.model });
            for (const call of first.calls) this.compiler.validateArguments(PROBE_TOOL, call.arguments);
            const values = first.calls.map((call) => String((call.arguments as Record<string, unknown>).value ?? ''));
            if (new Set(values).size !== values.length) throw createSSHelperError('LLM_MODEL_PROBE_FAILED', { stage: 'llm.tools.capability_probe.parallel', resourceId: input.resourceId, model: input.model });
            await input.beforeRequest?.();
            const second = await input.adapter.continue(first.adapterState, first.calls.map((call) => ({
                callId: call.callId,
                name: PROBE_TOOL.name,
                ok: true,
                content: { echoed: String((call.arguments as Record<string, unknown>).value) },
            })), input.signal);
            state = second.adapterState;
            if (second.state !== 'final') throw createSSHelperError('LLM_MODEL_PROBE_FAILED', { stage: 'llm.tools.capability_probe.continue', resourceId: input.resourceId, model: input.model });
            const output = second.output as Record<string, unknown>;
            if (output.ok !== true) throw createSSHelperError('LLM_MODEL_PROBE_FAILED', { stage: 'llm.tools.capability_probe.final', resourceId: input.resourceId, model: input.model });
            const capabilityDigest = stableToolDigest([input.resourceId, input.model, input.adapter.dialect, input.adapter.version, TOOL_CAPABILITY_PROBE_VERSION].join('\0'));
            return Object.freeze({
                status: 'verified',
                resourceId: input.resourceId,
                model: input.model,
                dialect: input.adapter.dialect,
                parallelToolCalls: first.calls.length === 2,
                streamingToolCalls: first.transport === 'stream' || second.transport === 'stream',
                strictToolSchema: input.adapter.dialect === 'openai_responses' || input.adapter.dialect === 'anthropic_messages' ? 'native' : input.adapter.dialect === 'deepseek_chat' ? 'beta' : 'none',
                reasoningReplay: input.adapter.dialect === 'deepseek_chat' || input.adapter.dialect === 'glm_chat' ? 'required' : input.adapter.dialect === 'openai_responses' || input.adapter.dialect === 'gemini_interactions' ? 'opaque' : 'none',
                verifiedAt: now,
                expiresAt: now + TOOL_CAPABILITY_SUCCESS_TTL_MS,
                probeVersion: TOOL_CAPABILITY_PROBE_VERSION,
                capabilityDigest,
            });
        } catch (error) {
            if (input.signal.aborted) {
                throw createSSHelperError('REQUEST_ABORTED', {
                    stage: 'llm.tools.capability_probe',
                    resourceId: input.resourceId,
                    model: input.model,
                });
            }
            const failure = readSSHelperFailure(error, { reasonCode: 'LLM_MODEL_PROBE_FAILED', stage: 'llm.tools.capability_probe', resourceId: input.resourceId, model: input.model });
            return Object.freeze({
                status: 'failed',
                resourceId: input.resourceId,
                model: input.model,
                dialect: input.adapter.dialect,
                parallelToolCalls: false,
                streamingToolCalls: false,
                strictToolSchema: 'none',
                reasoningReplay: 'none',
                verifiedAt: now,
                expiresAt: now + TOOL_CAPABILITY_FAILURE_TTL_MS,
                probeVersion: TOOL_CAPABILITY_PROBE_VERSION,
                failureCode: failure?.reasonCode ?? 'LLM_MODEL_PROBE_FAILED',
            });
        } finally {
            if (state !== undefined) input.adapter.dispose(state);
        }
    }
}
