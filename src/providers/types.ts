/**
 * LLM Provider 类型定义
 * 将 Provider 抽象与具体实现解耦
 */

import type { SSHelperFailureContext } from '@ss-helper/sdk';
import type { StructuredOutputIdentity, StructuredOutputPlan, StructuredOutputTransport } from '../schema/structured-output-plan';

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
}

export interface EmbedRequest {
    texts: string[];
    model?: string;
    signal?: AbortSignal;
}

export interface EmbedResponse {
    embeddings: number[][];
}

export interface RerankRequest {
    query: string;
    docs: string[];
    topK?: number;
    model?: string;
    signal?: AbortSignal;
}

export interface RerankResponse {
    results: Array<{ index: number; score: number; doc: string }>;
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
}
