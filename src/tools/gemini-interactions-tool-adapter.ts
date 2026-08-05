import { createSSHelperError, type LlmReasoningPolicy, type NormalizedToolCall, type NormalizedToolResult, type PlainData } from '@ss-helper/sdk';
import type { JsonHttpTransport, ProviderToolAdapter, ProviderToolStartInput, ProviderToolStep } from './tool-adapter';
import { providerStoresState } from './provider-privacy-policy';
import { compileReasoningFields } from '../providers/reasoning-policy';
import { canonicalToolName, createProviderToolNameAliases, estimateJsonBytes, parseArguments, parseFinalOutput, providerToolName, validateCalls, type ProviderToolNameAliases } from './tool-adapter-utils';

interface GeminiInteractionsState {
    readonly model: string;
    readonly initialInput: readonly Record<string, unknown>[];
    readonly replaySteps: readonly Record<string, unknown>[];
    readonly tools: readonly Record<string, unknown>[];
    readonly allowedNames: readonly string[];
    readonly toolNames: ProviderToolNameAliases;
    readonly maxTokens: number;
    readonly providerManaged: boolean;
    readonly previousInteractionId?: string;
    readonly pendingCalls: readonly { readonly callId: string; readonly name: string }[];
    readonly reasoning?: LlmReasoningPolicy;
}

export class GeminiInteractionsToolAdapter implements ProviderToolAdapter<GeminiInteractionsState> {
    readonly dialect = 'gemini_interactions' as const;
    readonly version = 3;
    constructor(private readonly transport: JsonHttpTransport) {}

    async start(input: ProviderToolStartInput): Promise<ProviderToolStep<GeminiInteractionsState>> {
        const providerManaged = providerStoresState(input.privacyPolicy);
        const toolNames = createProviderToolNameAliases(input.tools.map((tool) => tool.name));
        const state: GeminiInteractionsState = {
            model: input.model,
            initialInput: input.messages.map((message) => ({
                type: 'message', role: message.role === 'assistant' ? 'model' : message.role,
                content: [{ type: 'text', text: message.content }],
            })),
            replaySteps: [],
            tools: input.tools.map((tool) => ({
                type: 'function', name: providerToolName(toolNames, tool.name), description: tool.description, parameters: tool.parameters,
            })),
            allowedNames: input.tools.map((tool) => tool.name),
            toolNames,
            maxTokens: input.maxTokens,
            providerManaged,
            pendingCalls: [],
            ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
        };
        return this.send(state, [], true, input.signal);
    }

    async continue(state: GeminiInteractionsState, results: readonly NormalizedToolResult[], signal: AbortSignal): Promise<ProviderToolStep<GeminiInteractionsState>> {
        this.validateResultSet(state, results);
        const functionResults = results.map((result) => ({
            type: 'function_result', name: providerToolName(state.toolNames, result.name), call_id: result.callId,
            result: [{ type: 'text', text: JSON.stringify(result.content) }],
        }));
        return this.send({ ...state, pendingCalls: [] }, functionResults, true, signal);
    }

    async finalize(state: GeminiInteractionsState, finalInstruction: string, _outputSchema: PlainData, signal: AbortSignal): Promise<ProviderToolStep<GeminiInteractionsState>> {
        const instruction = { type: 'message', role: 'user', content: [{ type: 'text', text: finalInstruction }] };
        return this.send({ ...state, pendingCalls: [] }, [instruction], false, signal);
    }

    estimateStateBytes(state: GeminiInteractionsState): number { return estimateJsonBytes(state); }
    dispose(_state: GeminiInteractionsState): void {}

