import type {
    LLMProvider,
    LLMRequest,
    LLMResponse,
    RerankRequest,
    RerankResponse,
    ProviderConnectionResult,
    ProviderModelListResult,
} from './types';
import { providerConnectionFailure, providerHttpErrorFromResponse, providerModelListFailure, providerProtocolError } from './provider-errors';
import { responseDiagnostics } from './provider-response-diagnostics';

/**
 * 独立自定义重排 Provider
 * 协议: POST {baseUrl}
 * Authorization: Bearer <apiKey>
 * Body: { model, query, documents, top_n }
 */
export class CustomRerankProvider implements LLMProvider {
    id: string;
    kind: 'custom' = 'custom';
    capabilities = {
        chat: false,
        json: false,
        tools: false,
        embeddings: false,
        rerank: true,
        structuredOutput: { transports: ['prompt_only'] as const, preferred: 'prompt_only' as const },
    };

    private apiKey: string;
    private baseUrl: string;
    private model: string;
    private rerankPath: string;
    private customParams: Record<string, unknown>;
    private fetchImpl: typeof fetch;

    constructor(config: {
        id: string;
        apiKey: string;
        baseUrl: string;
        model?: string;
        rerankPath?: string;
        customParams?: Record<string, unknown>;
        fetchImpl?: typeof fetch;
    }) {
        this.id = config.id;
        this.apiKey = config.apiKey;
        this.baseUrl = config.baseUrl.replace(/\/+$/, '');
        this.model = config.model || '';
        this.rerankPath = this.normalizePath(config.rerankPath || '/rerank');
        this.fetchImpl = config.fetchImpl ?? fetch;
        this.customParams = config.customParams && typeof config.customParams === 'object' && !Array.isArray(config.customParams)
            ? { ...config.customParams }
            : {};
    }

    private normalizePath(path: string): string {
        const trimmed = String(path || '').trim() || '/rerank';
        return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    }

    private buildRerankUrl(): string {
        try {
            const base = new URL(this.baseUrl);
            const basePath = base.pathname.replace(/\/+$/, '');
            const rerankPath = this.rerankPath;

            if (basePath && rerankPath.toLowerCase() === basePath.toLowerCase()) {
                return base.toString().replace(/\/+$/, '');
            }

            if (basePath && rerankPath.toLowerCase().startsWith(`${basePath.toLowerCase()}/`)) {
                return `${base.origin}${rerankPath}`;
            }

            return `${this.baseUrl}${rerankPath}`;
        } catch {
            if (this.baseUrl.toLowerCase().endsWith(this.rerankPath.toLowerCase())) {
                return this.baseUrl;
            }
            return `${this.baseUrl}${this.rerankPath}`;
        }
    }

    private buildCandidateUrls(): string[] {
        return [this.buildRerankUrl()];
    }

    private getModelListBaseUrl(): string {
        try {
            const base = new URL(this.baseUrl);
            const basePath = base.pathname.replace(/\/+$/, '');
            const rerankPath = this.rerankPath.toLowerCase();
            if (basePath.toLowerCase() === rerankPath) {
                return base.origin;
            }
            if (basePath.toLowerCase().endsWith(rerankPath)) {
                return `${base.origin}${basePath.slice(0, basePath.length - this.rerankPath.length)}`.replace(/\/+$/, '');
            }
        } catch {
            const lowerBase = this.baseUrl.toLowerCase();
            const lowerPath = this.rerankPath.toLowerCase();
            if (lowerBase.endsWith(lowerPath)) {
                return this.baseUrl.slice(0, this.baseUrl.length - this.rerankPath.length).replace(/\/+$/, '');
            }
        }
        return this.baseUrl;
    }

    private withCustomParams(payload: Record<string, unknown>): Record<string, unknown> {
        return {
            ...this.customParams,
            ...payload,
        };
    }

    private buildPayloadVariants(req: RerankRequest): Array<Record<string, unknown>> {
        const model = String(req.model || this.model || '').trim();
        if (!model) {
            throw new Error('Rerank 请求缺少 model。请在资源配置或路由分配中设置 rerank model。');
        }

        const variants: Array<Record<string, unknown>> = [
            this.withCustomParams({
                model,
                query: req.query,
                documents: req.docs,
                top_n: req.topK,
            }),
            this.withCustomParams({
                model,
                query: req.query,
                documents: req.docs,
                top_k: req.topK,
            }),
            this.withCustomParams({
                model,
                query: req.query,
                documents: req.docs,
                docs: req.docs,
                topK: req.topK,
            }),
            this.withCustomParams({
                model,
                query: req.query,
                input: req.query,
                documents: req.docs,
                top_n: req.topK,
            }),
        ];

        return Array.from(new Set(variants.map((item: Record<string, unknown>) => JSON.stringify(item))))
            .map((text: string) => JSON.parse(text) as Record<string, unknown>);
    }

