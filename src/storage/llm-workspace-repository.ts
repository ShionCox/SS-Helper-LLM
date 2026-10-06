import type {
  PlainData,
  SecretPort,
  WorkspaceCommitOperation,
  WorkspacePort,
  WorkspaceQueryOptions,
  WorkspaceRecord,
  WorkspaceSession,
  SSHelperFailureContext,
  VerifiedToolCapabilities,
} from '@ss-helper/sdk';
import { createSSHelperError, LLM_RESOURCE_CAPABILITY_VERIFY_V0, isSSHelperReasonCode } from '@ss-helper/sdk';
import { DEFAULT_LLM_SETTINGS } from '../schema/defaults';
import { configuredMaxTokensControl } from '../sdk/max-tokens';
import type { LLMHubSettings, LLMRequestLogQueryOptions } from '../schema/types';
import type { ResourceConfig } from '../schema/types';
import { validateLlmSettings } from '../validation/settings';
import { buildStoredLog } from '../log/log-sanitizer';
import { startLlmPerformanceSpan } from '../runtime/logger';

export const LLM_WORKSPACE_ID = 'llm:global';
export const LLM_WORKSPACE_OWNER = 'ss-helper.llm';
const COLLECTIONS = ['settings', 'request-logs', 'consumers', 'resource-health', 'tool-capabilities'] as const;
const MAX_PAGE_SIZE = 1_000;
const MAX_TRANSACTION_OPERATIONS = 5_000;
const MAX_ARCHIVE_BYTES = 1_024 * 1_024;
const MAX_CONSUMERS = 1_000;
const DEFAULT_LOG_MAX_ENTRIES = 500;
const DEFAULT_LOG_RETENTION_DAYS = 30;
const DEFAULT_LOG_MAX_BYTES = 100 * 1024 * 1024;
type PersistedSettings = LLMHubSettings & { timeoutMs?: number };
type LogKind = 'generation' | 'embedding' | 'rerank';
type SecretSnapshot = {
  readonly secretId: string;
  readonly value: string;
  readonly metadata?: PlainData;
};

export interface WorkspaceCredentialMetadata {
  readonly secretId: string;
  readonly maskedValue: string;
  readonly updatedAt: number;
  readonly keyVersion: 1;
}

export interface ResourceHealthRecord {
  readonly resourceId: string;
  readonly state: 'success' | 'failed';
  readonly checkedAt: number;
  readonly durationMs: number;
  readonly failure?: SSHelperFailureContext;
}

export interface StoredToolCapabilityRecord {
  readonly cacheKey: string;
  readonly capability: VerifiedToolCapabilities;
}

export interface LLMConfigArchiveV0 {
  readonly format: 'ss-helper-llm-config';
  readonly version: 0;
  readonly settings: PlainData;
  readonly consumers: PlainData;
}

export interface PreparedSettingsRuntime {
  /** Throws when a newer runtime preparation superseded this snapshot. */
  assertCurrent?(): void;
  commit(): void;
  dispose(): void;
}

export interface SettingsRuntimePrepareOptions {
  readonly credentialOverrides?: Readonly<Record<string, string | null>>;
  readonly emptyCredentials?: boolean;
}

export interface SettingsUpdateOptions {
  readonly expectedRevision?: number;
  readonly resourceHealth?: ResourceHealthRecord;
}

export interface SaveResourceOptions {
  readonly reasoningPolicy?: import('@ss-helper/sdk').LlmReasoningPolicy;
  readonly resourceHealth?: ResourceHealthRecord;
  readonly secretMetadata?: PlainData;
}

export type SettingsRuntimePreparer = (
  settings: LLMHubSettings,
  options?: SettingsRuntimePrepareOptions,
) => Promise<PreparedSettingsRuntime | null>;

function asPlain(value: unknown): PlainData { return structuredClone(value) as PlainData; }
function recordRevision(record: WorkspaceRecord | null): number { return record?.revision ?? 0; }
function credentialId(resourceId: string): string { return `resource:${resourceId}`; }
function operationKey(prefix: string, suffix?: string): string { return `${prefix}:${globalThis.crypto.randomUUID()}${suffix ? `:${suffix}` : ''}`; }
function repositoryError(reasonCode: import('@ss-helper/sdk').SSHelperReasonCode, stage: string): Error {
  return createSSHelperError(reasonCode, { stage });
}

