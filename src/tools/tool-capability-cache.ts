import type { ProviderToolDialect, VerifiedToolCapabilities } from '@ss-helper/sdk';

export interface ToolCapabilityCacheKeyInput {
    readonly resourceId: string;
    readonly endpointDigest: string;
    readonly apiType: string;
    readonly model: string;
    readonly adapterVersion: number;
    readonly toolSchemaProfile: 'ss_helper_tool_v0';
    readonly probeVersion: number;
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

export function capabilityCacheKey(input: ToolCapabilityCacheKeyInput): string {
    return stableToolDigest([
        input.resourceId, input.endpointDigest, input.apiType, input.model,
        input.adapterVersion, input.toolSchemaProfile, input.probeVersion,
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

export function declaredToolCapability(input: {
    readonly resourceId: string;
    readonly model: string;
    readonly dialect: ProviderToolDialect;
    readonly probeVersion: number;
}): VerifiedToolCapabilities {
    return Object.freeze({
        status: 'declared',
        resourceId: input.resourceId,
        model: input.model,
        dialect: input.dialect,
        parallelToolCalls: false,
        streamingToolCalls: false,
        strictToolSchema: 'none',
        reasoningReplay: input.dialect === 'deepseek_chat' || input.dialect === 'glm_chat' ? 'required' : input.dialect === 'gemini_interactions' || input.dialect === 'openai_responses' ? 'opaque' : 'none',
        probeVersion: input.probeVersion,
    });
}
