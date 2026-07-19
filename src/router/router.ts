import type { LLMProvider } from '../providers/types';
import type {
    RouteResolveArgs,
    RouteResolveResult,
    LLMCapability,
    CapabilityKind,
    ResourceType,
    GlobalAssignments,
    AssignmentEntry,
    GenerationSource,
    PluginAssignment,
    TaskAssignment,
} from '../schema/types';
import type { ConsumerRegistry } from '../registry/consumer-registry';

/** 内置酒馆资源固定 ID */
export const BUILTIN_TAVERN_RESOURCE_ID = '__builtin_tavern__';

export interface ProviderRegistration {
    readonly provider: LLMProvider;
    readonly resourceType: ResourceType;
    readonly capabilities?: readonly LLMCapability[];
    readonly defaultModel?: string;
}

/**
 * 资源感知任务路由器
 *
 * 路由优先级：
 *   generation 来源门控 → routeHint → 任务分配 → 插件注册推荐 → 插件分配 → 全局分配 → fallback
 */
export class TaskRouter {
    private providers: Map<string, LLMProvider> = new Map();
    private providerCapabilities: Map<string, LLMCapability[]> = new Map();
    private providerDefaultModels: Map<string, string | undefined> = new Map();
    private resourceTypes: Map<string, ResourceType> = new Map();

    private globalAssignments: GlobalAssignments = {};
    private pluginAssignments: Map<string, PluginAssignment> = new Map();
    private taskAssignments: Map<string, TaskAssignment> = new Map();
    private generationSource: GenerationSource = 'tavern';

    private registry: ConsumerRegistry | null = null;

    setRegistry(registry: ConsumerRegistry): void {
        this.registry = registry;
    }

    // ─── Provider 管理 ───

    registerProvider(
        provider: LLMProvider,
        resourceType: ResourceType,
        capabilities?: LLMCapability[],
        defaultModel?: string,
    ): void {
        this.providers.set(provider.id, provider);
        this.resourceTypes.set(provider.id, resourceType);
        if (capabilities) {
            this.providerCapabilities.set(provider.id, capabilities);
        } else {
            const caps: LLMCapability[] = [];
            if (provider.capabilities.chat) caps.push('chat');
            if (provider.capabilities.json) caps.push('json');
            if (provider.capabilities.tools) caps.push('tools');
            if (provider.capabilities.embeddings) caps.push('embeddings');
            if (provider.capabilities.rerank) caps.push('rerank');
            this.providerCapabilities.set(provider.id, caps);
        }
        this.providerDefaultModels.set(provider.id, defaultModel);
    }

    removeProvider(resourceId: string): void {
        this.providers.delete(resourceId);
        this.providerCapabilities.delete(resourceId);
        this.providerDefaultModels.delete(resourceId);
        this.resourceTypes.delete(resourceId);
    }

    /**
     * Atomically replace a caller-owned provider set. All validation and map
     * construction happens before the live maps are swapped, so a failed
     * registration cannot leave the router partially updated.
     */
    replaceManagedProviders(managedIds: readonly string[], registrations: readonly ProviderRegistration[]): void {
        const managed = new Set(managedIds);
        const ids = new Set<string>();
        for (const registration of registrations) {
            const id = registration.provider.id;
            if (ids.has(id)) throw new Error(`重复 Provider: ${id}`);
            if (!managed.has(id) && this.providers.has(id)) throw new Error(`Provider ID 已被占用: ${id}`);
            ids.add(id);
        }

        const providers = new Map(this.providers);
        const capabilities = new Map(this.providerCapabilities);
        const defaultModels = new Map(this.providerDefaultModels);
        const resourceTypes = new Map(this.resourceTypes);
        for (const id of managed) {
            providers.delete(id);
            capabilities.delete(id);
            defaultModels.delete(id);
            resourceTypes.delete(id);
        }
        for (const registration of registrations) {
            const id = registration.provider.id;
            providers.set(id, registration.provider);
            resourceTypes.set(id, registration.resourceType);
            capabilities.set(id, registration.capabilities ? [...registration.capabilities] : this.inferCapabilities(registration.provider));
            defaultModels.set(id, registration.defaultModel);
        }
        this.providers = providers;
        this.providerCapabilities = capabilities;
        this.providerDefaultModels = defaultModels;
        this.resourceTypes = resourceTypes;
    }

