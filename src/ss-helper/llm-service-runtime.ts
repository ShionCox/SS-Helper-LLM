import { LLM_TASK_STATUS_CHANGED_V0, createSSHelperError, readSSHelperFailure, type HostPort, type LlmCapabilityKind, type LlmSafeResourceSummary, type LlmTaskStatusRequest, type LlmTaskStatusSnapshot, type LlmTaskStatusEntry, type LlmTaskRoutingAssignment, type LlmExecution, type LlmTaskRouteSetRequest, type LlmResourceCapabilityVerifyResponse, type LlmReasoningPolicy, type VerifiedReasoningCapabilities, type VerifiedToolCapabilities, type VerifiedEmbeddingCapabilities, type PluginSession } from '@ss-helper/sdk';
import { BudgetManager } from '../budget/budget-manager';
import { RequestLogService } from '../log/requestLogService';
import { RequestOrchestrator } from '../orchestrator/orchestrator';
import { ClaudeProvider } from '../providers/claude-provider';
import { CustomRerankProvider } from '../providers/custom-rerank-provider';
import { GeminiProvider } from '../providers/gemini-provider';
import { OpenAIProvider } from '../providers/openai-provider';
import { TavernProvider } from '../providers/tavern-provider';
import type { LLMProvider } from '../providers/types';
import type { StructuredOutputIdentity } from '../schema/structured-output-plan';
import { providerManifest } from '../providers/provider-manifest';
import { ConsumerRegistry } from '../registry/consumer-registry';
import { BUILTIN_TAVERN_RESOURCE_ID, TaskRouter } from '../router/router';
import { LLMSDKImpl } from '../sdk/llm-sdk';
import { DEFAULT_LLM_SETTINGS } from '../schema/defaults';
import type { LLMCapability, LLMHubSettings, ResourceConfig, ResourceType } from '../schema/types';
import { createLlmSdkServiceHandlers, type LlmServiceHandlers } from './services';
import { LlmWorkspaceRepository, type PreparedSettingsRuntime, type SettingsRuntimePrepareOptions } from '../storage/llm-workspace-repository';
import { validateLlmSettings } from '../validation/settings';
import { logger, safeFailureLogDetail } from '../runtime/logger';
import { createCoreBridgeFetch } from './core-bridge-fetch';
import { LlmToolTurnService } from './tool-turn-service';
import { normalizeProviderPrivacyPolicy } from '../tools/provider-privacy-policy';
import { RequestRateLimiter } from '../runtime/request-rate-limiter';
import { DEFAULT_REASONING_POLICY } from '../providers/reasoning-policy';
import { verifyReasoningCapabilities } from '../providers/reasoning-capability-probe';
import { stableToolDigest } from '../tools/tool-capability-cache';
import { configuredMaxTokensControl } from '../sdk/max-tokens';
import { describeSSHelperFailure } from '@ss-helper/sdk';

export interface ProductionLlmProviderRegistration {
    readonly provider: LLMProvider;
    readonly resourceType: ResourceType;
    readonly capabilities?: readonly LLMCapability[];
    readonly defaultModel?: string;
}

export interface ProductionLlmServiceOptions {
    readonly providers?: readonly ProductionLlmProviderRegistration[];
    readonly settings?: () => LLMHubSettings;
    readonly repository?: LlmWorkspaceRepository;
}

export function createProviderFromResource(resource: ResourceConfig, apiKey: string, fetchImpl: typeof fetch = fetch, streamingEnabled = true): LLMProvider {
    const resolvedApiType = resource.apiType;
    const manifest = providerManifest(resolvedApiType);
    const manifestVendor: StructuredOutputIdentity['vendor'] = manifest.id === 'openai' || manifest.id === 'deepseek' || manifest.id === 'gemini' || manifest.id === 'claude'
        ? manifest.id : 'unknown';
    const identity: StructuredOutputIdentity = { vendor: manifestVendor, evidence: 'manual', confidence: 'high', ...(resource.model ? { model: resource.model } : {}) };
    const base = { id: resource.id, apiKey, baseUrl: resource.baseUrl, model: resource.model, customParams: resource.customParams, fetchImpl, streamingEnabled };
    if (resource.type === 'rerank' && resource.rerankProtocol !== 'chat') return new CustomRerankProvider({ ...base, baseUrl: resource.baseUrl || '', rerankPath: resource.rerankPath });
    if (resolvedApiType === 'claude') {
        if (resource.toolDialect && resource.toolDialect !== 'anthropic_messages') throw createSSHelperError('LLM_CAPABILITY_UNAVAILABLE', { stage: 'llm.tools.adapter.configure', resourceId: resource.id });
        return new ClaudeProvider(base);
    }
    if (resolvedApiType === 'gemini') {
        if (resource.toolDialect && resource.toolDialect !== 'gemini_interactions') throw createSSHelperError('LLM_CAPABILITY_UNAVAILABLE', { stage: 'llm.tools.adapter.configure', resourceId: resource.id });
        return new GeminiProvider({ ...base, embeddingDimensions: resource.embeddingDimensions });
    }
    const customParams = resource.customParams && typeof resource.customParams === 'object' && !Array.isArray(resource.customParams)
        ? resource.customParams as Record<string, unknown> : {};
    const enableToolStream = (resolvedApiType === 'kimi' || resolvedApiType === 'glm') && (customParams.tool_stream === true || customParams.stream === true);
    return new OpenAIProvider({ ...base, apiType: resolvedApiType, structuredOutputIdentity: identity, enableRerank: resource.type === 'rerank' && resource.rerankProtocol === 'chat', embeddingPath: resource.embeddingPath, embeddingDimensions: resource.embeddingDimensions, toolDialect: resource.toolDialect ?? manifest.protocol, enableToolStream });
}

function withMaxTokensDefaults(settings: LLMHubSettings): LLMHubSettings {
    const output = configuredMaxTokensControl(settings);
    return {
        ...DEFAULT_LLM_SETTINGS,
        ...settings,
        maxTokensMode: output.mode,
        maxTokens: output.manualValue,
    };
}

