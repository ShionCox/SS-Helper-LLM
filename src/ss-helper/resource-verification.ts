import type {
  PlainData,
  PluginApiRequest,
  PluginApiResponse,
  PluginRequestOptions,
  SSHelperReasonCode,
} from '@ss-helper/sdk';
import { readSSHelperFailure } from '@ss-helper/sdk';
import type { ProviderConnectionResult, ProviderModelInfo } from '../providers/types';
import type { ResourceConfig } from '../schema/types';
import { createProviderFromResource } from './llm-service-runtime';
import { isOfficialDeepSeekBetaUrl } from '../providers/deepseek-endpoint';

export type ResourceVerificationCheckId = 'network' | 'auth' | 'model' | 'capability';
export type ResourceVerificationState = 'idle' | 'running' | 'success' | 'error';

export interface ResourceVerificationCheck {
  readonly state: ResourceVerificationState;
  readonly description: string;
}

export interface ResourceVerificationSnapshot {
  readonly network: ResourceVerificationCheck;
  readonly auth: ResourceVerificationCheck;
  readonly model: ResourceVerificationCheck;
  readonly capability: ResourceVerificationCheck;
}

export interface ResourceVerificationResult {
  readonly ok: boolean;
  readonly reasonCode?: SSHelperReasonCode;
  readonly checks: ResourceVerificationSnapshot;
  readonly models: readonly ProviderModelInfo[];
}

export interface ResourceVerificationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onProgress?: (snapshot: ResourceVerificationSnapshot) => void;
}

export interface ResourceModelDiscoveryResult {
  readonly ok: boolean;
  readonly supported: boolean;
  readonly reasonCode?: SSHelperReasonCode;
  readonly models: readonly ProviderModelInfo[];
}

export type ResourceProbeRequest = (
  request: PluginApiRequest,
  options?: PluginRequestOptions,
) => Promise<PluginApiResponse>;

interface CompatibleStatusResult {
  readonly ok: boolean;
  readonly reasonCode?: SSHelperReasonCode;
  readonly models: readonly ProviderModelInfo[];
}

const IDLE_CHECKS: ResourceVerificationSnapshot = Object.freeze({
  network: Object.freeze({ state: 'idle', description: '等待检查服务地址' }),
  auth: Object.freeze({ state: 'idle', description: '等待检查 API Key' }),
  model: Object.freeze({ state: 'idle', description: '等待检查模型' }),
  capability: Object.freeze({ state: 'idle', description: '等待检查用途能力' }),
});

function requiredCapabilities(type: ResourceConfig['type']): readonly ('chat' | 'json' | 'embeddings' | 'rerank')[] {
  if (type === 'embedding') return ['embeddings'];
  if (type === 'rerank') return ['rerank'];
  return ['chat', 'json'];
}

function copyChecks(checks: ResourceVerificationSnapshot): ResourceVerificationSnapshot {
  return {
    network: { ...checks.network },
    auth: { ...checks.auth },
    model: { ...checks.model },
    capability: { ...checks.capability },
  };
}

function failureReasonCode(error: unknown, fallback: SSHelperReasonCode, stage: string): SSHelperReasonCode {
  if (error && typeof error === 'object' && 'name' in error && (error as { name?: unknown }).name === 'AbortError') {
    return 'REQUEST_ABORTED';
  }
  return readSSHelperFailure(error, { reasonCode: fallback, stage })!.reasonCode;
}

function record(value: PlainData | undefined): Readonly<Record<string, PlainData>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, PlainData>>
    : undefined;
}

function supportsTavernCompatibleProbe(resource: ResourceConfig): boolean {
  return resource.type === 'generation'
    && resource.baseUrl !== undefined
    && (resource.apiType === 'openai' || resource.apiType === 'deepseek' || resource.apiType === 'generic');
}

