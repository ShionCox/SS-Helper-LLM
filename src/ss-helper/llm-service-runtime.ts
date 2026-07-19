import { LLM_CAPABILITY_STATUS_CHANGED_V1, type HostPort, type LlmCapabilityKind, type LlmCapabilityStatusRequest, type LlmCapabilityStatusResponse, type PluginSession } from '@ss-helper/sdk';
import { BudgetManager } from '../budget/budget-manager';
import { DisplayController } from '../display/display-controller';
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
import type { LLMCapability, LLMHubSettings, ResourceConfig, ResourceType } from '../schema/types';
import { createLlmSdkServiceHandlers, publishRouteChanged, type LlmServiceHandlers } from './services';
import { LlmWorkspaceRepository, type PreparedSettingsRuntime, type SettingsRuntimePrepareOptions } from '../storage/llm-workspace-repository';
import { validateLlmSettings } from '../validation/settings';

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

export function createProviderFromResource(resource: ResourceConfig, apiKey: string): LLMProvider {
    const identity = resource.apiType === 'generic'
        ? { vendor: 'unknown' as const, evidence: 'manual' as const, confidence: 'high' as const, ...(resource.model ? { model: resource.model } : {}) }
        : detectStructuredOutputIdentity({ manualVendor: resource.apiType, baseUrl: resource.baseUrl, model: resource.model });
    const resolvedApiType = identity.vendor === 'unknown' ? 'generic' : identity.vendor;
    const base = { id: resource.id, apiKey, baseUrl: resource.baseUrl, model: resource.model, customParams: resource.customParams, fetchImpl: fetch };
    if (resource.type === 'rerank') return new CustomRerankProvider({ ...base, baseUrl: resource.baseUrl || '', rerankPath: resource.rerankPath });
    if (resolvedApiType === 'claude') return new ClaudeProvider(base);
    if (resolvedApiType === 'gemini') return new GeminiProvider({ ...base, enableRerank: resource.capabilities?.includes('rerank') });
    return new OpenAIProvider({ ...base, apiType: resolvedApiType, structuredOutputIdentity: identity, enableRerank: resource.capabilities?.includes('rerank') });
}

