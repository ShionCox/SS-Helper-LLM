import { createSSHelperError, type LlmReasoningPolicy, type NormalizedToolCall, type NormalizedToolResult, type PlainData } from '@ss-helper/sdk';
import type { JsonHttpTransport, ProviderToolAdapter, ProviderToolStartInput, ProviderToolStep } from './tool-adapter';
import { providerStoresState } from './provider-privacy-policy';
import { canonicalToolName, createProviderToolNameAliases, estimateJsonBytes, parseArguments, parseFinalOutput, providerToolName, usageFromOpenAi, validateCalls, type ProviderToolNameAliases } from './tool-adapter-utils';
import { compileReasoningFields } from '../providers/reasoning-policy';

interface OpenAiResponsesState {
    readonly model: string;
    readonly initialInput: readonly Record<string, unknown>[];
    readonly replayItems: readonly Record<string, unknown>[];
    readonly tools: readonly Record<string, unknown>[];
    readonly allowedNames: readonly string[];
    readonly toolNames: ProviderToolNameAliases;
    readonly maxTokens: number;
    readonly providerManaged: boolean;
    readonly previousResponseId?: string;
    readonly pendingCalls: readonly { readonly callId: string; readonly name: string }[];
    readonly reasoning?: LlmReasoningPolicy;
}

export class OpenAiResponsesToolAdapter implements ProviderToolAdapter<OpenAiResponsesState> {
    readonly dialect = 'openai_responses' as const;
    readonly version = 5;
    constructor(private readonly transport: JsonHttpTransport) {}

    async start(input: ProviderToolStartInput): Promise<ProviderToolStep<OpenAiResponsesState>> {
        const providerManaged = providerStoresState(input.privacyPolicy);
        const toolNames = createProviderToolNameAliases(input.tools.map((tool) => tool.name));
        const initialInput = input.messages.map((message) => ({
            type: 'message',
            role: message.role,
            content: [{ type: 'input_text', text: message.content }],
        }));
        const tools = input.tools.map((tool) => ({
            type: 'function',
            name: providerToolName(toolNames, tool.name),
            description: tool.description,
            parameters: tool.parameters,
            strict: true,
        }));
        const state: OpenAiResponsesState = {
            model: input.model,
            initialInput,
            replayItems: [],
            tools,
            allowedNames: input.tools.map((tool) => tool.name),
            toolNames,
            maxTokens: input.maxTokens,
            providerManaged,
            pendingCalls: [],
            ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
        };
        return this.send(state, [], true, input.outputSchema, input.signal, input.toolChoice ?? 'auto');
    }

    async continue(state: OpenAiResponsesState, results: readonly NormalizedToolResult[], signal: AbortSignal): Promise<ProviderToolStep<OpenAiResponsesState>> {
        this.validateResultSet(state, results);
        const outputs = results.map((result) => ({
            type: 'function_call_output',
            call_id: result.callId,
            output: JSON.stringify(result.content),
        }));
        return this.send({ ...state, pendingCalls: [] }, outputs, true, undefined, signal);
    }

    async finalize(state: OpenAiResponsesState, finalInstruction: string, outputSchema: PlainData, signal: AbortSignal): Promise<ProviderToolStep<OpenAiResponsesState>> {
        const instruction = { type: 'message', role: 'user', content: [{ type: 'input_text', text: finalInstruction }] };
        return this.send({ ...state, pendingCalls: [] }, [instruction], false, outputSchema, signal);
    }

    estimateStateBytes(state: OpenAiResponsesState): number { return estimateJsonBytes(state); }
    dispose(_state: OpenAiResponsesState): void {}

