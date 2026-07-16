import type { PluginSession, WorkspacePort } from '@ss-helper/sdk';
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
import { ConsumerRegistry } from '../registry/consumer-registry';
import { BUILTIN_TAVERN_RESOURCE_ID, TaskRouter } from '../router/router';
import { LLMSDKImpl } from '../sdk/llm-sdk';
import type { LLMCapability, LLMHubSettings, ResourceConfig, ResourceType } from '../schema/types';
import { createLlmSdkServiceHandlers, publishRouteChanged, type LlmServiceHandlers } from './services';
import { LlmWorkspaceRepository } from '../storage/llm-workspace-repository';

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
    readonly workspace?: WorkspacePort;
}

export function createProviderFromResource(resource: ResourceConfig, apiKey: string): LLMProvider {
    const base = { id: resource.id, apiKey, baseUrl: resource.baseUrl, model: resource.model, customParams: resource.customParams };
    if (resource.type === 'rerank') return new CustomRerankProvider({ ...base, baseUrl: resource.baseUrl || '', rerankPath: resource.rerankPath, model: resource.model });
    switch (resource.apiType) {
        case 'claude': return new ClaudeProvider(base);
        case 'gemini': return new GeminiProvider({ ...base, enableRerank: resource.capabilities?.includes('rerank') });
        case 'deepseek':
        case 'generic':
        case 'openai':
        default: return new OpenAIProvider({ ...base, apiType: resource.apiType, enableRerank: resource.capabilities?.includes('rerank') });
    }
}

export function createProductionLlmServices(
    session: PluginSession<'tavern.generation.read' | 'tavern.generation.execute'>,
    options: ProductionLlmServiceOptions = {},
): LlmServiceHandlers {
    const router = new TaskRouter();
    const registry = new ConsumerRegistry();
    const budget = new BudgetManager();
    const display = new DisplayController();
    const repository = options.repository ?? (options.workspace ? new LlmWorkspaceRepository(options.workspace) : undefined);
    const settingsState: { value: LLMHubSettings } = { value: options.settings?.() ?? { enabled: true, globalProfile: 'balanced', maxTokensControl: { mode: 'adaptive' } } };
    router.setRegistry(registry);
    registry.setResourceCapabilityQuery((resourceId) => router.getProviderCapabilities(resourceId));
    router.registerProvider(new TavernProvider({ id: BUILTIN_TAVERN_RESOURCE_ID, generation: session.host.generation }), 'generation', ['chat', 'json']);
    const managed = new Set<string>();
    let lastGenerationRoute: string | undefined;
    for (const registration of options.providers ?? []) {
        router.registerProvider(registration.provider, registration.resourceType, registration.capabilities === undefined ? undefined : [...registration.capabilities], registration.defaultModel);
        managed.add(registration.provider.id);
    }

    const sdk = new LLMSDKImpl(router, budget, new RequestOrchestrator(), display, registry, new RequestLogService(repository));
    sdk.setSettingsResolver(() => { const value = settingsState.value as LLMHubSettings & Record<string, unknown>; return { ...settingsState.value, maxTokensControl: settingsState.value.maxTokensControl ?? ({ mode: value.maxTokensMode as 'inherit' | 'manual' | 'adaptive', manualValue: Number(value.maxTokens ?? 2048) }) }; });

    const apply = async (settings: LLMHubSettings): Promise<void> => {
        settingsState.value = { ...settings };
        try { if (settings.globalProfile) sdk.setGlobalProfile(settings.globalProfile); } catch { sdk.setGlobalProfile('balanced'); }
        router.applyGlobalAssignments(settings.globalAssignments ?? {});
        router.applyPluginAssignments(settings.pluginAssignments ?? []);
        router.applyTaskAssignments(settings.taskAssignments ?? []);
        budget.replaceConfigs(settings.budgets ?? {});
        display.restoreSilentPermissions(settings.silentPermissions ?? []);
        const nextGenerationRoute = settings.globalAssignments?.generation?.resourceId;
        if (nextGenerationRoute && nextGenerationRoute !== lastGenerationRoute) { publishRouteChanged(session, lastGenerationRoute, nextGenerationRoute, 'configured'); lastGenerationRoute = nextGenerationRoute; }
        if (!repository) return;
        const resources = Array.isArray(settings.resources) ? settings.resources : [];
        const next = new Map<string, LLMProvider>();
        for (const resource of resources) {
            if (!resource || resource.enabled === false || resource.source === 'tavern') continue;
            try {
                const key = await repository.getResourceSecret(resource.id);
                if (!key && resource.type !== 'rerank') continue;
                if (!key) continue;
                next.set(resource.id, createProviderFromResource(resource, key));
            } catch { /* missing Secret or malformed resource keeps it visibly disabled */ }
        }
        for (const id of managed) { router.getProvider(id)?.dispose?.(); router.removeProvider(id); }
        managed.clear();
        for (const [id, provider] of next) { const resource = resources.find((item) => item.id === id)!; router.registerProvider(provider, resource.type, resource.capabilities, resource.model); managed.add(id); }
    };

    if (repository) {
        registry.setPersistCallback((snapshots) => { void repository.saveConsumers(snapshots as unknown as Record<string, import('@ss-helper/sdk').PlainData>); });
        void repository.ready().then(async () => { const consumers = await repository.loadConsumers(); if (Object.keys(consumers).length) registry.restoreFromStorage(consumers as never); return repository.loadSettings(); }).then((settings) => apply(settings)).catch(() => undefined);
        repository.subscribeSettings((settings) => { void apply(settings); });
    }
    const handlers = createLlmSdkServiceHandlers(sdk, (kind) => {
        const display = settingsState.value.resultDisplay;
        if (display === 'fullscreen' || display === 'compact' || display === 'silent') return display;
        return kind === 'generation' ? 'compact' : 'silent';
    });
    let disposed = false;
    return { ...handlers, dispose(): void { if (disposed) return; disposed = true; for (const provider of new Set((options.providers ?? []).map((registration) => registration.provider))) provider.dispose?.(); for (const id of managed) router.getProvider(id)?.dispose?.(); } };
}