export function createProductionLlmServices(
    session: PluginSession<'tavern.generation.read' | 'tavern.generation.execute' | 'tavern.chat.events' | 'core.ui.notification.v1'>,
    options: ProductionLlmServiceOptions = {},
): LlmServiceHandlers {
    const router = new TaskRouter();
    const registry = new ConsumerRegistry();
    const budget = new BudgetManager();
    const display = new DisplayController();
    const repository = options.repository;
    const initialSettings = options.settings?.() ?? {};
    const settingsState: { value: LLMHubSettings } = { value: { ...DEFAULT_LLM_SETTINGS, ...initialSettings, maxTokensControl: initialSettings.maxTokensControl ?? { mode: 'adaptive' } } };
    router.setRegistry(registry);
    registry.setResourceCapabilityQuery((resourceId) => router.getProviderCapabilities(resourceId));
    router.registerProvider(new TavernProvider({ id: BUILTIN_TAVERN_RESOURCE_ID, generation: session.host.generation }), 'generation', ['chat', 'json']);
    const managed = new Set<string>();
    let lastGenerationRoute: string | undefined;
    let statusRevision = 0;
    const notifyCapabilityChange = (kinds: readonly LlmCapabilityKind[]): void => {
        statusRevision += 1;
        try {
            session.events.publish(LLM_CAPABILITY_STATUS_CHANGED_V1, { revision: statusRevision, kinds: [...new Set(kinds)] });
        } catch {
            // Event delivery is best effort and must not turn an applied runtime update into a failed save.
        }
    };
    for (const registration of options.providers ?? []) {
        router.registerProvider(registration.provider, registration.resourceType, registration.capabilities === undefined ? undefined : [...registration.capabilities], registration.defaultModel);
        managed.add(registration.provider.id);
    }

    const sdk = new LLMSDKImpl(router, budget, new RequestOrchestrator(), display, registry, new RequestLogService(repository));
    sdk.setSettingsResolver(() => { const value = settingsState.value as LLMHubSettings & Record<string, unknown>; return { ...settingsState.value, maxTokensControl: settingsState.value.maxTokensControl ?? ({ mode: value.maxTokensMode as 'inherit' | 'manual' | 'adaptive', manualValue: Number(value.maxTokens ?? 2048) }) }; });
    let disposed = false;
    let applyGeneration = 0;

    const prepareRuntime = async (input: LLMHubSettings, options: SettingsRuntimePrepareOptions = {}): Promise<PreparedSettingsRuntime> => {
        const generation = ++applyGeneration;
        const settings = { ...DEFAULT_LLM_SETTINGS, ...validateLlmSettings(input) };
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
                const provider = createProviderFromResource(resource, apiKey);
                built.push(provider);
                registrations.push({ provider, resourceType: resource.type, capabilities: resource.capabilities, defaultModel: resource.model });
            }
            const occupied = new Set(router.getAllProviders().filter((provider) => !managed.has(provider.id)).map((provider) => provider.id));
            if (registrations.some((registration) => occupied.has(registration.provider.id))) throw new Error('Provider ID 已被占用');
            if (disposed || generation !== applyGeneration) throw new Error('运行时应用已过期');
        } catch (error) {
            for (const provider of built) provider.dispose?.();
            if (error instanceof Error && error.message === '运行时应用已过期') throw Object.assign(new Error('运行时应用已过期'), { code: 'LLM_RUNTIME_APPLY_STALE' });
            throw Object.assign(new Error('LLM runtime apply failed'), { code: 'LLM_RUNTIME_APPLY_FAILED' });
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
                settingsState.value = { ...settings };
                sdk.setGlobalProfile(settings.globalProfile ?? 'balanced');
                router.applyGenerationSource(settings.generationSource);
                router.applyGlobalAssignments(settings.globalAssignments ?? {});
                router.applyPluginAssignments(settings.pluginAssignments ?? []);
                router.applyTaskAssignments(settings.taskAssignments ?? []);
                budget.replaceConfigs(settings.budgets ?? {});
                display.restoreSilentPermissions(settings.silentPermissions ?? []);
                router.replaceManagedProviders([...managed], registrations);
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

    const detachRuntimePreparer = repository?.attachRuntimePreparer(prepareRuntime);
    if (repository) {
        registry.setPersistCallback((snapshots) => { void repository.saveConsumers(snapshots as unknown as Record<string, import('@ss-helper/sdk').PlainData>); });
        void repository.ready().then(async () => { const consumers = await repository.loadConsumers(); if (Object.keys(consumers).length) registry.restoreFromStorage(consumers as never); return repository.loadSettings(); }).then(async (settings) => { const prepared = await prepareRuntime(settings); prepared.commit(); }).catch(() => undefined);
        repository.subscribeChanges((kinds) => notifyCapabilityChange(kinds));
    } else {
        void prepareRuntime(settingsState.value).then((prepared) => prepared.commit()).catch(() => undefined);
    }
    const host = session.host as unknown as HostPort;
    const unlistenGeneration = host.has?.('tavern.chat.events') && host.events ? host.events.subscribe('generation-config-changed', () => notifyCapabilityChange(['generation'])) : undefined;
    const handlers = createLlmSdkServiceHandlers(sdk, (kind) => {
        const display = settingsState.value.resultDisplay;
        if (display === 'fullscreen' || display === 'compact' || display === 'silent') return display;
        return kind === 'generation' ? 'compact' : 'silent';
    });
    return { ...handlers, capabilityStatus, dispose(): void { if (disposed) return; disposed = true; applyGeneration += 1; detachRuntimePreparer?.(); unlistenGeneration?.(); for (const provider of new Set((options.providers ?? []).map((registration) => registration.provider))) provider.dispose?.(); for (const id of managed) router.getProvider(id)?.dispose?.(); } };
}
