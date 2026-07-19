import type {
  PlainData,
  WorkspacePort,
  WorkspaceQueryRequest,
  WorkspaceRecord,
  WorkspaceTransactionOperation,
} from '@ss-helper/sdk';
import { DEFAULT_LLM_SETTINGS } from '../schema/defaults';
import type { LLMHubSettings } from '../schema/types';
import { validateLlmSettings } from '../validation/settings';
import { buildStoredLog } from '../log/log-sanitizer';

export const LLM_WORKSPACE_ID = 'llm:global';
export const LLM_WORKSPACE_OWNER = 'ss-helper.llm';
const COLLECTIONS = ['settings', 'credentials', 'request-logs', 'consumers'] as const;
const MAX_PAGE_SIZE = 1_000;
const MAX_TRANSACTION_OPERATIONS = 5_000;
const MAX_ARCHIVE_BYTES = 1_024 * 1_024;
const MAX_CONSUMERS = 1_000;
const DEFAULT_LOG_MAX_ENTRIES = 500;
const DEFAULT_LOG_RETENTION_DAYS = 30;
const DEFAULT_LOG_MAX_BYTES = 100 * 1024 * 1024;
type PersistedSettings = LLMHubSettings & { timeoutMs?: number; resultDisplay?: 'auto' | 'silent' | 'compact' | 'fullscreen' };
type LogKind = 'generation' | 'embedding' | 'rerank';

export interface WorkspaceCredentialMetadata {
  readonly secretId: string;
  readonly maskedValue: string;
  readonly updatedAt: number;
  readonly keyVersion: 1;
}

export interface LLMConfigArchiveV1 {
  readonly format: 'ss-helper-llm-config';
  readonly version: 1;
  readonly settings: PlainData;
  readonly consumers: PlainData;
}

export interface PreparedSettingsRuntime {
  commit(): void;
  dispose(): void;
}

export interface SettingsRuntimePrepareOptions {
  readonly credentialOverrides?: Readonly<Record<string, string | null>>;
  readonly emptyCredentials?: boolean;
}

export type SettingsRuntimePreparer = (
  settings: LLMHubSettings,
  options?: SettingsRuntimePrepareOptions,
) => Promise<PreparedSettingsRuntime | null>;

function asPlain(value: unknown): PlainData { return structuredClone(value) as PlainData; }
function recordRevision(record: WorkspaceRecord | null): number { return record?.revision ?? record?.version ?? 0; }
function credentialId(resourceId: string): string { return `resource:${resourceId}`; }
function operationKey(prefix: string, suffix?: string): string { return `${prefix}:${globalThis.crypto.randomUUID()}${suffix ? `:${suffix}` : ''}`; }
function safeError(message: string, code: string, extra: Record<string, unknown> = {}): Error & { code: string } { return Object.assign(new Error(message), { code, ...extra }); }

