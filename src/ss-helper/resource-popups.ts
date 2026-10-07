import {
  createSSHelperError,
  describeSSHelperFailure,
  readSSHelperFailure,
  type PlainData,
  type PluginSession,
  type PopupMenuHandle,
  type PopupUiContext,
  type PopupFormField,
  type PopupWizardAdapter,
  type PopupWizardDefinition,
  type PopupWizardSnapshot,
  type ProviderToolDialect,
  type LlmReasoningMode,
  type LlmReasoningEffort,
  type LlmReasoningPolicy,
  type VerifiedEmbeddingCapabilities,
  type SSHelperFailureContext,
  type SSHelperReasonCode,
} from '@ss-helper/sdk';
import type { LLMCapability, ResourceConfig, ResourceType } from '../schema/types';
import { LlmWorkspaceRepository, type ResourceHealthRecord } from '../storage/llm-workspace-repository';
import {
  LLM_POPUP_VERSION,
  LLM_RESOURCE_MANAGER_POPUP,
  LLM_RESOURCE_EDITOR_POPUP,
  LLM_RESOURCE_WIZARD_POPUP,
} from './settings';
import { ResourceVerificationCoordinator } from './resource-verification';
import { createCoreBridgeFetch } from './core-bridge-fetch';
import type { LlmServiceHandlers } from './services';
import { DEEPSEEK_BETA_BASE_URL, isOfficialDeepSeekBetaUrl } from '../providers/deepseek-endpoint';

type WizardStepId = 'purpose' | 'provider' | 'connection' | 'verification';
type ApiType = Exclude<ResourceConfig['apiType'], 'auto'>;
type ConnectionMode = 'official' | 'relay';
type DeepSeekApiMode = 'standard' | 'beta';
type ResourceNotifier = (level: 'success' | 'warning' | 'error', title: string, message: string, code: string) => void;
type ResourceToolServices = Pick<LlmServiceHandlers, 'taskStatus' | 'verifyResourceCapability'>;

interface ResourceDraft {
  type: ResourceType;
  apiType: ApiType;
  connectionMode: ConnectionMode;
  deepseekApiMode: DeepSeekApiMode;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  toolDialect: ProviderToolDialect;
  embeddingPath: string;
  embeddingDimensions: number | '';
  rerankProtocol: 'native' | 'chat';
  rerankPath: string;
  reasoningMode: LlmReasoningMode;
  reasoningEffort: LlmReasoningEffort;
}

interface ResourceWizardState {
  activeStepId: WizardStepId;
  readonly completed: Set<WizardStepId>;
  draft: ResourceDraft;
  fieldErrors: Record<string, string>;
  busy: boolean;
  dirty: boolean;
  modelOptions: readonly { value: string; label: string }[];
  discoveringModels: boolean;
  status?: PopupWizardSnapshot['status'];
}

