import { createSSHelperError, type LlmReasoningPolicy, type NormalizedToolCall, type NormalizedToolResult, type PlainData, type ProviderToolDialect } from '@ss-helper/sdk';
import type { JsonHttpTransport, ProviderToolAdapter, ProviderToolStartInput, ProviderToolStep } from './tool-adapter';
import { canonicalToolName, createProviderToolNameAliases, estimateJsonBytes, parseArguments, parseFinalOutput, providerToolName, usageFromOpenAi, validateCalls, type ProviderToolNameAliases } from './tool-adapter-utils';
import { OpenAiToolStreamAssembler } from './tool-stream-assembler';
import { compileReasoningFields, type ReasoningProvider } from '../providers/reasoning-policy';
import { isStrictJsonSchemaCompatible } from '../schema/strict-json-schema';

export type OpenAiChatDialectKind = 'standard' | 'deepseek' | 'kimi' | 'glm';
export interface OpenAiChatToolDialectPolicy {
    readonly kind: OpenAiChatDialectKind;
    readonly preserveAssistantMessageVerbatim: true;
    readonly preserveReasoningContent: boolean;
    readonly requireToolNameOnResult: boolean;
    readonly toolChoiceMode: 'full' | 'auto_only';
    readonly supportsStrict: 'beta' | 'none';
    readonly supportsToolStream: boolean;
}

export const OPENAI_CHAT_DIALECT_POLICIES: Readonly<Record<OpenAiChatDialectKind, OpenAiChatToolDialectPolicy>> = Object.freeze({
    standard: { kind: 'standard', preserveAssistantMessageVerbatim: true, preserveReasoningContent: false, requireToolNameOnResult: false, toolChoiceMode: 'full', supportsStrict: 'none', supportsToolStream: false },
    deepseek: { kind: 'deepseek', preserveAssistantMessageVerbatim: true, preserveReasoningContent: true, requireToolNameOnResult: false, toolChoiceMode: 'full', supportsStrict: 'none', supportsToolStream: false },
    kimi: { kind: 'kimi', preserveAssistantMessageVerbatim: true, preserveReasoningContent: true, requireToolNameOnResult: true, toolChoiceMode: 'full', supportsStrict: 'none', supportsToolStream: true },
    glm: { kind: 'glm', preserveAssistantMessageVerbatim: true, preserveReasoningContent: true, requireToolNameOnResult: false, toolChoiceMode: 'auto_only', supportsStrict: 'none', supportsToolStream: true },
});

interface OpenAiChatToolState {
    readonly model: string;
    readonly messages: readonly Record<string, unknown>[];
    readonly tools: readonly Record<string, unknown>[];
    readonly allowedNames: readonly string[];
    readonly toolNames: ProviderToolNameAliases;
    readonly maxTokens: number;
    readonly reasoning?: LlmReasoningPolicy;
    readonly lastAssistant?: Record<string, unknown>;
}

const DIALECTS: Readonly<Record<OpenAiChatDialectKind, ProviderToolDialect>> = Object.freeze({
    standard: 'openai_chat_compatible', deepseek: 'deepseek_chat', kimi: 'kimi_chat', glm: 'glm_chat',
});

export class OpenAiChatToolAdapter implements ProviderToolAdapter<OpenAiChatToolState> {
    readonly dialect: ProviderToolDialect;
    readonly version = 9;
    readonly toolStreamCapability: 'incremental' | 'unsupported';
    readonly strictToolSchemaCapability: 'beta' | 'unsupported';
    constructor(
        private readonly transport: JsonHttpTransport,
        private readonly policy: OpenAiChatToolDialectPolicy,
        private readonly options: { readonly requireReasoningContent?: boolean; readonly enableToolStream?: boolean; readonly reasoningProvider?: ReasoningProvider } = {},
    ) {
        this.dialect = DIALECTS[policy.kind];
        this.toolStreamCapability = policy.supportsToolStream ? 'incremental' : 'unsupported';
        this.strictToolSchemaCapability = policy.supportsStrict === 'beta' ? 'beta' : 'unsupported';
    }

