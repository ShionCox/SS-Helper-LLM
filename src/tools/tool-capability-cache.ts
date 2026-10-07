import type { VerifiedToolCapabilities } from '@ss-helper/sdk';
import type { LLMHubSettings, ResourceConfig } from '../schema/types';
import { DEFAULT_LLM_SETTINGS } from '../schema/defaults';
import { DEFAULT_REASONING_POLICY } from '../providers/reasoning-policy';
import { providerManifest } from '../providers/provider-manifest';

export interface ToolCapabilityCacheKeyInput {
    readonly resourceId: string;
    readonly endpointDigest: string;
    readonly apiType: string;
    readonly model: string;
    readonly adapterVersion: number;
    readonly toolSchemaProfile: 'ss_helper_tool_v0';
    readonly probeVersion: number;
    readonly reasoningMode?: 'provider_default' | 'enabled' | 'disabled';
    readonly reasoningEffort?: 'provider_default' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export const TOOL_CAPABILITY_SUCCESS_TTL_MS = 24 * 60 * 60 * 1_000;
export const TOOL_CAPABILITY_FAILURE_TTL_MS = 10 * 60 * 1_000;

export function stableToolDigest(value: string): string {
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(value)) {
        hash ^= BigInt(byte);
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

export function endpointDigest(value: string | undefined): string {
    return stableToolDigest(String(value ?? '').trim().toLocaleLowerCase());
}

/** Connection identity survives reloads and excludes display-only resource names. */
export function resourceConnectionDigest(resource: ResourceConfig, streamingEnabled = DEFAULT_LLM_SETTINGS.streamingEnabled): string {
    return stableToolDigest(JSON.stringify({
        source: resource.source, type: resource.type, apiType: resource.apiType,
        baseUrl: resource.baseUrl, model: resource.model, enabled: resource.enabled !== false,
        toolDialect: resource.toolDialect ?? providerManifest(resource.apiType).protocol,
        customParams: resource.customParams, privacyPolicy: resource.privacyPolicy,
        embeddingPath: resource.embeddingPath, embeddingDimensions: resource.embeddingDimensions,
        rerankPath: resource.rerankPath, rerankProtocol: resource.rerankProtocol, streamingEnabled,
    }));
}

export function invalidatedResourceIds(previous: LLMHubSettings, next: LLMHubSettings, credentialChanges: readonly string[] = []): Set<string> {
    const ids = new Set(credentialChanges);
    const nextById = new Map((next.resources ?? []).map(resource => [resource.id, resource]));
    for (const resource of previous.resources ?? []) {
        const updated = nextById.get(resource.id);
        if (!updated || resourceConnectionDigest(resource, previous.streamingEnabled) !== resourceConnectionDigest(updated, next.streamingEnabled)) ids.add(resource.id);
    }
    for (const id of new Set([...Object.keys(previous.resourcePolicies ?? {}), ...Object.keys(next.resourcePolicies ?? {})])) {
        const before = previous.resourcePolicies?.[id] ?? DEFAULT_REASONING_POLICY;
        const after = next.resourcePolicies?.[id] ?? DEFAULT_REASONING_POLICY;
        if (before.mode !== after.mode || before.effort !== after.effort) ids.add(id);
    }
    return ids;
}

export function capabilityCacheKey(input: ToolCapabilityCacheKeyInput): string {
    return stableToolDigest([
        input.resourceId, input.endpointDigest, input.apiType, input.model,
        input.adapterVersion, input.toolSchemaProfile, input.probeVersion, input.reasoningMode ?? 'provider_default', input.reasoningEffort ?? 'provider_default',
    ].join('\0'));
}

export class ToolCapabilityCache {
    private readonly snapshots = new Map<string, VerifiedToolCapabilities>();

    get(key: string, now = Date.now()): VerifiedToolCapabilities | undefined {
        const snapshot = this.snapshots.get(key);
        if (!snapshot) return undefined;
        if (snapshot.expiresAt !== undefined && snapshot.expiresAt <= now) return undefined;
        return snapshot;
    }

    peek(key: string): VerifiedToolCapabilities | undefined { return this.snapshots.get(key); }

    set(key: string, value: VerifiedToolCapabilities): VerifiedToolCapabilities {
        const frozen = Object.freeze({ ...value });
        this.snapshots.set(key, frozen);
        return frozen;
    }

    invalidateResource(resourceId: string): void {
        for (const [key, value] of this.snapshots) if (value.resourceId === resourceId) this.snapshots.delete(key);
    }

    clear(): void { this.snapshots.clear(); }
}
