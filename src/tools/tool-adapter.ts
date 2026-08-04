import type {
    LlmMessage,
    LlmToolDefinition,
    NormalizedToolCall,
    NormalizedToolResult,
    PlainData,
    ProviderPrivacyPolicy,
    ProviderToolDialect,
} from '@ss-helper/sdk';

export interface ProviderToolStartInput {
    readonly resourceId: string;
    readonly model: string;
    readonly messages: readonly LlmMessage[];
    readonly tools: readonly LlmToolDefinition[];
    readonly outputSchema: PlainData;
    readonly privacyPolicy: ProviderPrivacyPolicy;
    readonly maxTokens: number;
    /** Initial provider turn only; normal Agent calls default to auto. */
    readonly toolChoice?: 'auto' | 'required';
    readonly signal: AbortSignal;
}

export type ProviderToolStep<TState = unknown> =
    | {
        readonly state: 'tool_calls';
        readonly calls: readonly NormalizedToolCall[];
        readonly adapterState: TState;
        readonly transport?: 'stream' | 'non_stream';
        readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly totalTokens?: number };
    }
    | {
        readonly state: 'final';
        readonly output: PlainData;
        readonly adapterState: TState;
        readonly transport?: 'stream' | 'non_stream';
        readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly totalTokens?: number };
    };

export interface ProviderToolAdapter<TState = unknown> {
    readonly dialect: ProviderToolDialect;
    readonly version: number;
    start(input: ProviderToolStartInput): Promise<ProviderToolStep<TState>>;
    continue(
        state: TState,
        results: readonly NormalizedToolResult[],
        signal: AbortSignal,
    ): Promise<ProviderToolStep<TState>>;
    finalize(
        state: TState,
        finalInstruction: string,
        outputSchema: PlainData,
        signal: AbortSignal,
    ): Promise<ProviderToolStep<TState>>;
    estimateStateBytes(state: TState): number;
    dispose(state: TState): void;
}

export interface ToolCapableProvider {
    createToolAdapter(): ProviderToolAdapter;
}

export function isToolCapableProvider(value: unknown): value is ToolCapableProvider {
    return typeof (value as { createToolAdapter?: unknown } | null)?.createToolAdapter === 'function';
}

export interface JsonHttpTransport {
    readonly resourceId: string;
    readonly defaultModel: string;
    send(body: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>;
    sendStream?(body: Record<string, unknown>, signal: AbortSignal): Promise<readonly Record<string, unknown>[]>;
}
