import type { PluginSession } from '@ss-helper/sdk';
import { BudgetManager } from '../budget/budget-manager';
import { DisplayController } from '../display/display-controller';
import { RequestLogService } from '../log/requestLogService';
import { RequestOrchestrator } from '../orchestrator/orchestrator';
import { TavernProvider } from '../providers/tavern-provider';
import type { LLMProvider } from '../providers/types';
import { ConsumerRegistry } from '../registry/consumer-registry';
import { BUILTIN_TAVERN_RESOURCE_ID, TaskRouter } from '../router/router';
import { LLMSDKImpl } from '../sdk/llm-sdk';
import type { LLMCapability, LLMHubSettings, ResourceType } from '../schema/types';
import { createLlmSdkServiceHandlers, type LlmServiceHandlers } from './services';

export interface ProductionLlmProviderRegistration {
    readonly provider: LLMProvider;
    readonly resourceType: ResourceType;
    readonly capabilities?: readonly LLMCapability[];
    readonly defaultModel?: string;
}

export interface ProductionLlmServiceOptions {
    readonly providers?: readonly ProductionLlmProviderRegistration[];
    readonly settings?: () => LLMHubSettings;
}

export function createProductionLlmServices(
    session: PluginSession<'tavern.generation.read' | 'tavern.generation.execute'>,
    options: ProductionLlmServiceOptions = {},
): LlmServiceHandlers {
    const router = new TaskRouter();
    const registry = new ConsumerRegistry();
    router.setRegistry(registry);
    registry.setResourceCapabilityQuery((resourceId) => router.getProviderCapabilities(resourceId));
    router.registerProvider(new TavernProvider({ id: BUILTIN_TAVERN_RESOURCE_ID, generation: session.host.generation }), 'generation', ['chat', 'json']);
    for (const registration of options.providers ?? []) {
        router.registerProvider(
            registration.provider,
            registration.resourceType,
            registration.capabilities === undefined ? undefined : [...registration.capabilities],
            registration.defaultModel,
        );
    }
    const sdk = new LLMSDKImpl(
        router,
        new BudgetManager(),
        new RequestOrchestrator(),
        new DisplayController(),
        registry,
        new RequestLogService(),
    );
    if (options.settings !== undefined) sdk.setSettingsResolver(options.settings);
    const handlers = createLlmSdkServiceHandlers(sdk);
    let disposed = false;
    return {
        ...handlers,
        dispose(): void {
            if (disposed) return;
            disposed = true;
            for (const provider of new Set((options.providers ?? []).map((registration) => registration.provider))) provider.dispose?.();
        },
    };
}