function validateResourceHealth(value: PlainData): ResourceHealthRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw repositoryError('INVALID_PAYLOAD', 'llm.resource-health.validate');
  const record = value as Record<string, PlainData>;
  const keys = Object.keys(record);
  if (keys.some((key) => !['resourceId', 'state', 'checkedAt', 'durationMs', 'failure'].includes(key))) throw repositoryError('INVALID_PAYLOAD', 'llm.resource-health.validate');
  if (typeof record.resourceId !== 'string' || record.resourceId.trim() === '' || record.resourceId.length > 256) throw repositoryError('INVALID_PAYLOAD', 'llm.resource-health.validate');
  if (record.state !== 'success' && record.state !== 'failed') throw repositoryError('INVALID_PAYLOAD', 'llm.resource-health.validate');
  if (typeof record.checkedAt !== 'number' || !Number.isSafeInteger(record.checkedAt) || record.checkedAt <= 0) throw repositoryError('INVALID_PAYLOAD', 'llm.resource-health.validate');
  if (typeof record.durationMs !== 'number' || !Number.isSafeInteger(record.durationMs) || record.durationMs < 0 || record.durationMs > 86_400_000) throw repositoryError('INVALID_PAYLOAD', 'llm.resource-health.validate');
  const failure = record.failure;
  if (failure !== undefined && (
    typeof failure !== 'object'
    || failure === null
    || Array.isArray(failure)
    || !isSSHelperReasonCode((failure as Record<string, PlainData>).reasonCode)
    || typeof (failure as Record<string, PlainData>).stage !== 'string'
  )) throw repositoryError('INVALID_PAYLOAD', 'llm.resource-health.validate');
  if (record.state === 'failed' && failure === undefined) throw repositoryError('INVALID_PAYLOAD', 'llm.resource-health.validate');
  if (record.state === 'success' && failure !== undefined) throw repositoryError('INVALID_PAYLOAD', 'llm.resource-health.validate');
  return {
    resourceId: record.resourceId,
    state: record.state,
    checkedAt: record.checkedAt,
    durationMs: record.durationMs,
    ...(failure === undefined ? {} : { failure: structuredClone(failure) as unknown as SSHelperFailureContext }),
  };
}

function validateToolCapability(cacheKey: string, value: PlainData): StoredToolCapabilityRecord {
  if (!/^fnv1a64:[0-9a-f]{16}$/u.test(cacheKey)
    || LLM_RESOURCE_CAPABILITY_VERIFY_V0.validateResponse?.({ resourceId: (value as Record<string, unknown>).resourceId, taskKeys: [], capabilities: [value] }) !== true) {
    throw repositoryError('INVALID_PAYLOAD', 'llm.tool-capability.validate');
  }
  return { cacheKey, capability: structuredClone(value) as unknown as VerifiedToolCapabilities };
}

