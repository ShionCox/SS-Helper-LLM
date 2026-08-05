import { createSSHelperError, readSSHelperFailure, type LlmReasoningPolicy, type NormalizedToolResult, type PlainData, type ProviderPrivacyPolicy, type VerifiedToolCapabilities } from '@ss-helper/sdk';
import type { ProviderToolAdapter, ProviderToolStartInput, ProviderToolStep } from './tool-adapter';
import { attachProviderResponseDebug } from '../providers/provider-response-diagnostics';

export const TOOL_SESSION_LIMITS = Object.freeze({
    // Large Memory batches can legitimately carry the original stage context,
    // a complete thinking-model assistant turn and tool schemas in local replay.
    // Keep the state bounded, while leaving enough room for that single-turn
    // replay without misclassifying a valid tool call as session exhaustion.
    maxStateBytes: 1024 * 1024,
    perPlugin: 4,
    perChat: 3,
    perResource: 2,
    global: 16,
    ttlMs: 5 * 60 * 1_000,
    maxCallsPerRound: 6,
    maxCallsTotal: 6,
    maxToolRounds: 2,
});

function rejectedToolStepError(error: unknown, step: ProviderToolStep): unknown {
    const failure = readSSHelperFailure(error);
    if (failure?.reasonCode !== 'LLM_TOOL_CALL_LIMIT_EXCEEDED' || step.state !== 'tool_calls') return error;
    const usage = step.usage;
    const errorWithUsage = createSSHelperError(failure.reasonCode, {
        ...failure,
        ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
        ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
        ...(usage?.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    });
    return attachProviderResponseDebug(errorWithUsage, {
        providerResponse: {
            state: step.state,
            finishReason: 'tool_calls',
            calls: step.calls.map(call => ({ callId: call.callId, name: call.name, arguments: call.arguments })),
            ...(usage === undefined ? {} : { usage }),
        },
    });
}

export interface ToolSessionScope {
    readonly callerPluginId: string;
    readonly taskKey: string;
    readonly pipelineRunId: string;
    readonly chatKey: string;
    readonly resourceId: string;
    readonly model: string;
}

export interface ToolSessionStartInput extends ToolSessionScope {
    readonly adapter: ProviderToolAdapter;
    readonly capability: VerifiedToolCapabilities;
    readonly messages: ProviderToolStartInput['messages'];
    readonly tools: ProviderToolStartInput['tools'];
    readonly outputSchema: PlainData;
    readonly privacyPolicy: ProviderPrivacyPolicy;
    readonly maxTokens: number;
    readonly reasoning?: LlmReasoningPolicy;
    readonly validationMode?: 'strict' | 'itemized_partial';
    readonly validationCollections?: readonly string[];
    readonly signal: AbortSignal;
}

interface ToolSessionRecord extends ToolSessionScope {
    readonly id: string;
    readonly adapter: ProviderToolAdapter;
    readonly capabilitySnapshotId: string;
    readonly privacyMode: ProviderPrivacyPolicy['conversationStateMode'];
    readonly toolSchemaProfile: 'ss_helper_tool_v0';
    readonly createdAt: number;
    expiresAt: number;
    round: number;
    totalCalls: number;
    adapterState: unknown;
    stateBytes: number;
    pendingCalls: readonly { readonly callId: string; readonly name: string }[];
    readonly outputSchema: PlainData;
    readonly reasoningPolicy?: LlmReasoningPolicy;
    readonly validationMode?: 'strict' | 'itemized_partial';
    readonly validationCollections?: readonly string[];
}

export interface ManagedToolStep {
    readonly toolSessionId?: string;
    readonly step: ProviderToolStep;
    readonly round: number;
    readonly totalCalls: number;
    readonly capabilitySnapshotId: string;
    readonly outputSchema: PlainData;
    readonly reasoningPolicy?: LlmReasoningPolicy;
    readonly validationMode?: 'strict' | 'itemized_partial';
    readonly validationCollections?: readonly string[];
}

let sessionSequence = 0;
const nextSessionId = (): string => `tool_session_${Date.now()}_${++sessionSequence}`;

export class ToolSessionManager {
    private readonly sessions = new Map<string, ToolSessionRecord>();

    async start(input: ToolSessionStartInput, now = Date.now()): Promise<ManagedToolStep> {
        this.sweep(now);
        this.assertCapacity(input);
        const step = await input.adapter.start({
            resourceId: input.resourceId,
            model: input.model,
            messages: input.messages,
            tools: input.tools,
            outputSchema: input.outputSchema,
            privacyPolicy: input.privacyPolicy,
            maxTokens: input.maxTokens,
            ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
            signal: input.signal,
        });
        const capabilitySnapshotId = input.capability.capabilityDigest ?? `${input.resourceId}:${input.model}:${input.capability.probeVersion}`;
        if (step.state === 'final') {
            input.adapter.dispose(step.adapterState);
            return { step, round: 1, totalCalls: 0, capabilitySnapshotId, outputSchema: input.outputSchema, ...(input.reasoning === undefined ? {} : { reasoningPolicy: input.reasoning }), ...(input.validationMode === undefined ? {} : { validationMode: input.validationMode }), ...(input.validationCollections === undefined ? {} : { validationCollections: [...input.validationCollections] }) };
        }
        let stateBytes: number;
        try {
            this.assertCallLimits(1, step.calls.length, step.calls.length);
            stateBytes = input.adapter.estimateStateBytes(step.adapterState);
            this.assertStateBytes(stateBytes);
        } catch (error) {
            input.adapter.dispose(step.adapterState);
            throw rejectedToolStepError(error, step);
        }
        const id = nextSessionId();
        const record: ToolSessionRecord = {
            id,
            callerPluginId: input.callerPluginId,
            taskKey: input.taskKey,
            pipelineRunId: input.pipelineRunId,
            chatKey: input.chatKey,
            resourceId: input.resourceId,
            model: input.model,
            adapter: input.adapter,
            capabilitySnapshotId,
            privacyMode: input.privacyPolicy.conversationStateMode,
            toolSchemaProfile: 'ss_helper_tool_v0',
            createdAt: now,
            expiresAt: now + TOOL_SESSION_LIMITS.ttlMs,
            round: 1,
            totalCalls: step.calls.length,
            adapterState: step.adapterState,
            stateBytes,
            pendingCalls: step.calls.map((call) => ({ callId: call.callId, name: call.name })),
            outputSchema: input.outputSchema,
            ...(input.reasoning === undefined ? {} : { reasoningPolicy: input.reasoning }),
            ...(input.validationMode === undefined ? {} : { validationMode: input.validationMode }),
            ...(input.validationCollections === undefined ? {} : { validationCollections: [...input.validationCollections] }),
        };
        this.sessions.set(id, record);
        return { toolSessionId: id, step, round: record.round, totalCalls: record.totalCalls, capabilitySnapshotId, outputSchema: record.outputSchema, ...(record.reasoningPolicy === undefined ? {} : { reasoningPolicy: record.reasoningPolicy }), ...(record.validationMode === undefined ? {} : { validationMode: record.validationMode }), ...(record.validationCollections === undefined ? {} : { validationCollections: [...record.validationCollections] }) };
    }

    async continue(
        toolSessionId: string,
        scope: ToolSessionScope,
        results: readonly NormalizedToolResult[],
        signal: AbortSignal,
        now = Date.now(),
    ): Promise<ManagedToolStep> {
        this.sweep(now);
        const record = this.sessions.get(toolSessionId);
        if (!record) throw createSSHelperError('LLM_TOOL_SESSION_EXPIRED', { stage: 'llm.tools.session.continue' });
        this.assertScope(record, scope);
        this.assertResults(record, results);
        // The current pending calls were already admitted before they were
        // returned to the caller. Recheck immutable counters before any
        // continuation request; calls produced by that request are validated
        // before they are exposed and therefore can never reach a ToolGateway.
        this.assertCallLimits(record.round, record.pendingCalls.length, record.totalCalls);
        let step: ProviderToolStep | undefined;
        try {
            step = await record.adapter.continue(record.adapterState, results, signal);
            const nextRound = record.round + 1;
            const nextTotalCalls = record.totalCalls + (step.state === 'tool_calls' ? step.calls.length : 0);
            if (step.state === 'tool_calls') this.assertCallLimits(nextRound, step.calls.length, nextTotalCalls);
            record.round = nextRound;
            record.totalCalls = nextTotalCalls;
            record.adapterState = step.adapterState;
            record.stateBytes = record.adapter.estimateStateBytes(step.adapterState);
            this.assertStateBytes(record.stateBytes);
            record.expiresAt = now + TOOL_SESSION_LIMITS.ttlMs;
            record.pendingCalls = step.state === 'tool_calls' ? step.calls.map((call) => ({ callId: call.callId, name: call.name })) : [];
            if (step.state === 'final') this.release(record.id);
            return { ...(step.state === 'tool_calls' ? { toolSessionId: record.id } : {}), step, round: record.round, totalCalls: record.totalCalls, capabilitySnapshotId: record.capabilitySnapshotId, outputSchema: record.outputSchema, ...(record.reasoningPolicy === undefined ? {} : { reasoningPolicy: record.reasoningPolicy }), ...(record.validationMode === undefined ? {} : { validationMode: record.validationMode }), ...(record.validationCollections === undefined ? {} : { validationCollections: [...record.validationCollections] }) };
        } catch (error) {
            this.release(record.id);
            throw step === undefined ? error : rejectedToolStepError(error, step);
        }
    }

    async finalize(toolSessionId: string, scope: ToolSessionScope, instruction: string, outputSchema: PlainData, signal: AbortSignal): Promise<ManagedToolStep> {
        const record = this.sessions.get(toolSessionId);
        if (!record) throw createSSHelperError('LLM_TOOL_SESSION_EXPIRED', { stage: 'llm.tools.session.finalize' });
        this.assertScope(record, scope);
        try {
            const step = await record.adapter.finalize(record.adapterState, instruction, outputSchema, signal);
            if (step.state !== 'final') throw createSSHelperError('LLM_TOOL_CONTEXT_INTEGRITY_FAILED', { stage: 'llm.tools.session.finalize', expected: 'a final structured output without more tools' });
            record.adapterState = step.adapterState;
            record.round += 1;
            return { step, round: record.round, totalCalls: record.totalCalls, capabilitySnapshotId: record.capabilitySnapshotId, outputSchema: record.outputSchema };
        } finally {
            this.release(record.id);
        }
    }

    cancel(toolSessionId: string): boolean { return this.release(toolSessionId); }
    cancelByChat(callerPluginId: string, chatKey: string): number {
        const ids = [...this.sessions.values()].filter((record) => record.callerPluginId === callerPluginId && record.chatKey === chatKey).map((record) => record.id);
        ids.forEach((id) => this.release(id));
        return ids.length;
    }
    cancelByResource(resourceId: string): number {
        const ids = [...this.sessions.values()].filter((record) => record.resourceId === resourceId).map((record) => record.id);
        ids.forEach((id) => this.release(id));
        return ids.length;
    }
    dispose(): void { [...this.sessions.keys()].forEach((id) => this.release(id)); }
    get activeCount(): number { return this.sessions.size; }

    getRound(toolSessionId: string): number | undefined {
        return this.sessions.get(toolSessionId)?.round;
    }

    private assertCapacity(input: ToolSessionScope): void {
        const records = [...this.sessions.values()];
        if (records.length >= TOOL_SESSION_LIMITS.global
            || records.filter((record) => record.callerPluginId === input.callerPluginId).length >= TOOL_SESSION_LIMITS.perPlugin
            || records.filter((record) => record.callerPluginId === input.callerPluginId && record.chatKey === input.chatKey).length >= TOOL_SESSION_LIMITS.perChat
            || records.filter((record) => record.resourceId === input.resourceId).length >= TOOL_SESSION_LIMITS.perResource) {
            throw createSSHelperError('LLM_TOOL_SESSION_CAPACITY_EXCEEDED', {
                stage: 'llm.tools.session.capacity',
                resourceId: input.resourceId,
                model: input.model,
            });
        }
    }

    private assertStateBytes(bytes: number): void {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > TOOL_SESSION_LIMITS.maxStateBytes) {
            throw createSSHelperError('LLM_TOOL_SESSION_CAPACITY_EXCEEDED', {
                stage: 'llm.tools.session.state_size',
                expected: `adapter state at most ${TOOL_SESSION_LIMITS.maxStateBytes} bytes`,
            });
        }
    }

    private assertCallLimits(round: number, callsThisRound: number, totalCalls: number): void {
        if (round > TOOL_SESSION_LIMITS.maxToolRounds || callsThisRound > TOOL_SESSION_LIMITS.maxCallsPerRound || totalCalls > TOOL_SESSION_LIMITS.maxCallsTotal) {
            throw createSSHelperError('LLM_TOOL_CALL_LIMIT_EXCEEDED', {
                stage: 'llm.tools.session.call_limits',
                expected: `at most ${TOOL_SESSION_LIMITS.maxToolRounds} rounds, ${TOOL_SESSION_LIMITS.maxCallsPerRound} calls per round and ${TOOL_SESSION_LIMITS.maxCallsTotal} calls total`,
            });
        }
    }

    private assertScope(record: ToolSessionRecord, scope: ToolSessionScope): void {
        const matches = record.callerPluginId === scope.callerPluginId
            && record.taskKey === scope.taskKey
            && record.pipelineRunId === scope.pipelineRunId
            && record.chatKey === scope.chatKey
            && record.resourceId === scope.resourceId
            && record.model === scope.model;
        if (!matches) throw createSSHelperError('LLM_TOOL_SESSION_SCOPE_MISMATCH', {
            stage: 'llm.tools.session.scope',
            resourceId: scope.resourceId,
            model: scope.model,
        });
    }

    private assertResults(record: ToolSessionRecord, results: readonly NormalizedToolResult[]): void {
        const expected = new Map(record.pendingCalls.map((call) => [call.callId, call.name]));
        if (expected.size !== results.length || new Set(results.map((result) => result.callId)).size !== results.length || results.some((result) => expected.get(result.callId) !== result.name)) {
            throw createSSHelperError('LLM_TOOL_CONTEXT_INTEGRITY_FAILED', {
                stage: 'llm.tools.session.results',
                expected: 'exactly one result for each pending tool call',
            });
        }
    }

    private sweep(now: number): void {
        for (const record of [...this.sessions.values()]) if (record.expiresAt <= now) this.release(record.id);
    }

    private release(id: string): boolean {
        const record = this.sessions.get(id);
        if (!record) return false;
        this.sessions.delete(id);
        record.adapter.dispose(record.adapterState);
        return true;
    }

    getScope(toolSessionId: string): ToolSessionScope | undefined {
        const record = this.sessions.get(toolSessionId);
        if (!record) return undefined;
        return {
            callerPluginId: record.callerPluginId,
            taskKey: record.taskKey,
            pipelineRunId: record.pipelineRunId,
            chatKey: record.chatKey,
            resourceId: record.resourceId,
            model: record.model,
        };
    }
}
