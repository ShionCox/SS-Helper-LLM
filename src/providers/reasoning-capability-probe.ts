import {
    createSSHelperError,
    readSSHelperFailure,
    type LlmReasoningExecutionCapability,
    type LlmReasoningPolicy,
    type SSHelperFailureContext,
    type VerifiedReasoningCapabilities,
    type VerifiedToolCapabilities,
} from '@ss-helper/sdk';
import type { LLMProvider, LLMRequest } from './types';
import { providerManifest, type ProviderManifestId } from './provider-manifest';
import { normalizeReasoningPolicy, type ReasoningProvider } from './reasoning-policy';
import { createStructuredOutputPlan } from '../schema/structured-output-plan';
import { stableToolDigest } from '../tools/tool-capability-cache';

export const REASONING_CAPABILITY_PROBE_VERSION = 1;
export const REASONING_CAPABILITY_SUCCESS_TTL_MS = 24 * 60 * 60 * 1_000;
export const REASONING_CAPABILITY_FAILURE_TTL_MS = 10 * 60 * 1_000;

export interface ReasoningCapabilityProbeInput {
    readonly resourceId: string;
    readonly model: string;
    readonly provider: LLMProvider;
    readonly providerKind: ReasoningProvider;
    readonly connectionRevision: string;
    readonly policy: LlmReasoningPolicy;
    readonly requestId: string;
    readonly signal: AbortSignal;
    readonly beforeRequest?: () => Promise<void>;
    readonly toolCapability?: VerifiedToolCapabilities;
}

const SIMPLE_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
});

function probeFailure(input: ReasoningCapabilityProbeInput, error: unknown, stage: string): SSHelperFailureContext {
    const observed = readSSHelperFailure(error, {
        reasonCode: 'LLM_REASONING_PROBE_FAILED',
        stage,
        requestId: input.requestId,
        providerKind: input.providerKind,
        resourceId: input.resourceId,
        model: input.model,
    })!;
    if (observed.reasonCode === 'LLM_REASONING_CONFIGURATION_UNSUPPORTED') return observed;
    return createSSHelperError('LLM_REASONING_PROBE_FAILED', {
        stage,
        requestId: input.requestId,
        providerKind: input.providerKind,
        resourceId: input.resourceId,
        model: input.model,
    }).details as unknown as SSHelperFailureContext;
}

async function execute(input: ReasoningCapabilityProbeInput, request: LLMRequest): Promise<void> {
    await input.beforeRequest?.();
    input.signal.throwIfAborted();
    const response = await input.provider.request({ ...request, signal: input.signal });
    input.signal.throwIfAborted();
    if (!response || typeof response.content !== 'string') {
        throw createSSHelperError('PROVIDER_RESPONSE_INVALID', {
            stage: 'llm.reasoning.probe.response',
            requestId: input.requestId,
            resourceId: input.resourceId,
            model: input.model,
        });
    }
}

async function structuredRequest(input: ReasoningCapabilityProbeInput): Promise<LLMRequest> {
    const identity = input.provider.getStructuredOutputIdentity
        ? await input.provider.getStructuredOutputIdentity(input.model)
        : { vendor: 'unknown' as const, evidence: 'manual' as const, confidence: 'low' as const, model: input.model };
    const capability = await (input.provider.getStructuredOutputCapability?.(identity) ?? input.provider.capabilities.structuredOutput);
    const plan = createStructuredOutputPlan({
        identity,
        spec: { schema: SIMPLE_SCHEMA, name: 'ss_helper_reasoning_probe' },
        capability,
    });
    const messages: LLMRequest['messages'] = [
        { role: 'system', content: plan.promptInstruction },
        { role: 'user', content: 'Return the JSON object {"ok":true}.' },
    ];
    return { messages, model: input.model, maxTokens: 32, structuredOutput: plan, reasoning: input.policy };
}

function failureExecution(
    execution: LlmReasoningExecutionCapability['execution'],
    manifest: ReturnType<typeof providerManifest>,
    failure: SSHelperFailureContext,
): LlmReasoningExecutionCapability {
    return {
        execution,
        status: 'failed',
        modes: manifest.reasoning.modes,
        efforts: manifest.reasoning.efforts,
        transport: manifest.reasoning.transport,
        reasoningReplay: manifest.reasoning.replay,
        failure,
    };
}

