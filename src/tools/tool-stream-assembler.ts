import { createSSHelperError, type NormalizedToolCall } from '@ss-helper/sdk';

interface StreamedToolCallPart {
    readonly index: number;
    readonly id?: string;
    readonly name?: string;
    readonly arguments?: string;
}

interface MutableCall {
    id: string;
    name: string;
    arguments: string;
}

export interface AssembledToolCall {
    readonly callId: string;
    readonly name: string;
    readonly argumentsText: string;
}

export class OpenAiToolStreamAssembler {
    private readonly calls = new Map<number, MutableCall>();
    constructor(private readonly maxArgumentChars = 32_000) {}

    push(part: StreamedToolCallPart): void {
        if (!Number.isSafeInteger(part.index) || part.index < 0) this.fail('$.tool_calls.index', 'a non-negative integer');
        const current = this.calls.get(part.index) ?? { id: '', name: '', arguments: '' };
        if (part.id && current.id && part.id !== current.id) this.fail(`$.tool_calls[${part.index}].id`, 'one stable call id');
        if (part.name && current.name && part.name !== current.name) this.fail(`$.tool_calls[${part.index}].function.name`, 'one stable tool name');
        if (part.id) current.id = part.id;
        if (part.name) current.name = part.name;
        if (part.arguments) current.arguments += part.arguments;
        if (current.arguments.length > this.maxArgumentChars) this.fail(`$.tool_calls[${part.index}].function.arguments`, `at most ${this.maxArgumentChars} characters`);
        this.calls.set(part.index, current);
    }

    finish(): readonly NormalizedToolCall[] {
        return this.finishRaw().map(call => {
            let args: unknown;
            try { args = JSON.parse(call.argumentsText || '{}'); }
            catch { this.fail('$.tool_calls.function.arguments', 'complete JSON arguments'); }
            if (typeof args !== 'object' || args === null || Array.isArray(args)) this.fail('$.tool_calls.function.arguments', 'one JSON object');
            return { callId: call.callId, name: call.name, arguments: args as never };
        });
    }

    finishRaw(): readonly AssembledToolCall[] {
        const output: AssembledToolCall[] = [];
        for (const [index, call] of [...this.calls.entries()].sort(([left], [right]) => left - right)) {
            if (!call.id || !call.name) this.fail(`$.tool_calls[${index}]`, 'a complete id and function name');
            try {
                const args = JSON.parse(call.arguments || '{}');
                if (typeof args !== 'object' || args === null || Array.isArray(args)) this.fail(`$.tool_calls[${index}].function.arguments`, 'one JSON object');
            } catch (error) {
                if ((error as { details?: unknown })?.details) throw error;
                this.fail(`$.tool_calls[${index}].function.arguments`, 'complete JSON arguments');
            }
            output.push({ callId: call.id, name: call.name, argumentsText: call.arguments || '{}' });
        }
        return output;
    }

    private fail(path: string, expected: string): never {
        throw createSSHelperError('LLM_TOOL_CONTEXT_INTEGRITY_FAILED', {
            stage: 'llm.tools.stream.assemble',
            path,
            keyword: 'complete',
            expected,
        });
    }
}