function responseReason(response: PluginApiResponse, fallback: SSHelperReasonCode): SSHelperReasonCode {
  if (response.status === 401 || response.status === 403) return 'AUTH_FAILED';
  if (response.status === 408 || response.status === 504) return 'HTTP_REQUEST_TIMEOUT';
  if (response.status >= 500) return 'PROVIDER_SERVICE_UNAVAILABLE';
  return fallback;
}

export class ResourceVerificationCoordinator {
  readonly #request?: ResourceProbeRequest;
  readonly #fetchImpl: typeof fetch;

  constructor(options: { request?: ResourceProbeRequest; fetchImpl?: typeof fetch } = {}) {
    this.#request = options.request;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  async #compatibleStatus(
    resource: ResourceConfig,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<CompatibleStatusResult> {
    if (this.#request === undefined || resource.baseUrl === undefined) {
      return { ok: false, reasonCode: 'LLM_MODEL_DISCOVERY_UNSUPPORTED', models: [] };
    }
    const response = await this.#request({
      path: '/api/backends/chat-completions/status',
      method: 'POST',
      body: {
        chat_completion_source: 'openai',
        reverse_proxy: resource.baseUrl,
        proxy_password: apiKey,
      },
    }, { signal });
    const body = record(response.body);
    if (!response.ok || body?.error === true) {
      return {
        ok: false,
        reasonCode: responseReason(response, 'LLM_PROVIDER_TEST_FAILED'),
        models: [],
      };
    }
    const rawModels = Array.isArray(body?.data) ? body.data : [];
    const seen = new Set<string>();
    const models: ProviderModelInfo[] = [];
    for (const rawModel of rawModels) {
      const model = record(rawModel);
      const id = typeof model?.id === 'string' ? model.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const label = typeof model?.name === 'string' && model.name.trim()
        ? model.name.trim()
        : undefined;
      models.push({ id, ...(label === undefined ? {} : { label }) });
    }
    return { ok: true, models };
  }

  async #compatibleGenerationProbe(
    resource: ResourceConfig,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<{ readonly ok: boolean; readonly reasonCode?: SSHelperReasonCode }> {
    if (this.#request === undefined || resource.baseUrl === undefined || !resource.model) {
      return { ok: false, reasonCode: 'LLM_MODEL_PROBE_FAILED' };
    }
    const response = await this.#request({
      path: '/api/backends/chat-completions/generate',
      method: 'POST',
      body: {
        chat_completion_source: 'openai',
        reverse_proxy: resource.baseUrl,
        proxy_password: apiKey,
        model: resource.model,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        temperature: 0,
        max_tokens: 2,
        stream: false,
      },
    }, { signal });
    const body = record(response.body);
    if (!response.ok || body?.error !== undefined) {
      return {
        ok: false,
        reasonCode: responseReason(response, 'LLM_MODEL_PROBE_FAILED'),
      };
    }
    const choices = Array.isArray(body?.choices) ? body.choices : [];
    return choices.length > 0
      ? { ok: true }
      : { ok: false, reasonCode: 'LLM_MODEL_PROBE_FAILED' };
  }

  async discoverModels(
    resource: ResourceConfig,
    apiKey: string,
    options: Pick<ResourceVerificationOptions, 'signal' | 'timeoutMs'> = {},
  ): Promise<ResourceModelDiscoveryResult> {
    if (resource.apiType === 'deepseek' && isOfficialDeepSeekBetaUrl(resource.baseUrl)) {
      return { ok: false, supported: false, reasonCode: 'LLM_MODEL_DISCOVERY_UNSUPPORTED', models: [] };
    }
    if (this.#request !== undefined && supportsTavernCompatibleProbe(resource)) {
      const timeoutController = new AbortController();
      const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 12_000, 120_000));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        timeoutController.abort();
      }, timeoutMs);
      const abortFromCaller = (): void => timeoutController.abort();
      if (options.signal?.aborted === true) timeoutController.abort();
      options.signal?.addEventListener('abort', abortFromCaller, { once: true });
      try {
        const result = await this.#compatibleStatus(resource, apiKey, timeoutController.signal);
        if (timeoutController.signal.aborted) throw new DOMException('aborted', 'AbortError');
        return {
          ok: result.ok,
          supported: true,
          ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }),
          models: result.models,
        };
      } catch (error) {
        return {
          ok: false,
          supported: true,
          reasonCode: timedOut ? 'HTTP_REQUEST_TIMEOUT' : failureReasonCode(error, 'LLM_MODEL_DISCOVERY_FAILED', 'llm.resource.models'),
          models: [],
        };
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abortFromCaller);
      }
    }
    const provider = createProviderFromResource(resource, apiKey, this.#fetchImpl);
    const timeoutController = new AbortController();
    const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 12_000, 120_000));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);
    const abortFromCaller = (): void => timeoutController.abort();
    if (options.signal?.aborted === true) timeoutController.abort();
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    try {
      if (provider.listModels === undefined) return { ok: false, supported: false, reasonCode: 'LLM_MODEL_DISCOVERY_UNSUPPORTED', models: [] };
      const listed = await provider.listModels(timeoutController.signal);
      if (timeoutController.signal.aborted) throw new DOMException('aborted', 'AbortError');
      if (!listed.ok) {
        return {
          ok: false,
          supported: true,
          reasonCode: listed.failure?.reasonCode ?? 'LLM_MODEL_DISCOVERY_FAILED',
          models: [],
        };
      }
      const seen = new Set<string>();
      const models = listed.models.filter((model) => model.id.trim() !== '' && !seen.has(model.id) && seen.add(model.id));
      return { ok: true, supported: true, models };
    } catch (error) {
      return {
        ok: false,
        supported: true,
        reasonCode: timedOut ? 'HTTP_REQUEST_TIMEOUT' : failureReasonCode(error, 'LLM_MODEL_DISCOVERY_FAILED', 'llm.resource.models'),
        models: [],
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortFromCaller);
      provider.dispose?.();
    }
  }

  async verify(resource: ResourceConfig, apiKey: string, options: ResourceVerificationOptions = {}): Promise<ResourceVerificationResult> {
    if (this.#request !== undefined && supportsTavernCompatibleProbe(resource)) {
      return this.#verifyCompatible(resource, apiKey, options);
    }
    const provider = createProviderFromResource(resource, apiKey, this.#fetchImpl);
    const timeoutController = new AbortController();
    const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 20_000, 120_000));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);
    const abortFromCaller = (): void => timeoutController.abort();
    if (options.signal?.aborted === true) timeoutController.abort();
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    let checks = copyChecks(IDLE_CHECKS);
    const update = (id: ResourceVerificationCheckId, state: ResourceVerificationState, description: string): void => {
      checks = { ...checks, [id]: { state, description } };
      options.onProgress?.(copyChecks(checks));
    };

    try {
      update('network', 'running', '正在连接服务');
      update('auth', 'running', '正在验证 API Key');
      const connection: ProviderConnectionResult | undefined = resource.type === 'embedding'
        ? provider.embed === undefined
          ? undefined
          : await provider.embed({ texts: ['connection-check'], model: resource.model, signal: timeoutController.signal })
            .then(() => ({ ok: true, message: 'ok' }))
        : resource.type === 'rerank'
          ? provider.rerank === undefined
            ? undefined
            : await provider.rerank({ query: 'connection-check', docs: ['connection-check'], topK: 1, model: resource.model, signal: timeoutController.signal })
              .then(() => ({ ok: true, message: 'ok' }))
          : await provider.testConnection?.(timeoutController.signal);
      if (timeoutController.signal.aborted) throw new DOMException('aborted', 'AbortError');
      if (connection === undefined) {
        update('network', 'error', 'Provider 未提供连接测试');
        update('auth', 'error', '无法确认鉴权状态');
        return { ok: false, reasonCode: 'LLM_CAPABILITY_UNAVAILABLE', checks, models: [] };
      }
      if (!connection.ok) {
        const code = connection.failure?.reasonCode ?? 'LLM_PROVIDER_TEST_FAILED';
        if (code === 'HTTP_TRANSPORT_ERROR' || code === 'HTTP_REQUEST_TIMEOUT') {
          update('network', 'error', timedOut ? '连接超时' : '无法连接服务');
          update('auth', 'error', '尚未完成鉴权');
        } else if (code === 'AUTH_FAILED') {
          update('network', 'success', '服务地址可访问');
          update('auth', 'error', 'API Key 无效或权限不足');
        } else {
          update('network', 'success', '服务已响应');
          update('auth', 'success', '服务未报告鉴权失败');
        }
        update('model', 'error', '模型检查未通过');
        return { ok: false, reasonCode: code, checks, models: [] };
      }
      update('network', 'success', '服务地址可访问');
      update('auth', 'success', 'API Key 验证通过');

      update('model', 'running', '正在确认模型');
      let models: readonly ProviderModelInfo[] = [];
      const listed = await provider.listModels?.(timeoutController.signal);
      if (listed?.ok) models = listed.models;
      const configuredModel = resource.model?.trim();
      if (configuredModel && models.length > 0 && !models.some((model) => model.id === configuredModel)) {
        update('model', 'error', '模型不在服务返回的列表中');
        return { ok: false, reasonCode: 'MODEL_NOT_FOUND', checks, models };
      }
      update('model', 'success', configuredModel ? '模型可用' : '服务模型检查通过');

      update('capability', 'running', '正在核对用途能力');
      const missing = requiredCapabilities(resource.type).filter((capability) => provider.capabilities[capability] !== true);
      if (missing.length > 0) {
        update('capability', 'error', 'Provider 不支持所选用途');
        return { ok: false, reasonCode: 'LLM_CAPABILITY_UNAVAILABLE', checks, models };
      }
      update('capability', 'success', '用途能力匹配');
      return { ok: true, checks, models };
    } catch (error) {
      const code = timedOut ? 'HTTP_REQUEST_TIMEOUT' : failureReasonCode(error, 'LLM_PROVIDER_TEST_FAILED', 'llm.resource.verify');
      const description = code === 'REQUEST_ABORTED' ? '验证已取消' : code === 'HTTP_REQUEST_TIMEOUT' ? '验证超时' : '验证请求失败';
      if (checks.network.state === 'running') update('network', 'error', description);
      if (checks.auth.state === 'running') update('auth', 'error', description);
      if (checks.model.state === 'running') update('model', 'error', description);
      if (checks.capability.state === 'running') update('capability', 'error', description);
      return { ok: false, reasonCode: code, checks, models: [] };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortFromCaller);
      provider.dispose?.();
    }
  }

  async #verifyCompatible(
    resource: ResourceConfig,
    apiKey: string,
    options: ResourceVerificationOptions,
  ): Promise<ResourceVerificationResult> {
    const timeoutController = new AbortController();
    const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 20_000, 120_000));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);
    const abortFromCaller = (): void => timeoutController.abort();
    if (options.signal?.aborted === true) timeoutController.abort();
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    let checks = copyChecks(IDLE_CHECKS);
    let models: readonly ProviderModelInfo[] = [];
    const update = (id: ResourceVerificationCheckId, state: ResourceVerificationState, description: string): void => {
      checks = { ...checks, [id]: { state, description } };
      options.onProgress?.(copyChecks(checks));
    };
    try {
      update('network', 'running', '正在通过酒馆连接服务');
      update('auth', 'running', '正在验证草稿 API Key');
      if (resource.apiType === 'deepseek' && isOfficialDeepSeekBetaUrl(resource.baseUrl)) {
        update('model', 'running', '正在直接调用所选模型');
        const probe = await this.#compatibleGenerationProbe(resource, apiKey, timeoutController.signal);
        if (timeoutController.signal.aborted) throw new DOMException('aborted', 'AbortError');
        if (!probe.ok) {
          const code = probe.reasonCode ?? 'LLM_MODEL_PROBE_FAILED';
          if (code === 'AUTH_FAILED') {
            update('network', 'success', '服务地址可访问');
            update('auth', 'error', 'API Key 无效或权限不足');
          } else if (code === 'HTTP_TRANSPORT_ERROR' || code === 'HTTP_REQUEST_TIMEOUT') {
            update('network', 'error', code === 'HTTP_REQUEST_TIMEOUT' ? '连接超时' : '无法连接服务');
            update('auth', 'error', '尚未完成鉴权');
          } else {
            update('network', 'success', '服务已响应');
            update('auth', 'success', '服务未报告鉴权失败');
          }
          update('model', 'error', '模型调用未通过');
          return { ok: false, reasonCode: code, checks, models: [] };
        }
        update('network', 'success', '服务地址可访问');
        update('auth', 'success', 'API Key 验证通过');
        update('model', 'success', '模型可用');
        update('capability', 'running', '正在核对用途能力');
        update('capability', 'success', '用途能力匹配');
        return { ok: true, checks, models: [] };
      }
      const status = await this.#compatibleStatus(resource, apiKey, timeoutController.signal);
      if (timeoutController.signal.aborted) throw new DOMException('aborted', 'AbortError');
      if (!status.ok) {
        update('network', 'error', '服务地址或代理请求不可用');
        update('auth', 'error', '无法确认 API Key');
        update('model', 'error', '模型检查未通过');
        return {
          ok: false,
          reasonCode: status.reasonCode ?? 'LLM_PROVIDER_TEST_FAILED',
          checks,
          models: [],
        };
      }
      models = status.models;
      update('network', 'success', '服务地址可访问');
      update('auth', 'success', 'API Key 验证通过');

      update('model', 'running', '正在确认并调用所选模型');
      const configuredModel = resource.model?.trim();
      if (!configuredModel) {
        update('model', 'error', '尚未选择模型');
        return { ok: false, reasonCode: 'LLM_REQUEST_INVALID', checks, models };
      }
      if (models.length > 0 && !models.some((model) => model.id === configuredModel)) {
        update('model', 'error', '模型不在服务返回的列表中');
        return { ok: false, reasonCode: 'MODEL_NOT_FOUND', checks, models };
      }
      const probe = await this.#compatibleGenerationProbe(resource, apiKey, timeoutController.signal);
      if (timeoutController.signal.aborted) throw new DOMException('aborted', 'AbortError');
      if (!probe.ok) {
        update('model', 'error', '模型调用未通过');
        return { ok: false, reasonCode: probe.reasonCode ?? 'LLM_MODEL_PROBE_FAILED', checks, models };
      }
      update('model', 'success', '模型可用');

      update('capability', 'running', '正在核对用途能力');
      update('capability', 'success', '用途能力匹配');
      return { ok: true, checks, models };
    } catch (error) {
      const code = timedOut ? 'HTTP_REQUEST_TIMEOUT' : failureReasonCode(error, 'LLM_PROVIDER_TEST_FAILED', 'llm.resource.verify');
      const description = code === 'REQUEST_ABORTED' ? '验证已取消' : code === 'HTTP_REQUEST_TIMEOUT' ? '验证超时' : '验证请求失败';
      if (checks.network.state === 'running') update('network', 'error', description);
      if (checks.auth.state === 'running') update('auth', 'error', description);
      if (checks.model.state === 'running') update('model', 'error', description);
      if (checks.capability.state === 'running') update('capability', 'error', description);
      return { ok: false, reasonCode: code, checks, models };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}