    private inferCapabilities(provider: LLMProvider): LLMCapability[] {
        const capabilities: LLMCapability[] = [];
        if (provider.capabilities.chat) capabilities.push('chat');
        if (provider.capabilities.json) capabilities.push('json');
        if (provider.capabilities.tools) capabilities.push('tools');
        if (provider.capabilities.embeddings) capabilities.push('embeddings');
        if (provider.capabilities.rerank) capabilities.push('rerank');
        return capabilities;
    }

    // ─── 分配设置管理 ───

    applyGenerationSource(source: GenerationSource): void {
        this.generationSource = source;
    }

    applyGlobalAssignments(assignments: GlobalAssignments): void {
        this.globalAssignments = { ...assignments };
    }

    applyPluginAssignments(assignments: PluginAssignment[]): void {
        this.pluginAssignments.clear();
        for (const a of assignments) this.pluginAssignments.set(a.pluginId, a);
    }

    applyTaskAssignments(assignments: TaskAssignment[]): void {
        this.taskAssignments.clear();
        for (const a of assignments) this.taskAssignments.set(`${a.pluginId}::${a.taskKey}`, a);
    }

    getTaskAssignment(pluginId: string, taskKey: string): TaskAssignment | undefined {
        return this.taskAssignments.get(`${pluginId}::${taskKey}`);
    }

    // ─── 统一路由解析 ───

