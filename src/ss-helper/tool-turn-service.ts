import {
    createSSHelperError,
    readSSHelperFailure,
    type LlmMessage,
    type LlmToolTurnRequest,
    type LlmToolTurnResponse,
    type LlmStructuredItemRejection,
    type LlmStructuredValidationIssue,
    type LlmReasoningPolicy,
    type PlainData,
    type ProviderPrivacyPolicy,
    type VerifiedToolCapabilities,
} from '@ss-helper/sdk';
import type { ResourceConfig } from '../schema/types';
import { TaskRouter } from '../router/router';
import { isToolCapableProvider } from '../tools/tool-adapter';
import { normalizeProviderPrivacyPolicy } from '../tools/provider-privacy-policy';
import { ToolCapabilityProbe, TOOL_CAPABILITY_PROBE_VERSION } from '../tools/tool-capability-probe';
import { ToolCapabilityCache, capabilityCacheKey, endpointDigest } from '../tools/tool-capability-cache';
import { ToolSchemaCompiler } from '../tools/tool-schema-compiler';
import { ToolSessionManager, type ManagedToolStep, type ToolSessionScope } from '../tools/tool-session-manager';
import { validateJsonSchema, validateJsonSchemaItemized } from '../schema/json-schema-validator';
import { buildStructuredOutputSystemInstruction } from '../schema/structured-output';
import { RequestLogService } from '../log/requestLogService';
import { RequestRateLimiter } from '../runtime/request-rate-limiter';
import { DEFAULT_REASONING_POLICY } from '../providers/reasoning-policy';

interface ToolCapabilityVerification { readonly capability: VerifiedToolCapabilities; }

export interface ToolTurnResourceResolver {
    getResource(resourceId: string): ResourceConfig | undefined;
    getStreamingEnabled?(): boolean;
    getReasoningPolicy?(resourceId: string): LlmReasoningPolicy | undefined;
    getReasoningCapabilityDigest?(resourceId: string, model?: string): string | undefined;
}

export interface ToolCapabilityStore {
    listToolCapabilities(): Promise<readonly { readonly cacheKey: string; readonly capability: VerifiedToolCapabilities }[]>;
    saveToolCapability(cacheKey: string, value: VerifiedToolCapabilities): Promise<unknown>;
    deleteToolCapabilitiesForResource(resourceId: string): Promise<number>;
}

export type ToolTurnMaxTokensResolver = (
    request: LlmToolTurnRequest,
    callerPluginId: string,
    profileId?: string,
) => number;

export class LlmToolTurnService {
    private readonly compiler = new ToolSchemaCompiler();
    private readonly probe = new ToolCapabilityProbe();
    private readonly cache = new ToolCapabilityCache();
    private readonly sessions = new ToolSessionManager();
    private hydration: Promise<void> | undefined;
    private hydrated = false;
    private readonly resourceEpochs = new Map<string, number>();

    constructor(
        private readonly router: TaskRouter,
        private readonly resources: ToolTurnResourceResolver,
        private readonly resolveMaxTokens: ToolTurnMaxTokensResolver,
        private readonly store?: ToolCapabilityStore,
        private readonly requestLogs?: RequestLogService,
        private readonly describeTask: (pluginId: string, taskKey: string) => { readonly consumerDisplayName?: string; readonly taskDescription: string } = (_pluginId, taskKey) => ({ taskDescription: taskKey }),
        private readonly requestRateLimiter: RequestRateLimiter = new RequestRateLimiter(),
    ) {
        void this.ensureHydrated();
    }

