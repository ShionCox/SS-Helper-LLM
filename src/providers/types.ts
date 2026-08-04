/**
 * LLM Provider 类型定义
 * 将 Provider 抽象与具体实现解耦
 */

import type { SSHelperFailureContext } from '@ss-helper/sdk';
import type { StructuredOutputIdentity, StructuredOutputPlan, StructuredOutputTransport } from '../schema/structured-output-plan';
import type { ProviderToolAdapter } from '../tools/tool-adapter';

export interface ProviderRequestInit extends RequestInit {
    /** SS-Helper Bridge absolute request budget. Native fetch ignores this field. */
    readonly timeoutMs?: number;
    /** SS-Helper Bridge inactivity budget after the first response chunk. */
    readonly idleTimeoutMs?: number;
}

export type ProviderFetch = (input: RequestInfo | URL, init?: ProviderRequestInit) => Promise<Response>;

export interface ProviderResponseDiagnostics {
    readonly httpStatus?: number;
    readonly contentType?: string;
    readonly receivedBytes?: number;
    readonly streamed?: boolean;
    readonly streamEventCount?: number;
    readonly receivedAt?: number;
}

export interface StructuredOutputCapability {
    readonly transports: readonly StructuredOutputTransport[];
    readonly preferred: StructuredOutputTransport;
}

export interface LLMProviderCapabilities {
    chat: boolean;
    json: boolean;
    tools: boolean;
    embeddings: boolean;
    rerank?: boolean;
    structuredOutput: StructuredOutputCapability;
}

export interface LLMRequest {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    structuredOutput?: StructuredOutputPlan;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface LLMResponse {
    content: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    finishReason?: string;
    debugRequest?: Record<string, unknown>;
    structuredOutput?: {
        plannedTransport: StructuredOutputPlan['transport'];
        actualTransport: StructuredOutputPlan['transport'];
        fallbackReason?: string;
    };
    diagnostics?: ProviderResponseDiagnostics;
}

export interface EmbedRequest {
    texts: string[];
    model?: string;
    dimensions?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface EmbedResponse {
    embeddings: number[][];
    diagnostics?: ProviderResponseDiagnostics;
}

export interface RerankRequest {
    query: string;
    docs: string[];
    topK?: number;
    model?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface RerankResponse {
    results: Array<{ index: number; score: number; doc: string }>;
    diagnostics?: ProviderResponseDiagnostics;
}

// ── 检测与模型列表 ──

export interface ProviderConnectionResult {
    ok: boolean;
    message: string;
    failure?: SSHelperFailureContext;
    model?: string;
    latencyMs?: number;
}

export interface ProviderModelInfo {
    id: string;
    label?: string;
}

export interface ProviderModelListResult {
    ok: boolean;
    models: ProviderModelInfo[];
    message: string;
    failure?: SSHelperFailureContext;
}

/**
 * Provider 抽象接口
 */
export interface LLMProvider {
    id: string;
    kind: 'openai' | 'claude' | 'gemini' | 'local' | 'custom' | 'tavern';
    capabilities: LLMProviderCapabilities;
    request(req: LLMRequest): Promise<LLMResponse>;
    embed?(req: EmbedRequest): Promise<EmbedResponse>;
    rerank?(req: RerankRequest): Promise<RerankResponse>;
    testConnection?(signal?: AbortSignal): Promise<ProviderConnectionResult>;
    listModels?(signal?: AbortSignal): Promise<ProviderModelListResult>;
    dispose?(): void;
    getStructuredOutputIdentity?(model?: string): Promise<StructuredOutputIdentity> | StructuredOutputIdentity;
    getStructuredOutputCapability?(identity: StructuredOutputIdentity): Promise<StructuredOutputCapability> | StructuredOutputCapability;
    createToolAdapter?(): ProviderToolAdapter;
}