    resolveRoute(args: RouteResolveArgs): RouteResolveResult {
        const { consumer, taskKind, taskKey, requiredCapabilities, routeHint } = args;

        // 1. routeHint
        if (routeHint?.resourceId) {
            if (this.providerSatisfiesTask(routeHint.resourceId, taskKind, requiredCapabilities)) {
                return {
                    resourceId: routeHint.resourceId,
                    model: routeHint.model || this.resolveDefaultModel(routeHint.resourceId),
                    profileId: routeHint.profileId,
                    resolvedBy: 'route_hint',
                };
            }
        }

        // 2. 任务分配
        if (taskKey) {
            const assignment = this.taskAssignments.get(`${consumer}::${taskKey}`);
            if (assignment?.resourceId && !assignment.isStale) {
                if (this.providerSatisfiesTask(assignment.resourceId, taskKind, requiredCapabilities)) {
                    return {
                        resourceId: assignment.resourceId,
                        model: assignment.model || this.resolveDefaultModel(assignment.resourceId),
                        resolvedBy: 'user_task_override',
                    };
                }
            }
        }

        // 3. 插件注册任务推荐
        if (taskKey && this.registry) {
            const taskDesc = this.registry.getTaskDescriptor(consumer, taskKey);
            if (taskDesc?.recommendedRoute?.resourceId) {
                if (this.providerSatisfiesTask(taskDesc.recommendedRoute.resourceId, taskKind, requiredCapabilities)) {
                    return {
                        resourceId: taskDesc.recommendedRoute.resourceId,
                        model: this.resolveDefaultModel(taskDesc.recommendedRoute.resourceId),
                        profileId: taskDesc.recommendedRoute.profileId,
                        resolvedBy: 'plugin_task_recommend',
                    };
                }
            }
        }

        // 4. 插件分配
        const pluginAssignment = this.pluginAssignments.get(consumer);
        const pluginEntry = pluginAssignment?.[taskKind] as AssignmentEntry | undefined;
        if (pluginEntry?.resourceId) {
            if (this.providerSatisfiesTask(pluginEntry.resourceId, taskKind, requiredCapabilities)) {
                return {
                    resourceId: pluginEntry.resourceId,
                    model: pluginEntry.model || this.resolveDefaultModel(pluginEntry.resourceId),
                    resolvedBy: 'user_plugin_default',
                };
            }
        }

        // 5. 全局分配
        const globalEntry = this.globalAssignments[taskKind] as AssignmentEntry | undefined;
        if (globalEntry?.resourceId) {
            if (this.providerSatisfiesTask(globalEntry.resourceId, taskKind, requiredCapabilities)) {
                return {
                    resourceId: globalEntry.resourceId,
                    model: globalEntry.model || this.resolveDefaultModel(globalEntry.resourceId),
                    resolvedBy: 'user_global_default',
                };
            }
        }

        // 6. 酒馆模式只允许内置酒馆；自定义模式会在这里跳过。
        if (taskKind === 'generation' && this.generationSource === 'tavern') {
            if (this.providers.has(BUILTIN_TAVERN_RESOURCE_ID)) {
                if (this.providerSatisfiesTask(BUILTIN_TAVERN_RESOURCE_ID, taskKind, requiredCapabilities)) {
                    return {
                        resourceId: BUILTIN_TAVERN_RESOURCE_ID,
                        model: this.resolveDefaultModel(BUILTIN_TAVERN_RESOURCE_ID),
                        resolvedBy: 'builtin_tavern_fallback',
                    };
                }
            }
        }

        // 7. 终极 fallback: 先找同类型资源
        for (const [rid] of this.providers) {
            const rType = this.resourceTypes.get(rid);
            if (rType === taskKind && this.providerSatisfiesTask(rid, taskKind, requiredCapabilities)) {
                return {
                    resourceId: rid,
                    model: this.resolveDefaultModel(rid),
                    resolvedBy: 'fallback',
                };
            }
        }

        // 8. 跨类型 fallback：允许具备所需能力的资源参与，例如 generation 资源承担 rerank
        for (const [rid] of this.providers) {
            if (this.providerSatisfiesTask(rid, taskKind, requiredCapabilities)) {
                return {
                    resourceId: rid,
                    model: this.resolveDefaultModel(rid),
                    resolvedBy: 'fallback',
                };
            }
        }

        throw new Error(`[TaskRouter] 无法为 consumer="${consumer}" taskKind="${taskKind}" 找到可用资源`);
    }

    // ─── 能力查询 ───

    getProviderCapabilities(resourceId: string): LLMCapability[] {
        return this.providerCapabilities.get(resourceId) || [];
    }

    listProvidersWithCapabilities(required?: LLMCapability[]): LLMProvider[] {
        if (!required || required.length === 0) {
            return Array.from(this.providers.values());
        }
        return Array.from(this.providers.values()).filter(p =>
            this.providerSatisfies(p.id, required),
        );
    }

    getAllProviders(): LLMProvider[] {
        return Array.from(this.providers.values());
    }

    getProvider(resourceId: string): LLMProvider | undefined {
        return this.providers.get(resourceId);
    }

    getResourceType(resourceId: string): ResourceType | undefined {
        return this.resourceTypes.get(resourceId);
    }

    // ─── 内部方法 ───

    private providerSatisfies(resourceId: string, required?: LLMCapability[]): boolean {
        if (!required || required.length === 0) return true;
        const caps = this.providerCapabilities.get(resourceId);
        if (!caps) return false;
        return required.every(c => caps.includes(c));
    }

    private providerSatisfiesTask(resourceId: string, taskKind: CapabilityKind, required?: LLMCapability[]): boolean {
        const tavern = resourceId === BUILTIN_TAVERN_RESOURCE_ID;
        if (taskKind === 'generation') {
            if (this.generationSource === 'tavern' ? !tavern : tavern) return false;
        } else if (tavern) {
            return false;
        }
        return this.providerSatisfies(resourceId, required);
    }

    private resolveDefaultModel(resourceId: string): string | undefined {
        return this.providerDefaultModels.get(resourceId);
    }
}
