import { getActiveLlmStorage, type LlmCredentialRecord } from '../storage/database';

interface StoredCredentialPayload {
    apiKey?: string;
    key?: string;
    createdAt?: number;
}

export class VaultManager {
    private static readonly OBFUSCATION_PREFIX = 'stx_v1_';
    private readonly cache = new Map<string, string>();

    private async table() {
        const result = await getActiveLlmStorage();
        return result.cutover
            ? result.database.llm_credentials
            : result.fallbackDatabase!.table<LlmCredentialRecord, string>('llm_credentials');
    }

    async setCredential(resourceId: string, apiKey: string): Promise<void> {
        const table = await this.table();
        const existing = await table.get(resourceId);
        const now = Date.now();
        await table.put({
            providerId: resourceId,
            updatedAt: now,
            apiKeyMasked: this.maskApiKey(apiKey),
            payload: { apiKey: this.obfuscate(apiKey), createdAt: this.readCreatedAt(existing) ?? now },
        });
        this.cache.set(resourceId, apiKey);
    }

    async getCredential(resourceId: string): Promise<string | null> {
        const cached = this.cache.get(resourceId);
        if (cached) return cached;
        const entry = await (await this.table()).get(resourceId);
        if (!entry) return null;
        const apiKey = this.readStoredApiKey(entry);
        if (apiKey) this.cache.set(resourceId, apiKey);
        return apiKey;
    }

    async removeCredential(resourceId: string): Promise<void> {
        await (await this.table()).delete(resourceId);
        this.cache.delete(resourceId);
    }

    async listResourceIds(): Promise<string[]> {
        return (await (await this.table()).toCollection().primaryKeys()) as string[];
    }

    async hasCredential(resourceId: string): Promise<boolean> {
        return (await this.getCredential(resourceId)) !== null;
    }

    private obfuscate(plain: string): string {
        return VaultManager.OBFUSCATION_PREFIX + btoa(encodeURIComponent(plain));
    }

    private readCreatedAt(entry: LlmCredentialRecord | undefined): number | undefined {
        const payload = (entry?.payload ?? {}) as StoredCredentialPayload;
        return typeof payload.createdAt === 'number' ? payload.createdAt : undefined;
    }

    private readStoredApiKey(entry: LlmCredentialRecord): string | null {
        const payload = entry.payload as StoredCredentialPayload;
        const storedValue = String(payload.apiKey ?? payload.key ?? '').trim();
        return storedValue ? this.deobfuscate(storedValue) : null;
    }

    private maskApiKey(apiKey: string): string {
        const normalized = String(apiKey ?? '').trim();
        if (!normalized) return '';
        if (normalized.length <= 8) return `${normalized.slice(0, 2)}***${normalized.slice(-2)}`;
        return `${normalized.slice(0, 4)}***${normalized.slice(-4)}`;
    }

    private deobfuscate(obfuscated: string): string {
        if (!obfuscated.startsWith(VaultManager.OBFUSCATION_PREFIX)) return obfuscated;
        return decodeURIComponent(atob(obfuscated.slice(VaultManager.OBFUSCATION_PREFIX.length)));
    }
}
