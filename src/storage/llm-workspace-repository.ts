import type {
    PlainData,
    WorkspacePort,
    WorkspaceSecretMetadata,
} from '@ss-helper/sdk';
import type { LLMHubSettings, ResourceConfig } from '../schema/types';

export const LLM_WORKSPACE_ID = 'llm:global';
export const LLM_WORKSPACE_OWNER = 'ss-helper.llm';

const COLLECTIONS = ['settings', 'resources', 'assignments', 'consumers', 'budgets', 'permissions', 'request-logs', 'audit'] as const;
type PersistedSettings = LLMHubSettings & { detailedLogs?: boolean; timeoutMs?: number; resultDisplay?: 'auto' | 'silent' | 'compact' | 'fullscreen'; };

const asPlain = (value: unknown): PlainData => value as PlainData;

/**
 * Storage boundary for the LLM plugin. The SDK owns SQLite and encryption;
 * this class only maps LLM documents to generic workspace records.
 */
export class LlmWorkspaceRepository {
    private readonly workspace: WorkspacePort;
    private initialized: Promise<void> | undefined;
    private settings: PersistedSettings = { enabled: true, globalProfile: 'balanced', timeoutMs: 60000, resultDisplay: 'auto', detailedLogs: false };
    private settingsVersion: number | undefined;
    private readonly listeners = new Set<(settings: PersistedSettings) => void>();

    constructor(workspace: WorkspacePort) { this.workspace = workspace; }
    async health() { return this.workspace.health(); }

    async ready(): Promise<void> {
        if (!this.initialized) this.initialized = this.initialize();
        return this.initialized;
    }

    private async initialize(): Promise<void> {
        const opened = await this.workspace.open({ workspaceId: LLM_WORKSPACE_ID, create: true, metadata: { owner: LLM_WORKSPACE_OWNER, purpose: 'LLM configuration and runtime state' } });
        await Promise.all(COLLECTIONS.map((name) => this.workspace.defineCollection({ workspaceId: LLM_WORKSPACE_ID, name, indexes: name === 'request-logs' ? ['sourcePluginId', 'state', 'resourceId', 'taskKey', 'createdAt'] : [] })));
        const record = await this.workspace.get({ workspaceId: LLM_WORKSPACE_ID, collection: 'settings', recordId: 'global' });
        if (record) { this.settings = { ...this.settings, ...(record.value as unknown as PersistedSettings) }; this.settingsVersion = record.version; }
        else { this.settingsVersion = undefined; }
        if (!opened) return;
    }

    async loadSettings(): Promise<PersistedSettings> { await this.ready(); return { ...this.settings, resources: this.settings.resources?.map((item) => ({ ...item, customParams: item.customParams ? { ...item.customParams } : undefined })) }; }

