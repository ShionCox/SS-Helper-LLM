/**
 * LLMHub 核心类型定义
 * 统一定义四层架构（注册中心、路由解析、请求编排、展示控制）的全部契约类型。
 */

// ═══════════════════════════════════════════
//  能力约束联合字面量
// ═══════════════════════════════════════════

/** 受控能力字面量，不允许自由字符串漂移 */
export type LLMCapability = 'chat' | 'json' | 'tools' | 'embeddings' | 'rerank' | 'vision' | 'reasoning';

/** 能力大类 */
export type CapabilityKind = 'generation' | 'embedding' | 'rerank';
/** 唯一执行分流契约，禁止根据 URL/model 猜测执行类型。 */
export type LLMExecution = 'completion' | 'structured' | 'tool_turn' | 'embedding' | 'rerank';

// ═══════════════════════════════════════════
//  结果返回结构
// ═══════════════════════════════════════════

/** 请求元数据 —— 固定字段集 */
export interface LLMRunMeta {
    requestId: string;
    resourceId: string;
    model?: string;
    capabilityKind: CapabilityKind;
    queuedAt: number;
    startedAt?: number;
    finishedAt?: number;
    latencyMs?: number;
    attemptCount?: number;
    repairCount?: number;
    execution?: LLMExecution;
    resolvedBy?: 'task_assignment' | 'execution_default';
    provider?: string;
    source?: 'tavern' | 'custom';
    capabilityDigest?: string;
    reasoning?: LlmReasoningPolicy;
    transport?: LlmStructuredTransport;
    validationOutcome?: 'complete' | 'partial';
    itemRejections?: LlmStructuredItemRejection[];
    parentRequestId?: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** 统一结果形态 */
export type LLMRunResult<T> =
    | { ok: true; data: T; meta: LLMRunMeta }
    | { ok: false; retryable?: boolean; reasonCode?: SSHelperReasonCode; meta?: LLMRunMeta; failure: SSHelperFailureContext };

export type LLMTaskLifecycleStage =
    | 'queued'
    | 'running'
    | 'route_resolved'
    | 'provider_requesting'
    | 'completed'
    | 'failed'
    | 'aborted'
    | 'cancelled';

export interface LLMTaskLifecycleEvent {
    requestId: string;
    llmTaskId: string;
    consumer: string;
    taskKey: string;
    taskKind: CapabilityKind;
    stage: LLMTaskLifecycleStage;
    ts: number;
    message?: string;
    resourceId?: string;
    model?: string;
    progress?: number;
    reasonCode?: SSHelperReasonCode;
    failure?: SSHelperFailureContext;
}

export type LLMTaskLifecycleHandler = (event: LLMTaskLifecycleEvent) => void;

// ═══════════════════════════════════════════
//  展示模式
// ═══════════════════════════════════════════


// ═══════════════════════════════════════════
//  消费方注册描述
// ═══════════════════════════════════════════

/** 单个任务描述 */
export interface TaskDescriptor {
    taskKey: string;
    taskKind: CapabilityKind;
    execution?: LLMExecution;
    requirements?: {
        nativeStructured?: 'preferred' | 'required';
        strictToolSchema?: 'preferred' | 'required';
        streamingToolCalls?: 'preferred' | 'required';
    };
    requiredCapabilities: LLMCapability[];
    maxTokens?: number;
    description?: string;
    backgroundEligible?: boolean;
    structuredPolicy?: LlmStructuredRepairPolicy;
}

/** 消费方注册包 */
export interface ConsumerRegistration {
    pluginId: string;
    displayName: string;
    registrationVersion: number;
    tasks: TaskDescriptor[];
}

// ═══════════════════════════════════════════
//  注册快照：持久字段 & 会话字段
// ═══════════════════════════════════════════

/** 持久字段 —— 重启后恢复 */
export interface ConsumerPersistentSnapshot {
    pluginId: string;
    displayName: string;
    registrationVersion: number;
    tasks: TaskDescriptor[];
}

/** 会话字段 —— 不跨重启 */
export interface ConsumerSessionSnapshot {
    online: boolean;
    seenAt: number;
}

/** 完整注册快照 */
export interface ConsumerSnapshot extends ConsumerPersistentSnapshot {
    session: ConsumerSessionSnapshot;
}

// ═══════════════════════════════════════════
//  失效绑定快照
// ═══════════════════════════════════════════

// ═══════════════════════════════════════════
//  请求编排
// ═══════════════════════════════════════════

/** 请求作用域 —— 取消与作废判断的唯一上下文单位 */
export interface RequestScope {
    chatKey?: string;
    chatId?: string;
    sessionId?: string;
    pluginId?: string;
}

/** 请求入队参数 */
export interface RequestEnqueueOptions {
    dedupeKey?: string;
    replacePendingByKey?: string;
    scope?: RequestScope;
    /** Core Bus correlation id. Public contract handlers pass this through unchanged. */
    requestId?: string;
    /** Optional root request used to group deferred repair calls with capture. */
    parentRequestId?: string;
}

/** 请求状态机 */
export type RequestState =
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled';

/** 请求有效性状态 */
export interface RequestValidity {
    isCancelled: boolean;
    isSuperseded: boolean;
}

export interface RequestDebugInfo {
    rawResponseText?: string;
    parsedResponse?: unknown;
    normalizedResponse?: unknown;
    providerResponse?: unknown;
    validationErrors?: string[];
    validationIssues?: Array<{ path: string; keyword: string; expected: string }>;
    itemRejections?: LlmStructuredItemRejection[];
    failure?: SSHelperFailureContext;
}

export interface LLMProviderRequestMetadata {
    jsonOutputMode?: 'json_object' | 'json_schema' | 'prompt_json';
    strictToolSchema?: 'native' | 'beta' | 'none';
    requestFormat: string;
    operation?: string;
    method?: 'GET' | 'POST';
    providerKind?: string;
    apiType?: ApiType;
    resourceId?: string;
    model?: string;
    endpointOrigin?: string;
    endpointPath?: string;
    queryParameterNames?: string[];
    headerNames?: string[];
    authScheme?: 'bearer' | 'api_key' | 'none' | 'unknown';
    streaming?: boolean;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    sentAt?: number;
    messageCount?: number;
    messageRoles?: string[];
    inputCharCount?: number;
    toolCount?: number;
    toolNames?: string[];
    schemaHash?: string;
    structuredTransport?: string;
    maxTokens?: number;
    temperature?: number;
    embeddingTextCount?: number;
    rerankDocCount?: number;
    dimensions?: number;
    topK?: number;
    payloadBytes?: number;
    customParameterNames?: string[];
    reasoningMode?: import('@ss-helper/sdk').LlmReasoningMode;
    reasoningEffort?: import('@ss-helper/sdk').LlmReasoningEffort;
    reasoningCapabilityDigest?: string;
}

export interface LLMProviderResponseMetadata {
    outcome: 'success' | 'http_error' | 'network_error' | 'timeout' | 'cancelled' | 'empty' | 'invalid_json' | 'schema_error' | 'protocol_error' | 'unknown_error';
    httpStatus?: number;
    contentType?: string;
    receivedBytes?: number;
    streamed?: boolean;
    streamEventCount?: number;
    finishReason?: string;
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
    latencyMs?: number;
    receivedAt?: number;
    providerErrorCode?: string;
    providerErrorType?: string;
    providerErrorParam?: string;
}

export interface LLMParseMetadata {
    stage: string;
    outcome: 'not_applicable' | 'success' | 'empty' | 'invalid_json' | 'schema_error' | 'protocol_error';
    responseCharCount?: number;
    candidateJsonCount?: number;
    parsedRootType?: 'object' | 'array' | 'scalar' | 'unknown';
    validationIssueCount?: number;
    itemRejectionCount?: number;
    issues?: Array<{ path: string; keyword: string; expected: string }>;
}

export interface LLMRequestLogRequestSnapshot {
    taskKind: CapabilityKind;
    taskDescription?: string;
    budget?: unknown;
    enqueue?: unknown;
    schemaSummary?: string;
    schemaHash?: string;
    schema?: unknown;
    structuredOutput?: {
        vendor: string;
        detectionEvidence: string;
        confidence: 'high' | 'medium' | 'low';
        transport: string;
        strictSchemaCompatible: boolean;
        contextMode?: 'chat' | 'isolated';
        nativeJsonMode?: boolean;
        nativeSchemaSent?: boolean;
        manualRetryRepair?: {
            reasonCode: SSHelperReasonCode;
            state: 'queued' | 'applied';
        };
    };
    resolvedMaxTokens?: {
        value: number;
        source: string;
        detail?: unknown;
    };
    providerRequest?: unknown;
    providerRequestMeta?: LLMProviderRequestMetadata;
    normalizeMode?: string;
    generationInput?: unknown;
    embeddingTexts?: string[];
    rerankQuery?: string;
    rerankDocs?: string[];
    rerankTopK?: number;
    metrics?: {
        messageCount?: number;
        embeddingTextCount?: number;
        rerankDocCount?: number;
        schemaCharCount?: number;
        inputCharCount?: number;
        outputCharCount?: number;
    };
}

export interface LLMRequestLogResponseSnapshot {
    meta?: Partial<LLMRunMeta>;
    failure?: SSHelperFailureContext;
    validationErrors?: string[];
    validationIssues?: Array<{ path: string; keyword: string; expected: string }>;
    itemRejections?: LlmStructuredItemRejection[];
    rawResponseText?: string;
    responsePreview?: {
        kind: 'truncated_text';
        prefix: string;
        suffix?: string;
        originalBytes: number;
        retainedBytes: number;
    };
    providerResponse?: unknown;
    parsedResponse?: unknown;
    normalizedResponse?: unknown;
    providerResponseMeta?: LLMProviderResponseMetadata;
    parseMeta?: LLMParseMetadata;
}

export type LLMRequestLogEntryKind = 'provider_attempt' | 'agent_turn';

export interface LLMRequestLogRouteSnapshot {
    resourceId: string;
    resourceLabel?: string;
    model?: string;
    providerKind?: string;
    apiType?: ApiType;
    endpointOrigin?: string;
    endpointPath?: string;
    queryParameterNames?: string[];
    customParameterNames?: string[];
    streaming?: boolean;
}

export interface LLMRequestLogToolCallMetadata {
    callId: string;
    name: string;
    argumentBytes: number;
    /** Tool arguments, retained only by full log modes after sanitization. */
    arguments?: unknown;
}

export interface LLMRequestLogToolResultMetadata {
    callId: string;
    name: string;
    ok: boolean;
    resultBytes: number;
    readCount?: number;
    resultCount?: number;
    truncated?: boolean;
    reasonCode?: string;
    /** Tool result, retained only by full log modes after sanitization. */
    content?: unknown;
}

export interface LLMRequestLogValueMetadata {
    valueType: 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean' | 'unknown';
    serializedBytes: number;
    itemCount?: number;
    keyCount?: number;
}

export interface LLMRequestLogAgentSnapshot {
    state: 'tool_calls' | 'final' | 'failed' | 'cancelled';
    toolSessionId?: string;
    toolSessionRound: number;
    totalCalls: number;
    capabilitySnapshotId?: string;
    toolDescriptions?: Readonly<Record<string, string>>;
    toolCalls?: LLMRequestLogToolCallMetadata[];
    toolResults?: LLMRequestLogToolResultMetadata[];
    finalOutputMeta?: LLMRequestLogValueMetadata;
    /** Full normalized Agent result, retained only by full log modes. */
    finalOutput?: unknown;
    usage?: LlmUsage;
}

export interface LLMRequestLogEntry {
    /** Missing on legacy rows and therefore read as provider_attempt. */
    entryKind?: LLMRequestLogEntryKind;
    logId: string;
    llmTaskId: string;
    requestId: string;
    parentRequestId?: string;
    attemptId: string;
    sourcePluginId: string;
    consumer: string;
    consumerDisplayName?: string;
    taskKey: string;
    taskDescription?: string;
    taskKind: CapabilityKind;
    resourceId?: string;
    resourceLabel?: string;
    model?: string;
    providerKind?: string;
    workflow?: LlmWorkflowTrace;
    agent?: LLMRequestLogAgentSnapshot;
    state: RequestState;
    attemptIndex: number;
    attemptPhase: LlmStructuredAttemptPhase;
    plannedTransport?: LlmStructuredTransport;
    actualTransport?: LlmStructuredTransport;
    attemptTag: '初次请求' | '重试';
    attemptOutcome?: '成功' | '失败' | '取消';
    isFinalAttempt: boolean;
    chatKey?: string;
    sessionId?: string;
    queuedAt: number;
    startedAt?: number;
    finishedAt?: number;
    latencyMs?: number;
    request: LLMRequestLogRequestSnapshot;
    response: LLMRequestLogResponseSnapshot;
    truncated?: Record<string, unknown>;
}

export type LLMLogDetailMode = 'full' | 'failed-full' | 'summary' | 'off';

export interface LLMRequestLoggingSettings {
    enabled?: boolean;
    detailMode?: LLMLogDetailMode;
    maxEntries?: number;
    retentionDays?: number;
    maxBytes?: number;
}

export interface LLMRequestLogQueryOptions {
    limit?: number;
    offset?: number;
    order?: 'asc' | 'desc';
    state?: RequestState | 'all';
    search?: string;
    fromTs?: number;
    toTs?: number;
    sourcePluginId?: string;
    taskKind?: CapabilityKind;
    resourceId?: string;
    model?: string;
    reasonCode?: SSHelperReasonCode;
    entryKind?: LLMRequestLogEntryKind | 'all';
    callScope?: 'all' | 'ordinary' | 'agent_workflow';
    workflowId?: string;
}

/** 内部请求记录 */
export interface RequestRecord<T = unknown> {
    llmTaskId: string;
    consumer: string;
    taskKey: string;
    taskDescription?: string;
    consumerDisplayName?: string;
    taskKind: CapabilityKind;
    requestArgs?: unknown;
    state: RequestState;
    validity: RequestValidity;
    enqueueOptions: RequestEnqueueOptions;
    scope?: RequestScope;
    chatKey?: string;
    requestId: string;
    activeAttemptRequestId?: string;
    attemptIndex: number;
    activeAttemptPhase?: LlmStructuredAttemptPhase;
    queuedAt: number;
    startedAt?: number;
    finishedAt?: number;
    resultPromise: Promise<LLMRunResult<T>>;
    resolveResult?: (value: LLMRunResult<T>) => void;
    meta?: LLMRunMeta;
    debug?: RequestDebugInfo;
    requestLogSnapshot?: LLMRequestLogRequestSnapshot;
    routeSnapshot?: LLMRequestLogRouteSnapshot;
    workflow?: LlmWorkflowTrace;
}
export interface RouteResolveArgs {
    consumer: string;
    taskKind: CapabilityKind;
    execution?: LLMExecution;
    taskKey?: string;
    requiredCapabilities?: LLMCapability[];
}

/** 路由解析结果 */
export interface RouteResolveResult {
    resourceId: string;
    model?: string;
    /** 实际生效来源 */
    resolvedBy: 'task_assignment' | 'execution_default';
}

// ═══════════════════════════════════════════
//  资源类型
// ═══════════════════════════════════════════

/** 资源类型 —— 决定能力，不再手动勾选 */
export type ResourceType = 'generation' | 'embedding' | 'rerank';

/** 资源来源 */
export type ResourceSource = 'tavern' | 'custom';

/** 自定义 API 协议类型 */
export type ApiType = 'openai' | 'xai' | 'deepseek' | 'kimi' | 'glm' | 'gemini' | 'claude' | 'generic';

/** 资源级自定义请求参数 */
export type ResourceCustomParams = Record<string, unknown>;

/** 用户创建的第三方资源配置 */
export interface ResourceConfig {
    id: string;
    type: ResourceType;
    source: ResourceSource;
    apiType: ApiType;
    label: string;
    baseUrl?: string;
    model: string;
    enabled?: boolean;
    /** OpenAI-compatible embedding operation path, such as /embeddings. */
    embeddingPath?: string;
    /** Optional resource-level embedding output dimensions. */
    embeddingDimensions?: number;
    /** 重排资源专用路径，如 /rerank */
    rerankPath?: string;
    /** Native endpoint or generation-model JSON reranking. */
    rerankProtocol?: 'native' | 'chat';
    /** 资源声明能力（包含基础能力与附加能力） */
    capabilities?: LLMCapability[];
    /** 透传到 Provider 请求体中的自定义参数 */
    customParams?: ResourceCustomParams;
    /** Provider 工具续轮协议；通用接口仅在真实握手后生效。 */
    toolDialect?: ProviderToolDialect;
    /** 默认本地重放且 store=false；远端托管必须显式授权。 */
    privacyPolicy?: ProviderPrivacyPolicy;
}

// ═══════════════════════════════════════════
//  分配数据模型
// ═══════════════════════════════════════════

/** 单条分配项 —— 只保存 resourceId */
export interface AssignmentEntry {
    resourceId: string;
}

/** 全局 max_tokens 控制模式 */
export type MaxTokensMode = 'inherit' | 'manual' | 'adaptive';

/** 自适应 max_tokens 配置 */
export interface AdaptiveMaxTokensConfig {
    min?: number;
    max?: number;
    charDivisor?: number;
    schemaCharDivisor?: number;
    messageBonus?: number;
}

/** LLMHub 全局 max_tokens 控制 */
export interface GlobalMaxTokensControl {
    mode?: MaxTokensMode;
    manualValue?: number;
    adaptive?: AdaptiveMaxTokensConfig;
}

/** 全局分配 */
export interface GlobalAssignments {
    generation?: AssignmentEntry;
    embedding?: AssignmentEntry;
    rerank?: AssignmentEntry;
}

/** 插件分配 */
/** 任务分配 */
export interface TaskAssignment {
    pluginId: string;
    taskKey: string;
    taskKind: CapabilityKind;
    resourceId?: string;
    maxTokens?: number;
    isStale: boolean;
    staleReason?: string;
}

/** LLMHub 完整设置 */
export interface LLMHubSettings {
    enabled?: boolean;
    /** 大语言模型生成来源；不影响 embedding 与 rerank */
    /** 自定义生成资源是否使用流式传输 */
    streamingEnabled?: boolean;
    /** 全局 Provider 请求启动速率；0 表示不限速 */
    maxRequestsPerMinute?: number;
    timeoutMs?: number;
    maxTokensMode?: MaxTokensMode;
    maxTokens?: number;
    requestLogging?: LLMRequestLoggingSettings;
    globalProfile?: string;
    /** 全局 max_tokens 控制 */
    maxTokensControl?: GlobalMaxTokensControl;
    /** 用户创建的资源列表 */
    resources?: ResourceConfig[];
    /** 每个生成资源的思考策略；tavern:active 也使用同一张表。 */
    resourcePolicies?: Record<string, import('@ss-helper/sdk').LlmReasoningPolicy>;
    /** 全局分配 */
    globalAssignments?: GlobalAssignments;
    /** 任务分配 */
    taskAssignments?: TaskAssignment[];
    /** 预算配置 */
    budgets?: Record<string, import('../budget/budget-manager').BudgetConfig>;
    /** silent 权限授权 */
}

// ═══════════════════════════════════════════
//  资源状态快照
// ═══════════════════════════════════════════

/** 单个资源的运行时状态摘要 */
export interface ResourceStatusSnapshot {
    resourceId: string;
    resourceLabel: string;
    resourceType: ResourceType;
    source: ResourceSource;
    enabled: boolean;
    baseUrl?: string;
    model?: string;
    credentialConfigured: boolean;
    builtin: boolean;
    reasoningPolicy?: import('@ss-helper/sdk').LlmReasoningPolicy;
    reasoningCapabilities?: import('@ss-helper/sdk').VerifiedReasoningCapabilities;
}

/** 路由预览结果 */
export interface RoutePreviewSnapshot {
    consumer: string;
    taskKind: CapabilityKind;
    taskKey?: string;
    requiredCapabilities: LLMCapability[];
    available: boolean;
    resourceId?: string;
    resourceLabel?: string;
    resourceType?: ResourceType;
    source?: ResourceSource;
    model?: string;
    resolvedBy?: RouteResolveResult['resolvedBy'];
    failure?: SSHelperFailureContext;
    reasoningPolicy?: import('@ss-helper/sdk').LlmReasoningPolicy;
}

/** 当前资源池与分配的只读状态快照 */
export interface LLMHubStatusSnapshot {
    resources: ResourceStatusSnapshot[];
    globalProfile?: string;
    globalAssignments: GlobalAssignments;
    taskAssignments: TaskAssignment[];
    readiness: Record<CapabilityKind, boolean>;
}

/** 提供给外部插件读取 LLMHub 状态与路由预览的只读接口 */
export interface LLMInspectApi {
    getStatusSnapshot(): Promise<LLMHubStatusSnapshot> | LLMHubStatusSnapshot;
    previewRoute(args: RouteResolveArgs): Promise<RoutePreviewSnapshot> | RoutePreviewSnapshot;
}

// ═══════════════════════════════════════════
//  runTask / embed / rerank 入参
// ═══════════════════════════════════════════

export interface RunTaskArgs {
    consumer: string;
    taskKey: string;
    taskDescription?: string;
    trace?: LlmWorkflowTrace;
    taskKind: CapabilityKind;
    /** 显式执行类型；未提供时由 SDK 根据 schema/taskKind 确定。 */
    execution?: Extract<LLMExecution, 'completion' | 'structured' | 'tool_turn'>;
    input: any;
    schema?: object;
    budget?: { maxTokens?: number; maxLatencyMs?: number };
    enqueue?: RequestEnqueueOptions;
    onLifecycle?: LLMTaskLifecycleHandler;
    signal?: AbortSignal;
}

export interface EmbedArgs {
    consumer: string;
    taskKey: string;
    taskDescription?: string;
    trace?: LlmWorkflowTrace;
    texts: string[];
    execution?: 'embedding';
    dimensions?: number;
    enqueue?: RequestEnqueueOptions;
    onLifecycle?: LLMTaskLifecycleHandler;
    signal?: AbortSignal;
}

export interface RerankArgs {
    consumer: string;
    taskKey: string;
    taskDescription?: string;
    trace?: LlmWorkflowTrace;
    query: string;
    execution?: 'rerank';
    docs: string[];
    topK?: number;
    enqueue?: RequestEnqueueOptions;
    onLifecycle?: LLMTaskLifecycleHandler;
    signal?: AbortSignal;
}
import type {
    LlmUsage,
    LlmWorkflowTrace,
    LlmStructuredAttemptPhase,
    LlmStructuredItemRejection,
    LlmStructuredRepairPolicy,
    LlmStructuredTransport,
    SSHelperFailureContext,
    SSHelperReasonCode,
    ProviderPrivacyPolicy,
    ProviderToolDialect,
    LlmReasoningPolicy,
} from '@ss-helper/sdk';