const STEP_IDS: readonly WizardStepId[] = ['purpose', 'provider', 'connection', 'verification'];
const PROVIDERS: readonly ApiType[] = ['openai', 'xai', 'deepseek', 'kimi', 'glm', 'claude', 'gemini', 'generic'];
const PROVIDER_LABELS: Readonly<Record<ApiType, string>> = Object.freeze({
  openai: 'OpenAI-compatible',
  xai: 'xAI / Grok',
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  glm: 'GLM',
  claude: 'Claude',
  gemini: 'Gemini',
  generic: '通用兼容服务',
});
const PROVIDER_URLS: Readonly<Record<ApiType, string>> = Object.freeze({
  openai: 'https://api.openai.com/v1',
  xai: 'https://api.x.ai/v1',
  deepseek: 'https://api.deepseek.com',
  kimi: 'https://api.moonshot.cn/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  claude: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  generic: '',
});
const PURPOSE_LABELS: Readonly<Record<ResourceType, string>> = Object.freeze({
  generation: '生成',
  embedding: '向量化',
  rerank: '重排序',
});
const DEFAULT_REASONING_POLICY: LlmReasoningPolicy = Object.freeze({ mode: 'provider_default', effort: 'provider_default' });
const REASONING_MODE_OPTIONS = [
  { value: 'provider_default', label: '跟随 Provider 默认' },
  { value: 'enabled', label: '开启思考' },
  { value: 'disabled', label: '关闭思考' },
] as const;
const REASONING_EFFORT_OPTIONS = [
  { value: 'provider_default', label: '跟随默认' },
  { value: 'minimal', label: 'minimal' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
] as const;

function providerOptions(type: ResourceType): readonly { value: string; label: string }[] {
  const allowed = type === 'generation'
    ? PROVIDERS
    : type === 'embedding'
      ? PROVIDERS.filter((provider) => !['xai', 'claude', 'deepseek', 'kimi', 'glm'].includes(provider))
      : PROVIDERS.filter((provider) => provider === 'openai' || provider === 'deepseek' || provider === 'kimi' || provider === 'glm' || provider === 'generic');
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

function toolProbeRequestId(): string {
  return `tool-probe-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
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

function inferDeepSeekApiMode(baseUrl: string): DeepSeekApiMode {
  return isOfficialDeepSeekBetaUrl(baseUrl) ? 'beta' : 'standard';
}

function officialBaseUrl(apiType: ApiType, deepseekApiMode: DeepSeekApiMode): string {
  return apiType === 'deepseek' && deepseekApiMode === 'beta' ? DEEPSEEK_BETA_BASE_URL : PROVIDER_URLS[apiType];
}

function inferConnectionMode(apiType: ApiType, baseUrl: string): ConnectionMode {
  const normalized = parseBaseUrl(baseUrl);
  if (!PROVIDER_URLS[apiType]) return 'relay';
  if (normalized === parseBaseUrl(PROVIDER_URLS[apiType])) return 'official';
  return apiType === 'deepseek' && isOfficialDeepSeekBetaUrl(baseUrl) ? 'official' : 'relay';
}

function defaultToolDialect(apiType: ApiType, connectionMode: ConnectionMode = 'official'): ProviderToolDialect {
  if (apiType === 'openai') return connectionMode === 'relay' ? 'openai_chat_compatible' : 'openai_responses';
  if (apiType === 'deepseek') return 'deepseek_chat';
  if (apiType === 'kimi') return 'kimi_chat';
  if (apiType === 'glm') return 'glm_chat';
  if (apiType === 'claude') return 'anthropic_messages';
  if (apiType === 'gemini') return 'gemini_interactions';
  return 'openai_chat_compatible';
}

function isOpenAiToolProtocol(value: ProviderToolDialect): boolean {
  return value === 'openai_chat_compatible' || value === 'openai_responses';
}

function parseOperationPath(value: string): string | undefined {
  const path = value.trim();
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#')) return undefined;
  return path.replace(/\/+$/u, '') || '/';
}

const RESOURCE_WIZARD_DEFINITION: PopupWizardDefinition = {
  id: 'llm-resource',
  submitLabel: '保存',
  busyLabel: '正在保存…',
  confirmDiscard: {
    title: '放弃资源配置？',
    message: '尚未保存的修改将被丢弃。',
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
        description: '用途决定接口类型及可用字段。',
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
        { kind: 'text', id: 'label', label: '资源名称（选填）', placeholder: '留空按服务与模型命名', validation: { max: 128 } },
        { kind: 'segmented', id: 'connectionMode', label: '连接方式', description: '官方直连使用标准地址；第三方中转允许填写兼容服务地址。', options: [
          { value: 'official', label: '官方直连' },
          { value: 'relay', label: '第三方中转' },
        ], validation: { required: true } },
        { kind: 'segmented', id: 'deepseekApiMode', label: 'DeepSeek API 模式', description: 'Beta 使用官方 /beta 端点并单独实测严格工具 Schema；基础工具调用不受可选探测结果影响。', options: [
          { value: 'standard', label: '标准' },
          { value: 'beta', label: 'Beta' },
        ], validation: { required: true } },
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
        { kind: 'toggle', id: 'showAdvanced', label: '显示高级连接选项' },
        { kind: 'segmented', id: 'toolDialect', label: 'Agent 工具协议', description: '只影响 Agent 工具续轮；中转站默认使用 Chat Completions。', options: [
          { value: 'openai_chat_compatible', label: 'Chat Completions' },
          { value: 'openai_responses', label: 'Responses API' },
        ], validation: { required: true } },
        { kind: 'segmented', id: 'reasoningMode', label: '思考模式', description: '策略保存在当前生成资源上，只影响 SS-Helper 请求，不修改酒馆全局设置。', options: [...REASONING_MODE_OPTIONS], validation: { required: true } },
        { kind: 'select', id: 'reasoningEffort', label: '思考强度', description: '最终可用档位以当前资源和模型的实测结果为准。', options: [...REASONING_EFFORT_OPTIONS], validation: { required: true } },
        { kind: 'text', id: 'embeddingPath', label: '向量接口路径', description: '仅用于向量化资源，例如 /embeddings。', placeholder: '/embeddings', validation: { max: 512 } },
        { kind: 'number', id: 'embeddingDimensions', label: '向量维度', description: '可选；留空时使用模型默认维度。', validation: { min: 1, max: 100000 }, step: 1, showStepper: true },
        { kind: 'segmented', id: 'rerankProtocol', label: '重排协议', description: '原生调用 /rerank；聊天模型通过严格 JSON 评分完成重排。', options: [
          { value: 'native', label: '原生接口' },
          { value: 'chat', label: '聊天模型' },
        ] },
        { kind: 'text', id: 'rerankPath', label: '重排接口路径', description: '仅用于原生重排资源，例如 /rerank。', placeholder: '/rerank', validation: { max: 512 } },
      ],
    },
    {
      id: 'verification',
      label: '确认',
      title: '保存资源',
      description: '确认后直接保存，可在资源列表中手动测试连接',
      fields: [],
    },
  ],
};

function resourceEditorDefinition(source: ResourceConfig, hasStoredSecret: boolean, health?: ResourceHealthRecord): PopupWizardDefinition {
  const fields = RESOURCE_WIZARD_DEFINITION.steps.flatMap((step) => step.fields);
  const field = (id: string, overrides: Partial<PopupFormField> = {}): PopupFormField => ({
    ...fields.find((candidate) => candidate.id === id)!, ...overrides,
  } as PopupFormField);
  const diagnostic = health?.state === 'failed' && health.failure ? describeSSHelperFailure(health.failure) : undefined;
  const checkedAt = health === undefined ? undefined : `最近测试：${new Date(health.checkedAt).toLocaleString()}${diagnostic ? `\n${health.failure?.reasonCode} · ${diagnostic.title}\n${diagnostic.reason}\n${diagnostic.action}${health.failure?.requestId ? `\n请求 ID：${health.failure.requestId}` : ''}` : ''}`;
  return {
    ...RESOURCE_WIZARD_DEFINITION,
    id: 'llm-resource-editor',
    steps: [],
    form: {
      description: `${source.label} · ${PROVIDER_LABELS[source.apiType]} · ${source.model || '未指定模型'}`,
      footerHint: '保存后可在资源列表中测试连接',
      sections: [
        { id: 'connection', title: '连接配置', description: '用于 LLM 服务的基础连接信息。', fields: [
          field('label'),
          field('type', { kind: 'select', label: '用途', span: 'half', description: undefined }),
          field('apiType', { kind: 'select', span: 'half', description: undefined }),
          field('connectionMode', { description: undefined }),
          field('baseUrl', { description: '官方直连使用标准地址；中转地址可修改。' }),
          field('apiKey', { placeholder: hasStoredSecret ? '留空以保留现有密钥' : '填写 API Key', description: hasStoredSecret ? '已保存密钥；留空保持不变。' : '密钥将安全保存。' }),
          field('model', { description: '可从列表选择，也可手动输入模型 ID。', trailingAction: { id: 'refresh-models', label: '刷新模型列表', icon: 'rotate' } }),
        ] },
        { id: 'generation', title: '生成策略', description: '调整当前资源的思考行为。', column: 'secondary', fields: [
          field('reasoningMode', { description: '仅影响当前资源的 SS-Helper 请求。', options: REASONING_MODE_OPTIONS.map((option) => ({ ...option, label: option.value === 'provider_default' ? '跟随默认' : option.value === 'enabled' ? '开启' : '关闭' })) }),
          field('reasoningEffort', { description: '可用档位以当前模型的实测结果为准。' }),
        ] },
        { id: 'embedding', title: '向量配置', column: 'secondary', fields: [field('embeddingPath'), field('embeddingDimensions')] },
        { id: 'rerank', title: '重排配置', column: 'secondary', fields: [field('rerankProtocol'), field('rerankPath')] },
        { id: 'advanced', title: '高级连接选项', column: 'secondary', collapsible: true, fields: [field('deepseekApiMode'), field('toolDialect')] },
        { id: 'health', title: '连接状态', column: 'secondary', description: checkedAt, status: { tone: health === undefined ? 'neutral' : health.state === 'success' ? 'success' : 'error', message: health === undefined ? '尚未测试连接' : `最近连接${health.state === 'success' ? '正常' : '失败'} · ${health.durationMs} ms` }, fields: [] },
      ],
    },
  };
}

export class ResourceWizardController implements PopupWizardAdapter {
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
  #showAdvanced = false;

  constructor(options: {
    mode: 'create' | 'edit' | 'copy';
    source?: ResourceConfig;
    hasStoredSecret: boolean;
    timeoutMs: number;
    repository: LlmWorkspaceRepository;
    ui: PopupUiContext;
    notify: ResourceNotifier;
    verification: ResourceVerificationCoordinator;
    reasoningPolicy?: LlmReasoningPolicy;
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
    const sourceApiType = options.source?.apiType ?? 'generic';
    const sourceBaseUrl = options.source?.baseUrl ?? PROVIDER_URLS[sourceApiType];
    const sourceConnectionMode = inferConnectionMode(sourceApiType, sourceBaseUrl);
    const sourceDeepSeekApiMode = inferDeepSeekApiMode(sourceBaseUrl);
    const sourceReasoning = options.reasoningPolicy ?? DEFAULT_REASONING_POLICY;
    const draft: ResourceDraft = {
      type: sourceType,
      apiType: sourceApiType,
      connectionMode: sourceConnectionMode,
      deepseekApiMode: sourceDeepSeekApiMode,
      label: options.mode === 'copy' ? `${options.source?.label ?? '资源'}（副本）` : options.source?.label ?? '',
      baseUrl: sourceBaseUrl,
      apiKey: '',
      model: options.source?.model ?? '',
      toolDialect: options.source?.toolDialect ?? defaultToolDialect(sourceApiType, options.source ? 'official' : sourceConnectionMode),
      embeddingPath: options.source?.embeddingPath ?? '/embeddings',
      embeddingDimensions: options.source?.embeddingDimensions ?? '',
      rerankProtocol: options.source?.rerankProtocol ?? (sourceApiType === 'generic' ? 'native' : 'chat'),
      rerankPath: options.source?.rerankPath ?? '/rerank',
      reasoningMode: sourceReasoning.mode,
      reasoningEffort: sourceReasoning.effort,
    };
    this.#state = {
      activeStepId: options.mode === 'edit' ? 'connection' : 'purpose',
      completed: new Set(),
      draft,
      fieldErrors: {},
      busy: false,
      dirty: false,
      modelOptions: options.source?.model
        ? [{ value: options.source.model, label: options.source.model }]
        : [],
      discoveringModels: false,
    };
  }

  snapshot(): PopupWizardSnapshot {
    const draft = this.#state.draft;
    const showAdvanced = this.#mode === 'edit' || this.#showAdvanced;
    const showToolProtocol = draft.type === 'generation'
      && (draft.apiType === 'openai' || draft.apiType === 'xai' || (draft.apiType === 'generic' && isOpenAiToolProtocol(draft.toolDialect)));
    return {
      activeStepId: this.#state.activeStepId,
      completedStepIds: [...this.#state.completed],
      values: { ...this.#state.draft, showAdvanced: this.#showAdvanced },
      fieldErrors: { ...this.#state.fieldErrors },
      fieldOptions: {
        apiType: providerOptions(this.#state.draft.type),
        model: this.#state.modelOptions,
      },
      disabledFieldIds: draft.connectionMode === 'official' && PROVIDER_URLS[draft.apiType] ? ['baseUrl'] : [],
      hiddenFieldIds: [
        ...(!showAdvanced ? ['toolDialect', 'reasoningMode', 'reasoningEffort', 'embeddingPath', 'embeddingDimensions', 'rerankPath', 'deepseekApiMode'] : []),
        ...(draft.reasoningMode === 'disabled' ? ['reasoningEffort'] : []),
        ...(PROVIDER_URLS[draft.apiType] ? [] : ['connectionMode']),
        ...(draft.type === 'generation' && draft.apiType === 'deepseek' && draft.connectionMode === 'official' ? [] : ['deepseekApiMode']),
        ...(showToolProtocol ? [] : ['toolDialect']),
        ...(draft.type === 'generation' ? [] : ['reasoningMode', 'reasoningEffort']),
        ...(draft.type === 'embedding' ? [] : ['embeddingPath', 'embeddingDimensions']),
        ...(draft.type === 'rerank' ? [] : ['rerankProtocol']),
        ...(draft.type === 'rerank' && draft.rerankProtocol === 'native' ? [] : ['rerankPath']),
      ],
      dirty: this.#state.dirty,
      busy: this.#state.busy,
      submitDisabled: this.#state.busy || Object.keys(this.#validate(false)).length > 0,
      ...(this.#state.status === undefined ? {} : { status: this.#state.status }),
    };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  change(fieldId: string, value: PlainData): void {
    if (this.#state.busy) return;
    if (fieldId === 'showAdvanced') { this.#showAdvanced = value === true; this.#emit(); return; }
    const draft = this.#state.draft;
    if (fieldId === 'type' && typeof value === 'string' && ['generation', 'embedding', 'rerank'].includes(value)) {
      draft.type = value as ResourceType;
      if (!providerOptions(draft.type).some((option) => option.value === draft.apiType)) {
        draft.apiType = (providerOptions(draft.type)[0]?.value ?? 'generic') as ApiType;
        draft.baseUrl = officialBaseUrl(draft.apiType, draft.deepseekApiMode);
        draft.connectionMode = PROVIDER_URLS[draft.apiType] ? 'official' : 'relay';
        draft.toolDialect = defaultToolDialect(draft.apiType, draft.connectionMode);
      }
    } else if (fieldId === 'apiType' && typeof value === 'string' && PROVIDERS.includes(value as ApiType)) {
      const previousDefault = PROVIDER_URLS[draft.apiType];
      const previousWasOfficial = draft.connectionMode === 'official' || (!!previousDefault && inferConnectionMode(draft.apiType, draft.baseUrl) === 'official');
      draft.apiType = value as ApiType;
      if (draft.apiType === 'deepseek' && !previousWasOfficial) draft.deepseekApiMode = inferDeepSeekApiMode(draft.baseUrl);
      if (!draft.baseUrl || previousWasOfficial) draft.baseUrl = officialBaseUrl(draft.apiType, draft.deepseekApiMode);
      draft.connectionMode = inferConnectionMode(draft.apiType, draft.baseUrl);
      draft.toolDialect = defaultToolDialect(draft.apiType, draft.connectionMode);
    } else if (fieldId === 'connectionMode' && (value === 'official' || value === 'relay')) {
      draft.connectionMode = value;
      if (value === 'official' && PROVIDER_URLS[draft.apiType]) draft.baseUrl = officialBaseUrl(draft.apiType, draft.deepseekApiMode);
      draft.toolDialect = defaultToolDialect(draft.apiType, value);
    } else if (fieldId === 'deepseekApiMode' && (value === 'standard' || value === 'beta')) {
      draft.deepseekApiMode = value;
      if (draft.apiType === 'deepseek' && draft.connectionMode === 'official') draft.baseUrl = officialBaseUrl(draft.apiType, value);
    } else if (fieldId === 'label' && typeof value === 'string') draft.label = value;
    else if (fieldId === 'baseUrl' && typeof value === 'string') draft.baseUrl = value;
    else if (fieldId === 'apiKey' && typeof value === 'string') draft.apiKey = value;
    else if (fieldId === 'model' && typeof value === 'string') draft.model = value;
    else if (fieldId === 'toolDialect' && (value === 'openai_chat_compatible' || value === 'openai_responses')) draft.toolDialect = value;
    else if (fieldId === 'embeddingPath' && typeof value === 'string') draft.embeddingPath = value;
    else if (fieldId === 'embeddingDimensions' && (typeof value === 'number' || value === '')) draft.embeddingDimensions = value;
    else if (fieldId === 'rerankProtocol' && (value === 'native' || value === 'chat')) draft.rerankProtocol = value;
    else if (fieldId === 'rerankPath' && typeof value === 'string') draft.rerankPath = value;
    else if (fieldId === 'reasoningMode' && REASONING_MODE_OPTIONS.some((option) => option.value === value)) {
      draft.reasoningMode = value as LlmReasoningMode;
      if (draft.reasoningMode === 'disabled') draft.reasoningEffort = 'provider_default';
    }
    else if (fieldId === 'reasoningEffort' && REASONING_EFFORT_OPTIONS.some((option) => option.value === value)) draft.reasoningEffort = value as LlmReasoningEffort;
    else return;
    this.#state.dirty = true;
    this.#state.status = undefined;
    this.#state.fieldErrors = this.#validate(false);
    this.#emit();
    if (fieldId === 'type' || fieldId === 'apiType' || fieldId === 'connectionMode' || fieldId === 'deepseekApiMode' || fieldId === 'baseUrl' || fieldId === 'apiKey' || fieldId === 'model' || fieldId === 'reasoningMode' || fieldId === 'reasoningEffort') {
      this.#state.modelOptions = [];
      this.#scheduleModelDiscovery();
    }
  }

  navigate(stepId: string): void {
    if (this.#mode === 'edit') return;
    if (!STEP_IDS.includes(stepId as WizardStepId) || (!this.#state.completed.has(stepId as WizardStepId) && stepId !== this.#state.activeStepId)) return;
    this.#state.activeStepId = stepId as WizardStepId;
    this.#state.fieldErrors = this.#validateStep(this.#state.activeStepId, false);
    this.#emit();
  }

  back(): void {
    if (this.#mode === 'edit') return;
    const index = STEP_IDS.indexOf(this.#state.activeStepId);
    if (index <= 0 || this.#state.busy) return;
    this.#state.activeStepId = STEP_IDS[index - 1]!;
    this.#state.fieldErrors = this.#validateStep(this.#state.activeStepId, false);
    this.#emit();
  }

  async submit(): Promise<void> {
    if (this.#state.busy) return;
    const errors = this.#validate(true);
    this.#state.fieldErrors = errors;
    if (Object.keys(errors).length > 0) {
      this.#emit();
      return;
    }
    if (this.#mode === 'edit') { await this.#save(); return; }
    const index = STEP_IDS.indexOf(this.#state.activeStepId);
    if (index < STEP_IDS.length - 1) {
      this.#state.completed.add(this.#state.activeStepId);
      this.#state.activeStepId = STEP_IDS[index + 1]!;
      this.#emit();
      if (this.#state.activeStepId === 'connection') this.#scheduleModelDiscovery();
      return;
    }
    await this.#save();
  }

  async action(actionId: string): Promise<void> {
    if (actionId !== 'refresh-models' || this.#state.busy || this.#state.discoveringModels) return;
    if (parseBaseUrl(this.#state.draft.baseUrl.trim()) === undefined || (!this.#state.draft.apiKey.trim() && !(this.#mode === 'edit' && this.#hasStoredSecret))) {
      this.#state.fieldErrors = this.#validate(true);
      this.#state.status = { tone: 'warning', message: '请先填写有效的地址和密钥。', code: 'LLM_RESOURCE_INPUT_REQUIRED' };
      this.#notify('warning', '暂无法获取模型', this.#state.status.message, 'LLM_RESOURCE_INPUT_REQUIRED');
      this.#emit();
      return;
    }
    if (this.#modelDiscoveryTimer !== undefined) clearTimeout(this.#modelDiscoveryTimer);
    await this.#discoverModels();
    if (this.#state.status?.tone === 'warning') this.#notify('warning', '模型列表不可用', this.#state.status.message, this.#state.status.code ?? 'LLM_MODEL_DISCOVERY_FAILED');
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
    this.#state.discoveringModels = false;
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
        model: this.#state.draft.model.trim(),
        enabled: false,
        capabilities: capabilities(this.#state.draft.type),
        ...(this.#source?.customParams === undefined ? {} : { customParams: this.#source.customParams }),
        ...(this.#state.draft.type === 'generation' ? { toolDialect: this.#state.draft.toolDialect } : {}),
        ...(this.#source?.privacyPolicy === undefined ? {} : { privacyPolicy: this.#source.privacyPolicy }),
        ...(this.#state.draft.type === 'embedding' ? {
          embeddingPath: parseOperationPath(this.#state.draft.embeddingPath) ?? '/embeddings',
          ...(typeof this.#state.draft.embeddingDimensions === 'number' ? { embeddingDimensions: this.#state.draft.embeddingDimensions } : {}),
        } : {}),
        ...(this.#state.draft.type === 'rerank' ? {
          rerankProtocol: this.#state.draft.rerankProtocol,
          ...(this.#state.draft.rerankProtocol === 'native' ? { rerankPath: parseOperationPath(this.#state.draft.rerankPath) ?? '/rerank' } : {}),
        } : {}),
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

  #validate(includeRequired: boolean): Record<string, string> {
    return this.#mode === 'edit' || this.#state.activeStepId === 'verification'
      ? Object.assign({}, ...(['purpose', 'provider', 'connection'] as const).map((step) => this.#validateStep(step, includeRequired)))
      : this.#validateStep(this.#state.activeStepId, includeRequired);
  }

  #validateStep(step: WizardStepId, includeRequired: boolean): Record<string, string> {
    const errors: Record<string, string> = {};
    const draft = this.#state.draft;
    if (step === 'purpose' && !['generation', 'embedding', 'rerank'].includes(draft.type)) errors.type = '请选择资源用途';
    if (step === 'provider' && !providerOptions(draft.type).some((option) => option.value === draft.apiType)) errors.apiType = '当前服务不支持所选用途';
    if (step === 'connection') {
      if (draft.label.trim().length > 128) errors.label = '资源名称不能超过 128 个字符';
      if (!draft.baseUrl.trim() || parseBaseUrl(draft.baseUrl.trim()) === undefined) errors.baseUrl = '请输入无凭据、查询参数和片段的 HTTP(S) 地址';
      if (!draft.model.trim()) errors.model = '请输入模型 ID';
      if ((this.#mode !== 'edit' || !this.#hasStoredSecret) && !draft.apiKey.trim()) errors.apiKey = '请输入 API Key';
      if (draft.apiKey.length > 65_536) errors.apiKey = 'API Key 过长';
      if (draft.connectionMode === 'official' && !PROVIDER_URLS[draft.apiType]) errors.connectionMode = '当前服务没有可用的官方地址';
      if (draft.type === 'generation') {
        if (!REASONING_MODE_OPTIONS.some((option) => option.value === draft.reasoningMode)) errors.reasoningMode = '请选择思考模式';
        if (!REASONING_EFFORT_OPTIONS.some((option) => option.value === draft.reasoningEffort)) errors.reasoningEffort = '请选择思考强度';
        if (draft.reasoningMode === 'disabled' && draft.reasoningEffort !== 'provider_default') errors.reasoningEffort = '关闭思考时强度必须跟随默认';
        if (draft.apiType === 'generic' && (draft.reasoningMode !== 'provider_default' || draft.reasoningEffort !== 'provider_default')) errors.reasoningMode = '通用兼容服务只允许跟随 Provider 默认';
        if ((draft.apiType === 'xai' || draft.apiType === 'kimi') && draft.reasoningMode === 'disabled') errors.reasoningMode = '当前 Provider 不支持关闭思考';
      }
      if (draft.type === 'generation' && (draft.apiType === 'openai' || draft.apiType === 'xai' || draft.apiType === 'generic')
        && !isOpenAiToolProtocol(draft.toolDialect)) errors.toolDialect = '请选择 Chat Completions 或 Responses API';
      if (draft.type === 'embedding') {
        if (parseOperationPath(draft.embeddingPath) === undefined) errors.embeddingPath = '请输入以单个 / 开头且不含查询参数或片段的路径';
        if (draft.embeddingDimensions !== '' && (!Number.isInteger(draft.embeddingDimensions) || draft.embeddingDimensions <= 0 || draft.embeddingDimensions > 100_000)) errors.embeddingDimensions = '向量维度必须是 1 到 100000 的整数';
      }
      if (draft.type === 'rerank') {
        if (draft.rerankProtocol !== 'native' && draft.rerankProtocol !== 'chat') errors.rerankProtocol = '请选择重排协议';
        if (draft.rerankProtocol === 'native' && parseOperationPath(draft.rerankPath) === undefined) errors.rerankPath = '请输入以单个 / 开头且不含查询参数或片段的路径';
      }
    }
    if (!includeRequired && !this.#state.dirty && step === 'purpose') return {};
    return errors;
  }

  async #save(): Promise<void> {
    if (this.#modelDiscoveryTimer !== undefined) clearTimeout(this.#modelDiscoveryTimer);
    this.#modelDiscoveryTimer = undefined;
    this.#modelDiscoveryAbort?.abort();
    this.#modelDiscoveryAbort = undefined;
    this.#state.discoveringModels = false;
    this.#state.busy = true;
    this.#state.status = { tone: 'neutral', message: '正在保存资源配置…' };
    this.#emit();
    let oldSecret: string | null = null;
    let stage = 'llm.resource.secret';
    try {
      oldSecret = this.#source === undefined ? null : await this.#repository.getResourceSecret(this.#source.id);
      if (this.#abortController.signal.aborted) return;
      const key = this.#state.draft.apiKey.trim() || oldSecret;
      if (!key) throw createSSHelperError('AUTH_FAILED', { stage: 'llm.resource.secret' });
      const id = this.#mode === 'edit' && this.#source !== undefined ? this.#source.id : resourceId();
      const candidate: ResourceConfig = {
        id,
        type: this.#state.draft.type,
        source: 'custom',
        apiType: this.#state.draft.apiType,
        label: this.#state.draft.label.trim() || `${PROVIDER_LABELS[this.#state.draft.apiType]} · ${this.#state.draft.model.trim()}`.slice(0, 128),
        baseUrl: parseBaseUrl(this.#state.draft.baseUrl.trim()),
        model: this.#state.draft.model.trim(),
        enabled: this.#mode === 'edit' ? this.#source?.enabled ?? true : true,
        capabilities: capabilities(this.#state.draft.type),
        ...(this.#source?.customParams === undefined ? {} : { customParams: this.#source.customParams }),
        ...(this.#state.draft.type === 'generation' ? { toolDialect: this.#state.draft.toolDialect } : {}),
        ...(this.#source?.privacyPolicy === undefined ? {} : { privacyPolicy: this.#source.privacyPolicy }),
        ...(this.#state.draft.type === 'embedding' ? {
          embeddingPath: parseOperationPath(this.#state.draft.embeddingPath),
          ...(typeof this.#state.draft.embeddingDimensions === 'number' ? { embeddingDimensions: this.#state.draft.embeddingDimensions } : {}),
        } : {}),
        ...(this.#state.draft.type === 'rerank' ? {
          rerankProtocol: this.#state.draft.rerankProtocol,
          ...(this.#state.draft.rerankProtocol === 'native' ? { rerankPath: parseOperationPath(this.#state.draft.rerankPath) } : {}),
        } : {}),
      };
      stage = 'llm.resource.save';
      await this.#repository.saveResource(candidate, key, {
        ...(candidate.type === 'generation' ? { reasoningPolicy: { mode: this.#state.draft.reasoningMode, effort: this.#state.draft.reasoningEffort } } : {}),
        secretMetadata: { label: candidate.label },
      });
      this.#state.dirty = false;
      this.#state.status = { tone: 'success', message: '资源配置已保存。' };
      this.#notify('success', '资源已保存', `${candidate.label} 的配置已保存。`, 'LLM_RESOURCE_SAVED');
      this.#emit();
      this.#ui.close();
    } catch (error) {
      const diagnostic = describeSSHelperFailure(error, { reasonCode: 'INTERNAL_ERROR', stage });
      const failure = readSSHelperFailure(error, { reasonCode: diagnostic.reasonCode, stage });
      this.#state.status = { tone: 'error', message: `尚未保存。${diagnostic.title}：${diagnostic.reason} ${diagnostic.action}${failure?.requestId ? ` 请求 ID：${failure.requestId}` : ''}`, code: diagnostic.reasonCode };
      this.#notify('error', diagnostic.title, `${diagnostic.reason} ${diagnostic.action}`, diagnostic.reasonCode);
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
  const hasStoredSecret = source !== undefined && await repository.hasResourceSecret(source.id);
  const controller = new ResourceWizardController({
    mode,
    source,
    hasStoredSecret,
    timeoutMs: settings.timeoutMs ?? 20_000,
    repository,
    ui,
    notify,
    verification: verificationCoordinator(session),
    reasoningPolicy: source === undefined ? DEFAULT_REASONING_POLICY : settings.resourcePolicies?.[source.id] ?? DEFAULT_REASONING_POLICY,
  });
  const definition = mode === 'edit' && source !== undefined
    ? resourceEditorDefinition(source, hasStoredSecret, (await repository.listResourceHealth()).find((health) => health.resourceId === source.id))
    : RESOURCE_WIZARD_DEFINITION;
  const handle = ui.mountWizard(definition, controller);
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
  toolServices: ResourceToolServices,
): Promise<() => void> {
  let disposed = false;
  let provider = 'all';
  let statusFilter = 'all';
  let settings = await repository.loadSettings();
  let expandedResourceId = settings.resources?.find((resource) => resource.type === 'generation')?.id ?? settings.resources?.[0]?.id;
  let healthRecords = await repository.listResourceHealth();
  let toolCapabilities = new Map<string, Awaited<ReturnType<NonNullable<LlmServiceHandlers['taskStatus']>>>['resources'][number]['toolCapabilities']>();
  let reasoningCapabilities = new Map<string, Awaited<ReturnType<NonNullable<LlmServiceHandlers['taskStatus']>>>['resources'][number]['reasoningCapabilities']>();
  let embeddingCapabilities = new Map<string, VerifiedEmbeddingCapabilities | undefined>();
  let loadSequence = 0;
  const testControllers = new Map<string, AbortController>();
  const toolTestControllers = new Map<string, AbortController>();
  const menuHandles = new Set<PopupMenuHandle>();
  const testing = new Set<string>();
  const toolTesting = new Set<string>();
  const embeddingTesting = new Set<string>();
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
  const refresh = ui.createButton({ label: '刷新', ariaLabel: '刷新资源列表', icon: 'rotate', iconOnly: true, size: 'md' });
  const toolbar = container.ownerDocument.createElement('div');
  toolbar.className = 'ss-helper-llm-resource-toolbar';
  toolbar.append(search, providerSelect, statusSelect, refresh);
  const tavernPolicySection = container.ownerDocument.createElement('details');
  tavernPolicySection.className = 'ss-helper-llm-tavern-policy-section';
  const tavernPolicyHeading = container.ownerDocument.createElement('summary');
  tavernPolicyHeading.textContent = '酒馆当前连接思考策略';
  const tavernPolicyBar = container.ownerDocument.createElement('div');
  tavernPolicyBar.className = 'ss-helper-llm-tavern-reasoning-policy';
  const tavernPolicyLabel = container.ownerDocument.createElement('span');
  tavernPolicyLabel.textContent = '仅影响 SS-Helper 的酒馆连接请求';
  let tavernPolicy = settings.resourcePolicies?.['tavern:active'] ?? DEFAULT_REASONING_POLICY;
  const saveTavernPolicy = async (next: LlmReasoningPolicy): Promise<void> => {
    try {
      await repository.updateSettings((current) => ({
        ...current,
        resourcePolicies: { ...(current.resourcePolicies ?? {}), 'tavern:active': next },
      }));
      tavernPolicy = next;
      showToast('success', '思考策略已保存', '酒馆当前连接策略只影响 SS-Helper 请求。', 'LLM_REASONING_POLICY_SAVED');
    } catch (error) {
      showToast('error', '思考策略保存失败', '酒馆当前连接策略没有改变。', safeCode(error, 'INTERNAL_ERROR', 'llm.tavern.reasoning.save'));
    }
  };
  tavernPolicySection.append(tavernPolicyHeading, tavernPolicyBar);
  const list = container.ownerDocument.createElement('div');
  list.className = 'ss-helper-llm-resource-groups';
  const legend = container.ownerDocument.createElement('div');
  legend.className = 'ss-helper-llm-resource-legend';
  for (const [label, state, icon] of [['已配置', 'configured', 'circle-check'], ['已验证', 'verified', 'circle-check'], ['未验证', 'unknown', 'circle-question'], ['不适用', 'na', 'minus']] as const) {
    const item = container.ownerDocument.createElement('span');
    item.dataset.capabilityState = state;
    const copy = container.ownerDocument.createElement('span');
    copy.textContent = label;
    item.append(ui.createIcon({ name: icon, decorative: true }), copy);
    legend.append(item);
  }
  const legendHint = container.ownerDocument.createElement('p');
  legendHint.textContent = '已配置表示资源用途；功能支持以实测结果为准。';
  legend.append(legendHint);
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
    return !query || `${resource.label} ${resource.model ?? ''} ${PROVIDER_LABELS[resource.apiType]}`.toLocaleLowerCase().includes(query);
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
      showToast(result.ok ? 'success' : 'error', result.ok ? '连接测试通过' : '连接测试失败', result.ok ? `${resource.label} 的连接与模型响应正常。${resource.type === 'generation' ? 'Agent 需单独验证工具调用。' : ''}` : '请检查连接配置后重试。', reasonCode ?? 'LLM_RESOURCE_TEST_SUCCEEDED');
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
  const verifyToolCalls = async (resource: ResourceConfig): Promise<void> => {
    if (toolTesting.has(resource.id)) return;
    if (resource.type !== 'generation' || resource.enabled === false || !resource.model || toolServices.verifyResourceCapability === undefined) {
      throw createSSHelperError('LLM_CAPABILITY_UNAVAILABLE', {
        stage: 'llm.resource.tool_probe.precondition',
        resourceId: resource.id,
        ...(resource.model ? { model: resource.model } : {}),
      });
    }
    const controller = new AbortController();
    toolTestControllers.set(resource.id, controller);
    toolTesting.add(resource.id);
    status.textContent = `正在验证 ${resource.label} 的原生工具调用能力…`;
    render();
    try {
      const response = await toolServices.verifyResourceCapability({
        resourceId: resource.id,
        taskKeys: ['memory_extract_entities', 'memory_extract_content'],
        force: true,
      }, controller.signal, 'ss-helper.llm', toolProbeRequestId());
      if (controller.signal.aborted) return;
      const capability = response.capabilities[0];
      toolCapabilities.set(resource.id, capability);
      if (capability?.status !== 'verified') {
        const diagnostic = describeSSHelperFailure(capability?.failure ?? response.reasoning?.executions.find(item => item.execution === 'tool_turn')?.failure, {
          reasonCode: 'LLM_MODEL_PROBE_FAILED', stage: 'llm.resource.tool_probe', resourceId: resource.id, model: resource.model,
        });
        status.textContent = `${resource.label} 的工具调用验证未通过（${diagnostic.reasonCode}）：${diagnostic.title}。${diagnostic.action}`;
        showToast('error', diagnostic.title, `${diagnostic.reason} ${diagnostic.action}`, diagnostic.reasonCode);
        return;
      }
      status.textContent = `${resource.label} 已通过原生工具调用验证；能力按资源和模型缓存。`;
      showToast('success', '工具调用已验证', `${resource.label} 可以用于 Agent 模式。`, 'LLM_TOOL_CAPABILITY_VERIFIED');
    } catch (error) {
      if (controller.signal.aborted) return;
      const diagnostic = describeSSHelperFailure(error, {
        reasonCode: 'LLM_MODEL_PROBE_FAILED', stage: 'llm.resource.tool_probe', resourceId: resource.id, model: resource.model,
      });
      status.textContent = `${resource.label} 的工具调用验证失败（${diagnostic.reasonCode}）：${diagnostic.title}。${diagnostic.action}`;
      showToast('error', diagnostic.title, `${diagnostic.reason} ${diagnostic.action}`, diagnostic.reasonCode);
    } finally {
      toolTesting.delete(resource.id);
      toolTestControllers.delete(resource.id);
      if (!disposed) await load();
    }
  };
  const verifyEmbeddingBatch = async (resource: ResourceConfig): Promise<void> => {
    if (embeddingTesting.has(resource.id)) return;
    if (resource.type !== 'embedding' || resource.enabled === false || !resource.model || toolServices.verifyResourceCapability === undefined) {
      throw createSSHelperError('LLM_CAPABILITY_UNAVAILABLE', {
        stage: 'llm.resource.embedding_probe.precondition',
        resourceId: resource.id,
        ...(resource.model ? { model: resource.model } : {}),
      });
    }
    const controller = new AbortController();
    toolTestControllers.set(resource.id, controller);
    embeddingTesting.add(resource.id);
    status.textContent = `正在验证 ${resource.label} 的 Embedding 批量能力…`;
    render();
    try {
      const response = await toolServices.verifyResourceCapability({ resourceId: resource.id, taskKeys: ['memory_embed'], force: true }, controller.signal, 'ss-helper.llm', toolProbeRequestId());
      if (controller.signal.aborted) return;
      const capability = response.embedding;
      if (capability !== undefined) embeddingCapabilities.set(resource.id, capability);
      if (capability?.status !== 'verified') {
        const diagnostic = describeSSHelperFailure(capability?.failure, {
          reasonCode: 'LLM_MODEL_PROBE_FAILED', stage: 'llm.resource.embedding_probe', resourceId: resource.id, model: resource.model,
        });
        status.textContent = `${resource.label} 的 Embedding 批量验证未通过（${diagnostic.reasonCode}）：${diagnostic.title}。${diagnostic.action}`;
        showToast('error', diagnostic.title, `${diagnostic.reason} ${diagnostic.action}`, diagnostic.reasonCode);
        return;
      }
      status.textContent = `${resource.label} 已验证 Embedding 批量上限 ${capability.verifiedMaxBatchInputs}。`;
      showToast('success', 'Embedding 能力已验证', `${resource.label} 每批最多 ${capability.verifiedMaxBatchInputs} 条。`, 'LLM_EMBEDDING_CAPABILITY_VERIFIED');
    } catch (error) {
      if (controller.signal.aborted) return;
      const diagnostic = describeSSHelperFailure(error, {
        reasonCode: 'LLM_MODEL_PROBE_FAILED', stage: 'llm.resource.embedding_probe', resourceId: resource.id, model: resource.model,
      });
      status.textContent = `${resource.label} 的 Embedding 批量验证失败（${diagnostic.reasonCode}）：${diagnostic.title}。${diagnostic.action}`;
      showToast('error', diagnostic.title, `${diagnostic.reason} ${diagnostic.action}`, diagnostic.reasonCode);
    } finally {
      embeddingTesting.delete(resource.id);
      toolTestControllers.delete(resource.id);
      if (!disposed) await load();
    }
  };
  const toggleResource = async (resource: ResourceConfig): Promise<void> => {
    if (mutating.has(resource.id)) return;
    mutating.add(resource.id);
    render();
    try {
      const enabled = resource.enabled === false;
      await repository.updateSettings((current) => ({
        ...current,
        resources: current.resources?.map((item) => item.id === resource.id ? { ...item, enabled } : item) ?? [],
      }));
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
      if (action === 'edit') session.ui.openPopup(LLM_RESOURCE_EDITOR_POPUP, { mode: 'edit', resourceId: resource.id });
      else if (action === 'copy') session.ui.openPopup(LLM_RESOURCE_WIZARD_POPUP, { mode: 'copy', resourceId: resource.id });
      else if (action === 'test') await testResource(resource);
      else if (action === 'verify-tools') await verifyToolCalls(resource);
      else if (action === 'verify-embedding') await verifyEmbeddingBatch(resource);
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
    const focusedResource = container.ownerDocument.activeElement?.closest<HTMLElement>('[data-resource-expand]')?.dataset.resourceExpand;
    disposeMenus();
    renderSummary();
    tavernPolicy = settings.resourcePolicies?.['tavern:active'] ?? DEFAULT_REASONING_POLICY;
    tavernPolicyBar.replaceChildren(tavernPolicyLabel,
      ui.createSelect({ label: '酒馆思考模式', value: tavernPolicy.mode, options: [...REASONING_MODE_OPTIONS], onChange: (value) => { const mode = value as LlmReasoningMode; void saveTavernPolicy({ mode, effort: mode === 'disabled' ? 'provider_default' : tavernPolicy.effort }).finally(() => { if (!disposed) void load(); }); } }),
      ui.createSelect({ label: '酒馆思考强度', value: tavernPolicy.effort, disabled: tavernPolicy.mode === 'disabled', options: [...REASONING_EFFORT_OPTIONS], onChange: (value) => { void saveTavernPolicy({ mode: tavernPolicy.mode, effort: value as LlmReasoningEffort }).finally(() => { if (!disposed) void load(); }); } }),
    );
    list.replaceChildren();
    const healthMap = healthByResource();
    const visible = (['generation', 'embedding', 'rerank'] as const).flatMap((type) => (settings.resources ?? []).filter((resource) => resource.type === type && matchesFilters(resource, healthMap.get(resource.id))));
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
    const group = container.ownerDocument.createElement('div');
    group.className = 'ss-helper-llm-resource-table';
    group.setAttribute('role', 'table');
    group.setAttribute('aria-label', '资源与模型能力');
    const columns = container.ownerDocument.createElement('div');
    columns.className = 'ss-helper-llm-resource-columns';
    columns.setAttribute('role', 'row');
    const labels = ['资源', '类型', '连接', '文本生成', '工具调用', '思考控制', '向量化', '重排序', '操作'];
    for (const label of labels) {
      const cell = container.ownerDocument.createElement('span');
      cell.textContent = label;
      cell.setAttribute('role', 'columnheader');
      columns.append(cell);
    }
    group.append(columns);
    for (const resource of visible) {
        const health = healthMap.get(resource.id);
        const row = container.ownerDocument.createElement('article');
        row.className = 'ss-helper-llm-resource-row';
        row.dataset.resourceId = resource.id;
        row.dataset.expanded = String(expandedResourceId === resource.id);
        row.setAttribute('role', 'row');
        row.dataset.state = testing.has(resource.id) ? 'testing' : mutating.has(resource.id) ? 'busy' : resourceState(resource, health);
        const identity = container.ownerDocument.createElement('div');
        identity.className = 'ss-helper-llm-resource-identity';
        const expand = ui.createButton({ label: '功能详情', ariaLabel: `${resource.label} 功能详情`, icon: expandedResourceId === resource.id ? 'chevron-down' : 'chevron-right', iconOnly: true, size: 'sm' });
        expand.dataset.resourceExpand = resource.id;
        expand.setAttribute('aria-expanded', String(expandedResourceId === resource.id));
        expand.setAttribute('aria-controls', `llm-resource-detail-${resource.id}`);
        const toggleExpanded = (): void => { expand.focus(); expandedResourceId = expandedResourceId === resource.id ? undefined : resource.id; render(); };
        expand.addEventListener('click', (event) => { event.stopPropagation(); toggleExpanded(); });
        row.addEventListener('click', (event) => {
          if (!(event.target as HTMLElement).closest('button, .ss-helper-llm-resource-actions')) toggleExpanded();
        });
        const identityCopy = container.ownerDocument.createElement('div');
        const name = container.ownerDocument.createElement('strong');
        name.textContent = resource.label;
        const providerName = container.ownerDocument.createElement('span');
        providerName.textContent = `${PROVIDER_LABELS[resource.apiType]} · ${resource.model || '未指定模型'}`;
        identityCopy.append(name, providerName);
        identity.append(expand, identityCopy);
        const type = container.ownerDocument.createElement('span');
        type.textContent = PURPOSE_LABELS[resource.type];
        const connection = container.ownerDocument.createElement('div');
        connection.className = 'ss-helper-llm-resource-connection';
        const state = container.ownerDocument.createElement('span');
        state.className = 'ss-helper-llm-resource-state';
        state.textContent = testing.has(resource.id) ? '测试中' : mutating.has(resource.id) ? '处理中' : resource.enabled === false ? '已停用' : health?.state === 'success' ? '正常' : health?.state === 'failed' ? '失败' : '未测试';
        const duration = container.ownerDocument.createElement('span');
        duration.textContent = health ? `${health.durationMs} ms` : '等待测试';
        connection.append(state, duration);
        const capabilityState = (capability: { status: string; expiresAt?: number } | undefined, busy = false): string => busy ? 'testing' : capability?.expiresAt !== undefined && capability.expiresAt <= Date.now() ? 'expired' : capability?.status === 'verified' ? 'verified' : capability?.status === 'failed' ? 'failed' : 'unknown';
        const tool = toolCapabilities.get(resource.id);
        const reasoning = reasoningCapabilities.get(resource.id);
        const embedding = embeddingCapabilities.get(resource.id);
        const toolState = capabilityState(tool, toolTesting.has(resource.id));
        let reasoningState = capabilityState(reasoning);
        if (reasoningState === 'verified' && reasoning?.executions.some((execution) => execution.status !== 'verified')) reasoningState = 'partial';
        const batchState = capabilityState(embedding, embeddingTesting.has(resource.id));
        const stateLabels: Record<string, string> = { configured: '已配置', verified: '已验证', unknown: '未验证', failed: '未通过', partial: '部分可用', expired: '已过期', testing: '验证中', na: '不适用' };
        const capabilityCell = (label: string, value: string): HTMLElement => {
          const cell = container.ownerDocument.createElement('span');
          cell.className = 'ss-helper-llm-resource-capability';
          cell.dataset.capabilityState = value;
          cell.dataset.columnLabel = label;
          cell.setAttribute('aria-label', `${label}：${stateLabels[value]}`);
          cell.append(ui.createIcon({ name: value === 'configured' || value === 'verified' ? 'circle-check' : value === 'na' ? 'minus' : value === 'failed' ? 'circle-xmark' : 'circle-question', decorative: true }));
          const text = container.ownerDocument.createElement('span');
          text.textContent = stateLabels[value];
          cell.append(text);
          return cell;
        };
        const actions = container.ownerDocument.createElement('div');
        actions.className = 'ss-helper-llm-resource-actions';
        const test = ui.createButton({ label: testing.has(resource.id) ? '测试中' : health?.state === 'failed' ? '重试' : '测试', ariaLabel: `${resource.label} 测试连接`, size: 'sm', disabled: testing.has(resource.id) || mutating.has(resource.id) });
        test.title = '测试连接与模型响应';
        test.addEventListener('click', () => { void runAction(resource, 'test'); });
        actions.append(test);
        const edit = ui.createButton({ label: '编辑', ariaLabel: `${resource.label} 编辑`, size: 'sm', disabled: mutating.has(resource.id) });
        edit.addEventListener('click', () => { void runAction(resource, 'edit'); });
        actions.append(edit);
        const menu = ui.createMenu({
          label: `${resource.label} 更多操作`,
          items: [
            { id: 'copy', label: '复制资源', icon: 'copy', disabled: mutating.has(resource.id) },
            { id: 'test', label: testing.has(resource.id) ? '正在测试' : '测试连接', icon: 'flask', disabled: testing.has(resource.id) || mutating.has(resource.id) },
            ...(resource.type === 'generation' ? [{ id: 'verify-tools', label: toolTesting.has(resource.id) ? '正在验证工具调用' : '验证工具调用', icon: 'screwdriver-wrench', disabled: toolTesting.has(resource.id) || testing.has(resource.id) || mutating.has(resource.id) || resource.enabled === false || !resource.model }] : []),
            ...(resource.type === 'embedding' ? [{ id: 'verify-embedding', label: embeddingTesting.has(resource.id) ? '正在验证 Embedding 批量' : '验证 Embedding 批量', icon: 'grip', disabled: embeddingTesting.has(resource.id) || testing.has(resource.id) || mutating.has(resource.id) || resource.enabled === false || !resource.model }] : []),
            { id: 'toggle', label: resource.enabled === false ? '启用资源' : '停用资源', icon: resource.enabled === false ? 'toggle-on' : 'toggle-off', separatorBefore: true, disabled: mutating.has(resource.id) },
            { id: 'delete', label: '删除资源', icon: 'trash', tone: 'danger', separatorBefore: true, disabled: mutating.has(resource.id) },
          ],
          onSelect: (action) => runAction(resource, action),
        });
        menuHandles.add(menu);
        actions.append(menu.element);
        row.append(identity, type, connection,
          capabilityCell('文本生成', resource.type === 'generation' ? 'configured' : 'na'),
          capabilityCell('工具调用', resource.type === 'generation' ? toolState : 'na'),
          capabilityCell('思考控制', resource.type === 'generation' ? reasoningState : 'na'),
          capabilityCell('向量化', resource.type === 'embedding' ? 'configured' : 'na'),
          capabilityCell('重排序', resource.type === 'rerank' ? 'configured' : 'na'), actions);
        Array.from(row.children).forEach((cell, index) => { cell.setAttribute('role', 'cell'); (cell as HTMLElement).dataset.columnLabel = labels[index]; });
        group.append(row);
        const detail = container.ownerDocument.createElement('div');
        detail.id = `llm-resource-detail-${resource.id}`;
        detail.className = 'ss-helper-llm-resource-detail';
        detail.hidden = expandedResourceId !== resource.id;
        detail.setAttribute('role', 'row');
        const detailCell = container.ownerDocument.createElement('div');
        detailCell.className = 'ss-helper-llm-resource-detail-layout';
        detailCell.setAttribute('role', 'cell');
        detailCell.setAttribute('aria-colspan', String(labels.length));
        const checks = container.ownerDocument.createElement('section');
        const heading = container.ownerDocument.createElement('h3');
        heading.textContent = '功能验证详情';
        const hint = container.ownerDocument.createElement('p');
        hint.textContent = '连接正常不代表全部能力已验证。';
        checks.append(heading, hint);
        const addCheck = (label: string, value: string, description: string, action?: string): void => {
          const check = container.ownerDocument.createElement('div');
          check.className = 'ss-helper-llm-resource-check';
          const title = container.ownerDocument.createElement('span');
          title.textContent = label;
          const copy = container.ownerDocument.createElement('p');
          copy.textContent = description;
          check.append(title, capabilityCell(label, value), copy);
          if (action) {
            const verify = ui.createButton({ label: '验证', ariaLabel: `${resource.label} 验证${label}`, size: 'sm', disabled: resource.enabled === false || !resource.model || testing.has(resource.id) || toolTesting.has(resource.id) || embeddingTesting.has(resource.id) || mutating.has(resource.id) || !toolServices.verifyResourceCapability });
            verify.addEventListener('click', () => { void runAction(resource, action); });
            check.append(verify);
          }
          checks.append(check);
        };
        if (resource.type === 'generation') {
          addCheck('工具调用', toolState, toolState === 'verified' ? `协议：${tool?.dialect}` : tool?.failure ? describeSSHelperFailure(tool.failure).title : '验证后可确认 Agent 工具调用能力。', 'verify-tools');
          addCheck('思考策略', reasoningState, reasoning?.executions.length ? reasoning.executions.map((item) => `${item.execution === 'completion' ? '普通生成' : item.execution === 'structured' ? '结构化输出' : '工具调用'}：${stateLabels[capabilityState(item)]}`).join(' · ') : '点击工具调用“验证”，可同时验证思考策略。');
        } else if (resource.type === 'embedding') {
          addCheck('批量向量化', batchState, batchState === 'verified' ? `实测每批最多 ${embedding?.verifiedMaxBatchInputs} 条。` : embedding?.failure ? describeSSHelperFailure(embedding.failure).title : '批量能力需要单独验证。', 'verify-embedding');
        } else {
          addCheck('重排序', 'configured', resource.rerankProtocol === 'chat' ? '聊天模型通过结构化评分重排。' : `原生重排接口：${resource.rerankPath ?? '/rerank'}`);
        }
        const latest = container.ownerDocument.createElement('p');
        latest.className = 'ss-helper-llm-resource-latest';
        latest.textContent = `最近连接测试：${formatCheckedAt(health)}`;
        checks.append(latest);
        if (health?.failure) {
          const failure = container.ownerDocument.createElement('p');
          const diagnostic = describeSSHelperFailure(health.failure);
          failure.textContent = `${diagnostic.reasonCode} · ${diagnostic.title}。${diagnostic.action}`;
          checks.append(failure);
        }
        detailCell.append(checks);
        const configuration = container.ownerDocument.createElement('section');
        const configHeading = container.ownerDocument.createElement('h3');
        configHeading.textContent = resource.type === 'generation' ? '当前资源思考策略' : '模型配置';
        configuration.append(configHeading);
        if (resource.type === 'generation') {
          const policy = settings.resourcePolicies?.[resource.id] ?? DEFAULT_REASONING_POLICY;
          const policyHint = container.ownerDocument.createElement('p');
          policyHint.textContent = '仅影响此资源的 SS-Helper 请求';
          const policyControls = container.ownerDocument.createElement('div');
          policyControls.className = 'ss-helper-llm-resource-policy-controls';
          const savePolicy = async (next: LlmReasoningPolicy): Promise<void> => {
            if (mutating.has(resource.id)) return;
            mutating.add(resource.id);
            render();
            try {
              await repository.updateSettings((current) => ({ ...current, resourcePolicies: { ...(current.resourcePolicies ?? {}), [resource.id]: next } }));
              showToast('success', '思考策略已保存', resource.label, 'LLM_REASONING_POLICY_SAVED');
            } catch (error) {
              showToast('error', '思考策略保存失败', '请重试，原策略已保留。', safeCode(error, 'INTERNAL_ERROR', 'llm.resource.reasoning.save'));
            } finally {
              mutating.delete(resource.id);
              if (!disposed) await load();
            }
          };
          policyControls.append(
            ui.createSelect({ label: `${resource.label} 思考模式`, value: policy.mode, disabled: mutating.has(resource.id), options: [...REASONING_MODE_OPTIONS], onChange: (value) => { const mode = value as LlmReasoningMode; void savePolicy({ mode, effort: mode === 'disabled' ? 'provider_default' : policy.effort }); } }),
            ui.createSelect({ label: `${resource.label} 思考强度`, value: policy.effort, disabled: mutating.has(resource.id) || policy.mode === 'disabled', options: [...REASONING_EFFORT_OPTIONS], onChange: (value) => { void savePolicy({ mode: policy.mode, effort: value as LlmReasoningEffort }); } }),
          );
          const note = container.ownerDocument.createElement('p');
          note.textContent = reasoningState === 'verified' ? '可用模式与强度以该模型的实测结果为准。' : '思考能力尚未全部验证，部分设置可能不生效。';
          configuration.append(policyHint, policyControls, note);
        } else {
          const config = container.ownerDocument.createElement('p');
          config.textContent = resource.type === 'embedding' ? `${resource.embeddingDimensions ? `${resource.embeddingDimensions} 维` : '模型默认维度'} · ${resource.embeddingPath ?? '/embeddings'}` : resource.rerankProtocol === 'chat' ? '聊天重排' : `原生重排 · ${resource.rerankPath ?? '/rerank'}`;
          configuration.append(config);
        }
        detailCell.append(configuration);
        detail.append(detailCell);
        group.append(detail);
    }
    list.append(group);
    ui.refreshControls(list);
    if (focusedResource) Array.from(list.querySelectorAll<HTMLButtonElement>('[data-resource-expand]')).find((button) => button.dataset.resourceExpand === focusedResource)?.focus();
  };
  const load = async (): Promise<void> => {
    const sequence = ++loadSequence;
    const [nextSettings, nextHealth, routing] = await Promise.all([
      repository.loadSettings(),
      repository.listResourceHealth(),
      toolServices.taskStatus?.({}, 'ss-helper.llm').catch(() => undefined),
    ]);
    if (disposed || sequence !== loadSequence) return;
    settings = nextSettings;
    healthRecords = [...nextHealth];
    toolCapabilities = new Map((routing?.resources ?? []).map((resource) => [resource.resourceId, resource.toolCapabilities]));
    reasoningCapabilities = new Map((routing?.resources ?? []).map((resource) => [resource.resourceId, resource.reasoningCapabilities]));
    embeddingCapabilities = new Map((routing?.resources ?? []).map((resource) => [resource.resourceId, resource.embeddingCapabilities]));
    render();
  };
  search.addEventListener('input', render);
  refresh.addEventListener('click', () => { void load(); });
  shell.append(intro, summaryBar, toolbar, list, legend, tavernPolicySection, status);
  container.append(shell);
  const unsubscribe = repository.subscribeSettings(() => { void load(); });
  await load();
  return () => {
    disposed = true;
    for (const controller of testControllers.values()) controller.abort();
    testControllers.clear();
    for (const controller of toolTestControllers.values()) controller.abort();
    toolTestControllers.clear();
    disposeMenus();
    unsubscribe();
    container.replaceChildren();
  };
}

export function registerResourcePopups(session: PluginSession, repository: LlmWorkspaceRepository, toolServices: ResourceToolServices = {}): () => void {
  const notify = (level: 'success' | 'warning' | 'error', title: string, message: string, code: string): void => session.ui.showToast({ level, title, message, code });
  const formCleanups = [false, true].map((editing) => session.registerPopup({
    token: editing ? LLM_RESOURCE_EDITOR_POPUP : LLM_RESOURCE_WIZARD_POPUP,
    title: editing ? '编辑资源' : '添加资源',
    ariaLabel: editing ? 'LLM 资源编辑' : 'LLM 资源配置向导',
    closeLabel: editing ? '关闭资源编辑' : '关闭资源配置向导',
    render: (container, input, popupUi) => {
      const ui = requireUi(popupUi);
      let cleanup = (): void => undefined;
      let disposed = false;
      void renderResourceWizard(input, repository, session, ui, notify)
        .then((value) => { if (disposed) value(); else cleanup = value; })
        .catch((error) => {
          if (disposed) return;
          container.textContent = `资源配置加载失败（${safeCode(error, 'INTERNAL_ERROR', 'llm.resource-form.load')}）`;
        });
      return () => { disposed = true; cleanup(); };
    },
  }));
  const managerCleanup = session.registerPopup({
    token: LLM_RESOURCE_MANAGER_POPUP,
    title: '资源管理',
    ariaLabel: 'LLM 资源管理',
    presentation: 'workspace',
    render: (container, _input, popupUi) => {
      const ui = requireUi(popupUi);
      let cleanup = (): void => undefined;
      let disposed = false;
      void renderResourceManager(container, repository, session, ui, toolServices)
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
    for (const cleanup of formCleanups) cleanup();
  };
}

export const RESOURCE_POPUP_VERSION = LLM_POPUP_VERSION;