    private normalizeResponseResults(data: any, req: RerankRequest): RerankResponse {
        const rawResults = Array.isArray(data?.results)
            ? data.results
            : Array.isArray(data?.data)
                ? data.data
                : Array.isArray(data?.ranked_documents)
                    ? data.ranked_documents
                    : Array.isArray(data)
                        ? data
                        : [];

        const normalizedResults = rawResults.map((item: any, fallbackIndex: number) => {
            const rawIndex = Number(item?.index ?? item?.document_index ?? item?.id ?? fallbackIndex);
            const safeIndex = Number.isFinite(rawIndex) && rawIndex >= 0 ? rawIndex : fallbackIndex;
            const rawDoc = item?.document;
            const doc = typeof rawDoc === 'string'
                ? rawDoc
                : typeof rawDoc?.text === 'string'
                    ? rawDoc.text
                    : typeof rawDoc?.content === 'string'
                        ? rawDoc.content
                        : typeof item?.doc === 'string'
                            ? item.doc
                            : typeof item?.text === 'string'
                                ? item.text
                                : req.docs[safeIndex] ?? req.docs[fallbackIndex] ?? '';
            const score = Number(item?.relevance_score ?? item?.score ?? item?.similarity ?? item?.rank_score ?? 0);
            return {
                index: safeIndex,
                score: Number.isFinite(score) ? score : 0,
                doc: String(doc ?? ''),
            };
        });

        return {
            results: typeof req.topK === 'number' && req.topK > 0
                ? normalizedResults.slice(0, req.topK)
                : normalizedResults,
        };
    }

    private async executeCompatibleRerank(req: RerankRequest): Promise<RerankResponse> {
        const urls = this.buildCandidateUrls();
        const payloads = this.buildPayloadVariants(req);
        for (const url of urls) {
            for (const payload of payloads) {
                const response = await this.fetchImpl(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.apiKey}`,
                    },
                    body: JSON.stringify(payload),
                    signal: req.signal,
                });

                if (!response.ok) {
                    if (response.status === 401 || response.status === 403) {
                        throw await providerHttpErrorFromResponse('Rerank', response);
                    }
                    await response.text().catch(() => undefined);
                    continue;
                }

                const data = await response.json().catch(() => ({}));
                const normalized = this.normalizeResponseResults(data, req);
                if (Array.isArray(normalized.results) && normalized.results.length > 0) {
                    return { ...normalized, diagnostics: responseDiagnostics(response, data, { streamed: false }) };
                }
            }
        }

        throw providerProtocolError('Rerank');
    }

    async request(_req: LLMRequest): Promise<LLMResponse> {
        throw new Error('CustomRerankProvider 不支持 chat 请求');
    }

    async rerank(req: RerankRequest): Promise<RerankResponse> {
        return this.executeCompatibleRerank(req);
    }

    async testConnection(signal?: AbortSignal): Promise<ProviderConnectionResult> {
        const start = Date.now();
        try {
            await this.executeCompatibleRerank({
                model: this.model,
                query: 'test',
                docs: ['hello', 'world'],
                topK: 1,
                signal,
            });
            const latencyMs = Date.now() - start;

            return { ok: true, message: '重排服务连接成功', model: this.model, latencyMs };
        } catch (error: unknown) {
            return providerConnectionFailure(error, {
                stage: 'llm.provider.test',
                providerKind: this.kind,
                resourceId: this.id,
                model: this.model,
            }, Date.now() - start);
        }
    }

    async listModels(signal?: AbortSignal): Promise<ProviderModelListResult> {
        try {
            const res = await this.fetchImpl(`${this.getModelListBaseUrl()}/models`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${this.apiKey}` },
                signal,
            });

            if (!res.ok) {
                return providerModelListFailure(await providerHttpErrorFromResponse(this.kind, res), {
                    stage: 'llm.provider.models',
                    providerKind: this.kind,
                    resourceId: this.id,
                });
            }

            const json = await res.json();
            const list = Array.isArray(json?.data)
                ? json.data
                : Array.isArray(json?.models)
                    ? json.models
                    : Array.isArray(json)
                        ? json
                        : [];
            const models = list.map((m: any, index: number) => {
                const rawId = m?.id ?? m?.model ?? m?.name ?? m?.value;
                const id = String(rawId ?? `model-${index + 1}`);
                return { id, label: String(m?.id ?? m?.model ?? m?.name ?? id) };
            });

            return { ok: true, models, message: `共 ${models.length} 个模型` };
        } catch (error: unknown) {
            return providerModelListFailure(error, {
                stage: 'llm.provider.models',
                providerKind: this.kind,
                resourceId: this.id,
            });
        }
    }
}
