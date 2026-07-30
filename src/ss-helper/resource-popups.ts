import {
  createSSHelperError,
  readSSHelperFailure,
  type PlainData,
  type PluginSession,
  type PopupMenuHandle,
  type PopupUiContext,
  type PopupWizardAdapter,
  type PopupWizardDefinition,
  type PopupWizardSnapshot,
  type SSHelperFailureContext,
  type SSHelperReasonCode,
} from '@ss-helper/sdk';
import type { LLMCapability, ResourceConfig, ResourceType } from '../schema/types';
import { LlmWorkspaceRepository, type ResourceHealthRecord } from '../storage/llm-workspace-repository';
import {
  LLM_POPUP_VERSION,
  LLM_RESOURCE_MANAGER_POPUP,
  LLM_RESOURCE_WIZARD_POPUP,
} from './settings';
import {
  ResourceVerificationCoordinator,
  type ResourceVerificationSnapshot,
} from './resource-verification';
import { createCoreBridgeFetch } from './core-bridge-fetch';

type WizardStepId = 'purpose' | 'provider' | 'connection' | 'verification';
type ApiType = Exclude<ResourceConfig['apiType'], 'auto'>;
type ResourceNotifier = (level: 'success' | 'error', title: string, message: string, code: string) => void;

interface ResourceDraft {
  type: ResourceType;
  apiType: ApiType;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface ResourceWizardState {
  activeStepId: WizardStepId;
  readonly completed: Set<WizardStepId>;
  draft: ResourceDraft;
  fieldErrors: Record<string, string>;
  checks: ResourceVerificationSnapshot;
  busy: boolean;
  dirty: boolean;
  modelOptions: readonly { value: string; label: string }[];
  discoveringModels: boolean;
  status?: PopupWizardSnapshot['status'];
}

const STEP_IDS: readonly WizardStepId[] = ['purpose', 'provider', 'connection', 'verification'];
const PROVIDERS: readonly ApiType[] = ['openai', 'deepseek', 'claude', 'gemini', 'generic'];
const PROVIDER_LABELS: Readonly<Record<ApiType, string>> = Object.freeze({
  openai: 'OpenAI-compatible',
  deepseek: 'DeepSeek',
  claude: 'Claude',
  gemini: 'Gemini',
  generic: '通用兼容服务',
});
const PROVIDER_URLS: Readonly<Record<ApiType, string>> = Object.freeze({
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  claude: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  generic: '',
});
const PURPOSE_LABELS: Readonly<Record<ResourceType, string>> = Object.freeze({
  generation: '生成',
  embedding: '向量化',
  rerank: '重排序',
});

function emptyChecks(): ResourceVerificationSnapshot {
  return {
    network: { state: 'idle', description: '等待检查服务地址' },
    auth: { state: 'idle', description: '等待检查 API Key' },
    model: { state: 'idle', description: '等待检查模型' },
    capability: { state: 'idle', description: '等待检查用途能力' },
  };
}

function providerOptions(type: ResourceType): readonly { value: string; label: string }[] {
  const allowed = type === 'generation'
    ? PROVIDERS
    : type === 'embedding'
      ? PROVIDERS.filter((provider) => provider !== 'claude' && provider !== 'deepseek')
      : PROVIDERS.filter((provider) => provider === 'openai' || provider === 'deepseek' || provider === 'generic');
  return allowed.map((value) => ({ value, label: PROVIDER_LABELS[value] }));
}

function capabilities(type: ResourceType): LLMCapability[] {
  if (type === 'embedding') return ['embeddings'];
  if (type === 'rerank') return ['rerank'];
  return ['chat', 'json'];
}

function safeCode(error: unknown, fallback: SSHelperReasonCode, stage = 'llm.resource.ui'): SSHelperReasonCode {
  return readSSHelperFailure(error, { reasonCode: fallback, stage })!.reasonCode;
}

function resourceId(): string {
  return `resource-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
}

function parseBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return url.toString().replace(/\/$/u, '');
  } catch {
    return undefined;
  }
}

const RESOURCE_WIZARD_DEFINITION: PopupWizardDefinition = {
  id: 'llm-resource',
  submitLabel: '测试并保存',
  busyLabel: '正在测试连接…',
  confirmDiscard: {
    title: '放弃资源配置？',
    message: '尚未保存的字段和测试结果将被丢弃。',
  },
  steps: [
    {
      id: 'purpose',
      label: '用途',
      description: '选择任务用途',
      fields: [{
        kind: 'radio',
        id: 'type',
        label: '资源用途',
        description: '用途决定资源需要通过的能力检查。',
        options: [
          { value: 'generation', label: '生成' },
          { value: 'embedding', label: '向量化' },
          { value: 'rerank', label: '重排序' },
        ],
        validation: { required: true },
      }],
    },
    {
      id: 'provider',
      label: '服务',
      description: '选择服务协议',
      fields: [{
        kind: 'radio',
        id: 'apiType',
        label: '服务模板',
        description: '只显示支持当前用途的服务。',
        options: providerOptions('generation'),
        validation: { required: true },
      }],
    },
    {
      id: 'connection',
      label: '连接',
      title: '连接到服务',
      description: '填写地址、密钥和模型',
      fields: [
        { kind: 'text', id: 'label', label: '资源名称', placeholder: '例如：主要生成服务', validation: { required: true, min: 1, max: 128 } },
        { kind: 'text', id: 'baseUrl', label: 'Base URL', placeholder: 'https://api.example.com/v1', validation: { required: true, max: 2048 } },
        { kind: 'text', id: 'apiKey', label: 'API Key', description: '编辑资源时留空代表继续使用现有密钥。', secret: true, validation: { max: 65536 } },
        {
          kind: 'select',
          id: 'model',
          label: '默认模型',
          description: '连接信息有效时自动获取；服务不支持发现时仍可手动输入。',
          options: [],
          allowCustom: true,
          customPlaceholder: '输入模型 ID',
          validation: { required: true },
        },
      ],
    },
    {
      id: 'verification',
      label: '验证',
      title: '验证并启用',
      description: '测试通过后保存启用',
      fields: [],
    },
  ],
  aside: {
    title: '连接测试',
    description: '通过后自动保存并启用。',
    checks: [
      { id: 'network', label: '网络', icon: 'globe', description: '服务地址可以访问' },
      { id: 'auth', label: '鉴权', icon: 'shield-halved', description: 'API Key 有效' },
      { id: 'model', label: '模型', icon: 'cube', description: '模型存在并可以调用' },
      { id: 'capability', label: '用途能力', icon: 'brackets-curly', description: '支持所选资源用途' },
    ],
  },
};

class ResourceWizardController implements PopupWizardAdapter {
  readonly #listeners = new Set<() => void>();
  readonly #verification: ResourceVerificationCoordinator;
  readonly #abortController = new AbortController();
  readonly #mode: 'create' | 'edit' | 'copy';
  readonly #source?: ResourceConfig;
  readonly #hasStoredSecret: boolean;
  readonly #timeoutMs: number;
  readonly #repository: LlmWorkspaceRepository;
  readonly #ui: PopupUiContext;
  readonly #notify: ResourceNotifier;
  readonly #state: ResourceWizardState;
  #modelDiscoveryAbort?: AbortController;
  #modelDiscoveryTimer?: ReturnType<typeof setTimeout>;

  constructor(options: {
    mode: 'create' | 'edit' | 'copy';
    source?: ResourceConfig;
    hasStoredSecret: boolean;
    timeoutMs: number;
    repository: LlmWorkspaceRepository;
    ui: PopupUiContext;
    notify: ResourceNotifier;
    verification: ResourceVerificationCoordinator;
  }) {
    this.#mode = options.mode;
    this.#source = options.source;
    this.#hasStoredSecret = options.hasStoredSecret;
    this.#timeoutMs = options.timeoutMs;
    this.#repository = options.repository;
    this.#ui = options.ui;
    this.#notify = options.notify;
    this.#verification = options.verification;
    const sourceType = options.source?.type ?? 'generation';
    const sourceApiType = options.source?.apiType === 'auto' || options.source?.apiType === undefined ? 'generic' : options.source.apiType;
    const draft: ResourceDraft = {
      type: sourceType,
      apiType: sourceApiType,
      label: options.mode === 'copy' ? `${options.source?.label ?? '资源'}（副本）` : options.source?.label ?? '',
      baseUrl: options.source?.baseUrl ?? PROVIDER_URLS[sourceApiType],
      apiKey: '',
      model: options.source?.model ?? '',
    };
    this.#state = {
      activeStepId: 'purpose',
      completed: new Set(),
      draft,
      fieldErrors: {},
      checks: emptyChecks(),
      busy: false,
      dirty: false,
      modelOptions: options.source?.model
        ? [{ value: options.source.model, label: options.source.model }]
        : [],
      discoveringModels: false,
    };
  }

  snapshot(): PopupWizardSnapshot {
    const checks = Object.fromEntries(Object.entries(this.#state.checks).map(([id, check]) => [id, { ...check }]));
    return {
      activeStepId: this.#state.activeStepId,
      completedStepIds: [...this.#state.completed],
      values: { ...this.#state.draft },
      fieldErrors: { ...this.#state.fieldErrors },
      fieldOptions: {
        apiType: providerOptions(this.#state.draft.type),
        model: this.#state.modelOptions,
      },
      dirty: this.#state.dirty,
      busy: this.#state.busy,
      submitDisabled: this.#state.busy || Object.keys(this.#validateStep(this.#state.activeStepId, false)).length > 0,
      ...(this.#state.status === undefined ? {} : { status: this.#state.status }),
      checks,
    };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  change(fieldId: string, value: PlainData): void {
    if (this.#state.busy) return;
    const draft = this.#state.draft;
    if (fieldId === 'type' && typeof value === 'string' && ['generation', 'embedding', 'rerank'].includes(value)) {
      draft.type = value as ResourceType;
      if (!providerOptions(draft.type).some((option) => option.value === draft.apiType)) {
        draft.apiType = (providerOptions(draft.type)[0]?.value ?? 'generic') as ApiType;
        draft.baseUrl = PROVIDER_URLS[draft.apiType];
      }
    } else if (fieldId === 'apiType' && typeof value === 'string' && PROVIDERS.includes(value as ApiType)) {
      const previousDefault = PROVIDER_URLS[draft.apiType];
      draft.apiType = value as ApiType;
      if (!draft.baseUrl || draft.baseUrl === previousDefault) draft.baseUrl = PROVIDER_URLS[draft.apiType];
    } else if (fieldId === 'label' && typeof value === 'string') draft.label = value;
    else if (fieldId === 'baseUrl' && typeof value === 'string') draft.baseUrl = value;
    else if (fieldId === 'apiKey' && typeof value === 'string') draft.apiKey = value;
    else if (fieldId === 'model' && typeof value === 'string') draft.model = value;
    else return;
    this.#state.dirty = true;
    this.#state.checks = emptyChecks();
    this.#state.status = undefined;
    this.#state.fieldErrors = this.#validateStep(this.#state.activeStepId, false);
    this.#emit();
    if (fieldId === 'type' || fieldId === 'apiType' || fieldId === 'baseUrl' || fieldId === 'apiKey') {
      this.#state.modelOptions = [];
      this.#scheduleModelDiscovery();
    }
  }

  navigate(stepId: string): void {
    if (!STEP_IDS.includes(stepId as WizardStepId) || (!this.#state.completed.has(stepId as WizardStepId) && stepId !== this.#state.activeStepId)) return;
    this.#state.activeStepId = stepId as WizardStepId;
    this.#state.fieldErrors = this.#validateStep(this.#state.activeStepId, false);
    this.#emit();
  }

  back(): void {
    const index = STEP_IDS.indexOf(this.#state.activeStepId);
    if (index <= 0 || this.#state.busy) return;
    this.#state.activeStepId = STEP_IDS[index - 1]!;
    this.#state.fieldErrors = this.#validateStep(this.#state.activeStepId, false);
    this.#emit();
  }

  async submit(): Promise<void> {
    if (this.#state.busy) return;
    const errors = this.#validateStep(this.#state.activeStepId, true);
    this.#state.fieldErrors = errors;
    if (Object.keys(errors).length > 0) {
      this.#emit();
      return;
    }
    const index = STEP_IDS.indexOf(this.#state.activeStepId);
    if (index < STEP_IDS.length - 1) {
      this.#state.completed.add(this.#state.activeStepId);
      this.#state.activeStepId = STEP_IDS[index + 1]!;
      this.#emit();
      if (this.#state.activeStepId === 'connection') this.#scheduleModelDiscovery();
      return;
    }
    await this.#verifyAndSave();
  }

  dispose(): void {
    this.#abortController.abort();
    if (this.#modelDiscoveryTimer !== undefined) clearTimeout(this.#modelDiscoveryTimer);
    this.#modelDiscoveryAbort?.abort();
    this.#listeners.clear();
  }

  #scheduleModelDiscovery(): void {
    if (this.#modelDiscoveryTimer !== undefined) clearTimeout(this.#modelDiscoveryTimer);
    this.#modelDiscoveryAbort?.abort();
    this.#modelDiscoveryAbort = undefined;
    if (this.#state.activeStepId !== 'connection') return;
    if (parseBaseUrl(this.#state.draft.baseUrl.trim()) === undefined) return;
    if (!this.#state.draft.apiKey.trim() && !(this.#mode === 'edit' && this.#hasStoredSecret)) return;
    this.#modelDiscoveryTimer = setTimeout(() => {
      this.#modelDiscoveryTimer = undefined;
      void this.#discoverModels();
    }, 450);
  }

  async #discoverModels(): Promise<void> {
    const controller = new AbortController();
    this.#modelDiscoveryAbort?.abort();
    this.#modelDiscoveryAbort = controller;
    this.#state.discoveringModels = true;
    this.#state.status = { tone: 'neutral', message: '正在自动获取模型列表…' };
    this.#emit();
    try {
      const storedKey = this.#state.draft.apiKey.trim()
        ? null
        : this.#source === undefined
          ? null
          : await this.#repository.getResourceSecret(this.#source.id);
      const key = this.#state.draft.apiKey.trim() || storedKey;
      if (!key || controller.signal.aborted) return;
      const candidate: ResourceConfig = {
        id: this.#source?.id ?? 'resource-model-discovery',
        type: this.#state.draft.type,
        source: 'custom',
        apiType: this.#state.draft.apiType,
        label: this.#state.draft.label.trim() || '待配置资源',
        baseUrl: parseBaseUrl(this.#state.draft.baseUrl.trim()),
        model: this.#state.draft.model.trim() || undefined,
        enabled: false,
        capabilities: capabilities(this.#state.draft.type),
      };
      const result = await this.#verification.discoverModels(candidate, key, {
        signal: controller.signal,
        timeoutMs: Math.min(this.#timeoutMs, 12_000),
      });
      if (controller.signal.aborted) return;
      if (result.ok) {
        this.#state.modelOptions = result.models.map((model) => ({
          value: model.id,
          label: model.label?.trim() && model.label !== model.id ? `${model.label} · ${model.id}` : model.id,
        }));
        this.#state.status = this.#state.modelOptions.length > 0
          ? { tone: 'success', message: `已自动获取 ${this.#state.modelOptions.length} 个模型。` }
          : { tone: 'warning', message: '服务返回空模型列表，请手动输入模型 ID。', code: 'LLM_MODEL_LIST_EMPTY' };
      } else {
        this.#state.modelOptions = [];
        this.#state.status = {
          tone: 'warning',
          message: result.supported ? '模型列表获取失败，可继续手动输入。' : '该服务不支持模型发现，请手动输入。',
          code: result.reasonCode ?? 'LLM_MODEL_DISCOVERY_FAILED',
        };
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.#state.modelOptions = [];
        this.#state.status = {
          tone: 'warning',
          message: '模型列表获取失败，可继续手动输入。',
          code: safeCode(error, 'LLM_MODEL_DISCOVERY_FAILED'),
        };
      }
    } finally {
      if (this.#modelDiscoveryAbort === controller) {
        this.#modelDiscoveryAbort = undefined;
        this.#state.discoveringModels = false;
        this.#emit();
      }
    }
  }

  #validateStep(step: WizardStepId, includeRequired: boolean): Record<string, string> {
    const errors: Record<string, string> = {};
    const draft = this.#state.draft;
    if (step === 'purpose' && !['generation', 'embedding', 'rerank'].includes(draft.type)) errors.type = '请选择资源用途';
    if (step === 'provider' && !providerOptions(draft.type).some((option) => option.value === draft.apiType)) errors.apiType = '当前服务不支持所选用途';
    if (step === 'connection') {
      if (!draft.label.trim()) errors.label = '请输入资源名称';
      else if (draft.label.trim().length > 128) errors.label = '资源名称不能超过 128 个字符';
      if (!draft.baseUrl.trim() || parseBaseUrl(draft.baseUrl.trim()) === undefined) errors.baseUrl = '请输入无凭据、查询参数和片段的 HTTP(S) 地址';
      if (!draft.model.trim()) errors.model = '请输入模型 ID';
      if ((this.#mode !== 'edit' || !this.#hasStoredSecret) && !draft.apiKey.trim()) errors.apiKey = '请输入 API Key';
      if (draft.apiKey.length > 65_536) errors.apiKey = 'API Key 过长';
    }
    if (!includeRequired && !this.#state.dirty && step === 'purpose') return {};
    return errors;
  }

  async #verifyAndSave(): Promise<void> {
    if (this.#modelDiscoveryTimer !== undefined) clearTimeout(this.#modelDiscoveryTimer);
    this.#modelDiscoveryTimer = undefined;
    this.#modelDiscoveryAbort?.abort();
    this.#modelDiscoveryAbort = undefined;
    this.#state.busy = true;
    this.#state.status = { tone: 'neutral', message: '正在验证连接，尚未写入配置。' };
    this.#emit();
    let oldSecret: string | null = null;
    let wroteSecret = false;
    let persistedResourceId: string | undefined;
    try {
      oldSecret = this.#source === undefined ? null : await this.#repository.getResourceSecret(this.#source.id);
      const key = this.#state.draft.apiKey.trim() || oldSecret;
      if (!key) throw createSSHelperError('AUTH_FAILED', { stage: 'llm.resource.secret' });
      const id = this.#mode === 'edit' && this.#source !== undefined ? this.#source.id : resourceId();
      persistedResourceId = id;
      const candidate: ResourceConfig = {
        id,
        type: this.#state.draft.type,
        source: 'custom',
        apiType: this.#state.draft.apiType,
        label: this.#state.draft.label.trim(),
        baseUrl: parseBaseUrl(this.#state.draft.baseUrl.trim()),
        model: this.#state.draft.model.trim(),
        enabled: true,
        capabilities: capabilities(this.#state.draft.type),
      };
      const verificationStartedAt = Date.now();
      const result = await this.#verification.verify(candidate, key, {
        signal: this.#abortController.signal,
        timeoutMs: this.#timeoutMs,
        onProgress: (checks) => {
          this.#state.checks = checks;
          this.#emit();
        },
      });
      this.#state.checks = result.checks;
      if (!result.ok) {
        this.#state.status = { tone: 'error', message: '连接测试未通过，配置尚未保存。', code: result.reasonCode ?? 'LLM_PROVIDER_TEST_FAILED' };
        this.#notify('error', '资源验证失败', '请检查标记的连接项目后重试。', result.reasonCode ?? 'LLM_PROVIDER_TEST_FAILED');
        return;
      }
      if (this.#state.draft.apiKey.trim() || this.#mode !== 'edit') {
        await this.#repository.setResourceSecret(id, key, { label: candidate.label });
        wroteSecret = true;
      }
      const settings = await this.#repository.loadSettings();
      const current = settings.resources ?? [];
      const resources = this.#mode === 'edit'
        ? current.map((resource) => resource.id === id ? candidate : resource)
        : [...current, candidate];
      await this.#repository.saveSettings({ ...settings, resources }, {
        resourceHealth: {
          resourceId: id,
          state: 'success',
          checkedAt: Date.now(),
          durationMs: Math.max(0, Date.now() - verificationStartedAt),
        },
      });
      this.#state.dirty = false;
      this.#state.status = { tone: 'success', message: '资源已验证、保存并启用。' };
      this.#notify('success', '资源已启用', `${candidate.label} 已通过连接测试。`, 'LLM_RESOURCE_ENABLED');
      this.#emit();
      this.#ui.close();
    } catch (error) {
      if (wroteSecret) {
        try {
          if (persistedResourceId !== undefined && oldSecret) await this.#repository.setResourceSecret(persistedResourceId, oldSecret, { label: this.#source?.label ?? '资源' });
          else if (persistedResourceId !== undefined) await this.#repository.deleteResourceSecret(persistedResourceId);
        } catch {
          // The primary safe diagnostic remains the save failure; the resource was never enabled.
        }
      }
      const code = safeCode(error, 'INTERNAL_ERROR', 'llm.resource.save');
      this.#state.status = { tone: 'error', message: '资源未保存，请修正后重试。', code };
      this.#notify('error', '资源保存失败', '资源没有加入可用路由。', code);
    } finally {
      this.#state.busy = false;
      this.#emit();
    }
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

function requireUi(ui: PopupUiContext | undefined): PopupUiContext {
  if (ui === undefined) throw createSSHelperError('CORE_BRIDGE_UNAVAILABLE', { stage: 'llm.resource.ui' });
  return ui;
}

function verificationCoordinator(session: PluginSession): ResourceVerificationCoordinator {
  if (!session.host.has('tavern.plugin.request')) return new ResourceVerificationCoordinator();
  const request = (request: Parameters<typeof session.host.request.send>[0], options?: Parameters<typeof session.host.request.send>[1]) => session.host.request.send(request, options);
  return new ResourceVerificationCoordinator({
    request,
    fetchImpl: createCoreBridgeFetch(request),
  });
}

async function renderResourceWizard(
  input: PlainData,
  repository: LlmWorkspaceRepository,
  session: PluginSession,
  ui: PopupUiContext,
  notify: ResourceNotifier,
): Promise<() => void> {
  const settings = await repository.loadSettings();
  const record = typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Readonly<Record<string, PlainData>> : {};
  const mode = record.mode === 'edit' || record.mode === 'copy' ? record.mode : 'create';
  const resourceId = typeof record.resourceId === 'string' ? record.resourceId : undefined;
  const source = resourceId === undefined ? undefined : settings.resources?.find((resource) => resource.id === resourceId);
  if ((mode === 'edit' || mode === 'copy') && source === undefined) throw createSSHelperError('WORKSPACE_NOT_FOUND', { stage: 'llm.resource.lookup' });
  const controller = new ResourceWizardController({
    mode,
    source,
    hasStoredSecret: source === undefined ? false : await repository.hasResourceSecret(source.id),
    timeoutMs: settings.timeoutMs ?? 20_000,
    repository,
    ui,
    notify,
    verification: verificationCoordinator(session),
  });
  const handle = ui.mountWizard(RESOURCE_WIZARD_DEFINITION, controller);
  return () => {
    controller.dispose();
    handle.dispose();
  };
}

async function renderResourceManager(
  container: HTMLElement,
  repository: LlmWorkspaceRepository,
  session: PluginSession,
  ui: PopupUiContext,
): Promise<() => void> {
  let disposed = false;
  let provider = 'all';
  let statusFilter = 'all';
  let settings = await repository.loadSettings();
  let healthRecords = await repository.listResourceHealth();
  let loadSequence = 0;
  const testControllers = new Map<string, AbortController>();
  const menuHandles = new Set<PopupMenuHandle>();
  const testing = new Set<string>();
  const mutating = new Set<string>();
  const shell = container.ownerDocument.createElement('div');
  shell.className = 'ss-helper-llm-resource-manager';
  const intro = container.ownerDocument.createElement('header');
  intro.className = 'ss-helper-llm-resource-intro';
  const introCopy = container.ownerDocument.createElement('div');
  const introText = container.ownerDocument.createElement('p');
  introText.textContent = '管理用于 LLM 任务的资源，并检查服务是否可用。';
  introCopy.append(introText);
  const addResource = ui.createButton({ label: '添加资源', icon: 'circle-plus', tone: 'primary', size: 'md' });
  addResource.addEventListener('click', () => session.ui.openPopup(LLM_RESOURCE_WIZARD_POPUP, { mode: 'create' }));
  intro.append(introCopy);
  const summary = container.ownerDocument.createElement('div');
  summary.className = 'ss-helper-llm-resource-summary';
  const summaryBar = container.ownerDocument.createElement('div');
  summaryBar.className = 'ss-helper-llm-resource-summary-bar';
  summaryBar.append(summary, addResource);
  const search = ui.createInput({ label: '搜索资源', type: 'search', placeholder: '搜索资源名称、模型或提供商…' });
  const providerSelect = ui.createSelect({
    label: '按提供商筛选',
    value: provider,
    options: [
      { value: 'all', label: '提供商：全部' },
      ...PROVIDERS.map((value) => ({ value, label: PROVIDER_LABELS[value] })),
    ],
    onChange: (value) => { provider = value; render(); },
  });
  const statusSelect = ui.createSelect({
    label: '按状态筛选',
    value: statusFilter,
    options: [
      { value: 'all', label: '状态：全部' },
      { value: 'enabled', label: '已启用' },
      { value: 'disabled', label: '已停用' },
      { value: 'success', label: '测试正常' },
      { value: 'failed', label: '测试失败' },
      { value: 'untested', label: '未测试' },
    ],
    onChange: (value) => { statusFilter = value; render(); },
  });
  const refresh = ui.createButton({ label: '刷新', ariaLabel: '刷新资源列表', icon: 'rotate', iconOnly: true, size: 'sm' });
  const toolbar = container.ownerDocument.createElement('div');
  toolbar.className = 'ss-helper-llm-resource-toolbar';
  toolbar.append(search, providerSelect, statusSelect, refresh);
  const list = container.ownerDocument.createElement('div');
  list.className = 'ss-helper-llm-resource-groups';
  const status = container.ownerDocument.createElement('p');
  status.className = 'ss-helper-llm-resource-live-status';
  status.setAttribute('role', 'status');
  const verification = verificationCoordinator(session);

  const healthByResource = (): Map<string, ResourceHealthRecord> => new Map(healthRecords.map((record) => [record.resourceId, record]));
  const resourceState = (resource: ResourceConfig, health?: ResourceHealthRecord): 'enabled' | 'disabled' | 'success' | 'failed' | 'untested' => {
    if (resource.enabled === false) return 'disabled';
    if (health?.state === 'success') return 'success';
    if (health?.state === 'failed') return 'failed';
    return 'untested';
  };
  const showToast = (level: 'success' | 'error', title: string, message: string, code: string): void => {
    session.ui.showToast({ level, title, message, code });
  };
  const formatCheckedAt = (health?: ResourceHealthRecord): string => {
    if (health === undefined) return '未测试';
    return `${new Date(health.checkedAt).toLocaleString()} · ${health.durationMs} ms`;
  };
  const disposeMenus = (): void => {
    for (const handle of menuHandles) handle.dispose();
    menuHandles.clear();
  };
  const matchesFilters = (resource: ResourceConfig, health?: ResourceHealthRecord): boolean => {
    if (provider !== 'all' && resource.apiType !== provider) return false;
    const state = resourceState(resource, health);
    if (statusFilter !== 'all' && state !== statusFilter && !(statusFilter === 'enabled' && resource.enabled !== false)) return false;
    const query = search.value.trim().toLocaleLowerCase();
    return !query || `${resource.label} ${resource.model ?? ''} ${PROVIDER_LABELS[resource.apiType === 'auto' ? 'generic' : resource.apiType]}`.toLocaleLowerCase().includes(query);
  };
  const testResource = async (resource: ResourceConfig): Promise<void> => {
    if (testing.has(resource.id)) return;
    const controller = new AbortController();
    testControllers.set(resource.id, controller);
    testing.add(resource.id);
    render();
    const startedAt = Date.now();
    try {
      const key = await repository.getResourceSecret(resource.id);
      if (!key) {
        const failure: SSHelperFailureContext = {
          reasonCode: 'AUTH_FAILED',
          stage: 'llm.resource.test.credential',
          resourceId: resource.id,
          providerKind: resource.apiType,
          ...(resource.model ? { model: resource.model } : {}),
        };
        await repository.saveResourceHealth({
          resourceId: resource.id,
          state: 'failed',
          checkedAt: Date.now(),
          durationMs: Math.max(0, Date.now() - startedAt),
          failure,
        });
        showToast('error', '资源测试失败', '资源缺少可用密钥。', failure.reasonCode);
        return;
      }
      const result = await verification.verify(resource, key, {
        signal: controller.signal,
        timeoutMs: settings.timeoutMs ?? 20_000,
      });
      if (controller.signal.aborted) return;
      const reasonCode = result.ok ? undefined : result.reasonCode ?? 'LLM_PROVIDER_TEST_FAILED';
      const failure = reasonCode === undefined ? undefined : {
        reasonCode,
        stage: 'llm.resource.test',
        resourceId: resource.id,
        providerKind: resource.apiType,
        ...(resource.model ? { model: resource.model } : {}),
      } satisfies SSHelperFailureContext;
      await repository.saveResourceHealth({
        resourceId: resource.id,
        state: result.ok ? 'success' : 'failed',
        checkedAt: Date.now(),
        durationMs: Math.max(0, Date.now() - startedAt),
        ...(failure === undefined ? {} : { failure }),
      });
      showToast(result.ok ? 'success' : 'error', result.ok ? '资源测试通过' : '资源测试失败', result.ok ? `${resource.label} 可以正常使用。` : '请检查连接配置后重试。', reasonCode ?? 'LLM_RESOURCE_TEST_SUCCEEDED');
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = safeCode(error, 'LLM_PROVIDER_TEST_FAILED');
      const failure = readSSHelperFailure(error, {
        reasonCode: code,
        stage: 'llm.resource.test',
        resourceId: resource.id,
        providerKind: resource.apiType,
        ...(resource.model ? { model: resource.model } : {}),
      })!;
      await repository.saveResourceHealth({
        resourceId: resource.id,
        state: 'failed',
        checkedAt: Date.now(),
        durationMs: Math.max(0, Date.now() - startedAt),
        failure,
      });
      showToast('error', '资源测试失败', '请检查连接配置后重试。', code);
    } finally {
      testing.delete(resource.id);
      testControllers.delete(resource.id);
      if (!disposed) await load();
    }
  };
  const toggleResource = async (resource: ResourceConfig): Promise<void> => {
    if (mutating.has(resource.id)) return;
    mutating.add(resource.id);
    render();
    try {
      const latest = await repository.loadSettings();
      const enabled = resource.enabled === false;
      await repository.saveSettings({
        ...latest,
        resources: latest.resources?.map((item) => item.id === resource.id ? { ...item, enabled } : item) ?? [],
      });
      showToast('success', enabled ? '资源已启用' : '资源已停用', resource.label, enabled ? 'LLM_RESOURCE_ENABLED' : 'LLM_RESOURCE_DISABLED');
    } finally {
      mutating.delete(resource.id);
      if (!disposed) await load();
    }
  };
  const deleteResource = async (resource: ResourceConfig): Promise<void> => {
    const approved = await ui.confirm({
      title: `删除“${resource.label}”？`,
      message: '资源配置、最近测试摘要和加密密钥会一并删除，此操作无法撤销。',
      confirmLabel: '删除资源',
      danger: true,
    });
    if (!approved) return;
    if (mutating.has(resource.id)) return;
    mutating.add(resource.id);
    render();
    testControllers.get(resource.id)?.abort();
    try {
      await repository.deleteResource(resource.id);
      showToast('success', '资源已删除', resource.label, 'LLM_RESOURCE_DELETED');
    } finally {
      mutating.delete(resource.id);
      if (!disposed) await load();
    }
  };
  const runAction = async (resource: ResourceConfig, action: string): Promise<void> => {
    try {
      if (action === 'edit') session.ui.openPopup(LLM_RESOURCE_WIZARD_POPUP, { mode: 'edit', resourceId: resource.id });
      else if (action === 'copy') session.ui.openPopup(LLM_RESOURCE_WIZARD_POPUP, { mode: 'copy', resourceId: resource.id });
      else if (action === 'test') await testResource(resource);
      else if (action === 'toggle') await toggleResource(resource);
      else if (action === 'delete') await deleteResource(resource);
    } catch (error) {
      showToast('error', '资源操作失败', '资源没有发生未确认的更改。', safeCode(error, 'INTERNAL_ERROR', 'llm.resource.operation'));
    }
  };
  const renderSummary = (): void => {
    summary.replaceChildren();
    const healthMap = healthByResource();
    const definitions: readonly [string, string, number][] = [
      ['生成', 'comments', (settings.resources ?? []).filter((resource) => resource.type === 'generation').length],
      ['向量', 'grip', (settings.resources ?? []).filter((resource) => resource.type === 'embedding').length],
      ['重排', 'bars-staggered', (settings.resources ?? []).filter((resource) => resource.type === 'rerank').length],
      ['警告', 'triangle-exclamation', (settings.resources ?? []).filter((resource) => resource.enabled !== false && healthMap.get(resource.id)?.state === 'failed').length],
    ];
    for (const [label, icon, count] of definitions) {
      const item = container.ownerDocument.createElement('div');
      item.className = 'ss-helper-llm-resource-summary-item';
      item.append(ui.createIcon({ name: icon, decorative: true, fixedWidth: true }));
      const copy = container.ownerDocument.createElement('span');
      copy.textContent = label;
      const value = container.ownerDocument.createElement('strong');
      value.textContent = String(count);
      item.append(copy, value);
      summary.append(item);
    }
  };
  const render = (): void => {
    disposeMenus();
    renderSummary();
    list.replaceChildren();
    const healthMap = healthByResource();
    const visible = (settings.resources ?? []).filter((resource) => matchesFilters(resource, healthMap.get(resource.id)));
    if (visible.length === 0 && (search.value.trim() || provider !== 'all' || statusFilter !== 'all')) {
      const empty = container.ownerDocument.createElement('div');
      empty.className = 'ss-helper-llm-resource-empty is-filtered';
      empty.textContent = '没有符合当前筛选条件的资源。';
      list.append(empty);
      return;
    }
    if ((settings.resources ?? []).length === 0) {
      const empty = container.ownerDocument.createElement('div');
      empty.className = 'ss-helper-llm-resource-empty is-global';
      const message = container.ownerDocument.createElement('p');
      message.textContent = '还没有自定义资源。添加后可用于生成、向量或重排任务。';
      const add = ui.createButton({ label: '添加第一个资源', icon: 'circle-plus', tone: 'primary', size: 'sm' });
      add.addEventListener('click', () => session.ui.openPopup(LLM_RESOURCE_WIZARD_POPUP, { mode: 'create' }));
      empty.append(message, add);
      list.append(empty);
      return;
    }
    for (const type of ['generation', 'embedding', 'rerank'] as const) {
      const resources = visible.filter((resource) => resource.type === type);
      const group = container.ownerDocument.createElement('section');
      group.className = 'ss-helper-llm-resource-group';
      group.dataset.resourceType = type;
      const heading = container.ownerDocument.createElement('header');
      const headingCopy = container.ownerDocument.createElement('div');
      const title = container.ownerDocument.createElement('h3');
      title.textContent = `${PURPOSE_LABELS[type]}资源`;
      const description = container.ownerDocument.createElement('p');
      description.textContent = type === 'generation' ? '用于文本生成、对话和结构化任务' : type === 'embedding' ? '用于向量嵌入与语义检索' : '用于检索结果重排与相关性优化';
      headingCopy.append(ui.createIcon({
        name: type === 'generation' ? 'comments' : type === 'embedding' ? 'grip' : 'bars-staggered',
        decorative: true,
        fixedWidth: true,
      }), title, description);
      const count = container.ownerDocument.createElement('span');
      count.textContent = String(resources.length);
      heading.append(headingCopy, count);
      group.append(heading);
      if (resources.length === 0) {
        const empty = container.ownerDocument.createElement('div');
        empty.className = 'ss-helper-llm-resource-empty';
        const message = container.ownerDocument.createElement('p');
        message.textContent = `暂无${PURPOSE_LABELS[type]}资源`;
        const add = ui.createButton({ label: `添加${PURPOSE_LABELS[type]}资源`, icon: 'circle-plus', size: 'sm' });
        add.addEventListener('click', () => session.ui.openPopup(LLM_RESOURCE_WIZARD_POPUP, { mode: 'create' }));
        empty.append(message, add);
        group.append(empty);
        list.append(group);
        continue;
      }
      const columns = container.ownerDocument.createElement('div');
      columns.className = 'ss-helper-llm-resource-columns';
      for (const label of ['名称', '提供商', '模型', '状态', '最新测试', '操作']) {
        const cell = container.ownerDocument.createElement('span');
        cell.textContent = label;
        columns.append(cell);
      }
      group.append(columns);
      for (const resource of resources) {
        const health = healthMap.get(resource.id);
        const row = container.ownerDocument.createElement('article');
        row.className = 'ss-helper-llm-resource-row';
        row.dataset.state = testing.has(resource.id) ? 'testing' : mutating.has(resource.id) ? 'busy' : resourceState(resource, health);
        const name = container.ownerDocument.createElement('strong');
        name.textContent = resource.label;
        const providerName = container.ownerDocument.createElement('span');
        providerName.textContent = PROVIDER_LABELS[resource.apiType === 'auto' ? 'generic' : resource.apiType];
        const model = container.ownerDocument.createElement('span');
        model.textContent = resource.model ?? '未指定';
        model.title = resource.model ?? '未指定';
        const state = container.ownerDocument.createElement('span');
        state.className = 'ss-helper-llm-resource-state';
        state.textContent = testing.has(resource.id) ? '测试中' : mutating.has(resource.id) ? '处理中' : resource.enabled === false ? '已停用' : health?.state === 'success' ? '正常' : health?.state === 'failed' ? '失败' : '未测试';
        const checked = container.ownerDocument.createElement('span');
        checked.className = 'ss-helper-llm-resource-checked';
        checked.textContent = testing.has(resource.id) ? '正在检查连接…' : formatCheckedAt(health);
        if (health?.failure !== undefined) {
          const code = container.ownerDocument.createElement('code');
          code.textContent = health.failure.reasonCode;
          checked.append(code);
        }
        const actions = container.ownerDocument.createElement('div');
        actions.className = 'ss-helper-llm-resource-actions';
        if (health?.state === 'failed' && resource.enabled !== false) {
          const retry = ui.createButton({ label: '重新测试', size: 'xs', disabled: testing.has(resource.id) });
          retry.addEventListener('click', () => { void runAction(resource, 'test'); });
          actions.append(retry);
        }
        const edit = ui.createButton({ label: '编辑', size: 'xs', disabled: mutating.has(resource.id) });
        edit.addEventListener('click', () => { void runAction(resource, 'edit'); });
        actions.append(edit);
        const menu = ui.createMenu({
          label: `${resource.label} 更多操作`,
          items: [
            { id: 'copy', label: '复制资源', icon: 'copy', disabled: mutating.has(resource.id) },
            { id: 'test', label: testing.has(resource.id) ? '正在测试' : '测试连接', icon: 'flask', disabled: testing.has(resource.id) || mutating.has(resource.id) },
            { id: 'toggle', label: resource.enabled === false ? '启用资源' : '停用资源', icon: resource.enabled === false ? 'toggle-on' : 'toggle-off', separatorBefore: true, disabled: mutating.has(resource.id) },
            { id: 'delete', label: '删除资源', icon: 'trash', tone: 'danger', separatorBefore: true, disabled: mutating.has(resource.id) },
          ],
          onSelect: (action) => runAction(resource, action),
        });
        menuHandles.add(menu);
        actions.append(menu.element);
        row.append(name, providerName, model, state, checked, actions);
        group.append(row);
      }
      list.append(group);
    }
  };
  const load = async (): Promise<void> => {
    const sequence = ++loadSequence;
    const [nextSettings, nextHealth] = await Promise.all([repository.loadSettings(), repository.listResourceHealth()]);
    if (disposed || sequence !== loadSequence) return;
    settings = nextSettings;
    healthRecords = [...nextHealth];
    render();
  };
  search.addEventListener('input', render);
  refresh.addEventListener('click', () => { void load(); });
  shell.append(intro, summaryBar, toolbar, list, status);
  container.append(shell);
  const unsubscribe = repository.subscribeSettings(() => { void load(); });
  render();
  return () => {
    disposed = true;
    for (const controller of testControllers.values()) controller.abort();
    testControllers.clear();
    disposeMenus();
    unsubscribe();
    container.replaceChildren();
  };
}

export function registerResourcePopups(session: PluginSession, repository: LlmWorkspaceRepository): () => void {
  const notify = (level: 'success' | 'error', title: string, message: string, code: string): void => session.ui.showToast({ level, title, message, code });
  const wizardCleanup = session.registerPopup({
    token: LLM_RESOURCE_WIZARD_POPUP,
    title: '添加资源',
    ariaLabel: 'LLM 资源配置向导',
    closeLabel: '关闭资源配置向导',
    render: (container, input, popupUi) => {
      const ui = requireUi(popupUi);
      let cleanup = (): void => undefined;
      let disposed = false;
      void renderResourceWizard(input, repository, session, ui, notify)
        .then((value) => { if (disposed) value(); else cleanup = value; })
        .catch((error) => {
          if (disposed) return;
          container.textContent = `向导加载失败（${safeCode(error, 'INTERNAL_ERROR', 'llm.resource-wizard.load')}）`;
        });
      return () => { disposed = true; cleanup(); };
    },
  });
  const managerCleanup = session.registerPopup({
    token: LLM_RESOURCE_MANAGER_POPUP,
    title: '资源管理',
    ariaLabel: 'LLM 资源管理',
    presentation: 'workspace',
    render: (container, _input, popupUi) => {
      const ui = requireUi(popupUi);
      let cleanup = (): void => undefined;
      let disposed = false;
      void renderResourceManager(container, repository, session, ui)
        .then((value) => { if (disposed) value(); else cleanup = value; })
        .catch((error) => {
          if (disposed) return;
          container.textContent = `资源加载失败（${safeCode(error, 'INTERNAL_ERROR', 'llm.resource-manager.load')}）`;
        });
      return () => { disposed = true; cleanup(); };
    },
  });
  return () => {
    managerCleanup();
    wizardCleanup();
  };
}

export const RESOURCE_POPUP_VERSION = LLM_POPUP_VERSION;
