/**
 * LLM Provider 类型定义
 * 将 Provider 抽象与具体实现解耦
 */

import type { ApiType } from '../schema/types';
import type { SchemaCompatOptions } from '../schema/strict-json-schema';

export interface LLMProviderCapabilities {
    chat: boolean;
    json: boolean;
    tools: boolean;
    embeddings: boolean;
    rerank?: boolean;
}

export interface LLMRequest {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    schema?: object;
    schemaName?: string;
    preferredResponseFormat?: 'json_object' | 'json_schema' | 'system_json';
    schemaCompat?: SchemaCompatOptions;
    signal?: AbortSignal;
}

export interface LLMResponse {
    content: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    finishReason?: string;
    debugRequest?: Record<string, unknown>;
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
    errorCode?: string;
    detail?: string;
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
    errorCode?: string;
    detail?: string;
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
    testConnection?(): Promise<ProviderConnectionResult>;
    listModels?(): Promise<ProviderModelListResult>;
    dispose?(): void;
}