    private async send(
        state: OpenAiResponsesState,
        appended: readonly Record<string, unknown>[],
        allowTools: boolean,
        outputSchema: PlainData | undefined,
        signal: AbortSignal,
        toolChoice: 'auto' | 'required' = 'auto',
    ): Promise<ProviderToolStep<OpenAiResponsesState>> {
        const localInput = [...state.initialInput, ...state.replayItems, ...appended];
        const body: Record<string, unknown> = {
            model: state.model,
            input: state.providerManaged ? appended.length > 0 ? appended : state.initialInput : localInput,
            store: state.providerManaged,
            max_output_tokens: state.maxTokens,
            ...compileReasoningFields({ provider: 'openai', dialect: this.dialect, policy: state.reasoning, execution: 'tool_turn', transport: 'openai_responses' }),
            parallel_tool_calls: true,
            ...(state.providerManaged && state.previousResponseId ? { previous_response_id: state.previousResponseId } : {}),
            ...(allowTools ? { tools: state.tools, tool_choice: toolChoice } : {}),
            ...(!allowTools && outputSchema ? {
                text: { format: { type: 'json_schema', name: 'ss_helper_stage_output', strict: true, schema: outputSchema } },
            } : {}),
        };
        const streamed = this.transport.sendStream !== undefined;
        const data = streamed
            ? this.assembleStream(await this.transport.sendStream!(body, signal))
            : await this.transport.send(body, signal);
        const incompleteDetails = data.incomplete_details;
        const incompleteReason = incompleteDetails && typeof incompleteDetails === 'object' && !Array.isArray(incompleteDetails)
            ? (incompleteDetails as Record<string, unknown>).reason
            : undefined;
        if (data.status === 'incomplete' || incompleteReason === 'max_output_tokens') {
            throw createSSHelperError('STRUCTURED_OUTPUT_TRUNCATED', {
                stage: 'llm.tools.openai_responses.final',
            });
        }
        const output = Array.isArray(data.output) ? data.output as Array<Record<string, unknown>> : [];
        const calls: NormalizedToolCall[] = [];
        for (let index = 0; index < output.length; index += 1) {
            const item = output[index]!;
            if (item.type !== 'function_call') continue;
            calls.push({
                callId: String(item.call_id ?? ''),
                name: canonicalToolName(state.toolNames, String(item.name ?? '')),
                arguments: parseArguments(item.arguments, `$.output[${index}].arguments`),
            });
        }
        const previousResponseId = typeof data.id === 'string' && data.id ? data.id : undefined;
        const next: OpenAiResponsesState = {
            ...state,
            replayItems: state.providerManaged ? [] : [...state.replayItems, ...appended, ...output],
            ...(previousResponseId ? { previousResponseId } : {}),
            pendingCalls: calls.map((call) => ({ callId: call.callId, name: call.name })),
        };
        if (calls.length > 0) return { state: 'tool_calls', calls: validateCalls(calls, new Set(state.allowedNames)), adapterState: next, transport: streamed ? 'stream' : 'non_stream', usage: usageFromOpenAi(data) };
        const outputText = typeof data.output_text === 'string' ? data.output_text : this.extractOutputText(output);
        return { state: 'final', output: parseFinalOutput(outputText, 'llm.tools.openai_responses.final'), adapterState: next, transport: streamed ? 'stream' : 'non_stream', usage: usageFromOpenAi(data) };
    }

    private assembleStream(chunks: readonly Record<string, unknown>[]): Record<string, unknown> {
        for (let index = chunks.length - 1; index >= 0; index -= 1) {
            const chunk = chunks[index]!;
            const response = chunk.response;
            if (response && typeof response === 'object' && !Array.isArray(response)) return response as Record<string, unknown>;
            if (Array.isArray(chunk.output) || typeof chunk.output_text === 'string') return chunk;
        }
        throw createSSHelperError('PROVIDER_RESPONSE_INVALID', {
            stage: 'llm.tools.openai_responses.stream_complete',
            expected: 'response.completed with a response object',
        });
    }

    private extractOutputText(output: readonly Record<string, unknown>[]): string {
        const parts: string[] = [];
        for (const item of output) {
            if (item.type !== 'message' || !Array.isArray(item.content)) continue;
            for (const content of item.content as Array<Record<string, unknown>>) {
                if ((content.type === 'output_text' || content.type === 'text') && typeof content.text === 'string') parts.push(content.text);
            }
        }
        return parts.join('').trim();
    }

    private validateResultSet(state: OpenAiResponsesState, results: readonly NormalizedToolResult[]): void {
        const expected = new Map(state.pendingCalls.map((call) => [call.callId, call.name]));
        if (expected.size !== results.length || results.some((result) => expected.get(result.callId) !== result.name)) {
            throw createSSHelperError('LLM_TOOL_CONTEXT_INTEGRITY_FAILED', {
                stage: 'llm.tools.openai_responses.result_pairing',
                expected: 'one function_call_output for every pending call_id',
            });
        }
    }
}