async function sha256Json(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

type QueryOptions = Pick<WorkspaceQueryRequest, 'filter' | 'where' | 'orderBy'>;

export class LlmWorkspaceRepository {
  private settings: PersistedSettings = { ...DEFAULT_LLM_SETTINGS };
  private settingsRevision = 0;
  private initialized?: Promise<void>;
  private mutationQueue: Promise<void> = Promise.resolve();
  private runtimePreparer?: SettingsRuntimePreparer;
  private readonly listeners = new Set<(settings: PersistedSettings) => void>();
  private readonly changeListeners = new Set<(kinds: readonly LogKind[]) => void>();

  constructor(private readonly workspace: WorkspacePort) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async initialize(): Promise<void> {
    await this.workspace.open({ workspaceId: LLM_WORKSPACE_ID, ownerPluginId: LLM_WORKSPACE_OWNER, create: true, metadata: { owner: LLM_WORKSPACE_OWNER, purpose: 'LLM browser configuration and runtime state' } });
    await Promise.all(COLLECTIONS.map((name) => this.workspace.defineCollection({ workspaceId: LLM_WORKSPACE_ID, ownerPluginId: LLM_WORKSPACE_OWNER, name, indexes: name === 'request-logs' ? ['sourcePluginId', 'state', 'resourceId', 'taskKey', 'taskKind', 'model', 'reasonCode', 'createdAt'] : [] })));
    await this.loadSettings();
  }

  async ready(): Promise<void> { this.initialized ??= this.initialize(); return this.initialized; }
  async health() { await this.ready(); return this.workspace.health(); }

  attachRuntimePreparer(preparer: SettingsRuntimePreparer): () => void {
    this.runtimePreparer = preparer;
    return () => { if (this.runtimePreparer === preparer) this.runtimePreparer = undefined; };
  }

  private async prepareRuntime(settings: LLMHubSettings, options: SettingsRuntimePrepareOptions = {}): Promise<PreparedSettingsRuntime | null> {
    return this.runtimePreparer?.(structuredClone(settings), options) ?? null;
  }

  private notifySettings(): void {
    const value = structuredClone(this.settings);
    for (const listener of this.listeners) { try { listener(value); } catch { /* UI listeners must not change committed storage results. */ } }
  }

  private notifyChanges(kinds: readonly LogKind[]): void {
    for (const listener of this.changeListeners) { try { listener(kinds); } catch { /* diagnostics listeners are best effort. */ } }
  }

  private async queryAll(collection: string, options: QueryOptions = {}): Promise<WorkspaceRecord[]> {
    const records: WorkspaceRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.workspace.query({ workspaceId: LLM_WORKSPACE_ID, ownerPluginId: LLM_WORKSPACE_OWNER, collection, ...options, ...(cursor ? { cursor } : {}), limit: MAX_PAGE_SIZE });
      records.push(...page.records);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return records;
  }

  private settingsFrom(value: LLMHubSettings): PersistedSettings {
    return {
      ...DEFAULT_LLM_SETTINGS,
      ...value,
      requestLogging: {
        ...DEFAULT_LLM_SETTINGS.requestLogging,
        ...(value.requestLogging ?? {}),
      },
    };
  }

  async loadSettings(): Promise<PersistedSettings> {
    await this.workspace.open({ workspaceId: LLM_WORKSPACE_ID, ownerPluginId: LLM_WORKSPACE_OWNER, create: true });
    const record = await this.workspace.get({ workspaceId: LLM_WORKSPACE_ID, ownerPluginId: LLM_WORKSPACE_OWNER, collection: 'settings', recordId: 'global' });
    this.settingsRevision = recordRevision(record);
    this.settings = record ? this.settingsFrom(validateLlmSettings(record.value)) : { ...DEFAULT_LLM_SETTINGS };
    return structuredClone(this.settings);
  }

  async saveSettings(next: LLMHubSettings & Record<string, unknown>): Promise<PersistedSettings> {
    return this.enqueue(async () => {
      await this.ready();
      const value = validateLlmSettings(next);
      const prepared = await this.prepareRuntime(value);
      try {
        const result = await this.workspace.transaction({
          workspaceId: LLM_WORKSPACE_ID,
          ownerPluginId: LLM_WORKSPACE_OWNER,
          idempotencyKey: operationKey('llm-settings'),
          operations: [{ action: 'upsert', collection: 'settings', recordId: 'global', value: asPlain(value), expectedRevision: this.settingsRevision }],
        });
        this.settingsRevision = result.results[0]?.revision ?? result.results[0]?.version ?? this.settingsRevision + 1;
        this.settings = this.settingsFrom(value);
        prepared?.commit();
      } catch (error) {
        prepared?.dispose();
        throw error;
      }
      this.notifySettings();
      this.notifyChanges(['generation', 'embedding', 'rerank']);
      return structuredClone(this.settings);
    });
  }

  async reset(): Promise<PersistedSettings> {
    return this.enqueue(async () => {
      await this.ready();
      const credentials = await this.queryAll('credentials');
      const prepared = await this.prepareRuntime(DEFAULT_LLM_SETTINGS, { emptyCredentials: true });
      const operations: WorkspaceTransactionOperation[] = [{ action: 'delete', collection: 'settings', recordId: 'global', expectedRevision: this.settingsRevision }];
      credentials.forEach((record) => operations.push({ action: 'delete', collection: 'credentials', recordId: record.recordId, expectedRevision: recordRevision(record) }));
      if (operations.length > MAX_TRANSACTION_OPERATIONS) { prepared?.dispose(); throw safeError('重置数据过多，请先清理旧凭据', 'LLM_IMPORT_TOO_LARGE'); }
      try {
        await this.workspace.transaction({ workspaceId: LLM_WORKSPACE_ID, ownerPluginId: LLM_WORKSPACE_OWNER, idempotencyKey: operationKey('llm-reset'), operations });
        this.settingsRevision = 0;
        this.settings = { ...DEFAULT_LLM_SETTINGS };
        prepared?.commit();
      } catch (error) {
        prepared?.dispose();
        throw error;
      }
      this.notifySettings();
      this.notifyChanges(['generation', 'embedding', 'rerank']);
      return structuredClone(this.settings);
    });
  }

  subscribeSettings(listener: (settings: PersistedSettings) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  subscribeChanges(listener: (kinds: readonly LogKind[]) => void): () => void { this.changeListeners.add(listener); return () => this.changeListeners.delete(listener); }

  async getResourceSecret(resourceId: string): Promise<string | null> {
    await this.ready();
    const record = await this.workspace.get({ workspaceId: LLM_WORKSPACE_ID, ownerPluginId: LLM_WORKSPACE_OWNER, collection: 'credentials', recordId: credentialId(resourceId) });
    const value = record?.value as { apiKey?: unknown } | undefined;
    return typeof value?.apiKey === 'string' && value.apiKey.length > 0 ? value.apiKey : null;
  }
  async hasResourceSecret(resourceId: string): Promise<boolean> { return (await this.getResourceSecret(resourceId)) !== null; }

  async setResourceSecret(resourceId: string, value: string, _metadata: PlainData = {}): Promise<WorkspaceCredentialMetadata> {
    return this.enqueue(async () => {
      await this.ready();
      const normalized = value.trim();
      if (!normalized || normalized.length > 65_536) throw safeError('密钥无效', 'PAYLOAD_INVALID');
      const current = await this.workspace.get({ workspaceId: LLM_WORKSPACE_ID, ownerPluginId: LLM_WORKSPACE_OWNER, collection: 'credentials', recordId: credentialId(resourceId) });
      const prepared = await this.prepareRuntime(this.settings, { credentialOverrides: { [resourceId]: normalized } });
      const updatedAt = Date.now();
      try {
        const result = await this.workspace.transaction({
          workspaceId: LLM_WORKSPACE_ID,
          ownerPluginId: LLM_WORKSPACE_OWNER,
          idempotencyKey: operationKey('llm-credential-set'),
          operations: [{ action: 'upsert', collection: 'credentials', recordId: credentialId(resourceId), value: asPlain({ resourceId, apiKey: normalized, updatedAt }), expectedRevision: recordRevision(current) }],
        });
        prepared?.commit();
        void result;
      } catch (error) {
        prepared?.dispose();
        throw error;
      }
      this.notifyChanges(['generation', 'embedding', 'rerank']);
      return { secretId: credentialId(resourceId), maskedValue: `••••${normalized.slice(-2)}`, updatedAt, keyVersion: 1 };
    });
  }

  async deleteResourceSecret(resourceId: string): Promise<boolean> {
    return this.enqueue(async () => {
      await this.ready();
      const current = await this.workspace.get({ workspaceId: LLM_WORKSPACE_ID, ownerPluginId: LLM_WORKSPACE_OWNER, collection: 'credentials', recordId: credentialId(resourceId) });
      if (!current) return false;
      const prepared = await this.prepareRuntime(this.settings, { credentialOverrides: { [resourceId]: null } });
      try {
        const result = await this.workspace.transaction({ workspaceId: LLM_WORKSPACE_ID, ownerPluginId: LLM_WORKSPACE_OWNER, idempotencyKey: operationKey('llm-credential-delete'), operations: [{ action: 'delete', collection: 'credentials', recordId: credentialId(resourceId), expectedRevision: recordRevision(current) }] });
        prepared?.commit();
        void result;
      } catch (error) {
        prepared?.dispose();
        throw error;
      }
      this.notifyChanges(['generation', 'embedding', 'rerank']);
      return true;
    });
  }

  async deleteResource(resourceId: string): Promise<boolean> {
    return this.enqueue(async () => {
      await this.ready();
      const next = this.settingsFrom({ ...this.settings, resources: (this.settings.resources ?? []).filter((resource) => resource.id !== resourceId) });
      const currentCredential = await this.workspace.get({ workspaceId: LLM_WORKSPACE_ID, ownerPluginId: LLM_WORKSPACE_OWNER, collection: 'credentials', recordId: credentialId(resourceId) });
      const prepared = await this.prepareRuntime(next, { credentialOverrides: { [resourceId]: null } });
      const operations: WorkspaceTransactionOperation[] = [{ action: 'upsert', collection: 'settings', recordId: 'global', value: asPlain(next), expectedRevision: this.settingsRevision }];
      if (currentCredential) operations.push({ action: 'delete', collection: 'credentials', recordId: credentialId(resourceId), expectedRevision: recordRevision(currentCredential) });
      try {
        const result = await this.workspace.transaction({ workspaceId: LLM_WORKSPACE_ID, ownerPluginId: LLM_WORKSPACE_OWNER, idempotencyKey: operationKey('llm-resource-delete'), operations });
        this.settingsRevision = result.results[0]?.revision ?? result.results[0]?.version ?? this.settingsRevision + 1;
        this.settings = next;
        prepared?.commit();
      } catch (error) {
        prepared?.dispose();
        throw error;
      }
      this.notifySettings();
      this.notifyChanges(['generation', 'embedding', 'rerank']);
      return true;
    });
  }

  async listSecrets(): Promise<readonly WorkspaceCredentialMetadata[]> {
    await this.ready();
    const records = await this.queryAll('credentials');
    return records.map((record) => { const value = record.value as { apiKey?: unknown; updatedAt?: unknown }; const key = typeof value.apiKey === 'string' ? value.apiKey : ''; return { secretId: record.recordId, maskedValue: `••••${key.slice(-2)}`, updatedAt: Number(value.updatedAt ?? record.updatedAt), keyVersion: 1 as const }; });
  }

  async exportConfig(): Promise<{ archive: PlainData; sha256: string }> {
    await this.ready();
    const consumers = await this.loadConsumers();
    const archive: LLMConfigArchiveV1 = { format: 'ss-helper-llm-config', version: 1, settings: asPlain(this.settings), consumers: asPlain(consumers) };
    const archiveBytes = new TextEncoder().encode(JSON.stringify(archive)).byteLength;
    if (archiveBytes > MAX_ARCHIVE_BYTES) throw safeError('配置归档过大', 'LLM_IMPORT_TOO_LARGE');
    return { archive: asPlain(archive), sha256: await sha256Json(archive) };
  }

  async importConfig(archive: PlainData, sha256: string): Promise<void> {
    return this.enqueue(async () => {
      await this.ready();
      if (await sha256Json(archive) !== sha256) throw safeError('备份校验失败', 'BACKUP_HASH_MISMATCH');
      const value = archive as unknown as Partial<LLMConfigArchiveV1>;
      if (value.format !== 'ss-helper-llm-config' || value.version !== 1 || !value.settings || !value.consumers || typeof value.consumers !== 'object' || Array.isArray(value.consumers)) throw safeError('备份格式无效', 'BACKUP_INVALID');
      const archiveBytes = new TextEncoder().encode(JSON.stringify(archive)).byteLength;
      if (archiveBytes > MAX_ARCHIVE_BYTES) throw safeError('配置归档过大', 'LLM_IMPORT_TOO_LARGE');
      const settings = validateLlmSettings(value.settings);
      const consumerInput = value.consumers as Record<string, PlainData>;
      const consumerIds = Object.keys(consumerInput);
      if (consumerIds.length > MAX_CONSUMERS || consumerIds.some((id) => !id.trim() || id.length > 256)) throw safeError('消费者快照过大或无效', 'LLM_IMPORT_TOO_LARGE');
      const existingCredentials = await this.queryAll('credentials');
      const existingConsumers = await this.queryAll('consumers');
      const existingById = new Map(existingConsumers.map((record) => [record.recordId, record]));
      const operations: WorkspaceTransactionOperation[] = [{ action: 'upsert', collection: 'settings', recordId: 'global', value: asPlain(settings), expectedRevision: this.settingsRevision }];
      existingCredentials.forEach((record) => operations.push({ action: 'delete', collection: 'credentials', recordId: record.recordId, expectedRevision: recordRevision(record) }));
      const keep = new Set(consumerIds);
      existingConsumers.filter((record) => !keep.has(record.recordId)).forEach((record) => operations.push({ action: 'delete', collection: 'consumers', recordId: record.recordId, expectedRevision: recordRevision(record) }));
      for (const [recordId, consumer] of Object.entries(consumerInput)) operations.push({ action: 'upsert', collection: 'consumers', recordId, value: asPlain(consumer), expectedRevision: recordRevision(existingById.get(recordId) ?? null) });
      if (operations.length > MAX_TRANSACTION_OPERATIONS) throw safeError('备份包含过多记录', 'LLM_IMPORT_TOO_LARGE');
      const prepared = await this.prepareRuntime(settings, { emptyCredentials: true });
      try {
        const result = await this.workspace.transaction({ workspaceId: LLM_WORKSPACE_ID, ownerPluginId: LLM_WORKSPACE_OWNER, idempotencyKey: operationKey('llm-import'), operations });
        this.settingsRevision = result.results[0]?.revision ?? result.results[0]?.version ?? this.settingsRevision + 1;
        this.settings = this.settingsFrom(settings);
        prepared?.commit();
      } catch (error) {
        prepared?.dispose();
        throw error;
      }
      this.notifySettings();
      this.notifyChanges(['generation', 'embedding', 'rerank']);
    });
  }

  async clearAll(): Promise<void> {
    return this.enqueue(async () => {
      await this.ready();
      const prepared = await this.prepareRuntime(DEFAULT_LLM_SETTINGS, { emptyCredentials: true });
      try {
        await this.workspace.clearOwned({ idempotencyKey: operationKey('llm-clear') });
        this.initialized = undefined;
        this.settingsRevision = 0;
        this.settings = { ...DEFAULT_LLM_SETTINGS };
        prepared?.commit();
        await this.ready();
      } catch (error) {
        prepared?.dispose();
        throw error;
      }
      this.notifySettings();
      this.notifyChanges(['generation', 'embedding', 'rerank']);
    });
  }

  async saveLog(entry: PlainData): Promise<void> {
    return this.enqueue(async () => {
      await this.ready();
      const raw = entry as Record<string, unknown>;
      const settings = this.settingsFrom(this.settings);
      const logging = settings.requestLogging ?? {};
      const mode = logging.enabled === false ? 'off' : (logging.detailMode ?? 'full');
      const stored = buildStoredLog(raw, mode);
      if (!stored) return;
      await this.workspace.transaction({ workspaceId: LLM_WORKSPACE_ID, ownerPluginId: LLM_WORKSPACE_OWNER, idempotencyKey: operationKey('llm-log'), operations: [{ action: 'upsert', collection: 'request-logs', recordId: globalThis.crypto.randomUUID(), value: stored.value }] });
      await this.pruneLogsLocked();
    });
  }

  private async pruneLogsLocked(): Promise<number> {
    const logging = this.settingsFrom(this.settings).requestLogging ?? {};
    const maxEntries = Math.max(1, logging.maxEntries ?? DEFAULT_LOG_MAX_ENTRIES);
    const retentionDays = Math.max(1, logging.retentionDays ?? DEFAULT_LOG_RETENTION_DAYS);
    const maxBytes = Math.max(1, logging.maxBytes ?? DEFAULT_LOG_MAX_BYTES);
    const now = Date.now();
    const cutoff = now - retentionDays * 86_400_000;
    const records = await this.queryAll('request-logs', { orderBy: { field: 'createdAt', direction: 'asc' } });
    const recordsWithSize = records.map((record) => ({ record, createdAt: Number((record.value as Record<string, unknown>).createdAt ?? 0), size: Number((record.value as Record<string, unknown>).storageBytes ?? JSON.stringify(record.value).length) }));
    const remove = new Set<WorkspaceRecord>();
    let survivors = recordsWithSize.filter((item) => {
      if (item.createdAt > 0 && item.createdAt < cutoff) { remove.add(item.record); return false; }
      return true;
    });
    while (survivors.length > maxEntries) remove.add(survivors.shift()!.record);
    let totalBytes = survivors.reduce((sum, item) => sum + item.size, 0);
    while (totalBytes > maxBytes && survivors.length) {
      const item = survivors.shift()!;
      totalBytes -= item.size;
      remove.add(item.record);
    }
    if (!remove.size) return 0;
    const removed = [...remove];
    let count = 0;
    for (let index = 0; index < removed.length; index += MAX_TRANSACTION_OPERATIONS) {
      const batch = removed.slice(index, index + MAX_TRANSACTION_OPERATIONS);
      const result = await this.workspace.transaction({
        workspaceId: LLM_WORKSPACE_ID,
        ownerPluginId: LLM_WORKSPACE_OWNER,
        idempotencyKey: operationKey('llm-prune-logs'),
        operations: batch.map((record) => ({ action: 'delete' as const, collection: 'request-logs', recordId: record.recordId, expectedRevision: recordRevision(record) })),
      });
      count += result.results.filter((item) => item.removed !== false).length;
    }
    return count;
  }

  async clearLogs(): Promise<number> {
    return this.enqueue(async () => {
      await this.ready();
      let removed = 0;
      let batch = 0;
      const clearOperationId = operationKey('llm-clear-logs');
      try {
        while (true) {
          const records = await this.workspace.query({ workspaceId: LLM_WORKSPACE_ID, ownerPluginId: LLM_WORKSPACE_OWNER, collection: 'request-logs', limit: MAX_PAGE_SIZE });
          if (!records.records.length) return removed;
          const result = await this.workspace.transaction({
            workspaceId: LLM_WORKSPACE_ID,
            ownerPluginId: LLM_WORKSPACE_OWNER,
            idempotencyKey: `${clearOperationId}:${batch}`,
            operations: records.records.map((record) => ({ action: 'delete' as const, collection: 'request-logs', recordId: record.recordId, expectedRevision: recordRevision(record) })),
          });
          removed += result.results.filter((item) => item.removed !== false).length;
          batch += 1;
        }
      } catch (error) {
        const cause = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
        throw safeError(`日志已清理 ${removed} 条，剩余记录可重试`, 'LLM_LOG_CLEAR_PARTIAL', { removedCount: removed, cause });
      }
    });
  }

  async queryLogs(input: { state?: string; sourcePluginId?: string; resourceId?: string; taskKind?: string; model?: string; reasonCode?: string; search?: string; fromTs?: number; toTs?: number; limit?: number; offset?: number } = {}): Promise<readonly PlainData[]> {
    await this.ready();
    const filter: Record<string, PlainData> = {};
    if (input.state && input.state !== 'all') filter.state = input.state;
    if (input.sourcePluginId) filter.sourcePluginId = input.sourcePluginId;
    if (input.resourceId) filter.resourceId = input.resourceId;
    if (input.taskKind) filter.taskKind = input.taskKind;
    if (input.model) filter.model = input.model;
    if (input.reasonCode) filter.reasonCode = input.reasonCode;
    const where = [
      ...(input.fromTs === undefined ? [] : [{ field: 'createdAt', op: 'gte' as const, value: input.fromTs as PlainData }]),
      ...(input.toTs === undefined ? [] : [{ field: 'createdAt', op: 'lte' as const, value: input.toTs as PlainData }]),
    ];
    const page = await this.workspace.query({ workspaceId: LLM_WORKSPACE_ID, ownerPluginId: LLM_WORKSPACE_OWNER, collection: 'request-logs', filter, ...(where.length ? { where } : {}), orderBy: { field: 'createdAt', direction: 'desc' }, limit: Math.min(500, input.limit ?? 100) });
    const search = String(input.search ?? '').trim().toLowerCase();
    return page.records.map((record) => record.value).filter((value) => !search || JSON.stringify(value).toLowerCase().includes(search));
  }

  async deleteLogs(logIds: readonly string[]): Promise<number> {
    return this.enqueue(async () => {
      await this.ready();
      const wanted = new Set(logIds.filter(Boolean));
      if (!wanted.size) return 0;
      const records = (await this.queryAll('request-logs')).filter((record) => wanted.has(String((record.value as Record<string, unknown>).logId ?? '')));
      let removed = 0;
      for (let index = 0; index < records.length; index += MAX_TRANSACTION_OPERATIONS) {
        const batch = records.slice(index, index + MAX_TRANSACTION_OPERATIONS);
        const result = await this.workspace.transaction({ workspaceId: LLM_WORKSPACE_ID, ownerPluginId: LLM_WORKSPACE_OWNER, idempotencyKey: operationKey('llm-delete-logs'), operations: batch.map((record) => ({ action: 'delete' as const, collection: 'request-logs', recordId: record.recordId, expectedRevision: recordRevision(record) })) });
        removed += result.results.filter((item) => item.removed !== false).length;
      }
      return removed;
    });
  }

  async getLogStats(): Promise<{ count: number; failed: number; bytes: number; latestAt?: number; oldestAt?: number; policy: { maxEntries: number; retentionDays: number; maxBytes: number } }> {
    await this.ready();
    const records = await this.queryAll('request-logs');
    const values = records.map((record) => record.value as Record<string, unknown>);
    const timestamps = values.map((value) => Number(value.createdAt ?? 0)).filter((value) => value > 0);
    const logging = this.settingsFrom(this.settings).requestLogging ?? {};
    return {
      count: values.length,
      failed: values.filter((value) => value.state === 'failed').length,
      bytes: values.reduce((sum, value) => sum + Number(value.storageBytes ?? JSON.stringify(value).length), 0),
      latestAt: timestamps.length ? Math.max(...timestamps) : undefined,
      oldestAt: timestamps.length ? Math.min(...timestamps) : undefined,
      policy: { maxEntries: logging.maxEntries ?? DEFAULT_LOG_MAX_ENTRIES, retentionDays: logging.retentionDays ?? DEFAULT_LOG_RETENTION_DAYS, maxBytes: logging.maxBytes ?? DEFAULT_LOG_MAX_BYTES },
    };
  }

  async loadConsumers(): Promise<Record<string, PlainData>> {
    await this.ready();
    const records = await this.queryAll('consumers');
    return Object.fromEntries(records.map((record) => [record.recordId, record.value]));
  }

  private async saveConsumersLocked(snapshot: Record<string, PlainData>): Promise<void> {
    const ids = Object.keys(snapshot);
    if (ids.length > MAX_CONSUMERS) throw safeError('消费者快照过大', 'LLM_IMPORT_TOO_LARGE');
    const existing = await this.queryAll('consumers');
    const existingById = new Map(existing.map((record) => [record.recordId, record]));
    const keep = new Set(ids);
    const operations: WorkspaceTransactionOperation[] = existing.filter((record) => !keep.has(record.recordId)).map((record) => ({ action: 'delete' as const, collection: 'consumers', recordId: record.recordId, expectedRevision: recordRevision(record) }));
    for (const [recordId, value] of Object.entries(snapshot)) operations.push({ action: 'upsert', collection: 'consumers', recordId, value: asPlain(value), expectedRevision: recordRevision(existingById.get(recordId) ?? null) });
    if (operations.length > MAX_TRANSACTION_OPERATIONS) throw safeError('消费者快照过大', 'LLM_IMPORT_TOO_LARGE');
    if (operations.length) await this.workspace.transaction({ workspaceId: LLM_WORKSPACE_ID, ownerPluginId: LLM_WORKSPACE_OWNER, idempotencyKey: operationKey('llm-consumers'), operations });
  }

  async saveConsumers(snapshot: Record<string, PlainData>): Promise<void> { return this.enqueue(async () => { await this.ready(); await this.saveConsumersLocked(snapshot); }); }
}
