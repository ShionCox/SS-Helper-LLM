import type { LLMProvider } from '../providers/types';
import type {
    RouteResolveArgs,
    RouteResolveResult,
    LLMCapability,
    CapabilityKind,
    ResourceType,
    TaskAssignment,
    LLMExecution,
} from '../schema/types';
import type { ConsumerRegistry } from '../registry/consumer-registry';
import { createSSHelperError, type SSHelperReasonCode } from '@ss-helper/sdk';

/** 动态酒馆资源固定 ID；与自定义资源走同一条能力、路由和日志链。 */
export const BUILTIN_TAVERN_RESOURCE_ID = 'tavern:active';

export interface ProviderRegistration {
    readonly provider: LLMProvider;
    readonly resourceType: ResourceType;
    readonly capabilities?: readonly LLMCapability[];
    readonly defaultModel?: string;
}

/**
 * 唯一任务路由器。
 *
 * 路由解析只有两级：显式 task assignment → execution default。
 * 不根据 Provider 名称、URL、模型名或其他同类型资源猜测，也不跨类型
 * fallback；失败必须停在当前资源并返回结构化诊断。
 */
export class TaskRouter {
    private providers = new Map<string, LLMProvider>();
    private providerCapabilities = new Map<string, LLMCapability[]>();
    private providerDefaultModels = new Map<string, string | undefined>();
    private resourceTypes = new Map<string, ResourceType>();
    private executionDefaults = new Map<LLMExecution, string>();
    private taskAssignments = new Map<string, TaskAssignment>();
    private registry: ConsumerRegistry | null = null;
    private executionAvailabilityQuery?: (resourceId: string, execution: LLMExecution) => { readonly available: boolean; readonly reasonCode?: SSHelperReasonCode };

    setRegistry(registry: ConsumerRegistry): void { this.registry = registry; }
    setExecutionAvailabilityQuery(query: (resourceId: string, execution: LLMExecution) => { readonly available: boolean; readonly reasonCode?: SSHelperReasonCode }): void { this.executionAvailabilityQuery = query; }

    registerProvider(provider: LLMProvider, resourceType: ResourceType, capabilities?: readonly LLMCapability[], defaultModel?: string): void {
        this.providers.set(provider.id, provider);
        this.resourceTypes.set(provider.id, resourceType);
        this.providerCapabilities.set(provider.id, capabilities ? [...capabilities] : this.inferCapabilities(provider));
        this.providerDefaultModels.set(provider.id, defaultModel);
    }

    removeProvider(resourceId: string): void {
        this.providers.delete(resourceId);
        this.providerCapabilities.delete(resourceId);
        this.providerDefaultModels.delete(resourceId);
        this.resourceTypes.delete(resourceId);
        for (const [execution, value] of this.executionDefaults) if (value === resourceId) this.executionDefaults.delete(execution);
    }

