import { LLM_CAPABILITY_STATUS_CHANGED_V0, createSSHelperError, readSSHelperFailure, type HostPort, type LlmCapabilityKind, type LlmCapabilityStatusRequest, type LlmCapabilityStatusResponse, type LlmSafeResourceSummary, type LlmTaskRoutingSnapshot, type PluginSession } from '@ss-helper/sdk';
import { BudgetManager } from '../budget/budget-manager';
import { RequestLogService } from '../log/requestLogService';
import { RequestOrchestrator } from '../orchestrator/orchestrator';
import { ClaudeProvider } from '../providers/claude-provider';
import { CustomRerankProvider } from '../providers/custom-rerank-provider';
import { GeminiProvider } from '../providers/gemini-provider';
import { OpenAIProvider } from '../providers/openai-provider';
import { TavernProvider } from '../providers/tavern-provider';
import type { LLMProvider } from '../providers/types';
import { detectStructuredOutputIdentity } from '../schema/structured-output-plan';
import { ConsumerRegistry } from '../registry/consumer-registry';
import { BUILTIN_TAVERN_RESOURCE_ID, TaskRouter } from '../router/router';
import { LLMSDKImpl } from '../sdk/llm-sdk';
import { DEFAULT_LLM_SETTINGS } from '../schema/defaults';
import type { GlobalMaxTokensControl, LLMCapability, LLMHubSettings, ResourceConfig, ResourceType } from '../schema/types';
import { createLlmSdkServiceHandlers, publishRouteChanged, type LlmServiceHandlers } from './services';
import { LlmWorkspaceRepository, type PreparedSettingsRuntime, type SettingsRuntimePrepareOptions } from '../storage/llm-workspace-repository';
import { validateLlmSettings } from '../validation/settings';
import { logger, safeFailureLogDetail } from '../runtime/logger';
import { createCoreBridgeFetch } from './core-bridge-fetch';
import { LlmToolTurnService } from './tool-turn-service';
import { normalizeProviderPrivacyPolicy } from '../tools/provider-privacy-policy';
import { RequestRateLimiter } from '../runtime/request-rate-limiter';

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
    const resolvedApiType = resource.apiType === 'auto' ? 'generic' : resource.apiType;
    const identity = resolvedApiType === 'generic' || resolvedApiType === 'xai' || resolvedApiType === 'kimi' || resolvedApiType === 'glm'
        ? { vendor: 'unknown' as const, evidence: 'manual' as const, confidence: 'high' as const, ...(resource.model ? { model: resource.model } : {}) }
        : detectStructuredOutputIdentity({ manualVendor: resolvedApiType, model: resource.model });
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
    const thinking = customParams.thinking;
    const requireReasoningContent = resolvedApiType === 'deepseek' && (
        /reasoner/iu.test(resource.model ?? '')
        || thinking === true
        || (typeof thinking === 'object' && thinking !== null && !Array.isArray(thinking) && (thinking as Record<string, unknown>).type === 'enabled')
    );
    const enableToolStream = (resolvedApiType === 'kimi' || resolvedApiType === 'glm') && (customParams.tool_stream === true || customParams.stream === true);
    return new OpenAIProvider({ ...base, apiType: resolvedApiType, structuredOutputIdentity: identity, enableRerank: resource.type === 'rerank' && resource.rerankProtocol === 'chat', embeddingPath: resource.embeddingPath, embeddingDimensions: resource.embeddingDimensions, toolDialect: resource.toolDialect, requireReasoningContent, enableToolStream });
}

function configuredMaxTokensControl(settings: LLMHubSettings): GlobalMaxTokensControl {
    const mode = settings.maxTokensMode ?? settings.maxTokensControl?.mode ?? DEFAULT_LLM_SETTINGS.maxTokensMode;
    if (mode === 'manual') {
        return {
            mode,
            manualValue: settings.maxTokens ?? settings.maxTokensControl?.manualValue ?? DEFAULT_LLM_SETTINGS.maxTokens,
        };
    }
    return {
        mode,
        ...(mode === 'adaptive' && settings.maxTokensControl?.adaptive
            ? { adaptive: settings.maxTokensControl.adaptive }
            : {}),
    };
}