function routingCapabilities(resource: ResourceConfig, provider: LLMProvider): LLMCapability[] {
    const capabilities = new Set<LLMCapability>();
    if (resource.type === 'embedding') {
        if (provider.capabilities.embeddings) capabilities.add('embeddings');
        return [...capabilities];
    }
    if (resource.type === 'rerank') {
        if (provider.capabilities.rerank) capabilities.add('rerank');
        return [...capabilities];
    }
    if (provider.capabilities.chat) capabilities.add('chat');
    if (provider.capabilities.json) capabilities.add('json');
    if (provider.capabilities.tools) capabilities.add('tools');
    for (const capability of resource.capabilities ?? []) {
        if (capability === 'vision' || capability === 'reasoning') capabilities.add(capability);
    }
    return [...capabilities];
}

function unknownReasoningCapabilities(resourceId: string, model: string | undefined, providerValue: string | undefined, connectionRevision: string): VerifiedReasoningCapabilities {
    const manifest = providerManifest(providerValue);
    const executions = (['completion', 'structured', 'tool_turn'] as const).map((execution) => ({
        execution,
        status: 'unknown' as const,
        modes: manifest.reasoning.modes,
        efforts: manifest.reasoning.efforts,
        transport: manifest.reasoning.transport,
        reasoningReplay: manifest.reasoning.replay,
    }));
    return {
        status: 'unknown',
        resourceId,
        model: model || 'unknown',
        provider: manifest.id,
        defaultMode: manifest.reasoning.defaultMode,
        modes: manifest.reasoning.modes,
        efforts: manifest.reasoning.efforts,
        transport: manifest.reasoning.transport,
        reasoningReplay: manifest.reasoning.replay,
        executions,
        connectionRevision: connectionRevision || 'unverified',
        probeVersion: 1,
    };
}