    replaceManagedProviders(managedIds: readonly string[], registrations: readonly ProviderRegistration[]): void {
        const managed = new Set(managedIds);
        const ids = new Set<string>();
        for (const registration of registrations) {
            const id = registration.provider.id;
            if (ids.has(id)) throw new Error(`重复 Provider: ${id}`);
            if (!managed.has(id) && this.providers.has(id)) throw new Error(`Provider ID 已被占用: ${id}`);
            ids.add(id);
        }
        for (const id of managed) this.removeProvider(id);
        for (const registration of registrations) this.registerProvider(registration.provider, registration.resourceType, registration.capabilities, registration.defaultModel);
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

    /** 设置 execution 默认资源；同一 execution 只保留一个确定资源。 */
    applyExecutionDefaults(defaults: Partial<Record<LLMExecution, string>>): void {
        for (const execution of ['completion', 'structured', 'tool_turn', 'embedding', 'rerank'] as const) {
            const resourceId = defaults[execution];
            if (resourceId === undefined) this.executionDefaults.delete(execution);
            else this.executionDefaults.set(execution, resourceId);
        }
    }

    applyTaskAssignments(assignments: readonly TaskAssignment[]): void {
        this.taskAssignments.clear();
        for (const assignment of assignments) {
            this.taskAssignments.set(`${assignment.pluginId}::${assignment.taskKey}`, { ...assignment });
        }
    }

    getTaskAssignment(pluginId: string, taskKey: string): TaskAssignment | undefined { return this.taskAssignments.get(`${pluginId}::${taskKey}`); }
    getExecutionDefault(execution: LLMExecution): string | undefined { return this.executionDefaults.get(execution); }

    resolveRoute(args: RouteResolveArgs): RouteResolveResult {
        const execution = this.resolveExecution(args);
        const required = [...(args.requiredCapabilities ?? [])];
        const assignment = args.taskKey ? this.taskAssignments.get(`${args.consumer}::${args.taskKey}`) : undefined;
        if (assignment?.resourceId) {
            if (assignment.isStale || !this.providerSatisfiesExecution(assignment.resourceId, execution, required)) {
                throw createSSHelperError('LLM_TASK_ROUTE_UNAVAILABLE', { stage: 'llm.router.task_assignment', resourceId: assignment.resourceId });
            }
            this.assertExecutionAvailable(assignment.resourceId, execution);
            return this.route(assignment.resourceId, 'task_assignment', execution);
        }
        const resourceId = this.executionDefaults.get(execution);
        if (resourceId !== undefined && this.providerSatisfiesExecution(resourceId, execution, required)) {
            this.assertExecutionAvailable(resourceId, execution);
            return this.route(resourceId, 'execution_default', execution);
        }
        throw createSSHelperError('PROVIDER_UNAVAILABLE', { stage: 'llm.router.resolve', ...(resourceId ? { resourceId } : {}) });
    }

    private resolveExecution(args: RouteResolveArgs): LLMExecution {
        if (args.execution) return args.execution;
        if (args.taskKey) {
            const descriptor = this.registry?.getTaskDescriptor(args.consumer, args.taskKey);
            if (descriptor?.execution) return descriptor.execution;
            if (descriptor?.taskKind === 'embedding') return 'embedding';
            if (descriptor?.taskKind === 'rerank') return 'rerank';
            if (descriptor?.requiredCapabilities.includes('tools')) return 'tool_turn';
        }
        if (args.taskKind === 'embedding') return 'embedding';
        if (args.taskKind === 'rerank') return 'rerank';
        return args.requiredCapabilities?.includes('tools') ? 'tool_turn' : 'structured';
    }

    private route(resourceId: string, resolvedBy: 'task_assignment' | 'execution_default', execution: LLMExecution): RouteResolveResult {
        return { resourceId, model: this.resolveDefaultModel(resourceId), resolvedBy };
    }

    private providerSatisfiesExecution(resourceId: string, execution: LLMExecution, required: readonly LLMCapability[]): boolean {
        const type = this.resourceTypes.get(resourceId);
        const expectedType = execution === 'embedding' ? 'embedding' : execution === 'rerank' ? 'rerank' : 'generation';
        if (type !== expectedType) return false;
        const capabilities = this.providerCapabilities.get(resourceId);
        return capabilities !== undefined && required.every((capability) => capabilities.includes(capability));
    }

    private assertExecutionAvailable(resourceId: string, execution: LLMExecution): void {
        const result = this.executionAvailabilityQuery?.(resourceId, execution);
        if (result?.available === false) {
            throw createSSHelperError(result.reasonCode ?? 'LLM_REASONING_CAPABILITY_UNVERIFIED', {
                stage: 'llm.router.reasoning',
                resourceId,
            });
        }
    }

    getProviderCapabilities(resourceId: string): LLMCapability[] { return this.providerCapabilities.get(resourceId) || []; }
    listProvidersWithCapabilities(required?: readonly LLMCapability[]): LLMProvider[] {
        return [...this.providers.values()].filter((provider) => !required || required.every((capability) => this.getProviderCapabilities(provider.id).includes(capability)));
    }
    getAllProviders(): LLMProvider[] { return [...this.providers.values()]; }
    getProvider(resourceId: string): LLMProvider | undefined { return this.providers.get(resourceId); }
    getResourceType(resourceId: string): ResourceType | undefined { return this.resourceTypes.get(resourceId); }
    getDefaultModel(resourceId: string): string | undefined { return this.resolveDefaultModel(resourceId); }
    private resolveDefaultModel(resourceId: string): string | undefined { return this.providerDefaultModels.get(resourceId); }
}