export async function verifyReasoningCapabilities(input: ReasoningCapabilityProbeInput): Promise<VerifiedReasoningCapabilities> {
    const policy = normalizeReasoningPolicy(input.policy);
    const manifest = providerManifest(input.providerKind as ProviderManifestId);
    const executions: LlmReasoningExecutionCapability[] = [];
    const optionalFailures: SSHelperFailureContext[] = [];
    const base = {
        resourceId: input.resourceId,
        model: input.model,
        provider: input.providerKind,
        defaultMode: manifest.reasoning.defaultMode,
        modes: manifest.reasoning.modes,
        efforts: manifest.reasoning.efforts,
        transport: manifest.reasoning.transport,
        reasoningReplay: manifest.reasoning.replay,
        connectionRevision: input.connectionRevision,
        probeVersion: REASONING_CAPABILITY_PROBE_VERSION,
    } as const;

    const unsupported = input.providerKind === 'generic' && (policy.mode !== 'provider_default' || policy.effort !== 'provider_default');
    const run = async (
        execution: LlmReasoningExecutionCapability['execution'],
        request: () => Promise<LLMRequest>,
    ): Promise<void> => {
        if (unsupported) {
            const failure = createSSHelperError('LLM_REASONING_CONFIGURATION_UNSUPPORTED', {
                stage: `llm.reasoning.probe.${execution}`,
                requestId: input.requestId,
                providerKind: input.providerKind,
                resourceId: input.resourceId,
                model: input.model,
            }).details as unknown as SSHelperFailureContext;
            executions.push(failureExecution(execution, manifest, failure));
            optionalFailures.push(failure);
            return;
        }
        try {
            await execute(input, await request());
            executions.push({
                execution,
                status: 'verified',
                modes: manifest.reasoning.modes,
                efforts: manifest.reasoning.efforts,
                transport: manifest.reasoning.transport,
                reasoningReplay: manifest.reasoning.replay,
            });
        } catch (error) {
            if (input.signal.aborted) {
                throw createSSHelperError('REQUEST_ABORTED', {
                    stage: `llm.reasoning.probe.${execution}`,
                    requestId: input.requestId,
                    resourceId: input.resourceId,
                    model: input.model,
                });
            }
            const failure = probeFailure(input, error, `llm.reasoning.probe.${execution}`);
            executions.push(failureExecution(execution, manifest, failure));
            optionalFailures.push(failure);
        }
    };

    await run('completion', async () => ({
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        model: input.model,
        maxTokens: 16,
        reasoning: policy,
    }));
    await run('structured', () => structuredRequest(input));
    if (input.toolCapability?.status === 'verified') {
        executions.push({
            execution: 'tool_turn',
            status: 'verified',
            modes: manifest.reasoning.modes,
            efforts: manifest.reasoning.efforts,
            transport: manifest.reasoning.transport,
            reasoningReplay: manifest.reasoning.replay,
        });
    } else {
        const failure = input.toolCapability?.failure ?? createSSHelperError('LLM_REASONING_CAPABILITY_UNVERIFIED', {
            stage: 'llm.reasoning.probe.tool_turn',
            requestId: input.requestId,
            providerKind: input.providerKind,
            resourceId: input.resourceId,
            model: input.model,
        }).details as unknown as SSHelperFailureContext;
        executions.push(failureExecution('tool_turn', manifest, failure));
        optionalFailures.push(failure);
    }

    const verifiedCount = executions.filter((execution) => execution.status === 'verified').length;
    const digest = stableToolDigest(JSON.stringify({
        resourceId: input.resourceId,
        model: input.model,
        provider: input.providerKind,
        policy,
        connectionRevision: input.connectionRevision,
        executions: executions.map(({ execution, status, transport, reasoningReplay }) => ({ execution, status, transport, reasoningReplay })),
    }));
    return Object.freeze({
        ...base,
        status: verifiedCount > 0 ? 'verified' : 'failed',
        verifiedAt: Date.now(),
        expiresAt: Date.now() + (verifiedCount > 0 ? REASONING_CAPABILITY_SUCCESS_TTL_MS : REASONING_CAPABILITY_FAILURE_TTL_MS),
        capabilityDigest: digest,
        executions,
        ...(optionalFailures.length ? { optionalFailures } : {}),
    });
}