export function createProductionLlmServices(
    session: PluginSession<'tavern.generation.read' | 'tavern.generation.execute' | 'tavern.chat.events' | 'tavern.plugin.request' | 'core.ui.notification.v0' | 'secrets.read' | 'secrets.write'>,
    options: ProductionLlmServiceOptions = {},
): LlmServiceHandlers {
    const router = new TaskRouter();
    const registry = new ConsumerRegistry();
    const budget = new BudgetManager();
    const repository = options.repository;
    const bridgeFetch = session.host.has('tavern.plugin.request')
        ? createCoreBridgeFetch((request, requestOptions) => session.host.request.send(request, requestOptions))
        : fetch;
    const initialSettings = options.settings?.() ?? {};
    const settingsState: { value: LLMHubSettings } = { value: withMaxTokensDefaults(initialSettings) };
    type ReasoningSnapshotRecord = { readonly capabilities: VerifiedReasoningCapabilities; readonly policy: LlmReasoningPolicy };
    const reasoningSnapshots = new Map<string, ReasoningSnapshotRecord>();
    const embeddingSnapshots = new Map<string, VerifiedEmbeddingCapabilities>();
    const resourceEpochs = new Map<string, number>();
    const bumpResourceEpoch = (resourceId: string): number => {
        const next = (resourceEpochs.get(resourceId) ?? 0) + 1;
        resourceEpochs.set(resourceId, next);
        embeddingSnapshots.delete(resourceId);
        return next;
    };
    const resourceEpoch = (resourceId: string): number => resourceEpochs.get(resourceId) ?? 0;
    const unknownEmbeddingCapabilities = (resourceId: string, model: string | undefined): VerifiedEmbeddingCapabilities => ({
        status: 'unknown', resourceId, model: model || 'unknown', verifiedMaxBatchInputs: 8,
    });
    router.setRegistry(registry);
    router.registerProvider(new TavernProvider({ id: BUILTIN_TAVERN_RESOURCE_ID, generation: session.host.generation }), 'generation', [
        'chat', 'json',
        ...(session.host.has('tavern.generation.execute') ? ['tools' as const] : []),
    ]);
    const managed = new Set<string>();
    let stateRevision = 0;
    const notifyCapabilityChange = (kinds: readonly LlmCapabilityKind[]): void => {
        stateRevision += 1;
        const taskKeys = registry.listConsumerRegistrations().flatMap((registration) => registration.tasks
            .filter((task) => {
                const kind = task.taskKind ?? (task.execution === 'embedding' ? 'embedding' : task.execution === 'rerank' ? 'rerank' : 'generation');
                return kinds.includes(kind);
            })
            .map((task) => task.taskKey));
        const resourceIds = [BUILTIN_TAVERN_RESOURCE_ID, ...(settingsState.value.resources ?? []).map((resource) => resource.id)];
        try {
            session.bus.publish(LLM_TASK_STATUS_CHANGED_V0, { revision: stateRevision, taskKeys: [...new Set(taskKeys)], resourceIds: [...new Set(resourceIds)] });
        } catch {
            // Event delivery is best effort and must not turn an applied runtime update into a failed save.
        }
    };
    const unlistenRegistry = registry.subscribe(() => notifyCapabilityChange(['generation', 'embedding', 'rerank']));
    for (const registration of options.providers ?? []) {
        router.registerProvider(registration.provider, registration.resourceType, registration.capabilities === undefined ? undefined : [...registration.capabilities], registration.defaultModel);
        managed.add(registration.provider.id);
    }

    const requestLogs = new RequestLogService(repository);
    const requestRateLimiter = new RequestRateLimiter();
    requestRateLimiter.setMaxRequestsPerMinute(settingsState.value.maxRequestsPerMinute ?? DEFAULT_LLM_SETTINGS.maxRequestsPerMinute);
    const describeTask = (pluginId: string, taskKey: string, taskKind: 'generation' | 'embedding' | 'rerank' = 'generation') => {
        const registration = registry.getConsumerRegistration(pluginId);
        const registered = registry.getTaskDescriptor(pluginId, taskKey)?.description?.trim();
        return {
            ...(registration?.displayName ? { consumerDisplayName: registration.displayName } : {}),
            taskDescription: registered || (taskKind === 'embedding'
                ? '用途未声明的向量化任务'
                : taskKind === 'rerank'
                    ? '用途未声明的重排任务'
                    : '用途未声明的生成任务'),
        };
    };
    const sdk = new LLMSDKImpl(router, budget, new RequestOrchestrator(), registry, requestLogs, requestRateLimiter);
    sdk.setSettingsResolver(() => ({
        ...settingsState.value,
        maxTokensControl: configuredMaxTokensControl(settingsState.value),
    }));
    const tavernResource: ResourceConfig = { id: BUILTIN_TAVERN_RESOURCE_ID, type: 'generation', source: 'tavern', apiType: 'generic', label: '酒馆当前连接', model: '', enabled: true };
    let tavernModel: string | undefined;
    let tavernConnectionRevision = '';
    let tavernEpoch = 0;
    const readTavernSnapshot = async (): Promise<{ readonly snapshot: Awaited<ReturnType<NonNullable<HostPort['generation']>['inspect']>>; readonly epoch: number }> => {
        const generationPort = session.host.generation as typeof session.host.generation & {
            readonly inspect?: () => Promise<Awaited<ReturnType<NonNullable<HostPort['generation']>['inspect']>>>;
        };
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const epoch = tavernEpoch;
            const snapshot = typeof generationPort.inspect === 'function'
                ? await generationPort.inspect()
                : await Promise.all([generationPort.available(), generationPort.current()]).then(([available, current]) => ({ taskId: 'current', status: 'queued' as const, available, ...current }));
            if (epoch === tavernEpoch) return { snapshot, epoch };
        }
        throw createSSHelperError('SERVER_SESSION_CLOSED', { stage: 'llm.tavern.snapshot' });
    };
    const reasoningPolicyFor = (resourceId: string): LlmReasoningPolicy => settingsState.value.resourcePolicies?.[resourceId] ?? DEFAULT_REASONING_POLICY;
    const resourceConnectionRevision = (resource: ResourceConfig, model?: string): string => stableToolDigest(JSON.stringify({
        source: resource.source,
        apiType: resource.apiType,
        baseUrl: resource.baseUrl,
        model: model ?? resource.model,
        toolDialect: resource.toolDialect,
        customParams: resource.customParams,
        privacyPolicy: resource.privacyPolicy,
        epoch: resourceEpoch(resource.id),
    }));
    const reasoningSnapshotFor = (resourceId: string, model?: string): VerifiedReasoningCapabilities | undefined => {
        const record = reasoningSnapshots.get(resourceId);
        if (!record || (model !== undefined && record.capabilities.model !== model) || (record.capabilities.expiresAt !== undefined && record.capabilities.expiresAt <= Date.now())) return undefined;
        if (record.policy.mode !== reasoningPolicyFor(resourceId).mode || record.policy.effort !== reasoningPolicyFor(resourceId).effort) return undefined;
        const expectedRevision = resourceId === BUILTIN_TAVERN_RESOURCE_ID ? tavernConnectionRevision : (() => {
            const resource = settingsState.value.resources?.find((item) => item.id === resourceId);
            return resource ? resourceConnectionRevision(resource, model) : '';
        })();
        return expectedRevision !== '' && record.capabilities.connectionRevision === expectedRevision ? record.capabilities : undefined;
    };
    router.setExecutionAvailabilityQuery((resourceId, execution) => {
        if (execution === 'embedding' || execution === 'rerank') return { available: true };
        const policy = reasoningPolicyFor(resourceId);
        if (policy.mode === 'provider_default' && policy.effort === 'provider_default') return { available: true };
        const model = resourceId === BUILTIN_TAVERN_RESOURCE_ID ? tavernModel : router.getDefaultModel(resourceId);
        const snapshot = reasoningSnapshotFor(resourceId, model);
        if (!snapshot) return { available: false, reasonCode: 'LLM_REASONING_CAPABILITY_UNVERIFIED' };
        const executionSnapshot = snapshot.executions.find((item) => item.execution === execution);
        if (!executionSnapshot || executionSnapshot.status !== 'verified') return { available: false, reasonCode: 'LLM_REASONING_CONFIGURATION_UNSUPPORTED' };
        return { available: true };
    });
    sdk.setReasoningCapabilityResolver((resourceId, model) => reasoningSnapshotFor(resourceId, model)?.capabilityDigest);
    const toolTurn = new LlmToolTurnService(router, {
        getResource: (resourceId) => resourceId === BUILTIN_TAVERN_RESOURCE_ID
            ? tavernResource
            : settingsState.value.resources?.find((resource) => resource.id === resourceId),
        getStreamingEnabled: () => settingsState.value.streamingEnabled !== false,
        getReasoningPolicy: reasoningPolicyFor,
        getReasoningCapabilityDigest: (resourceId, model) => reasoningSnapshotFor(resourceId, model)?.capabilityDigest,
    }, (request, callerPluginId, profileId) => sdk.resolveTaskMaxTokens({
        consumer: callerPluginId,
        taskKey: request.task,
        taskKind: 'generation',
        input: request.input,
        ...(request.outputSchema ? { schema: request.outputSchema as object } : {}),
        ...(request.maxTokens === undefined ? {} : { budget: { maxTokens: request.maxTokens } }),
    }, profileId).value, repository, requestLogs, (pluginId, taskKey) => describeTask(pluginId, taskKey), requestRateLimiter);
    if (repository) {
        void repository.sanitizeStoredLogs().catch((error) => logger.warn(
            'LLM 请求日志安全清理失败',
            safeFailureLogDetail(error, { reasonCode: 'LOG_UNAVAILABLE', stage: 'llm.log.sanitize' }),
        ));
        void repository.reconcileInterruptedLogs().catch((error) => logger.warn(
            '遗留 LLM 请求日志收敛失败',
            safeFailureLogDetail(error, { reasonCode: 'LOG_UNAVAILABLE', stage: 'llm.log.reconcile' }),
        ));
    }
    let disposed = false;
    let applyGeneration = 0;

    const prepareRuntime = async (input: LLMHubSettings, options: SettingsRuntimePrepareOptions = {}): Promise<PreparedSettingsRuntime> => {
        const generation = ++applyGeneration;
        const settings = withMaxTokensDefaults(validateLlmSettings(input));
        const resources = Array.isArray(settings.resources) ? settings.resources : [];
        const registrations: ProductionLlmProviderRegistration[] = [];
        const built: LLMProvider[] = [];
        const overrides = options.credentialOverrides ?? {};
        try {
            for (const resource of resources) {
                if (resource.enabled === false || resource.source === 'tavern') continue;
                let apiKey: string | null = null;
                if (Object.prototype.hasOwnProperty.call(overrides, resource.id)) apiKey = overrides[resource.id] ?? null;
                else if (!options.emptyCredentials && repository) apiKey = await repository.getResourceSecret(resource.id);
                if (!apiKey) continue;
                const provider = createProviderFromResource(
                    resource,
                    apiKey,
                    /^https?:\/\//iu.test(resource.baseUrl ?? '') ? bridgeFetch : fetch,
                    settings.streamingEnabled,
                );
                built.push(provider);
                // Routing is constrained by the resource's declared purpose so
                // a multi-capability adapter cannot leak generation into an
                // embedding/rerank resource (or vice versa).
                registrations.push({ provider, resourceType: resource.type, capabilities: routingCapabilities(resource, provider), defaultModel: resource.model });
            }
            const occupied = new Set(router.getAllProviders().filter((provider) => !managed.has(provider.id)).map((provider) => provider.id));
            if (registrations.some((registration) => occupied.has(registration.provider.id))) {
                throw createSSHelperError('INTERNAL_ERROR', { stage: 'llm.runtime.provider_conflict' });
            }
            if (disposed || generation !== applyGeneration) {
                throw createSSHelperError('SERVER_SESSION_CLOSED', { stage: 'llm.runtime.apply' });
            }
        } catch (error) {
            for (const provider of built) provider.dispose?.();
            const failure = readSSHelperFailure(error, {
                reasonCode: 'INTERNAL_ERROR',
                stage: 'llm.runtime.apply',
            })!;
            const { reasonCode, ...context } = failure;
            throw createSSHelperError(reasonCode, context);
        }

        let committed = false;
        let released = false;
        return {
            assertCurrent: (): void => {
                if (disposed || generation !== applyGeneration) {
                    throw createSSHelperError('INTERNAL_ERROR', { stage: 'llm.runtime.apply.stale' });
                }
            },
            commit: (): void => {
                if (committed || released) return;
                if (disposed || generation !== applyGeneration) {
                    for (const provider of built) provider.dispose?.();
                    released = true;
                    throw createSSHelperError('INTERNAL_ERROR', { stage: 'llm.runtime.apply.stale' });
                }
                const oldProviders = [...managed].map((id) => router.getProvider(id)).filter((provider): provider is LLMProvider => Boolean(provider));
                const previousResources = settingsState.value.resources ?? [];
                const previousPolicies = settingsState.value.resourcePolicies ?? {};
                const streamingChanged = (settingsState.value.streamingEnabled ?? DEFAULT_LLM_SETTINGS.streamingEnabled) !== settings.streamingEnabled;
                for (const resourceId of Object.keys(overrides)) {
                    bumpResourceEpoch(resourceId);
                    reasoningSnapshots.delete(resourceId);
                    toolTurn.invalidateResource(resourceId);
                }
                settingsState.value = { ...settings };
                requestRateLimiter.setMaxRequestsPerMinute(settings.maxRequestsPerMinute ?? DEFAULT_LLM_SETTINGS.maxRequestsPerMinute);
                sdk.setGlobalProfile(settings.globalProfile ?? 'balanced');
                router.replaceManagedProviders([...managed], registrations);
                const generationDefault = settings.globalAssignments?.generation?.resourceId ?? BUILTIN_TAVERN_RESOURCE_ID;
                router.applyExecutionDefaults({
                    completion: generationDefault,
                    structured: generationDefault,
                    tool_turn: generationDefault,
                    ...(settings.globalAssignments?.embedding?.resourceId ? { embedding: settings.globalAssignments.embedding.resourceId } : {}),
                    ...(settings.globalAssignments?.rerank?.resourceId ? { rerank: settings.globalAssignments.rerank.resourceId } : {}),
                });
                router.applyTaskAssignments(settings.taskAssignments ?? []);
                budget.replaceConfigs(settings.budgets ?? {});
                const nextResources = settings.resources ?? [];
                const nextById = new Map(nextResources.map((resource) => [resource.id, resource]));
                for (const previous of previousResources) {
                    const next = nextById.get(previous.id);
                    const policyChanged = JSON.stringify(previousPolicies[previous.id] ?? DEFAULT_REASONING_POLICY) !== JSON.stringify(settings.resourcePolicies?.[previous.id] ?? DEFAULT_REASONING_POLICY);
                    if (streamingChanged || policyChanged || !next || JSON.stringify(previous) !== JSON.stringify(next)) {
                        bumpResourceEpoch(previous.id);
                        reasoningSnapshots.delete(previous.id);
                        toolTurn.invalidateResource(previous.id);
                    }
                }
                if (JSON.stringify(previousPolicies[BUILTIN_TAVERN_RESOURCE_ID] ?? DEFAULT_REASONING_POLICY) !== JSON.stringify(settings.resourcePolicies?.[BUILTIN_TAVERN_RESOURCE_ID] ?? DEFAULT_REASONING_POLICY)) {
                    bumpResourceEpoch(BUILTIN_TAVERN_RESOURCE_ID);
                    reasoningSnapshots.delete(BUILTIN_TAVERN_RESOURCE_ID);
                    toolTurn.invalidateResource(BUILTIN_TAVERN_RESOURCE_ID);
                }
                managed.clear();
                for (const registration of registrations) managed.add(registration.provider.id);
                for (const provider of oldProviders) provider.dispose?.();
                if (repository === undefined) notifyCapabilityChange(['generation', 'embedding', 'rerank']);
                committed = true;
            },
            dispose: (): void => {
                if (committed || released) return;
                for (const provider of built) provider.dispose?.();
                released = true;
            },
        };
    };

    const capabilityStatus = async (request: { readonly checks: readonly { readonly id: string; readonly taskKey: string; readonly taskKind: LlmCapabilityKind; readonly requiredCapabilities?: readonly string[] }[] }, signal: AbortSignal, callerPluginId: string): Promise<{ readonly revision: number; readonly checks: readonly { readonly id: string; readonly configured: boolean; readonly available: boolean; readonly resourceId?: string; readonly model?: string; readonly source?: 'tavern' | 'custom'; readonly reason?: string }[] }> => {
        if (signal.aborted) throw createSSHelperError('REQUEST_ABORTED', { stage: 'llm.capability_status' });
        const settings = settingsState.value;
        const resources = Array.isArray(settings.resources) ? settings.resources : [];
        const entries = await Promise.all(request.checks.map(async (check) => {
            const descriptor = registry.getTaskDescriptor(callerPluginId, check.taskKey);
            const execution = executionFor({ taskKind: check.taskKind, execution: descriptor?.execution, requiredCapabilities: check.requiredCapabilities });
            const base = { id: check.id };
            if (settings.enabled === false) return { ...base, configured: false, available: false, reason: 'llm_disabled' as const };
            const required = [...(check.requiredCapabilities ?? (execution === 'tool_turn' ? ['chat', 'tools'] : execution === 'structured' || execution === 'completion' ? ['chat', 'json'] : execution === 'embedding' ? ['embeddings'] : ['rerank']))] as LLMCapability[];
            const candidates = resources.filter((resource) => {
                if (resource.source === 'tavern') return false;
                const declared = new Set(resource.capabilities ?? []);
                if (resource.type === 'generation') { declared.add('chat'); declared.add('json'); }
                if (resource.type === 'embedding') declared.add('embeddings');
                if (resource.type === 'rerank') declared.add('rerank');
                return resource.type === (execution === 'embedding' ? 'embedding' : execution === 'rerank' ? 'rerank' : 'generation') && required.every((capability) => declared.has(capability));
            });
            const enabledCandidates = candidates.filter((resource) => resource.enabled !== false);
            let missingCredential = false;
            for (const resource of enabledCandidates) {
                if (await repository?.hasResourceSecret(resource.id)) break;
                missingCredential = true;
            }
            let route;
            try { route = router.resolveRoute({ consumer: callerPluginId, taskKind: check.taskKind, execution, taskKey: check.taskKey, requiredCapabilities: required as never }); } catch (error) {
                const failure = readSSHelperFailure(error);
                if (missingCredential) return { ...base, configured: false, available: false, reason: 'credential_missing' as const };
                if (candidates.length > 0 && enabledCandidates.length === 0) return { ...base, configured: false, available: false, reason: 'resource_disabled' as const };
                if (candidates.length === 0 && execution !== 'completion' && execution !== 'structured' && execution !== 'tool_turn') return { ...base, configured: false, available: false, reason: 'no_resource' as const };
                if (failure?.reasonCode === 'LLM_REASONING_CAPABILITY_UNVERIFIED') return { ...base, configured: true, available: false, reason: 'reasoning_unverified' as const };
                if (failure?.reasonCode === 'LLM_REASONING_CONFIGURATION_UNSUPPORTED') return { ...base, configured: true, available: false, reason: 'reasoning_unsupported' as const };
                return { ...base, configured: false, available: false, reason: 'route_unavailable' as const };
            }
            if (route.resourceId === BUILTIN_TAVERN_RESOURCE_ID) {
                try {
                    const { snapshot: current } = await readTavernSnapshot();
                    const model = current.model ?? route.model;
                    const provider = current.provider;
                    if (current.available === false || !provider) return { ...base, configured: false, available: false, reason: 'tavern_unavailable' as const };
                    return { ...base, configured: true, available: true, source: 'tavern' as const, resourceId: BUILTIN_TAVERN_RESOURCE_ID, ...(model === undefined ? {} : { model }) };
                } catch { return { ...base, configured: false, available: false, reason: 'status_unavailable' as const }; }
            }
            const resource = resources.find((item) => item.id === route.resourceId);
            if (!resource) return { ...base, configured: false, available: false, reason: 'route_unavailable' as const };
            if (resource.enabled === false) return { ...base, configured: false, available: false, reason: 'resource_disabled' as const };
            if (repository && !(await repository.hasResourceSecret(resource.id))) return { ...base, configured: false, available: false, reason: 'credential_missing' as const };
            return { ...base, configured: true, available: true, source: 'custom' as const, resourceId: resource.id, ...(route.model ?? resource.model ? { model: route.model ?? resource.model } : {}) };
        }));
        return { revision: stateRevision, checks: entries };
    };

    const safeResources = async (): Promise<LlmSafeResourceSummary[]> => {
        const resources = settingsState.value.resources ?? [];
        const custom = await Promise.all(resources.map(async (resource): Promise<LlmSafeResourceSummary> => {
            const provider = router.getProvider(resource.id);
            const available = resource.enabled !== false && provider !== undefined && (!repository || await repository.hasResourceSecret(resource.id));
            const toolCapabilities = await toolTurn.getCapability(resource.id, resource.model, true);
            const reasoningPolicy = resource.type === 'generation' ? reasoningPolicyFor(resource.id) : undefined;
            const reasoningCapabilities = resource.type === 'generation'
                ? reasoningSnapshotFor(resource.id, resource.model) ?? unknownReasoningCapabilities(resource.id, resource.model, resource.apiType, resourceConnectionRevision(resource, resource.model))
                : undefined;
            const embeddingCapabilities = resource.type === 'embedding'
                ? embeddingSnapshots.get(resource.id) ?? unknownEmbeddingCapabilities(resource.id, resource.model)
                : undefined;
            return {
                resourceId: resource.id,
                label: resource.label,
                type: resource.type,
                apiType: resource.apiType,
                ...(resource.model ? { defaultModel: resource.model } : {}),
                enabled: resource.enabled !== false,
                available,
                capabilities: router.getProviderCapabilities(resource.id),
                ...(toolCapabilities ? { toolCapabilities } : {}),
                ...(reasoningPolicy ? { reasoningPolicy } : {}),
                ...(reasoningCapabilities ? { reasoningCapabilities } : {}),
                ...(embeddingCapabilities ? { embeddingCapabilities } : {}),
                privacyPolicy: normalizeProviderPrivacyPolicy(resource.privacyPolicy),
                ...(available ? {} : { unavailableReason: provider ? 'credential_missing' : 'resource_unavailable' }),
            };
        }));
        let tavern: LlmSafeResourceSummary | undefined;
        try {
            const { snapshot: current, epoch } = await readTavernSnapshot();
            const available = current.available === true;
            let nextTavernRevision = stableToolDigest(JSON.stringify({ epoch, connectionRevision: current.connectionRevision, provider: current.provider, model: current.model, mainApi: current.mainApi, toolCallingSupported: current.toolCallingSupported }));
            if (tavernConnectionRevision !== '' && tavernConnectionRevision !== nextTavernRevision) {
                tavernEpoch += 1;
                nextTavernRevision = stableToolDigest(JSON.stringify({ epoch: tavernEpoch, connectionRevision: current.connectionRevision, provider: current.provider, model: current.model, mainApi: current.mainApi, toolCallingSupported: current.toolCallingSupported }));
                reasoningSnapshots.delete(BUILTIN_TAVERN_RESOURCE_ID);
                toolTurn.invalidateResource(BUILTIN_TAVERN_RESOURCE_ID);
            }
            tavernConnectionRevision = nextTavernRevision;
            tavernModel = current.model;
            const toolCapabilities = await toolTurn.getCapability(BUILTIN_TAVERN_RESOURCE_ID, current.model, true);
            const reasoningPolicy = reasoningPolicyFor(BUILTIN_TAVERN_RESOURCE_ID);
            const reasoningCapabilities = reasoningSnapshotFor(BUILTIN_TAVERN_RESOURCE_ID, current.model)
                ?? unknownReasoningCapabilities(BUILTIN_TAVERN_RESOURCE_ID, current.model, current.provider, tavernConnectionRevision);
            tavern = {
                resourceId: BUILTIN_TAVERN_RESOURCE_ID,
                label: '酒馆当前连接',
                type: 'generation',
                apiType: current.provider ?? 'tavern',
                ...(current.model ? { defaultModel: current.model } : {}),
                enabled: true,
                available: available && current.provider !== undefined,
                capabilities: router.getProviderCapabilities(BUILTIN_TAVERN_RESOURCE_ID),
                ...(toolCapabilities ? { toolCapabilities } : {}),
                reasoningPolicy,
                ...(reasoningCapabilities ? { reasoningCapabilities } : {}),
                ...(available && current.provider ? {} : { unavailableReason: 'tavern_unavailable' }),
            };
        } catch { tavern = undefined; }
        return tavern === undefined ? custom : [tavern, ...custom];
    };
    const executionFor = (task: { readonly taskKind?: 'generation' | 'embedding' | 'rerank'; readonly execution?: LlmExecution; readonly requiredCapabilities?: readonly string[] }): LlmExecution => {
        if (task.execution) return task.execution;
        if (task.taskKind === 'embedding') return 'embedding';
        if (task.taskKind === 'rerank') return 'rerank';
        return task.requiredCapabilities?.includes('tools') ? 'tool_turn' : 'structured';
    };
    const taskStatusSnapshot = async (callerPluginId: string, request: LlmTaskStatusRequest): Promise<LlmTaskStatusSnapshot> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const startRevision = stateRevision;
        const settings = structuredClone(settingsState.value);
        const registration = registry.getConsumerRegistration(callerPluginId);
        const registered = registration?.tasks ?? [];
        const selected = request.taskKeys === undefined ? registered : registered.filter((task) => request.taskKeys!.includes(task.taskKey));
        const checks = selected.map((task) => ({
            id: task.taskKey,
            taskKey: task.taskKey,
            taskKind: task.taskKind ?? (executionFor(task) === 'embedding' ? 'embedding' : executionFor(task) === 'rerank' ? 'rerank' : 'generation'),
            requiredCapabilities: task.requiredCapabilities,
        }));
        const capability = await capabilityStatus({ checks }, new AbortController().signal, callerPluginId);
        const byId = new Map(capability.checks.map((entry) => [entry.id, entry]));
        const resources = await safeResources();
        const resourcesById = new Map(resources.map((resource) => [resource.resourceId, resource]));
        const tasks: LlmTaskStatusEntry[] = selected.map((task) => {
            const execution = executionFor(task);
            const entry = byId.get(task.taskKey);
            const resource = entry?.resourceId ? resourcesById.get(entry.resourceId) : undefined;
            const assignment = (settings.taskAssignments ?? []).find((item) => item.pluginId === callerPluginId && item.taskKey === task.taskKey && item.resourceId);
            const provider = entry?.resourceId ? router.getProvider(entry.resourceId) : undefined;
            const unsupported = (task.requirements?.nativeStructured === 'required' && (execution !== 'structured' || !provider?.capabilities.structuredOutput?.transports.some(transport => transport !== 'prompt_only')))
                || (task.requirements?.strictToolSchema === 'required' && (execution !== 'tool_turn' || !['native', 'beta'].includes(resource?.toolCapabilities?.strictToolSchema ?? 'unknown')))
                || (task.requirements?.streamingToolCalls === 'required' && (execution !== 'tool_turn' || resource?.toolCapabilities?.streamingToolCalls !== 'incremental' || settings.streamingEnabled === false));
            const available = entry?.available === true && !unsupported;
            const reasonCode = unsupported ? 'LLM_TASK_REQUIREMENT_UNSUPPORTED' : 'LLM_TASK_ROUTE_UNAVAILABLE';
            const route = entry?.resourceId === undefined ? undefined : {
                resourceId: entry.resourceId,
                provider: resource?.apiType ?? entry.source ?? 'unknown',
                model: entry.model ?? resource?.defaultModel ?? 'unknown',
                source: entry.source ?? (resource?.resourceId === BUILTIN_TAVERN_RESOURCE_ID ? 'tavern' : 'custom'),
                execution,
                transport: execution,
                resolvedBy: assignment ? 'task_assignment' as const : 'execution_default' as const,
                ...((resource?.reasoningCapabilities?.capabilityDigest ?? resource?.toolCapabilities?.capabilityDigest)
                    ? { capabilityDigest: resource.reasoningCapabilities?.capabilityDigest ?? resource.toolCapabilities?.capabilityDigest }
                    : {}),
                ...(resource?.reasoningPolicy ? { reasoning: resource.reasoningPolicy } : {}),
            };
            return {
                taskKey: task.taskKey,
                execution,
                available,
                ...(entry?.resourceId ? { resourceId: entry.resourceId } : {}),
                ...(route ? { route } : {}),
                ...(task.requirements ? { requirements: task.requirements } : {}),
                ...(available ? {} : {
                    failure: readSSHelperFailure(createSSHelperError(reasonCode, {
                        stage: 'llm.task.status',
                        ...(entry?.resourceId ? { resourceId: entry.resourceId } : {}),
                        ...(entry?.model ? { model: entry.model } : {}),
                    }), { reasonCode: 'LLM_TASK_ROUTE_UNAVAILABLE', stage: 'llm.task.status' })!,
                }),
            };
        });
        const defaults = (['completion', 'structured', 'tool_turn', 'embedding', 'rerank'] as const).reduce<Partial<Record<LlmExecution, string>>>((result, execution) => {
            const resourceId = router.getExecutionDefault(execution);
            if (resourceId !== undefined) result[execution] = resourceId;
            return result;
        }, {});
        if (startRevision !== stateRevision) continue;
        return {
            revision: startRevision,
            tasks,
            defaults,
            assignments: (settings.taskAssignments ?? [])
                .filter((assignment) => assignment.pluginId === callerPluginId && selected.some((task) => task.taskKey === assignment.taskKey))
                .map((assignment): LlmTaskRoutingAssignment => ({ taskKey: assignment.taskKey, ...(assignment.resourceId ? { resourceId: assignment.resourceId } : {}) })),
            resources,
        };
      }
      throw createSSHelperError('WORKSPACE_CONFLICT', { stage: 'llm.task.status.snapshot' });
    };
    const taskRouteSet = async (request: LlmTaskRouteSetRequest, callerPluginId: string): Promise<LlmTaskStatusSnapshot> => {
        if (request.expectedRevision !== stateRevision) throw createSSHelperError('WORKSPACE_CONFLICT', { stage: 'llm.task-route.save' });
        const incomingKeys = new Set(request.assignments.map((assignment) => assignment.taskKey));
        const updates = request.assignments.flatMap((assignment) => {
            const descriptor = registry.getTaskDescriptor(callerPluginId, assignment.taskKey);
            if (!descriptor) throw createSSHelperError('LLM_TASK_UNSUPPORTED', { stage: 'llm.task-route.save' });
            if (!assignment.resourceId) return [];
            const execution = executionFor(descriptor);
            const expectedType = execution === 'embedding' ? 'embedding' : execution === 'rerank' ? 'rerank' : 'generation';
            const required = descriptor.requiredCapabilities ?? (execution === 'tool_turn' ? ['chat', 'tools'] : execution === 'embedding' ? ['embeddings'] : execution === 'rerank' ? ['rerank'] : ['chat', 'json']);
            const capabilities = router.getProviderCapabilities(assignment.resourceId);
            if (router.getResourceType(assignment.resourceId) !== expectedType || !required.every((capability) => capabilities.includes(capability))) throw createSSHelperError('LLM_CAPABILITY_UNAVAILABLE', { stage: 'llm.task-route.save', resourceId: assignment.resourceId });
            return [{ pluginId: callerPluginId, taskKey: assignment.taskKey, taskKind: descriptor.taskKind ?? (expectedType === 'embedding' ? 'embedding' : expectedType === 'rerank' ? 'rerank' : 'generation'), resourceId: assignment.resourceId, isStale: false }];
        });
        const apply = (current: LLMHubSettings): LLMHubSettings & Record<string, unknown> => {
            const retained = (current.taskAssignments ?? []).filter((assignment) => assignment.pluginId !== callerPluginId || !incomingKeys.has(assignment.taskKey));
            const globalAssignments = { ...(current.globalAssignments ?? {}) };
            for (const [key, resourceId] of Object.entries(request.defaults ?? {})) {
                if (resourceId === undefined) continue;
                if (key === 'embedding' || key === 'rerank' || key === 'completion' || key === 'structured' || key === 'tool_turn') {
                    const family = key === 'embedding' ? 'embedding' : key === 'rerank' ? 'rerank' : 'generation';
                    globalAssignments[family] = { resourceId };
                }
            }
            return { ...current, taskAssignments: [...retained, ...updates], globalAssignments };
        };
        if (repository) await repository.updateSettings(apply);
        else { const prepared = await prepareRuntime(apply(settingsState.value)); prepared.commit(); }
        return taskStatusSnapshot(callerPluginId, { taskKeys: request.assignments.map((assignment) => assignment.taskKey) });
    };

    const runtimeDisposers: Array<() => void> = [];
    const detachRuntimePreparer = repository?.attachRuntimePreparer(prepareRuntime);
    if (repository) {
        registry.setPersistCallback((snapshots) => repository.saveConsumers(snapshots as unknown as Record<string, import('@ss-helper/sdk').PlainData>));
        const unsubscribeRepository = repository.subscribeChanges((kinds) => notifyCapabilityChange(kinds));
        let initializing = false;
        let initialized = false;
        const initializeRuntime = async (): Promise<void> => {
            if (disposed || initializing || initialized) return;
            initializing = true;
            try {
            let delayMs = 0;
            while (!disposed) {
                if (disposed) return;
                if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
                try {
                    await repository.ready();
                    const consumers = await repository.loadConsumers();
                    if (Object.keys(consumers).length) registry.restoreFromStorage(consumers as never);
                    const settings = await repository.loadSettings();
                    const prepared = await prepareRuntime(settings);
                    prepared.commit();
                    initialized = true;
                    notifyCapabilityChange(['generation', 'embedding', 'rerank']);
                    return;
                } catch (error) {
                    const failure = describeSSHelperFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'llm.runtime.initialize' });
                    if (!failure.retryable) {
                        logger.error('LLM 初始化需要修复配置。', safeFailureLogDetail(error, failure));
                        return;
                    }
                    delayMs = Math.min(5_000, delayMs === 0 ? 120 : delayMs * 2);
                }
            }
            } finally { initializing = false; }
        };
        const unsubscribeRecovery = repository.subscribeSettings(() => { void initializeRuntime(); });
        void initializeRuntime();
        runtimeDisposers.push(unsubscribeRecovery);
        runtimeDisposers.push(unsubscribeRepository);
    } else {
        void prepareRuntime(settingsState.value).then((prepared) => prepared.commit()).catch(() => undefined);
    }
    const host = session.host as unknown as HostPort;
    const unlistenGeneration = host.has?.('tavern.chat.events') && host.events ? host.events.subscribe('generation-config-changed', () => {
        tavernEpoch += 1;
        tavernModel = undefined;
        tavernConnectionRevision = '';
        reasoningSnapshots.delete(BUILTIN_TAVERN_RESOURCE_ID);
        toolTurn.invalidateResource(BUILTIN_TAVERN_RESOURCE_ID);
        notifyCapabilityChange(['generation']);
    }) : undefined;
    const handlers = createLlmSdkServiceHandlers(sdk);
    return {
        ...handlers,
        describeTask,
        toolTurn: (request, signal, callerPluginId, requestId) => toolTurn.turn(request, callerPluginId, requestId, signal),
        cancelToolSession: (toolSessionId, callerPluginId) => toolTurn.cancel(toolSessionId, callerPluginId),
        taskStatus: (request, callerPluginId) => taskStatusSnapshot(callerPluginId, request),
        taskRouteSet,
        verifyResourceCapability: async (request, signal, _callerPluginId, requestId): Promise<LlmResourceCapabilityVerifyResponse> => {
            const isTavern = request.resourceId === BUILTIN_TAVERN_RESOURCE_ID;
            const resource = isTavern ? tavernResource : settingsState.value.resources?.find((item) => item.id === request.resourceId);
            const provider = router.getProvider(request.resourceId);
            if (!resource || !provider) throw createSSHelperError('PROVIDER_UNAVAILABLE', { stage: 'llm.reasoning.verify.resource', resourceId: request.resourceId });
            let model = resource.model ?? router.getDefaultModel(request.resourceId);
            let providerKind = providerManifest(resource.apiType).id as 'openai' | 'claude' | 'gemini' | 'deepseek' | 'kimi' | 'glm' | 'xai' | 'generic';
            let connectionRevision = resourceConnectionRevision(resource, model);
            let probeTavernEpoch = tavernEpoch;
            const probeResourceEpoch = resourceEpoch(request.resourceId);
            if (isTavern) {
                const { snapshot: current, epoch } = await readTavernSnapshot();
                probeTavernEpoch = epoch;
                model = current.model ?? model;
                providerKind = providerManifest(current.provider).id as typeof providerKind;
                connectionRevision = stableToolDigest(JSON.stringify({ epoch, connectionRevision: current.connectionRevision, provider: current.provider, model: current.model, mainApi: current.mainApi, toolCallingSupported: current.toolCallingSupported }));
                tavernModel = model;
                tavernConnectionRevision = connectionRevision;
            }
            if (!model) throw createSSHelperError('MODEL_NOT_FOUND', { stage: 'llm.reasoning.verify.model', resourceId: request.resourceId });
            if (resource.type === 'embedding') {
                const epoch = resourceEpoch(request.resourceId);
                let verifiedMaxBatchInputs: 8 | 16 | 32 = 8;
                let status: VerifiedEmbeddingCapabilities['status'] = 'failed';
                let failure: VerifiedEmbeddingCapabilities['failure'];
                for (const size of [8, 16, 32] as const) {
                    try {
                        const probe = await provider.embed?.({ texts: Array.from({ length: size }, (_, index) => `ss-helper-batch-probe-${index}`), model, signal });
                        if (!probe || probe.embeddings.length !== size) break;
                        verifiedMaxBatchInputs = size;
                        status = 'verified';
                    } catch (error) {
                        failure = readSSHelperFailure(error, { reasonCode: 'LLM_REASONING_PROBE_FAILED', stage: 'llm.embedding.batch-probe', requestId, resourceId: request.resourceId, model });
                        break;
                    }
                }
                if (epoch !== resourceEpoch(request.resourceId)) throw createSSHelperError('LLM_REASONING_CAPABILITY_UNVERIFIED', { stage: 'llm.embedding.probe.stale', requestId, resourceId: request.resourceId, model });
                const embedding: VerifiedEmbeddingCapabilities = {
                    status, resourceId: request.resourceId, model, verifiedMaxBatchInputs,
                    ...(status === 'verified' ? { verifiedAt: Date.now() } : {}),
                    ...(failure ? { failure } : {}),
                };
                embeddingSnapshots.set(request.resourceId, embedding);
                notifyCapabilityChange(['embedding']);
                return { resourceId: request.resourceId, taskKeys: request.taskKeys ?? [], capabilities: [], embedding };
            }
            const policy = reasoningPolicyFor(request.resourceId);
            let toolCapability: VerifiedToolCapabilities | undefined;
            try {
                toolCapability = (await toolTurn.verify(request.resourceId, model, request.force === true, requestId, signal, policy)).capability;
            } catch {
                // Reasoning verification is independent. A resource may still
                // report completion/structured support when its optional tool
                // handshake is unavailable.
            }
            if (isTavern ? probeTavernEpoch !== tavernEpoch : probeResourceEpoch !== resourceEpoch(request.resourceId)) {
                throw createSSHelperError('LLM_REASONING_CAPABILITY_UNVERIFIED', { stage: 'llm.reasoning.probe.stale', requestId, resourceId: request.resourceId, model });
            }
            const cached = request.force === true ? undefined : reasoningSnapshotFor(request.resourceId, model);
            let reasoning = cached;
            if (reasoning === undefined) {
                reasoning = await verifyReasoningCapabilities({
                    resourceId: request.resourceId,
                    model,
                    provider,
                    providerKind,
                    connectionRevision,
                    policy,
                    requestId,
                    signal,
                    beforeRequest: () => requestRateLimiter.acquire(signal, requestId),
                    ...(toolCapability === undefined ? {} : { toolCapability }),
                });
                const stillCurrent = isTavern ? probeTavernEpoch === tavernEpoch : probeResourceEpoch === resourceEpoch(request.resourceId);
                if (!stillCurrent) throw createSSHelperError('LLM_REASONING_CAPABILITY_UNVERIFIED', { stage: 'llm.reasoning.probe.stale', requestId, resourceId: request.resourceId, model });
                reasoningSnapshots.set(request.resourceId, { capabilities: reasoning, policy });
                notifyCapabilityChange(['generation']);
            }
            notifyCapabilityChange(['generation']);
            return { resourceId: request.resourceId, taskKeys: request.taskKeys ?? [], capabilities: toolCapability === undefined ? [] : [toolCapability], reasoning };
        },
        dispose(): void { if (disposed) return; disposed = true; applyGeneration += 1; runtimeDisposers.splice(0).forEach((dispose) => dispose()); detachRuntimePreparer?.(); unlistenGeneration?.(); unlistenRegistry(); toolTurn.dispose(); sdk.dispose(); for (const provider of new Set((options.providers ?? []).map((registration) => registration.provider))) provider.dispose?.(); for (const id of managed) router.getProvider(id)?.dispose?.(); },
    };
}