async function sha256Json(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

type QueryOptions = Pick<WorkspaceQueryOptions, 'filter' | 'where' | 'orderBy'>;

export class LlmWorkspaceRepository {
  private settings: PersistedSettings = this.settingsFrom(DEFAULT_LLM_SETTINGS);
  private settingsRevision = 0;
  private initialized?: Promise<void>;
  private initializationState: 'idle' | 'pending' | 'ready' = 'idle';
  private mutationQueue: Promise<void> = Promise.resolve();
  private runtimePreparer?: SettingsRuntimePreparer;
  private readonly listeners = new Set<(settings: PersistedSettings) => void>();
  private readonly changeListeners = new Set<(kinds: readonly LogKind[]) => void>();
  private workspaceSession?: WorkspaceSession;

  constructor(private readonly workspace: WorkspacePort, private readonly secrets?: SecretPort) {}

  private requireWorkspace(): WorkspaceSession {
    if (this.workspaceSession === undefined) throw repositoryError('WORKSPACE_UNAVAILABLE', 'llm.workspace.session');
    return this.workspaceSession;
  }

  private read(request: { readonly collection: string; readonly id: string }): Promise<WorkspaceRecord | null> {
    return this.requireWorkspace().get(request.collection, request.id);
  }

  private scan(request: { readonly collection: string } & WorkspaceQueryOptions) {
    const { collection, ...options } = request;
    return this.requireWorkspace().query(collection, options);
  }

  private write(request: { readonly idempotencyKey?: string; readonly operations: readonly WorkspaceCommitOperation[] }) {
    return this.requireWorkspace().commit({
      idempotencyKey: request.idempotencyKey ?? operationKey('llm-commit'),
      operations: request.operations,
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async loadSettingsFromWorkspace(): Promise<PersistedSettings> {
    const record = await this.read({ collection: 'settings', id: 'global' });
    this.settingsRevision = recordRevision(record);
    this.settings = this.settingsFrom(record ? validateLlmSettings(record.value) : DEFAULT_LLM_SETTINGS);
    return structuredClone(this.settings);
  }

  private async initialize(): Promise<void> {
    const finish = startLlmPerformanceSpan('repository.initialize');
    try {
      this.workspaceSession = await this.workspace.open({
        id: LLM_WORKSPACE_ID,
        metadata: { purpose: 'LLM browser configuration and runtime state' },
        schema: {
          collections: COLLECTIONS.map(name => ({
            name,
            indexes: name === 'request-logs'
              ? ['sourcePluginId', 'state', 'resourceId', 'taskKey', 'taskKind', 'model', 'reasonCode', 'entryKind', 'workflowId', 'createdAt']
              : name === 'resource-health' ? ['state', 'checkedAt']
                : name === 'tool-capabilities' ? ['resourceId', 'model', 'status', 'expiresAt'] : [],
          })),
        },
      });
      await this.loadSettingsFromWorkspace();
      finish();
    } catch (error) {
      finish('error');
      throw error;
    }
  }

  async ready(): Promise<void> {
    if (this.initialized === undefined) {
      const attempt = this.initialize();
      this.initialized = attempt;
      this.initializationState = 'pending';
      void attempt.then(() => {
        if (this.initialized !== attempt) return;
        this.initializationState = 'ready';
        this.notifySettings();
      }, () => {
        if (this.initialized !== attempt) return;
        this.initialized = undefined;
        this.initializationState = 'idle';
      });
    }
    return this.initialized;
  }
  async health() { await this.ready(); return this.workspace.admin.health(); }

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
    const seenCursors = new Set<string>();
    do {
      const page = await this.scan({ collection, ...options, ...(cursor ? { cursor } : {}), limit: MAX_PAGE_SIZE });
      records.push(...page.records);
      cursor = page.nextCursor ?? undefined;
      if (cursor !== undefined && (seenCursors.has(cursor) || seenCursors.size >= MAX_PAGE_SIZE * 100)) {
        throw repositoryError('INTERNAL_ERROR', 'llm.workspace.pagination');
      }
      if (cursor !== undefined) seenCursors.add(cursor);
    } while (cursor);
    return records;
  }

  private requireSecrets(): SecretPort {
    if (this.secrets === undefined) throw repositoryError('WORKSPACE_SECRET_UNAVAILABLE', 'llm.workspace.secret');
    return this.secrets;
  }

  private async restoreSecrets(records: readonly SecretSnapshot[], stage: string): Promise<void> {
    const secrets = this.requireSecrets();
    try {
      for (const record of records) {
        await secrets.set({
          workspaceId: LLM_WORKSPACE_ID,
          secretId: record.secretId,
          value: record.value,
          ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
        });
      }
    } catch {
      throw createSSHelperError('WORKSPACE_SECRET_UNAVAILABLE', { stage });
    }
  }

  private async removeAllSecrets(stage: string): Promise<readonly SecretSnapshot[]> {
    const secrets = this.requireSecrets();
    const metadata = await secrets.list({ workspaceId: LLM_WORKSPACE_ID });
    const snapshots: SecretSnapshot[] = [];
    for (const record of metadata) {
      const secret = await secrets.get({ workspaceId: LLM_WORKSPACE_ID, secretId: record.secretId });
      if (secret === null) {
        throw createSSHelperError('WORKSPACE_SECRET_UNAVAILABLE', { stage });
      }
      snapshots.push({
        secretId: secret.secretId,
        value: secret.value,
        ...(secret.metadata === undefined ? {} : { metadata: secret.metadata }),
      });
    }
    const removed: SecretSnapshot[] = [];
    try {
      for (const record of snapshots) {
        const deleted = await secrets.delete({ workspaceId: LLM_WORKSPACE_ID, secretId: record.secretId });
        if (!deleted) throw createSSHelperError('WORKSPACE_SECRET_UNAVAILABLE', { stage });
        removed.push(record);
      }
      return snapshots;
    } catch (error) {
      await this.restoreSecrets(removed, `${stage}.compensate`);
      throw error;
    }
  }

  private settingsFrom(value: LLMHubSettings): PersistedSettings {
    const { maxTokensMode: _defaultMode, maxTokens: _defaultTokens, ...defaults } = DEFAULT_LLM_SETTINGS;
    const { maxTokensMode: _mode, maxTokens: _tokens, ...retained } = value;
    return {
      ...defaults,
      ...retained,
      maxTokensControl: configuredMaxTokensControl(value),
      requestLogging: {
        ...DEFAULT_LLM_SETTINGS.requestLogging,
        ...(value.requestLogging ?? {}),
      },
    };
  }

  async loadSettings(): Promise<PersistedSettings> {
    await this.ready();
    return structuredClone(this.settings);
  }

  async updateSettings(
    mutator: (current: PersistedSettings) => LLMHubSettings & Record<string, unknown>,
    options: SettingsUpdateOptions = {},
  ): Promise<PersistedSettings> {
    return this.enqueue(async () => {
      await this.ready();
      if (options.expectedRevision !== undefined && options.expectedRevision !== this.settingsRevision) {
        throw repositoryError('WORKSPACE_CONFLICT', 'llm.settings.update');
      }
      const next = mutator(structuredClone(this.settings));
      const value = validateLlmSettings(next);
      const health = options.resourceHealth === undefined ? undefined : validateResourceHealth(asPlain(options.resourceHealth));
      const previousHealth = health === undefined ? null : await this.read({ collection: 'resource-health', id: health.resourceId });
      const prepared = await this.prepareRuntime(value);
      try {
        prepared?.assertCurrent?.();
        const result = await this.write({
          idempotencyKey: operationKey('llm-settings'),
          operations: [
            { action: 'put', collection: 'settings', id: 'global', value: asPlain(value), expectedRevision: this.settingsRevision },
            ...(health === undefined ? [] : [{
              action: 'put' as const,
              collection: 'resource-health',
              id: health.resourceId,
              value: asPlain(health),
              expectedRevision: recordRevision(previousHealth),
            }]),
          ],
        });
        this.settingsRevision = result.results[0]?.revision ?? this.settingsRevision + 1;
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

  async replaceSettings(next: LLMHubSettings & Record<string, unknown>, expectedRevision?: number): Promise<PersistedSettings> {
    return this.updateSettings(() => next, { ...(expectedRevision === undefined ? {} : { expectedRevision }) });
  }

  async saveSettings(
    next: LLMHubSettings & Record<string, unknown>,
    options: { readonly resourceHealth?: ResourceHealthRecord } = {},
  ): Promise<PersistedSettings> {
    return this.updateSettings(() => next, options);
  }

  /**
   * Atomically applies a resource, its policy/health and credential. The
   * secret store is compensated if the Workspace CAS write fails, so another
   * settings mutation cannot observe a half-enabled resource.
   */
  async saveResource(resource: ResourceConfig, secret: string, options: SaveResourceOptions = {}): Promise<PersistedSettings> {
    return this.enqueue(async () => {
      await this.ready();
      const normalizedSecret = secret.trim();
      if (!normalizedSecret || normalizedSecret.length > 65_536) throw repositoryError('INVALID_PAYLOAD', 'llm.resource.secret');
      const resources = this.settings.resources ?? [];
      const nextResources = resources.some((item) => item.id === resource.id)
        ? resources.map((item) => item.id === resource.id ? structuredClone(resource) : item)
        : [...resources, structuredClone(resource)];
      const resourcePolicies = { ...(this.settings.resourcePolicies ?? {}) };
      if (resource.type === 'generation' && options.reasoningPolicy !== undefined) resourcePolicies[resource.id] = structuredClone(options.reasoningPolicy);
      if (resource.type !== 'generation') delete resourcePolicies[resource.id];
      const next = this.settingsFrom({ ...this.settings, resources: nextResources, resourcePolicies });
      const health = options.resourceHealth === undefined ? undefined : validateResourceHealth(asPlain(options.resourceHealth));
      const previousHealth = health === undefined ? null : await this.read({ collection: 'resource-health', id: health.resourceId });
      const staleCapabilities = (await this.queryAll('tool-capabilities')).filter((record) => (record.value as Record<string, PlainData>).resourceId === resource.id);
      const prepared = await this.prepareRuntime(next, { credentialOverrides: { [resource.id]: normalizedSecret } });
      const secrets = this.requireSecrets();
      const secretId = credentialId(resource.id);
      const previousSecret = await secrets.get({ workspaceId: LLM_WORKSPACE_ID, secretId });
      let secretWritten = false;
      try {
        prepared?.assertCurrent?.();
        await secrets.set({
          workspaceId: LLM_WORKSPACE_ID,
          secretId,
          value: normalizedSecret,
          ...(options.secretMetadata === undefined ? {} : { metadata: options.secretMetadata }),
        });
        secretWritten = true;
        const result = await this.write({
          idempotencyKey: operationKey('llm-resource-save'),
          operations: [
            { action: 'put', collection: 'settings', id: 'global', value: asPlain(next), expectedRevision: this.settingsRevision },
            ...(health === undefined ? [] : [{ action: 'put' as const, collection: 'resource-health', id: health.resourceId, value: asPlain(health), expectedRevision: recordRevision(previousHealth) }]),
            ...staleCapabilities.map((record) => ({ action: 'delete' as const, collection: 'tool-capabilities', id: record.id, expectedRevision: recordRevision(record) })),
          ],
        });
        this.settingsRevision = result.results[0]?.revision ?? this.settingsRevision + 1;
        this.settings = next;
        prepared?.commit();
      } catch (error) {
        prepared?.dispose();
        if (secretWritten) {
          try {
            if (previousSecret === null) await secrets.delete({ workspaceId: LLM_WORKSPACE_ID, secretId });
            else await secrets.set({ workspaceId: LLM_WORKSPACE_ID, secretId, value: previousSecret.value, ...(previousSecret.metadata === undefined ? {} : { metadata: previousSecret.metadata }) });
          } catch {
            throw createSSHelperError('WORKSPACE_SECRET_UNAVAILABLE', { stage: 'llm.resource.save.compensate-secret', resourceId: resource.id });
          }
        }
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
      const prepared = await this.prepareRuntime(DEFAULT_LLM_SETTINGS, { emptyCredentials: true });
      const [healthRecords, toolCapabilities] = await Promise.all([
        this.queryAll('resource-health'),
        this.queryAll('tool-capabilities'),
      ]);
      const operations: WorkspaceCommitOperation[] = [
        { action: 'delete', collection: 'settings', id: 'global', expectedRevision: this.settingsRevision },
        ...healthRecords.map((record) => ({
          action: 'delete' as const,
          collection: 'resource-health',
          id: record.id,
          expectedRevision: recordRevision(record),
        })),
        ...toolCapabilities.map((record) => ({
          action: 'delete' as const,
          collection: 'tool-capabilities',
          id: record.id,
          expectedRevision: recordRevision(record),
        })),
      ];
      if (operations.length > MAX_TRANSACTION_OPERATIONS) { prepared?.dispose(); throw repositoryError('BACKUP_TOO_LARGE', 'llm.settings.reset'); }
      let removedSecrets: readonly SecretSnapshot[] = [];
      try {
        prepared?.assertCurrent?.();
        removedSecrets = await this.removeAllSecrets('llm.settings.reset.secret');
        try {
          await this.write({ idempotencyKey: operationKey('llm-reset'), operations });
        } catch (error) {
          await this.restoreSecrets(removedSecrets, 'llm.settings.reset.compensate-secret');
          throw error;
        }
        this.settingsRevision = 0;
        this.settings = this.settingsFrom(DEFAULT_LLM_SETTINGS);
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

  subscribeSettings(listener: (settings: PersistedSettings) => void): () => void {
    let active = true;
    this.listeners.add(listener);
    if (this.initializationState === 'ready') queueMicrotask(() => { if (active) listener(structuredClone(this.settings)); });
    else void this.ready().catch(() => undefined);
    return () => { active = false; this.listeners.delete(listener); };
  }
  subscribeChanges(listener: (kinds: readonly LogKind[]) => void): () => void { this.changeListeners.add(listener); return () => this.changeListeners.delete(listener); }

  async getResourceSecret(resourceId: string): Promise<string | null> {
    await this.ready();
    return (await this.requireSecrets().get({ workspaceId: LLM_WORKSPACE_ID, secretId: credentialId(resourceId) }))?.value ?? null;
  }
  async hasResourceSecret(resourceId: string): Promise<boolean> { return (await this.getResourceSecret(resourceId)) !== null; }

  async listResourceHealth(): Promise<readonly ResourceHealthRecord[]> {
    await this.ready();
    return (await this.queryAll('resource-health')).map((record) => validateResourceHealth(record.value));
  }

  async saveResourceHealth(value: ResourceHealthRecord): Promise<ResourceHealthRecord> {
    return this.enqueue(async () => {
      await this.ready();
      const health = validateResourceHealth(asPlain(value));
      const previous = await this.read({ collection: 'resource-health', id: health.resourceId });
      await this.write({
        idempotencyKey: operationKey('llm-resource-health'),
        operations: [{
          action: 'put',
          collection: 'resource-health',
          id: health.resourceId,
          value: asPlain(health),
          expectedRevision: recordRevision(previous),
        }],
      });
      return structuredClone(health);
    });
  }

  async listToolCapabilities(): Promise<readonly StoredToolCapabilityRecord[]> {
    return this.enqueue(async () => {
      await this.ready();
      const records = await this.queryAll('tool-capabilities');
      const valid: StoredToolCapabilityRecord[] = [];
      const invalid: WorkspaceRecord[] = [];
      for (const record of records) {
        if (/^fnv1a64:[0-9a-f]{16}$/u.test(record.id)
          && LLM_RESOURCE_CAPABILITY_VERIFY_V0.validateResponse?.({ resourceId: (record.value as Record<string, unknown>).resourceId, taskKeys: [], capabilities: [record.value] }) === true) {
          valid.push(validateToolCapability(record.id, record.value));
        } else invalid.push(record);
      }
      for (let index = 0; index < invalid.length; index += MAX_TRANSACTION_OPERATIONS) {
        const batch = invalid.slice(index, index + MAX_TRANSACTION_OPERATIONS);
        await this.write({
          idempotencyKey: operationKey('llm-tool-capability-prune'),
          operations: batch.map((record) => ({
            action: 'delete' as const,
            collection: 'tool-capabilities',
            id: record.id,
            expectedRevision: recordRevision(record),
          })),
        });
      }
      return valid;
    });
  }

  async saveToolCapability(cacheKey: string, value: VerifiedToolCapabilities): Promise<StoredToolCapabilityRecord> {
    return this.enqueue(async () => {
      await this.ready();
      const stored = validateToolCapability(cacheKey, asPlain(value));
      const previous = await this.read({ collection: 'tool-capabilities', id: cacheKey });
      await this.write({
        idempotencyKey: operationKey('llm-tool-capability'),
        operations: [{
          action: 'put',
          collection: 'tool-capabilities',
          id: cacheKey,
          value: asPlain(stored.capability),
          expectedRevision: recordRevision(previous),
        }],
      });
      return structuredClone(stored);
    });
  }

  async deleteToolCapabilitiesForResource(resourceId: string): Promise<number> {
    return this.enqueue(async () => {
      await this.ready();
      const records = (await this.queryAll('tool-capabilities')).filter((record) => {
        const value = record.value as Record<string, PlainData>;
        return value.resourceId === resourceId;
      });
      if (!records.length) return 0;
      const result = await this.write({
        idempotencyKey: operationKey('llm-tool-capability-delete'),
        operations: records.map((record) => ({
          action: 'delete' as const,
          collection: 'tool-capabilities',
          id: record.id,
          expectedRevision: recordRevision(record),
        })),
      });
      return result.results.filter((item) => item.removed !== false).length;
    });
  }

  async setResourceSecret(resourceId: string, value: string, _metadata: PlainData = {}): Promise<WorkspaceCredentialMetadata> {
    return this.enqueue(async () => {
      await this.ready();
      const normalized = value.trim();
      if (!normalized || normalized.length > 65_536) throw repositoryError('INVALID_PAYLOAD', 'llm.secret.validate');
      const prepared = await this.prepareRuntime(this.settings, { credentialOverrides: { [resourceId]: normalized } });
      try {
        prepared?.assertCurrent?.();
        const result = await this.requireSecrets().set({ workspaceId: LLM_WORKSPACE_ID, secretId: credentialId(resourceId), value: normalized, metadata: _metadata });
        prepared?.commit();
        this.notifyChanges(['generation', 'embedding', 'rerank']);
        return { secretId: result.secretId, maskedValue: result.maskedValue, updatedAt: result.updatedAt, keyVersion: 1 };
      } catch (error) {
        prepared?.dispose();
        throw error;
      }
    });
  }

  async deleteResourceSecret(resourceId: string): Promise<boolean> {
    return this.enqueue(async () => {
      await this.ready();
      const current = await this.requireSecrets().get({ workspaceId: LLM_WORKSPACE_ID, secretId: credentialId(resourceId) });
      if (current === null) return false;
      const prepared = await this.prepareRuntime(this.settings, { credentialOverrides: { [resourceId]: null } });
      try {
        prepared?.assertCurrent?.();
        const deleted = await this.requireSecrets().delete({ workspaceId: LLM_WORKSPACE_ID, secretId: credentialId(resourceId) });
        if (!deleted) {
          throw createSSHelperError('WORKSPACE_SECRET_UNAVAILABLE', {
            stage: 'llm.secret.delete',
            resourceId,
          });
        }
        prepared?.commit();
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
      const resourcePolicies = { ...(this.settings.resourcePolicies ?? {}) };
      delete resourcePolicies[resourceId];
      const next = this.settingsFrom({ ...this.settings, resources: (this.settings.resources ?? []).filter((resource) => resource.id !== resourceId), resourcePolicies });
      const prepared = await this.prepareRuntime(next, { credentialOverrides: { [resourceId]: null } });
      const health = await this.read({ collection: 'resource-health', id: resourceId });
      const toolCapabilities = (await this.queryAll('tool-capabilities')).filter((record) => {
        const value = record.value as Record<string, PlainData>;
        return value.resourceId === resourceId;
      });
      const secrets = this.requireSecrets();
      const secretId = credentialId(resourceId);
      const previousSecret = await secrets.get({ workspaceId: LLM_WORKSPACE_ID, secretId });
      const operations: WorkspaceCommitOperation[] = [
        { action: 'put', collection: 'settings', id: 'global', value: asPlain(next), expectedRevision: this.settingsRevision },
        ...(health === null ? [] : [{ action: 'delete' as const, collection: 'resource-health', id: resourceId, expectedRevision: recordRevision(health) }]),
        ...toolCapabilities.map((record) => ({ action: 'delete' as const, collection: 'tool-capabilities', id: record.id, expectedRevision: recordRevision(record) })),
      ];
      let secretDeleted = false;
      try {
        prepared?.assertCurrent?.();
        if (previousSecret !== null) {
          const deleted = await secrets.delete({ workspaceId: LLM_WORKSPACE_ID, secretId });
          if (!deleted) {
            throw createSSHelperError('WORKSPACE_SECRET_UNAVAILABLE', {
              stage: 'llm.resource.delete.secret',
              resourceId,
            });
          }
          secretDeleted = true;
        }
        let result;
        try {
          result = await this.write({ idempotencyKey: operationKey('llm-resource-delete'), operations });
        } catch (error) {
          if (secretDeleted && previousSecret !== null) {
            try {
              await secrets.set({
                workspaceId: LLM_WORKSPACE_ID,
                secretId,
                value: previousSecret.value,
                ...(previousSecret.metadata === undefined ? {} : { metadata: previousSecret.metadata }),
              });
            } catch {
              throw createSSHelperError('WORKSPACE_SECRET_UNAVAILABLE', {
                stage: 'llm.resource.delete.compensate-secret',
                resourceId,
              });
            }
          }
          throw error;
        }
        this.settingsRevision = result.results[0]?.revision ?? this.settingsRevision + 1;
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
    return (await this.requireSecrets().list({ workspaceId: LLM_WORKSPACE_ID })).map((record) => ({ ...record, keyVersion: 1 as const }));
  }

  async exportConfig(): Promise<{ archive: PlainData; sha256: string }> {
    await this.ready();
    const consumers = await this.loadConsumers();
    const archive: LLMConfigArchiveV0 = { format: 'ss-helper-llm-config', version: 0, settings: asPlain(this.settings), consumers: asPlain(consumers) };
    const archiveBytes = new TextEncoder().encode(JSON.stringify(archive)).byteLength;
    if (archiveBytes > MAX_ARCHIVE_BYTES) throw repositoryError('BACKUP_TOO_LARGE', 'llm.backup.export');
    return { archive: asPlain(archive), sha256: await sha256Json(archive) };
  }

  async importConfig(archive: PlainData, sha256: string): Promise<void> {
    return this.enqueue(async () => {
      await this.ready();
      if (await sha256Json(archive) !== sha256) throw repositoryError('BACKUP_INTEGRITY_INVALID', 'llm.backup.import');
      const value = archive as unknown as Partial<LLMConfigArchiveV0>;
      if (value.format !== 'ss-helper-llm-config' || value.version !== 0 || !value.settings || !value.consumers || typeof value.consumers !== 'object' || Array.isArray(value.consumers)) throw repositoryError('BACKUP_FORMAT_INVALID', 'llm.backup.import');
      const archiveBytes = new TextEncoder().encode(JSON.stringify(archive)).byteLength;
      if (archiveBytes > MAX_ARCHIVE_BYTES) throw repositoryError('BACKUP_TOO_LARGE', 'llm.backup.import');
      const settings = validateLlmSettings(value.settings);
      const consumerInput = value.consumers as Record<string, PlainData>;
      const consumerIds = Object.keys(consumerInput);
      if (consumerIds.length > MAX_CONSUMERS || consumerIds.some((id) => !id.trim() || id.length > 256)) throw repositoryError('BACKUP_TOO_LARGE', 'llm.backup.import');
      const existingConsumers = await this.queryAll('consumers');
      const existingById = new Map(existingConsumers.map((record) => [record.id, record]));
      const operations: WorkspaceCommitOperation[] = [{ action: 'put', collection: 'settings', id: 'global', value: asPlain(settings), expectedRevision: this.settingsRevision }];
      const keep = new Set(consumerIds);
      existingConsumers.filter((record) => !keep.has(record.id)).forEach((record) => operations.push({ action: 'delete', collection: 'consumers', id: record.id, expectedRevision: recordRevision(record) }));
      for (const [recordId, consumer] of Object.entries(consumerInput)) operations.push({ action: 'put', collection: 'consumers', id: recordId, value: asPlain(consumer), expectedRevision: recordRevision(existingById.get(recordId) ?? null) });
      if (operations.length > MAX_TRANSACTION_OPERATIONS) throw repositoryError('BACKUP_TOO_LARGE', 'llm.backup.import');
      const prepared = await this.prepareRuntime(settings, { emptyCredentials: true });
      let removedSecrets: readonly SecretSnapshot[] = [];
      try {
        prepared?.assertCurrent?.();
        removedSecrets = await this.removeAllSecrets('llm.backup.import.secret');
        let result;
        try {
          result = await this.write({ idempotencyKey: operationKey('llm-import'), operations });
        } catch (error) {
          await this.restoreSecrets(removedSecrets, 'llm.backup.import.compensate-secret');
          throw error;
        }
        this.settingsRevision = result.results[0]?.revision ?? this.settingsRevision + 1;
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
      let removedSecrets: readonly SecretSnapshot[] = [];
      try {
        prepared?.assertCurrent?.();
        removedSecrets = await this.removeAllSecrets('llm.clear.secret');
        try {
          await this.workspace.admin.reset({ idempotencyKey: operationKey('llm-clear') });
        } catch (error) {
          await this.restoreSecrets(removedSecrets, 'llm.clear.compensate-secret');
          throw error;
        }
        this.initialized = undefined;
        this.settingsRevision = 0;
        this.settings = this.settingsFrom(DEFAULT_LLM_SETTINGS);
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
      const logId = String(raw.logId ?? '').trim();
      if (!logId) throw repositoryError('INVALID_PAYLOAD', 'llm.log.validate');
      await this.write({ idempotencyKey: operationKey('llm-log'), operations: [{ action: 'put', collection: 'request-logs', id: logId, value: stored.value }] });
      await this.pruneLogsLocked();
    });
  }

  async sanitizeStoredLogs(): Promise<number> {
    return this.enqueue(async () => {
      await this.ready();
      const records = (await this.queryAll('request-logs')).filter((record) => {
        const value = record.value as Record<string, unknown>;
        const response = value.response && typeof value.response === 'object' && !Array.isArray(value.response)
          ? value.response as Record<string, unknown>
          : undefined;
        const providerResponse = response?.providerResponse && typeof response.providerResponse === 'object' && !Array.isArray(response.providerResponse)
          ? response.providerResponse as Record<string, unknown>
          : undefined;
        return Number(value.logFormatVersion ?? 0) < 3
          || (Object.hasOwn(providerResponse ?? {}, 'debugRequest') && providerResponse?.debugRequest !== '[未记录]');
      });
      let rewritten = 0;
      for (let index = 0; index < records.length; index += MAX_TRANSACTION_OPERATIONS) {
        const batch = records.slice(index, index + MAX_TRANSACTION_OPERATIONS);
        const operations = batch.flatMap(record => {
          const value = record.value as Record<string, unknown>;
          const mode = Number(value.logFormatVersion ?? 0) < 3 ? 'summary' : 'full';
          const stored = buildStoredLog(value, mode);
          return stored ? [{
            action: 'put' as const,
            collection: 'request-logs',
            id: record.id,
            expectedRevision: recordRevision(record),
            value: stored.value,
          }] : [];
        });
        if (!operations.length) continue;
        await this.write({
          idempotencyKey: operationKey('llm-sanitize-logs'),
          operations,
        });
        rewritten += operations.length;
      }
      return rewritten;
    });
  }

  async reconcileInterruptedLogs(): Promise<number> {
    return this.enqueue(async () => {
      await this.ready();
      const records = (await this.queryAll('request-logs')).filter((record) => {
        const state = String((record.value as Record<string, unknown>).state ?? '');
        return state === 'queued' || state === 'running';
      });
      if (!records.length) return 0;
      const finishedAt = Date.now();
      for (let index = 0; index < records.length; index += MAX_TRANSACTION_OPERATIONS) {
        const batch = records.slice(index, index + MAX_TRANSACTION_OPERATIONS);
        await this.write({
          idempotencyKey: operationKey('llm-reconcile-logs'),
          operations: batch.map((record) => {
            const value = record.value as Record<string, PlainData>;
            const response = value.response && typeof value.response === 'object' && !Array.isArray(value.response)
              ? value.response as Record<string, PlainData>
              : {};
            return {
              action: 'put' as const,
              collection: 'request-logs',
              id: record.id,
              expectedRevision: recordRevision(record),
              value: {
                ...value,
                state: 'failed',
                attemptOutcome: '失败',
                isFinalAttempt: true,
                finishedAt,
                response: {
                  ...response,
                  failure: {
                    reasonCode: 'REQUEST_ABORTED',
                    stage: 'llm.log.reconcile',
                    requestId: String(value.requestId ?? record.id),
                  },
                },
              },
            };
          }),
        });
      }
      return records.length;
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
      const result = await this.write({
        idempotencyKey: operationKey('llm-prune-logs'),
        operations: batch.map((record) => ({ action: 'delete' as const, collection: 'request-logs', id: record.id, expectedRevision: recordRevision(record) })),
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
          const records = await this.scan({ collection: 'request-logs', limit: MAX_PAGE_SIZE });
          if (!records.records.length) return removed;
          const result = await this.write({
            idempotencyKey: `${clearOperationId}:${batch}`,
            operations: records.records.map((record) => ({ action: 'delete' as const, collection: 'request-logs', id: record.id, expectedRevision: recordRevision(record) })),
          });
          removed += result.results.filter((item) => item.removed !== false).length;
          batch += 1;
        }
      } catch {
        throw repositoryError('INTERNAL_ERROR', 'llm.log.clear');
      }
    });
  }

  async queryLogs(input: LLMRequestLogQueryOptions = {}): Promise<readonly PlainData[]> {
    await this.ready();
    const filter: Record<string, PlainData> = {};
    if (input.state && input.state !== 'all') filter.state = input.state;
    if (input.sourcePluginId) filter.sourcePluginId = input.sourcePluginId;
    if (input.resourceId) filter.resourceId = input.resourceId;
    if (input.taskKind) filter.taskKind = input.taskKind;
    if (input.model) filter.model = input.model;
    const where = [
      ...(input.fromTs === undefined ? [] : [{ field: 'createdAt', op: 'gte' as const, value: input.fromTs as PlainData }]),
      ...(input.toTs === undefined ? [] : [{ field: 'createdAt', op: 'lte' as const, value: input.toTs as PlainData }]),
    ];
    const records = await this.queryAll('request-logs', {
      filter,
      ...(where.length ? { where } : {}),
      orderBy: { field: 'createdAt', direction: 'desc' },
    });
    const search = String(input.search ?? '').trim().toLowerCase();
    const limit = Math.min(500, Math.max(0, Math.trunc(input.limit ?? 100)));
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    return records
      .map((record) => {
        const value = record.value as Record<string, PlainData>;
        const logId = String(value.logId ?? record.id).trim() || record.id;
        const requestId = String(value.requestId ?? logId).trim() || logId;
        return {
          ...value,
          logId,
          requestId,
          entryKind: value.entryKind ?? 'provider_attempt',
          createdAt: value.createdAt ?? value.finishedAt ?? value.queuedAt ?? record.updatedAt ?? Date.now(),
        } satisfies Record<string, PlainData>;
      })
      .filter((value) => {
        const row = value as Record<string, unknown>;
        const response = row.response && typeof row.response === 'object'
          ? row.response as Record<string, unknown>
          : undefined;
        const failure = response?.failure && typeof response.failure === 'object'
          ? response.failure as Record<string, unknown>
          : undefined;
        if (input.reasonCode && failure?.reasonCode !== input.reasonCode) return false;
        if (input.entryKind && input.entryKind !== 'all' && String(row.entryKind ?? 'provider_attempt') !== input.entryKind) return false;
        const workflow = row.workflow && typeof row.workflow === 'object' && !Array.isArray(row.workflow)
          ? row.workflow as Record<string, unknown>
          : undefined;
        const agentWorkflow = workflow?.workflowKind === 'agent';
        if (input.callScope === 'agent_workflow' && !agentWorkflow) return false;
        if (input.callScope === 'ordinary' && agentWorkflow) return false;
        if (input.workflowId && workflow?.workflowId !== input.workflowId) return false;
        return !search || JSON.stringify(value).toLowerCase().includes(search);
      })
      .slice(offset, offset + limit);
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
        const result = await this.write({ idempotencyKey: operationKey('llm-delete-logs'), operations: batch.map((record) => ({ action: 'delete' as const, collection: 'request-logs', id: record.id, expectedRevision: recordRevision(record) })) });
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
    return Object.fromEntries(records.map((record) => [record.id, record.value]));
  }

  private async saveConsumersLocked(snapshot: Record<string, PlainData>): Promise<void> {
    const ids = Object.keys(snapshot);
    if (ids.length > MAX_CONSUMERS) throw repositoryError('BACKUP_TOO_LARGE', 'llm.consumer.snapshot');
    const existing = await this.queryAll('consumers');
    const existingById = new Map(existing.map((record) => [record.id, record]));
    const keep = new Set(ids);
    const operations: WorkspaceCommitOperation[] = existing.filter((record) => !keep.has(record.id)).map((record) => ({ action: 'delete' as const, collection: 'consumers', id: record.id, expectedRevision: recordRevision(record) }));
    for (const [recordId, value] of Object.entries(snapshot)) operations.push({ action: 'put', collection: 'consumers', id: recordId, value: asPlain(value), expectedRevision: recordRevision(existingById.get(recordId) ?? null) });
    if (operations.length > MAX_TRANSACTION_OPERATIONS) throw repositoryError('BACKUP_TOO_LARGE', 'llm.consumer.snapshot');
    if (operations.length) await this.write({ idempotencyKey: operationKey('llm-consumers'), operations });
  }

  async saveConsumers(snapshot: Record<string, PlainData>): Promise<void> { return this.enqueue(async () => { await this.ready(); await this.saveConsumersLocked(snapshot); }); }
}