    async saveSettings(next: LLMHubSettings & Record<string, unknown>): Promise<PersistedSettings> {
        await this.ready();
        const value = { ...this.settings, ...next } as PersistedSettings;
        let version: number | undefined;
        try {
            const result = await this.workspace.transaction({
                workspaceId: LLM_WORKSPACE_ID,
                idempotencyKey: `settings-save-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                operations: [{ action: 'upsert', collection: 'settings', recordId: 'global', value: asPlain(value), ...(this.settingsVersion === undefined ? {} : { expectedVersion: this.settingsVersion }) }],
            });
            version = result.results[0]?.version;
        } catch (error) {
            if ((error as { code?: string }).code === 'WORKSPACE_CONFLICT') {
                const latest = await this.workspace.get({ workspaceId: LLM_WORKSPACE_ID, collection: 'settings', recordId: 'global' });
                if (latest) { this.settings = { ...this.settings, ...(latest.value as unknown as PersistedSettings) }; this.settingsVersion = latest.version; }
                const conflict = new Error('配置已被其他页面更新，请重新载入最新内容。') as Error & { code?: string }; conflict.code = 'WORKSPACE_CONFLICT'; throw conflict;
            }
            throw error;
        }
        this.settings = value; this.settingsVersion = version;
        this.listeners.forEach((listener) => listener({ ...this.settings }));
        return { ...this.settings };
    }

    async reset(): Promise<PersistedSettings> {
        await this.ready();
        await this.workspace.transaction({
            workspaceId: LLM_WORKSPACE_ID,
            idempotencyKey: `settings-reset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            operations: [{ action: 'delete', collection: 'settings', recordId: 'global', ...(this.settingsVersion === undefined ? {} : { expectedVersion: this.settingsVersion }) }],
        });
        this.settings = { enabled: true, globalProfile: 'balanced', timeoutMs: 60000, resultDisplay: 'auto', detailedLogs: false }; this.settingsVersion = undefined;
        this.listeners.forEach((listener) => listener({ ...this.settings }));
        return { ...this.settings };
    }

    subscribeSettings(listener: (settings: PersistedSettings) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

    async setResourceSecret(resourceId: string, value: string, metadata: PlainData = {}): Promise<WorkspaceSecretMetadata> {
        await this.ready();
        return this.workspace.secretSet({ workspaceId: LLM_WORKSPACE_ID, secretId: `resource:${resourceId}:api-key`, value, metadata });
    }

    async getResourceSecret(resourceId: string): Promise<string | undefined> {
        await this.ready();
        const item = await this.workspace.secretGet({ workspaceId: LLM_WORKSPACE_ID, secretId: `resource:${resourceId}:api-key` });
        return item?.value;
    }

    async deleteResourceSecret(resourceId: string): Promise<boolean> {
        await this.ready();
        return this.workspace.secretDelete({ workspaceId: LLM_WORKSPACE_ID, secretId: `resource:${resourceId}:api-key` });
    }

    async listSecrets(): Promise<readonly WorkspaceSecretMetadata[]> {
        await this.ready(); return this.workspace.secretList({ workspaceId: LLM_WORKSPACE_ID });
    }

    async exportConfig(): Promise<{ archive: PlainData; sha256: string }> {
        await this.ready();
        const result = await this.workspace.exportAll();
        return { archive: result.archive as unknown as PlainData, sha256: result.sha256 };
    }

    async importConfig(archive: PlainData, sha256: string): Promise<void> {
        await this.ready();
        await this.workspace.importAll({ archive: archive as never, sha256 });
        this.settingsVersion = undefined;
        const record = await this.workspace.get({ workspaceId: LLM_WORKSPACE_ID, collection: 'settings', recordId: 'global' });
        this.settings = record ? { ...this.settings, ...(record.value as unknown as PersistedSettings) } : { enabled: true, globalProfile: 'balanced', timeoutMs: 60000, resultDisplay: 'auto', detailedLogs: false };
        this.settingsVersion = record?.version;
        this.listeners.forEach((listener) => listener({ ...this.settings }));
    }

    async clearAll(): Promise<void> {
        await this.ready();
        await this.workspace.clearOwned({ preserveWorkspaceIds: [] });
        // clearOwned removes the workspace itself. Re-open it before the next
        // save so a global reset leaves the plugin immediately usable.
        this.initialized = undefined;
        await this.ready();
        this.settingsVersion = undefined;
        this.settings = { enabled: true, globalProfile: 'balanced', timeoutMs: 60000, resultDisplay: 'auto', detailedLogs: false };
        this.listeners.forEach((listener) => listener({ ...this.settings }));
    }

    async saveLog(entry: PlainData): Promise<void> {
        await this.ready();
        const settings = await this.loadSettings();
        const withIndexFields = { ...(entry as unknown as Record<string, unknown>), createdAt: Date.now(), resourceId: ((entry as unknown as Record<string, unknown>).response as Record<string, unknown> | undefined)?.meta && ((((entry as unknown as Record<string, unknown>).response as Record<string, unknown>).meta as Record<string, unknown>).resourceId) } as Record<string, unknown>;
        const persisted = settings.detailedLogs === true
            ? withIndexFields as unknown as PlainData
            : (() => {
                const value = withIndexFields;
                const request = value.request as Record<string, unknown> | undefined;
                const response = value.response as Record<string, unknown> | undefined;
                return { ...value, request: request ? { taskKind: request.taskKind, taskDescription: request.taskDescription, metrics: request.metrics } : undefined, response: response ? { meta: response.meta, finalError: response.finalError, reasonCode: response.reasonCode } : undefined } as unknown as PlainData;
            })();
        const recordId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await this.workspace.upsert({ workspaceId: LLM_WORKSPACE_ID, collection: 'request-logs', recordId, value: persisted });
        const page = await this.workspace.query({ workspaceId: LLM_WORKSPACE_ID, collection: 'request-logs', orderBy: { field: 'createdAt', direction: 'desc' }, limit: 2001 });
        if (page.records.length > 2000) await this.workspace.delete({ workspaceId: LLM_WORKSPACE_ID, collection: 'request-logs', recordId: page.records.at(-1)!.recordId });
    }

    async clearLogs(): Promise<number> {
        await this.ready();
        let removed = 0;
        let cursor: string | undefined;
        do {
            const page = await this.workspace.query({ workspaceId: LLM_WORKSPACE_ID, collection: 'request-logs', limit: 1000, ...(cursor ? { cursor } : {}) });
            for (const record of page.records) {
                if (await this.workspace.delete({ workspaceId: LLM_WORKSPACE_ID, collection: 'request-logs', recordId: record.recordId })) removed += 1;
            }
            // Deleting the current page makes the next cursor invalid on some
            // backends; restart from the beginning until no records remain.
            cursor = page.records.length > 0 ? undefined : page.nextCursor ?? undefined;
            if (page.records.length === 0) break;
        } while (cursor !== undefined || removed > 0);
        return removed;
    }

    async queryLogs(input: { state?: string; sourcePluginId?: string; resourceId?: string; search?: string; limit?: number } = {}): Promise<readonly PlainData[]> {
        await this.ready();
        const filter: Record<string, PlainData> = {};
        if (input.state && input.state !== 'all') filter.state = input.state;
        if (input.sourcePluginId) filter.sourcePluginId = input.sourcePluginId;
        if (input.resourceId) filter.resourceId = input.resourceId;
        const page = await this.workspace.query({ workspaceId: LLM_WORKSPACE_ID, collection: 'request-logs', filter, orderBy: { field: 'createdAt', direction: 'desc' }, limit: input.limit ?? 100 });
        const search = String(input.search ?? '').trim().toLowerCase();
        return page.records.map((record) => record.value).filter((value) => !search || JSON.stringify(value).toLowerCase().includes(search));
    }

    async loadConsumers(): Promise<Record<string, PlainData>> {
        await this.ready();
        const page = await this.workspace.query({ workspaceId: LLM_WORKSPACE_ID, collection: 'consumers', limit: 1000 });
        return Object.fromEntries(page.records.map((record) => [record.recordId, record.value]));
    }

    async saveConsumers(snapshot: Record<string, PlainData>): Promise<void> {
        await this.ready();
        const existing = await this.workspace.query({ workspaceId: LLM_WORKSPACE_ID, collection: 'consumers', limit: 1000 });
        const keep = new Set(Object.keys(snapshot));
        for (const record of existing.records) if (!keep.has(record.recordId)) await this.workspace.delete({ workspaceId: LLM_WORKSPACE_ID, collection: 'consumers', recordId: record.recordId });
        for (const [id, value] of Object.entries(snapshot)) await this.workspace.upsert({ workspaceId: LLM_WORKSPACE_ID, collection: 'consumers', recordId: id, value });
    }
}