function withMaxTokensDefaults(settings: LLMHubSettings): LLMHubSettings {
    return {
        ...DEFAULT_LLM_SETTINGS,
        ...settings,
        maxTokensMode: settings.maxTokensMode ?? settings.maxTokensControl?.mode ?? DEFAULT_LLM_SETTINGS.maxTokensMode,
        maxTokens: settings.maxTokens ?? settings.maxTokensControl?.manualValue ?? DEFAULT_LLM_SETTINGS.maxTokens,
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
    router.setRegistry(registry);
    registry.setResourceCapabilityQuery((resourceId) => router.getProviderCapabilities(resourceId));
    router.registerProvider(new TavernProvider({ id: BUILTIN_TAVERN_RESOURCE_ID, generation: session.host.generation }), 'generation', ['chat', 'json']);
    const managed = new Set<string>();
    let lastGenerationRoute: string | undefined;
    let statusRevision = 0;
    let routeRevision = 0;
    const notifyCapabilityChange = (kinds: readonly LlmCapabilityKind[]): void => {
        statusRevision += 1;
        try {
            session.bus.publish(LLM_CAPABILITY_STATUS_CHANGED_V0, { revision: statusRevision, kinds: [...new Set(kinds)] });
        } catch {
            // Event delivery is best effort and must not turn an applied runtime update into a failed save.
        }
    };
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
    const toolTurn = new LlmToolTurnService(router, {
        getResource: (resourceId) => settingsState.value.resources?.find((resource) => resource.id === resourceId),
        getStreamingEnabled: () => settingsState.value.streamingEnabled !== false,
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
            commit: (): void => {
                if (committed || released) return;
                if (disposed || generation !== applyGeneration) {
                    for (const provider of built) provider.dispose?.();
                    released = true;
                    return;
                }
                const oldProviders = [...managed].map((id) => router.getProvider(id)).filter((provider): provider is LLMProvider => Boolean(provider));
                const previousResources = settingsState.value.resources ?? [];
                const streamingChanged = (settingsState.value.streamingEnabled ?? DEFAULT_LLM_SETTINGS.streamingEnabled) !== settings.streamingEnabled;
                settingsState.value = { ...settings };
                requestRateLimiter.setMaxRequestsPerMinute(settings.maxRequestsPerMinute ?? DEFAULT_LLM_SETTINGS.maxRequestsPerMinute);
                sdk.setGlobalProfile(settings.globalProfile ?? 'balanced');
                router.applyGenerationSource(settings.generationSource ?? DEFAULT_LLM_SETTINGS.generationSource);
                router.applyGlobalAssignments(settings.globalAssignments ?? {});
                router.applyPluginAssignments(settings.pluginAssignments ?? []);
                router.applyTaskAssignments(settings.taskAssignments ?? []);
                budget.replaceConfigs(settings.budgets ?? {});
                router.replaceManagedProviders([...managed], registrations);
                const nextResources = settings.resources ?? [];
                const nextById = new Map(nextResources.map((resource) => [resource.id, resource]));
                for (const previous of previousResources) {
                    const next = nextById.get(previous.id);
                    if (streamingChanged || !next || JSON.stringify({ apiType: previous.apiType, baseUrl: previous.baseUrl, model: previous.model, toolDialect: previous.toolDialect, privacyPolicy: previous.privacyPolicy }) !== JSON.stringify({ apiType: next.apiType, baseUrl: next.baseUrl, model: next.model, toolDialect: next.toolDialect, privacyPolicy: next.privacyPolicy })) toolTurn.invalidateResource(previous.id);
                }
                managed.clear();
                for (const registration of registrations) managed.add(registration.provider.id);
                for (const provider of oldProviders) provider.dispose?.();
                const nextGenerationRoute = settings.generationSource === 'tavern' ? BUILTIN_TAVERN_RESOURCE_ID : settings.globalAssignments?.generation?.resourceId;
                if (nextGenerationRoute && nextGenerationRoute !== lastGenerationRoute) {
                    try { publishRouteChanged(session, lastGenerationRoute, nextGenerationRoute, 'configured'); } catch {
                        // A failing subscriber must not roll back an already applied route update.
                    }
                    lastGenerationRoute = nextGenerationRoute;
                }
                notifyCapabilityChange(['generation', 'embedding', 'rerank']);
                routeRevision += 1;
                committed = true;
            },
            dispose: (): void => {
                if (committed || released) return;
                for (const provider of built) provider.dispose?.();
                released = true;
            },
        };
    };

    const capabilityStatus = async (request: LlmCapabilityStatusRequest, signal: AbortSignal): Promise<LlmCapabilityStatusResponse> => {
        if (signal.aborted) throw new Error('capability status request aborted');
        const settings = settingsState.value;
        const resources = Array.isArray(settings.resources) ? settings.resources : [];
        const entries = await Promise.all(request.checks.map(async (check) => {
            const base = {
                id: check.id,
                ...(check.taskKind === 'generation' ? { source: settings.generationSource } : {}),
            };
            if (settings.enabled === false) return { ...base, configured: false, available: false, reason: 'llm_disabled' as const };
            const required = [...(check.requiredCapabilities ?? (check.taskKind === 'generation' ? ['chat', 'json'] : check.taskKind === 'embedding' ? ['embeddings'] : ['rerank']))] as LLMCapability[];
            const candidates = resources.filter((resource) => {
                if (resource.source === 'tavern') return false;
                const declared = new Set(resource.capabilities ?? []);
                if (resource.type === 'generation') { declared.add('chat'); declared.add('json'); }
                if (resource.type === 'embedding') declared.add('embeddings');
                if (resource.type === 'rerank') declared.add('rerank');
                return (resource.type === check.taskKind || required.some((capability) => declared.has(capability))) && required.every((capability) => declared.has(capability));
            });
            const enabledCandidates = candidates.filter((resource) => resource.enabled !== false);
            let missingCredential = false;
            for (const resource of enabledCandidates) {
                if (await repository?.hasResourceSecret(resource.id)) break;
                missingCredential = true;
            }
            let route;
            try { route = router.resolveRoute({ consumer: 'ss-helper.memory', taskKind: check.taskKind, taskKey: check.taskKey, requiredCapabilities: required as never }); } catch {
                if (missingCredential) return { ...base, configured: false, available: false, reason: 'credential_missing' as const };
                if (candidates.length > 0 && enabledCandidates.length === 0) return { ...base, configured: false, available: false, reason: 'resource_disabled' as const };
                if (candidates.length === 0 && (check.taskKind !== 'generation' || settings.generationSource === 'custom')) return { ...base, configured: false, available: false, reason: 'no_resource' as const };
                return { ...base, configured: false, available: false, reason: 'route_unavailable' as const };
            }
            if (route.resourceId === BUILTIN_TAVERN_RESOURCE_ID) {
                try {
                    const available = await session.host.generation.available();
                    const current = await session.host.generation.current();
                    const model = current.model ?? route.model;
                    const provider = current.provider;
                    if (!available || !provider) return { ...base, configured: false, available: false, reason: 'tavern_unavailable' as const };
                    return { ...base, configured: true, available: true, source: 'tavern' as const, ...(model === undefined ? {} : { model }) };
                } catch { return { ...base, configured: false, available: false, reason: 'status_unavailable' as const }; }
            }
            const resource = resources.find((item) => item.id === route.resourceId);
            if (!resource) return { ...base, configured: false, available: false, reason: 'route_unavailable' as const };
            if (resource.enabled === false) return { ...base, configured: false, available: false, reason: 'resource_disabled' as const };
            if (repository && !(await repository.hasResourceSecret(resource.id))) return { ...base, configured: false, available: false, reason: 'credential_missing' as const };
            return { ...base, configured: true, available: true, source: 'custom' as const, resourceId: resource.id, ...(route.model ?? resource.model ? { model: route.model ?? resource.model } : {}) };
        }));
        return { revision: statusRevision, checks: entries };
    };

    const safeResources = async (): Promise<LlmSafeResourceSummary[]> => {
        const resources = settingsState.value.resources ?? [];
        return Promise.all(resources.map(async (resource): Promise<LlmSafeResourceSummary> => {
            const provider = router.getProvider(resource.id);
            const available = resource.enabled !== false && provider !== undefined && (!repository || await repository.hasResourceSecret(resource.id));
            const toolCapabilities = await toolTurn.getCapability(resource.id, resource.model, true);
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
                privacyPolicy: normalizeProviderPrivacyPolicy(resource.privacyPolicy),
                ...(available ? {} : { unavailableReason: provider ? 'credential_missing' : 'resource_unavailable' }),
            };
        }));
    };
    const taskRoutingSnapshot = async (callerPluginId: string, taskKeys?: readonly string[]): Promise<LlmTaskRoutingSnapshot> => {
        const allowed = taskKeys ? new Set(taskKeys) : undefined;
        return {
            revision: routeRevision,
            assignments: (settingsState.value.taskAssignments ?? [])
                .filter((assignment) => assignment.pluginId === callerPluginId && (!allowed || allowed.has(assignment.taskKey)))
                .map((assignment) => ({ taskKey: assignment.taskKey, ...(assignment.resourceId ? { resourceId: assignment.resourceId } : {}), ...(assignment.model ? { model: assignment.model } : {}) })),
            resources: await safeResources(),
        };
    };

    const detachRuntimePreparer = repository?.attachRuntimePreparer(prepareRuntime);
    if (repository) {
        registry.setPersistCallback((snapshots) => { void repository.saveConsumers(snapshots as unknown as Record<string, import('@ss-helper/sdk').PlainData>); });
        void (async () => {
            for (const delayMs of [0, 120, 400, 1_200, 3_000] as const) {
                if (disposed) return;
                if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
                try {
                    await repository.ready();
                    const consumers = await repository.loadConsumers();
                    if (Object.keys(consumers).length) registry.restoreFromStorage(consumers as never);
                    const settings = await repository.loadSettings();
                    const prepared = await prepareRuntime(settings);
                    prepared.commit();
                    return;
                } catch {
                    // Server-plugin and workspace startup are independent of the
                    // browser extension. A later bounded attempt must be able to
                    // apply persisted routes even when the first Bridge call lost
                    // the startup race.
                }
            }
        })();
        repository.subscribeChanges((kinds) => notifyCapabilityChange(kinds));
    } else {
        void prepareRuntime(settingsState.value).then((prepared) => prepared.commit()).catch(() => undefined);
    }
    const host = session.host as unknown as HostPort;
    const unlistenGeneration = host.has?.('tavern.chat.events') && host.events ? host.events.subscribe('generation-config-changed', () => notifyCapabilityChange(['generation'])) : undefined;
    const handlers = createLlmSdkServiceHandlers(sdk);
    return {
        ...handlers,
        describeTask,
        capabilityStatus,
        toolTurn: (request, signal, callerPluginId, requestId) => toolTurn.turn(request, callerPluginId, requestId, signal),
        cancelToolSession: (toolSessionId, callerPluginId) => toolTurn.cancel(toolSessionId, callerPluginId),
        verifyToolCapability: async (request, signal) => {
            const response = await toolTurn.verify(request.resourceId, request.model, request.force === true, signal);
            notifyCapabilityChange(['generation']);
            return response;
        },
        getTaskRouting: (request, callerPluginId) => taskRoutingSnapshot(callerPluginId, request.taskKeys),
        setTaskRouting: async (request, callerPluginId) => {
            if (request.expectedRevision !== routeRevision) throw createSSHelperError('WORKSPACE_CONFLICT', { stage: 'llm.routing.save' });
            const incomingKeys = new Set(request.assignments.map((assignment) => assignment.taskKey));
            const retained = (settingsState.value.taskAssignments ?? []).filter((assignment) => assignment.pluginId !== callerPluginId || !incomingKeys.has(assignment.taskKey));
            const updates = request.assignments.flatMap((assignment) => {
                const descriptor = registry.getTaskDescriptor(callerPluginId, assignment.taskKey);
                if (!descriptor) throw createSSHelperError('LLM_TASK_UNSUPPORTED', { stage: 'llm.routing.save' });
                if (!assignment.resourceId) return [];
                const capabilities = router.getProviderCapabilities(assignment.resourceId);
                if (!descriptor.requiredCapabilities.every((capability) => capabilities.includes(capability))) throw createSSHelperError('LLM_CAPABILITY_UNAVAILABLE', { stage: 'llm.routing.save', resourceId: assignment.resourceId, ...(assignment.model ? { model: assignment.model } : {}) });
                return [{ pluginId: callerPluginId, taskKey: assignment.taskKey, taskKind: descriptor.taskKind, resourceId: assignment.resourceId, ...(assignment.model ? { model: assignment.model } : {}), isStale: false }];
            });
            const next = { ...settingsState.value, taskAssignments: [...retained, ...updates] };
            if (repository) await repository.saveSettings(next);
            else { const prepared = await prepareRuntime(next); prepared.commit(); }
            return taskRoutingSnapshot(callerPluginId, request.assignments.map((assignment) => assignment.taskKey));
        },
        dispose(): void { if (disposed) return; disposed = true; applyGeneration += 1; detachRuntimePreparer?.(); unlistenGeneration?.(); toolTurn.dispose(); sdk.dispose(); for (const provider of new Set((options.providers ?? []).map((registration) => registration.provider))) provider.dispose?.(); for (const id of managed) router.getProvider(id)?.dispose?.(); },
    };
}
