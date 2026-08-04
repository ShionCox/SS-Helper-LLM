import { createSSHelperError, type NormalizedToolCall, type NormalizedToolResult, type PlainData } from '@ss-helper/sdk';
import type { JsonHttpTransport, ProviderToolAdapter, ProviderToolStartInput, ProviderToolStep } from './tool-adapter';
import { canonicalToolName, createProviderToolNameAliases, estimateJsonBytes, parseArguments, parseFinalOutput, providerToolName, validateCalls, type ProviderToolNameAliases } from './tool-adapter-utils';

interface AnthropicToolState {
    readonly model: string;
    readonly system?: string;
    readonly messages: readonly Record<string, unknown>[];
    readonly tools: readonly Record<string, unknown>[];
    readonly allowedNames: readonly string[];
    readonly toolNames: ProviderToolNameAliases;
    readonly maxTokens: number;
    readonly pendingCalls: readonly { readonly callId: string; readonly name: string }[];
}

export class AnthropicMessagesToolAdapter implements ProviderToolAdapter<AnthropicToolState> {
    readonly dialect = 'anthropic_messages' as const;
    readonly version = 3;
    constructor(private readonly transport: JsonHttpTransport) {}

    async start(input: ProviderToolStartInput): Promise<ProviderToolStep<AnthropicToolState>> {
        const system = input.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n') || undefined;
        const messages = input.messages.filter((message) => message.role !== 'system').map((message) => ({
            role: message.role === 'assistant' ? 'assistant' : 'user',
            content: [{ type: 'text', text: message.content }],
        }));
        const toolNames = createProviderToolNameAliases(input.tools.map((tool) => tool.name));
        const state: AnthropicToolState = {
            model: input.model,
            ...(system ? { system } : {}),
            messages: messages.length > 0 ? messages : [{ role: 'user', content: [{ type: 'text', text: '' }] }],
            tools: input.tools.map((tool) => ({ name: providerToolName(toolNames, tool.name), description: tool.description, input_schema: tool.parameters, strict: true })),
            allowedNames: input.tools.map((tool) => tool.name),
            toolNames,
            maxTokens: input.maxTokens,
            pendingCalls: [],
        };
        return this.send(state, true, input.signal);
    }

    async continue(state: AnthropicToolState, results: readonly NormalizedToolResult[], signal: AbortSignal): Promise<ProviderToolStep<AnthropicToolState>> {
        this.validateResultSet(state, results);
        const user = {
            role: 'user',
            content: results.map((result) => ({
                type: 'tool_result', tool_use_id: result.callId,
                content: JSON.stringify(result.content), is_error: !result.ok,
            })),
        };
        return this.send({ ...state, messages: [...state.messages, user], pendingCalls: [] }, true, signal);
    }

    async finalize(state: AnthropicToolState, finalInstruction: string, _outputSchema: PlainData, signal: AbortSignal): Promise<ProviderToolStep<AnthropicToolState>> {
        const user = { role: 'user', content: [{ type: 'text', text: finalInstruction }] };
        return this.send({ ...state, messages: [...state.messages, user], pendingCalls: [] }, false, signal);
    }

    estimateStateBytes(state: AnthropicToolState): number { return estimateJsonBytes(state); }
    dispose(_state: AnthropicToolState): void {}

    private async send(state: AnthropicToolState, allowTools: boolean, signal: AbortSignal): Promise<ProviderToolStep<AnthropicToolState>> {
        const body = {
            model: state.model,
            max_tokens: state.maxTokens,
            messages: state.messages,
            ...(state.system ? { system: state.system } : {}),
            ...(allowTools ? { tools: state.tools, tool_choice: { type: 'auto' } } : {}),
        };
        const streamed = this.transport.sendStream !== undefined;
        const data = streamed
            ? this.assembleStream(await this.transport.sendStream!(body, signal))
            : await this.transport.send(body, signal);
        const content = Array.isArray(data.content) ? data.content as Array<Record<string, unknown>> : [];
        const assistant = { role: 'assistant', content };
        const calls: NormalizedToolCall[] = [];
        for (let index = 0; index < content.length; index += 1) {
            const block = content[index]!;
            if (block.type !== 'tool_use') continue;
            calls.push({
                callId: String(block.id ?? ''),
                name: canonicalToolName(state.toolNames, String(block.name ?? '')),
                arguments: parseArguments(block.input, `$.content[${index}].input`),
            });
        }
        const next = {
            ...state,
            messages: [...state.messages, assistant],
            pendingCalls: calls.map((call) => ({ callId: call.callId, name: call.name })),
        };
        const prompt = Number((data.usage as Record<string, unknown> | undefined)?.input_tokens);
        const completion = Number((data.usage as Record<string, unknown> | undefined)?.output_tokens);
        const usage = Number.isSafeInteger(prompt) && Number.isSafeInteger(completion)
            ? { inputTokens: prompt, outputTokens: completion, totalTokens: prompt + completion }
            : undefined;
        if (calls.length > 0) return { state: 'tool_calls', calls: validateCalls(calls, new Set(state.allowedNames)), adapterState: next, transport: streamed ? 'stream' : 'non_stream', ...(usage ? { usage } : {}) };
        const text = content.filter((block) => block.type === 'text').map((block) => String(block.text ?? '')).join('').trim();
        return { state: 'final', output: parseFinalOutput(text, 'llm.tools.anthropic.final'), adapterState: next, transport: streamed ? 'stream' : 'non_stream', ...(usage ? { usage } : {}) };
    }

    private assembleStream(chunks: readonly Record<string, unknown>[]): Record<string, unknown> {
        const complete = chunks.find((chunk) => Array.isArray(chunk.content));
        if (complete) return complete;
        throw createSSHelperError('PROVIDER_RESPONSE_INVALID', { stage: 'llm.tools.anthropic.stream_complete', expected: 'a complete content array' });
    }

    private validateResultSet(state: AnthropicToolState, results: readonly NormalizedToolResult[]): void {
        const expected = new Map(state.pendingCalls.map((call) => [call.callId, call.name]));
        if (expected.size !== results.length || results.some((result) => expected.get(result.callId) !== result.name)) {
            throw createSSHelperError('LLM_TOOL_CONTEXT_INTEGRITY_FAILED', {
                stage: 'llm.tools.anthropic.result_pairing',
                expected: 'one tool_result for every tool_use_id',
            });
        }
    }
}