    async verify(resourceId: string, model: string | undefined, force: boolean, requestId: string, signal: AbortSignal, reasoning?: LlmReasoningPolicy): Promise<ToolCapabilityVerification> {
        await this.ensureHydrated();
        const resolved = this.resolveProvider(resourceId, model);
        const activeReasoning = reasoning ?? this.resources.getReasoningPolicy?.(resourceId) ?? DEFAULT_REASONING_POLICY;
        const key = this.cacheKey(resolved.resource, resolved.model, resolved.adapter.version, activeReasoning);
        const cached = force ? undefined : this.cache.get(key);
        if (cached) return { capability: cached };
        const epoch = this.resourceEpochs.get(resourceId) ?? 0;
        const capability = await this.probe.verify({
            resourceId,
            model: resolved.model,
            requestId,
            adapter: resolved.adapter,
            privacyPolicy: resolved.privacyPolicy,
            signal,
            beforeRequest: () => this.requestRateLimiter.acquire(signal),
            reasoning: activeReasoning,
        });
        if (epoch !== (this.resourceEpochs.get(resourceId) ?? 0)) {
            await this.store?.deleteToolCapabilitiesForResource(resourceId).catch(() => undefined);
            throw createSSHelperError('LLM_TOOL_CAPABILITY_UNVERIFIED', { stage: 'llm.tools.capability_probe.stale', requestId, resourceId, model: resolved.model });
        }
        if (this.store !== undefined) {
            try {
                await this.store.saveToolCapability(key, capability);
            } catch (error) {
                this.cache.invalidateResource(resourceId);
                await this.store.deleteToolCapabilitiesForResource(resourceId).catch(() => undefined);
                throw error;
            }
        }
        if (epoch !== (this.resourceEpochs.get(resourceId) ?? 0)) {
            await this.store?.deleteToolCapabilitiesForResource(resourceId).catch(() => undefined);
            throw createSSHelperError('LLM_TOOL_CAPABILITY_UNVERIFIED', { stage: 'llm.tools.capability_probe.stale', requestId, resourceId, model: resolved.model });
        }
        return { capability: this.cache.set(key, capability) };
    }

    async getCapability(resourceId: string, model?: string, includeExpired = false): Promise<VerifiedToolCapabilities | undefined> {
        await this.ensureHydrated();
        const provider = this.router.getProvider(resourceId);
        if (!provider || !isToolCapableProvider(provider)) return undefined;
        let adapter;
        try { adapter = provider.createToolAdapter(); } catch { return undefined; }
        const resource = this.resources.getResource(resourceId);
        const resolvedModel = model ?? resource?.model ?? this.router.getDefaultModel(resourceId);
        if (!resource || !resolvedModel) return undefined;
        const key = this.cacheKey(resource, resolvedModel, adapter.version, this.resources.getReasoningPolicy?.(resourceId) ?? DEFAULT_REASONING_POLICY);
        return includeExpired ? this.cache.peek(key) : this.cache.get(key);
    }