    async start(input: ProviderToolStartInput): Promise<ProviderToolStep<OpenAiChatToolState>> {
        const messages = input.messages.map((message) => ({ role: message.role, content: message.content }));
        // Provider-side strict mode is request-wide for DeepSeek: one optional
        // schema makes a mixed strict request invalid. The session compiler still
        // validates every emitted call locally against its original schema.
        const useProviderStrict = input.tools.length > 0 && this.policy.supportsStrict !== 'none'
            && input.tools.every((tool) => tool.strict !== false && isStrictJsonSchemaCompatible(tool.parameters));
        const toolNames = createProviderToolNameAliases(input.tools.map((tool) => tool.name));
        const tools = input.tools.map((tool) => ({
            type: 'function',
            function: {
                name: providerToolName(toolNames, tool.name),
                description: tool.description,
                parameters: tool.parameters,
                ...(useProviderStrict ? { strict: true } : {}),
            },
        }));
        const base: OpenAiChatToolState = {
            model: input.model,
            messages,
            tools,
            allowedNames: input.tools.map((tool) => tool.name),
            toolNames,
            maxTokens: input.maxTokens,
            ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
        };
        const toolChoice = input.toolChoice === 'required' && this.policy.toolChoiceMode === 'full' ? 'required' : 'auto';
        return this.send(base, true, input.signal, toolChoice);
    }

    async continue(state: OpenAiChatToolState, results: readonly NormalizedToolResult[], signal: AbortSignal): Promise<ProviderToolStep<OpenAiChatToolState>> {
        if (!state.lastAssistant) this.integrity('missing assistant tool_calls before tool results');
        const calls = Array.isArray(state.lastAssistant.tool_calls) ? state.lastAssistant.tool_calls as Array<Record<string, unknown>> : [];
        const expected = new Map(calls.map((call) => [
            String(call.id ?? ''),
            canonicalToolName(state.toolNames, String((call.function as Record<string, unknown> | undefined)?.name ?? '')),
        ]));
        if (expected.size !== results.length || results.some((result) => expected.get(result.callId) !== result.name)) this.integrity('tool result ids must match the complete assistant tool_calls set');
        const toolMessages = results.map((result) => ({
            role: 'tool',
            tool_call_id: result.callId,
            ...(this.policy.requireToolNameOnResult ? { name: providerToolName(state.toolNames, result.name) } : {}),
            content: JSON.stringify(result.content),
        }));
        return this.send({ ...state, messages: [...state.messages, ...toolMessages], lastAssistant: undefined }, true, signal);
    }

    async finalize(state: OpenAiChatToolState, finalInstruction: string, _outputSchema: PlainData, signal: AbortSignal): Promise<ProviderToolStep<OpenAiChatToolState>> {
        const messages = [...state.messages, { role: 'user', content: finalInstruction }];
        return this.send({ ...state, messages, lastAssistant: undefined }, false, signal);
    }

    estimateStateBytes(state: OpenAiChatToolState): number { return estimateJsonBytes(state); }
    dispose(_state: OpenAiChatToolState): void {}