    private async send(
        state: GeminiInteractionsState,
        appended: readonly Record<string, unknown>[],
        allowTools: boolean,
        signal: AbortSignal,
    ): Promise<ProviderToolStep<GeminiInteractionsState>> {
        const input = state.providerManaged
            ? appended.length > 0 ? appended : state.initialInput
            : [...state.initialInput, ...state.replaySteps, ...appended];
        const body: Record<string, unknown> = {
            model: state.model,
            input,
            store: state.providerManaged,
            max_output_tokens: state.maxTokens,
            ...compileReasoningFields({ provider: 'gemini', dialect: this.dialect, policy: state.reasoning, execution: 'tool_turn' }),
            ...(state.providerManaged && state.previousInteractionId ? { previous_interaction_id: state.previousInteractionId } : {}),
            ...(allowTools ? { tools: state.tools } : {}),
        };
        const streamed = this.transport.sendStream !== undefined;
        const data = streamed
            ? this.assembleStream(await this.transport.sendStream!(body, signal))
            : await this.transport.send(body, signal);
        const steps = Array.isArray(data.outputs) ? data.outputs as Array<Record<string, unknown>>
            : Array.isArray(data.steps) ? data.steps as Array<Record<string, unknown>> : [];
        const calls: NormalizedToolCall[] = [];
        for (let index = 0; index < steps.length; index += 1) {
            const step = steps[index]!;
            if (step.type !== 'function_call') continue;
            calls.push({
                callId: String(step.call_id ?? step.id ?? ''),
                name: canonicalToolName(state.toolNames, String(step.name ?? '')),
                arguments: parseArguments(step.arguments, `$.steps[${index}].arguments`),
            });
        }
        const interactionId = typeof data.id === 'string' && data.id ? data.id : undefined;
        const next: GeminiInteractionsState = {
            ...state,
            replaySteps: state.providerManaged ? [] : [...state.replaySteps, ...appended, ...steps],
            ...(interactionId ? { previousInteractionId: interactionId } : {}),
            pendingCalls: calls.map((call) => ({ callId: call.callId, name: call.name })),
        };
        if (calls.length > 0) return { state: 'tool_calls', calls: validateCalls(calls, new Set(state.allowedNames)), adapterState: next, transport: streamed ? 'stream' : 'non_stream' };
        const text = this.extractText(data, steps);
        return { state: 'final', output: parseFinalOutput(text, 'llm.tools.gemini.final'), adapterState: next, transport: streamed ? 'stream' : 'non_stream' };
    }

    private assembleStream(chunks: readonly Record<string, unknown>[]): Record<string, unknown> {
        for (let index = chunks.length - 1; index >= 0; index -= 1) {
            const chunk = chunks[index]!;
            const interaction = chunk.interaction;
            if (interaction && typeof interaction === 'object' && !Array.isArray(interaction)) return interaction as Record<string, unknown>;
            if (Array.isArray(chunk.outputs) || Array.isArray(chunk.steps) || typeof chunk.output_text === 'string') return chunk;
        }
        throw createSSHelperError('PROVIDER_RESPONSE_INVALID', { stage: 'llm.tools.gemini.stream_complete', expected: 'a completed interaction' });
    }

    private extractText(data: Record<string, unknown>, steps: readonly Record<string, unknown>[]): string {
        if (typeof data.output_text === 'string') return data.output_text;
        const text: string[] = [];
        for (const step of steps) {
            if (typeof step.text === 'string') text.push(step.text);
            if (!Array.isArray(step.content)) continue;
            for (const content of step.content as Array<Record<string, unknown>>) if (typeof content.text === 'string') text.push(content.text);
        }
        return text.join('').trim();
    }

    private validateResultSet(state: GeminiInteractionsState, results: readonly NormalizedToolResult[]): void {
        const expected = new Map(state.pendingCalls.map((call) => [call.callId, call.name]));
        if (expected.size !== results.length || results.some((result) => expected.get(result.callId) !== result.name)) {
            throw createSSHelperError('LLM_TOOL_CONTEXT_INTEGRITY_FAILED', {
                stage: 'llm.tools.gemini.result_pairing',
                expected: 'one function_result for every function_call call_id',
            });
        }
    }
}
