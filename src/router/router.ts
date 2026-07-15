import type { LLMProvider } from '../providers/types';
import type {
    RouteResolveArgs,
    RouteResolveResult,
    LLMCapability,
    CapabilityKind,
    ResourceType,
    GlobalAssignments,
    AssignmentEntry,
    PluginAssignment,
    TaskAssignment,
} from '../schema/types';
import type { ConsumerRegistry } from '../registry/consumer-registry';

/** 内置酒馆资源固定 ID */
export const BUILTIN_TAVERN_RESOURCE_ID = '__builtin_tavern__';

/**
 * 资源感知任务路由器
 *
 * 路由优先级：
 *   routeHint → 任务分配 → 插件注册推荐 → 插件分配 → 全局分配 → 内置酒馆(仅生成) → fallback
 */
export class TaskRouter {
    private providers: Map<string, LLMProvider> = new Map();
    private providerCapabilities: Map<string, LLMCapability[]> = new Map();
    private providerDefaultModels: Map<string, string | undefined> = new Map();
    private resourceTypes: Map<string, ResourceType> = new Map();

    private globalAssignments: GlobalAssignments = {};
    private pluginAssignments: Map<string, PluginAssignment> = new Map();
    private taskAssignments: Map<string, TaskAssignment> = new Map();

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

    // ─── 分配设置管理 ───

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
            if (this.providerSatisfies(routeHint.resourceId, requiredCapabilities)) {
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
                if (this.providerSatisfies(assignment.resourceId, requiredCapabilities)) {
                    return {
                        resourceId: assignment.resourceId,
                        model: this.resolveDefaultModel(assignment.resourceId),
                        resolvedBy: 'user_task_override',
                    };
                }
            }
        }

        // 3. 插件注册任务推荐
        if (taskKey && this.registry) {
            const taskDesc = this.registry.getTaskDescriptor(consumer, taskKey);
            if (taskDesc?.recommendedRoute?.resourceId) {
                if (this.providerSatisfies(taskDesc.recommendedRoute.resourceId, requiredCapabilities)) {
                    return {
                        resourceId: taskDesc.recommendedRoute.resourceId,
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
            if (this.providerSatisfies(pluginEntry.resourceId, requiredCapabilities)) {
                return {
                    resourceId: pluginEntry.resourceId,
                    model: this.resolveDefaultModel(pluginEntry.resourceId),
                    resolvedBy: 'user_plugin_default',
                };
            }
        }

        // 5. 全局分配
        const globalEntry = this.globalAssignments[taskKind] as AssignmentEntry | undefined;
        if (globalEntry?.resourceId) {
            if (this.providerSatisfies(globalEntry.resourceId, requiredCapabilities)) {
                return {
                    resourceId: globalEntry.resourceId,
                    model: this.resolveDefaultModel(globalEntry.resourceId),
                    resolvedBy: 'user_global_default',
                };
            }
        }

        // 6. 内置酒馆回退（仅生成类）
        if (taskKind === 'generation') {
            if (this.providers.has(BUILTIN_TAVERN_RESOURCE_ID)) {
                if (this.providerSatisfies(BUILTIN_TAVERN_RESOURCE_ID, requiredCapabilities)) {
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
            if (rType === taskKind && this.providerSatisfies(rid, requiredCapabilities)) {
                return {
                    resourceId: rid,
                    model: this.resolveDefaultModel(rid),
                    resolvedBy: 'fallback',
                };
            }
        }

        // 8. 跨类型 fallback：允许具备所需能力的资源参与，例如 generation 资源承担 rerank
        for (const [rid] of this.providers) {
            if (this.providerSatisfies(rid, requiredCapabilities)) {
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

    private resolveDefaultModel(resourceId: string): string | undefined {
        return this.providerDefaultModels.get(resourceId);
    }
}