    private async send(state: OpenAiChatToolState, allowTools: boolean, signal: AbortSignal, toolChoice: 'auto' | 'required' = 'auto'): Promise<ProviderToolStep<OpenAiChatToolState>> {
        const useStream = this.policy.supportsToolStream
            && this.options.enableToolStream === true
            && this.transport.sendStream !== undefined;
        const body: Record<string, unknown> = {
            model: state.model,
            messages: state.messages,
            max_tokens: state.maxTokens,
            stream: useStream,
            ...compileReasoningFields({
                provider: this.options.reasoningProvider ?? (this.policy.kind === 'deepseek' ? 'deepseek' : this.policy.kind === 'kimi' ? 'kimi' : this.policy.kind === 'glm' ? 'glm' : 'generic'),
                dialect: this.dialect,
                policy: state.reasoning,
                execution: 'tool_turn',
            }),
            ...(this.options.reasoningProvider === 'tavern' && state.reasoning !== undefined ? { __ss_helper_reasoning: state.reasoning } : {}),
            ...(useStream && this.policy.kind === 'glm' ? { tool_stream: true } : {}),
            ...(allowTools ? {
                tools: state.tools,
                // DeepSeek V4 enables thinking by default and rejects tool_choice
                // in thinking mode. The caller still enforces required tool use
                // locally by rejecting a turn that does not emit a valid call.
                ...(this.policy.kind === 'deepseek' ? {} : { tool_choice: toolChoice }),
            } : {}),
            ...(this.policy.kind === 'deepseek' ? { response_format: { type: 'json_object' } } : {}),
        };
        const data = useStream
            ? this.assembleStream(await this.transport.sendStream!(body, signal))
            : await this.transport.send(body, signal);
        const choices = Array.isArray(data.choices) ? data.choices as Array<Record<string, unknown>> : [];
        const finishReason = choices[0]?.finish_reason;
        const diagnostics: NonNullable<ProviderToolStep['diagnostics']> = {
            jsonOutputMode: this.policy.kind === 'deepseek' ? 'json_object' as const : 'prompt_json' as const,
            strictToolSchema: allowTools && state.tools.length > 0 && state.tools.every(tool => (tool.function as Record<string, unknown>).strict === true) ? 'beta' as const : 'none' as const,
            ...(finishReason === undefined ? {} : { finishReason: finishReason === 'stop' || finishReason === 'tool_calls' || finishReason === 'length' ? finishReason : 'other' as const }),
        };
        if (choices[0]?.finish_reason === 'length') {
            throw createSSHelperError('STRUCTURED_OUTPUT_TRUNCATED', {
                stage: 'llm.tools.openai_chat.final',
            });
        }
        const message = choices[0]?.message;
        if (typeof message !== 'object' || message === null || Array.isArray(message)) this.integrity('one assistant message');
        const assistant: Record<string, unknown> = { ...(message as Record<string, unknown>), role: 'assistant' };
        const rawCalls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls as Array<Record<string, unknown>> : [];
        if (this.policy.kind === 'deepseek' && rawCalls.length > 0 && assistant.content == null) assistant.content = '';
        const requiresReasoningReplay = this.options.requireReasoningContent === true
            || (this.policy.kind === 'deepseek' && state.reasoning?.mode === 'enabled');
        if (requiresReasoningReplay && rawCalls.length > 0 && assistant.reasoning_content === undefined) {
            this.integrity('reasoning_content for an enabled thinking tool turn');
        }
        const next = { ...state, messages: [...state.messages, assistant], lastAssistant: assistant };
        if (rawCalls.length > 0) {
            const calls: NormalizedToolCall[] = rawCalls.map((call, index) => {
                const fn = call.function;
                if (typeof fn !== 'object' || fn === null || Array.isArray(fn)) this.integrity(`function payload for tool call ${index}`);
                const functionRecord = fn as Record<string, unknown>;
                return {
                    callId: String(call.id ?? ''),
                    name: canonicalToolName(state.toolNames, String(functionRecord.name ?? '')),
                    arguments: parseArguments(functionRecord.arguments, `$.choices[0].message.tool_calls[${index}].function.arguments`),
                };
            });
            return { state: 'tool_calls', calls: validateCalls(calls, new Set(state.allowedNames)), adapterState: next, transport: useStream ? 'stream' : 'non_stream', usage: usageFromOpenAi(data), diagnostics };
        }
        const content = assistant.content;
        return { state: 'final', output: parseFinalOutput(content, 'llm.tools.openai_chat.final'), adapterState: next, transport: useStream ? 'stream' : 'non_stream', usage: usageFromOpenAi(data), diagnostics };
    }

    private assembleStream(chunks: readonly Record<string, unknown>[]): Record<string, unknown> {
        const assembler = new OpenAiToolStreamAssembler();
        let content = '';
        let reasoningContent = '';
        let usage: unknown;
        let finishReason: unknown;
        for (const chunk of chunks) {
            if (chunk.usage !== undefined) usage = chunk.usage;
            const choices = Array.isArray(chunk.choices) ? chunk.choices as Array<Record<string, unknown>> : [];
            if (choices[0]?.finish_reason !== undefined) finishReason = choices[0].finish_reason;
            const delta = choices[0]?.delta;
            if (!delta || typeof delta !== 'object' || Array.isArray(delta)) continue;
            const record = delta as Record<string, unknown>;
            if (typeof record.content === 'string') content += record.content;
            if (typeof record.reasoning_content === 'string') reasoningContent += record.reasoning_content;
            if (!Array.isArray(record.tool_calls)) continue;
            for (const raw of record.tool_calls as Array<Record<string, unknown>>) {
                const fn = raw.function && typeof raw.function === 'object' && !Array.isArray(raw.function) ? raw.function as Record<string, unknown> : {};
                assembler.push({
                    index: Number(raw.index),
                    ...(typeof raw.id === 'string' && raw.id ? { id: raw.id } : {}),
                    ...(typeof fn.name === 'string' && fn.name ? { name: fn.name } : {}),
                    ...(typeof fn.arguments === 'string' && fn.arguments ? { arguments: fn.arguments } : {}),
                });
            }
        }
        const rawCalls = assembler.finishRaw();
        const message: Record<string, unknown> = {
            role: 'assistant',
            ...(content ? { content } : { content: null }),
            ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
            ...(rawCalls.length ? { tool_calls: rawCalls.map(call => ({ id: call.callId, type: 'function', function: { name: call.name, arguments: call.argumentsText } })) } : {}),
        };
        return { choices: [{ message, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }], ...(usage === undefined ? {} : { usage }) };
    }

    private integrity(expected: string): never {
        throw createSSHelperError('LLM_TOOL_CONTEXT_INTEGRITY_FAILED', {
            stage: 'llm.tools.openai_chat.integrity',
            expected,
        });
    }
}