    async turn(request: LlmToolTurnRequest, callerPluginId: string, requestId: string, signal: AbortSignal): Promise<LlmToolTurnResponse> {
        const startedAt = Date.now();
        const description = this.describeTask(callerPluginId, request.task);
        const toolSessionRound = request.toolSessionId
            ? (this.sessions.getRound(request.toolSessionId) ?? 1) + 1
            : 1;
        let completedResponse: LlmToolTurnResponse | undefined;
        let parsedResponse: PlainData | undefined;
        let validationIssues: Array<{ path: string; keyword: string; expected: string }> | undefined;
        try {
            const prepared = request.toolSessionId
                ? await this.continueTurn(request, callerPluginId, requestId, signal)
                : await this.startTurn(request, callerPluginId, requestId, signal);
            const response = prepared.response;
            completedResponse = response;
            if (response.state === 'final') {
                parsedResponse = response.output;
                validationIssues = prepared.validationIssues;
                const partialValidation = request.validationMode === 'itemized_partial' || response.itemRejections !== undefined;
                if (validationIssues?.length && !partialValidation) {
                    const issue = validationIssues[0];
                    throw createSSHelperError('SCHEMA_VALIDATION_FAILED', {
                        stage: 'llm.tools.turn.final_validate', requestId,
                        resourceId: response.route.resourceId,
                        model: response.route.model,
                        path: issue.path, keyword: issue.keyword, expected: issue.expected,
                    });
                }
            }
            const resourceId = response.route.resourceId;
            const resource = resourceId === undefined ? undefined : this.resources.getResource(resourceId);
            await this.requestLogs?.recordAgentTurn({
                request,
                response,
                ...(parsedResponse === undefined ? {} : { parsedResponse }),
                callerPluginId,
                consumerDisplayName: description.consumerDisplayName,
                taskDescription: description.taskDescription,
                requestId,
                route: resource && (response.route.model ?? resource.model) ? this.routeSnapshot(resource, (response.route.model ?? resource.model)!) : {
                    resourceId: resourceId ?? 'unknown',
                    resourceLabel: resourceId ?? 'unknown',
                    model: response.route.model,
                    providerKind: response.route.provider,
                },
                startedAt,
            });
            return response;
        } catch (error) {
            const mappedError = readSSHelperFailure(error) === undefined && signal.aborted
                ? createSSHelperError('REQUEST_ABORTED', { stage: 'llm.tools.turn', requestId })
                : error;
            const responseDebug = mappedError as Error & {
                readonly rawResponseText?: string;
                readonly providerResponse?: unknown;
            };
            const failure = readSSHelperFailure(mappedError, {
                reasonCode: 'INTERNAL_ERROR',
                stage: 'llm.tools.turn',
                requestId,
            })!;
            const usage = completedResponse?.usage;
            const errorWithUsage = usage === undefined ? mappedError : createSSHelperError(failure.reasonCode, {
                ...failure,
                ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
                ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
                ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
            });
            const resource = failure.resourceId ? this.resources.getResource(failure.resourceId) : undefined;
            await this.requestLogs?.recordAgentTurn({
                request,
                failure,
                ...(completedResponse ? { response: completedResponse } : {}),
                ...(parsedResponse === undefined ? {} : { parsedResponse }),
                ...(validationIssues?.length ? { validationIssues } : {}),
                ...(typeof responseDebug.rawResponseText === 'string' ? { rawResponseText: responseDebug.rawResponseText } : {}),
                ...(responseDebug.providerResponse === undefined ? {} : { providerResponse: responseDebug.providerResponse }),
                callerPluginId,
                consumerDisplayName: description.consumerDisplayName,
                taskDescription: description.taskDescription,
                requestId,
                toolSessionRound,
                ...(failure.resourceId ? { route: resource && failure.model
                    ? this.routeSnapshot(resource, failure.model)
                    : {
                        resourceId: failure.resourceId,
                        resourceLabel: resource?.label ?? failure.resourceId,
                        model: failure.model,
                        providerKind: resource?.apiType,
                    } } : {}),
                startedAt,
            }).catch(() => undefined);
            throw errorWithUsage;
        }
    }

    private routeSnapshot(resource: ResourceConfig, model: string) {
        let endpointOrigin: string | undefined;
        let endpointPath: string | undefined;
        let queryParameterNames: string[] | undefined;
        if (resource.baseUrl) {
            try {
                const endpoint = new URL(resource.baseUrl);
                endpointOrigin = endpoint.origin;
                queryParameterNames = [...new Set(endpoint.searchParams.keys())].sort();
                const operation = resource.toolDialect === 'openai_responses' ? '/responses'
                    : resource.toolDialect === 'anthropic_messages' ? '/messages'
                        : resource.toolDialect === 'gemini_interactions' ? '/interactions'
                            : '/chat/completions';
                const basePath = (endpoint.pathname || '/').replace(/\/+$/u, '');
                endpointPath = basePath.endsWith(operation) ? basePath : `${basePath}${operation}`;
            } catch {
                endpointPath = String(resource.baseUrl).split(/[?#]/u, 1)[0];
            }
        }
        return {
            resourceId: resource.id,
            resourceLabel: resource.label,
            model,
            providerKind: resource.apiType,
            apiType: resource.apiType,
            ...(endpointOrigin ? { endpointOrigin } : {}),
            ...(endpointPath ? { endpointPath } : {}),
            ...(queryParameterNames?.length ? { queryParameterNames } : {}),
            ...(resource.customParams ? { customParameterNames: Object.keys(resource.customParams).sort() } : {}),
            streaming: this.resources.getStreamingEnabled?.() !== false,
        } as const;
    }

    private async startTurn(request: LlmToolTurnRequest, callerPluginId: string, requestId: string, signal: AbortSignal): Promise<{ response: LlmToolTurnResponse; validationIssues?: Array<{ path: string; keyword: string; expected: string }> }> {
        const route = this.router.resolveRoute({
            consumer: callerPluginId,
            taskKind: 'generation',
            execution: 'tool_turn',
            taskKey: request.task,
            requiredCapabilities: ['chat', 'tools'],
        });
        const resolved = this.resolveProvider(route.resourceId, route.model);
        const capability = await this.getCapability(route.resourceId, resolved.model);
        if (!capability || capability.status !== 'verified' || (capability.expiresAt !== undefined && capability.expiresAt <= Date.now())) {
            throw createSSHelperError('LLM_TOOL_CAPABILITY_UNVERIFIED', {
                stage: 'llm.tools.turn.start', requestId, resourceId: route.resourceId, model: resolved.model,
            });
        }
        const tools = this.compiler.compile(request.tools ?? [], resolved.adapter.dialect);
        const outputSchema = request.outputSchema as PlainData;
        const messages = this.withOutputSchemaInstruction(
            this.readMessages(request.input),
            buildStructuredOutputSystemInstruction({
                schema: outputSchema as object,
                name: request.task,
            }),
        );
        await this.requestLogs?.recordAgentTurn({
            phase: 'started', request, callerPluginId,
            ...this.describeTask(callerPluginId, request.task), requestId,
            route: this.routeSnapshot(resolved.resource, resolved.model),
            toolSessionRound: 1, startedAt: Date.now(),
        });
        await this.requestRateLimiter.acquire(signal, requestId);
        const managed = await this.sessions.start({
            callerPluginId,
            taskKey: request.task,
            pipelineRunId: request.pipelineRunId,
            chatKey: request.chatKey,
            resourceId: route.resourceId,
            model: resolved.model,
            adapter: resolved.adapter,
            capability,
            messages,
            tools,
            outputSchema,
            privacyPolicy: resolved.privacyPolicy,
            reasoning: this.resources.getReasoningPolicy?.(route.resourceId) ?? DEFAULT_REASONING_POLICY,
            maxTokens: this.resolveMaxTokens(request, callerPluginId),
            ...(request.validationMode === undefined ? {} : { validationMode: request.validationMode }),
            ...(request.validationCollections === undefined ? {} : { validationCollections: request.validationCollections }),
            signal,
        });
        return this.toResponse(managed, requestId, request.parentRequestId, resolved.resource, resolved.model);
    }

    cancel(toolSessionId: string, callerPluginId: string): boolean {
        const scope = this.sessions.getScope(toolSessionId);
        if (!scope) return false;
        if (scope.callerPluginId !== callerPluginId) throw createSSHelperError('LLM_TOOL_SESSION_SCOPE_MISMATCH', { stage: 'llm.tools.turn.cancel' });
        return this.sessions.cancel(toolSessionId);
    }
    invalidateResource(resourceId: string): void {
        this.resourceEpochs.set(resourceId, (this.resourceEpochs.get(resourceId) ?? 0) + 1);
        this.cache.invalidateResource(resourceId);
        void this.store?.deleteToolCapabilitiesForResource(resourceId).catch(() => undefined);
        this.sessions.cancelByResource(resourceId);
    }
    dispose(): void { for (const resourceId of this.resourceEpochs.keys()) this.resourceEpochs.set(resourceId, (this.resourceEpochs.get(resourceId) ?? 0) + 1); this.sessions.dispose(); this.cache.clear(); }

    private async ensureHydrated(): Promise<void> {
        if (this.hydrated || this.store === undefined) {
            this.hydrated = true;
            return;
        }
        if (this.hydration === undefined) {
            const operation = this.store.listToolCapabilities().then((records) => {
                for (const record of records) this.cache.set(record.cacheKey, record.capability);
                this.hydrated = true;
            }).finally(() => {
                if (this.hydration === operation) this.hydration = undefined;
            });
            this.hydration = operation;
        }
        await this.hydration.catch(() => undefined);
    }

    private async continueTurn(request: LlmToolTurnRequest, callerPluginId: string, requestId: string, signal: AbortSignal): Promise<{ response: LlmToolTurnResponse; validationIssues?: Array<{ path: string; keyword: string; expected: string }> }> {
        const toolSessionId = request.toolSessionId!;
        const active = this.sessions.getScope(toolSessionId);
        if (!active) throw createSSHelperError('LLM_TOOL_SESSION_EXPIRED', { stage: 'llm.tools.turn.continue', requestId });
        const scope: ToolSessionScope = {
            callerPluginId,
            taskKey: request.task,
            pipelineRunId: request.pipelineRunId,
            chatKey: request.chatKey,
            resourceId: active.resourceId,
            model: active.model,
        };
        const resource = this.resources.getResource(active.resourceId);
        if (!resource) throw createSSHelperError('LLM_TOOL_SESSION_EXPIRED', { stage: 'llm.tools.turn.continue', requestId, resourceId: active.resourceId, model: active.model });
        if (resource) {
            await this.requestLogs?.recordAgentTurn({
                phase: 'started', request, callerPluginId,
                ...this.describeTask(callerPluginId, request.task), requestId,
                route: this.routeSnapshot(resource, active.model),
                toolSessionRound: (this.sessions.getRound(toolSessionId) ?? 1) + 1,
                startedAt: Date.now(),
            });
        }
        await this.requestRateLimiter.acquire(signal, requestId);
        const managed = await this.sessions.continue(toolSessionId, scope, request.toolResults ?? [], signal);
        return this.toResponse(managed, requestId, request.parentRequestId, resource, active.model);
    }

    private toResponse(managed: ManagedToolStep, requestId: string, parentRequestId: string | undefined, resource: ResourceConfig, model: string): { response: LlmToolTurnResponse; validationIssues?: Array<{ path: string; keyword: string; expected: string }> } {
        const diagnostics = {
            toolSessionRound: managed.round,
            totalCalls: managed.totalCalls,
            toolSchemaProfile: 'ss_helper_tool_v0' as const,
            providerAdapterVersion: 1,
            capabilitySnapshotId: managed.capabilitySnapshotId,
        };
        const route = {
            resourceId: resource.id,
            source: resource.source,
            provider: resource.apiType,
            model,
            execution: 'tool_turn' as const,
            transport: 'tool_call',
            capabilityDigest: this.resources.getReasoningCapabilityDigest?.(resource.id, model) ?? managed.capabilitySnapshotId,
            ...(managed.reasoningPolicy === undefined ? {} : { reasoning: managed.reasoningPolicy }),
        };
        const usage = managed.step.usage;
        if (managed.step.state === 'tool_calls') return { response: {
            requestId, ...(parentRequestId ? { parentRequestId } : {}), state: 'tool_calls',
            toolSessionId: managed.toolSessionId!, calls: managed.step.calls, route, diagnostics,
            ...(usage ? { usage } : {}),
        } };
        const itemizedValidation = managed.outputSchema && managed.validationMode === 'itemized_partial'
            ? validateJsonSchemaItemized(managed.step.output, managed.outputSchema as object, managed.validationCollections ?? [])
            : undefined;
        const validation = itemizedValidation
            ?? (managed.outputSchema ? validateJsonSchema(managed.step.output, managed.outputSchema as object) : { valid: true as const });
        const itemRejections: readonly LlmStructuredItemRejection[] = itemizedValidation?.valid
            ? itemizedValidation.rejections.map(item => ({
                collection: item.collection,
                itemIndex: item.itemIndex,
                issues: item.issues.map(issue => ({ path: issue.path, keyword: issue.keyword, expected: issue.expected })),
                sourceRefs: [...item.sourceRefs],
            }))
            : [];
        const validationIssues: readonly LlmStructuredValidationIssue[] = itemizedValidation?.valid
            ? itemRejections.flatMap(item => item.issues)
            : validation.valid
                ? []
                : validation.issues.map(issue => ({ path: issue.path, keyword: issue.keyword, expected: issue.expected }));
        const output = itemizedValidation?.valid ? itemizedValidation.value as PlainData : managed.step.output;
        return {
            response: {
                requestId, ...(parentRequestId ? { parentRequestId } : {}), state: 'final',
                output, route, diagnostics, ...(usage ? { usage } : {}),
                ...(validationIssues.length ? { validationIssues } : {}),
                ...(itemRejections.length ? { itemRejections } : {}),
            },
            ...(validationIssues.length ? { validationIssues: [...validationIssues] } : {}),
        };
    }

    private resolveProvider(resourceId: string, model?: string): { resource: ResourceConfig; model: string; privacyPolicy: ProviderPrivacyPolicy; adapter: ReturnType<NonNullable<import('../providers/types').LLMProvider['createToolAdapter']>> } {
        const provider = this.router.getProvider(resourceId);
        const resource = this.resources.getResource(resourceId);
        const resolvedModel = model ?? resource?.model ?? this.router.getDefaultModel(resourceId);
        if (!provider || !resource || !resolvedModel || !isToolCapableProvider(provider)) {
            throw createSSHelperError('LLM_TOOL_CALLS_UNSUPPORTED', {
                stage: 'llm.tools.provider.resolve', resourceId, ...(resolvedModel ? { model: resolvedModel } : {}),
            });
        }
        return { resource, model: resolvedModel, privacyPolicy: normalizeProviderPrivacyPolicy(resource.privacyPolicy), adapter: provider.createToolAdapter() };
    }

    private cacheKey(resource: ResourceConfig, model: string, adapterVersion: number, reasoning: LlmReasoningPolicy): string {
        return capabilityCacheKey({
            resourceId: resource.id,
            endpointDigest: endpointDigest(resource.baseUrl),
            apiType: resource.apiType,
            model,
            adapterVersion,
            toolSchemaProfile: 'ss_helper_tool_v0',
            probeVersion: TOOL_CAPABILITY_PROBE_VERSION,
            reasoningMode: reasoning.mode,
            reasoningEffort: reasoning.effort,
        });
    }

    private readMessages(input: PlainData | undefined): readonly LlmMessage[] {
        const value = input as Record<string, unknown> | undefined;
        if (value && Array.isArray(value.messages) && value.messages.length > 0) {
            const messages: LlmMessage[] = value.messages.map((item) => {
                if (typeof item !== 'object' || item === null || Array.isArray(item)) throw createSSHelperError('LLM_REQUEST_INVALID', { stage: 'llm.tools.messages' });
                const record = item as Record<string, unknown>;
                if (!['system', 'user', 'assistant'].includes(String(record.role)) || typeof record.content !== 'string') throw createSSHelperError('LLM_REQUEST_INVALID', { stage: 'llm.tools.messages' });
                return { role: record.role as LlmMessage['role'], content: record.content };
            });
            return messages;
        }
        return [{ role: 'user', content: JSON.stringify(input ?? {}) }];
    }

    private withOutputSchemaInstruction(messages: readonly LlmMessage[], instruction: string): readonly LlmMessage[] {
        const [first, ...rest] = messages;
        if (first?.role === 'system') {
            return [{ ...first, content: `${first.content}\n\n${instruction}` }, ...rest];
        }
        return [{ role: 'system', content: instruction }, ...messages];
    }
}
