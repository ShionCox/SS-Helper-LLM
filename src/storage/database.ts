import Dexie, { type Table } from 'dexie';

export const LEGACY_DATABASE_NAME = 'SSHelperDatabase';
export const LLM_DATABASE_NAME = 'SSHelperLLMDatabase';
export const LLM_DATABASE_VERSION = 1;
export const CUTOVER_MARKER_KEY = 'llm-cutover-v1';
export const ROLLBACK_BACKUP_KEY = 'llm-rollback-backup-v1';
export const ROLLBACK_EVIDENCE_KEY = 'llm-rollback-v1';

const LEGACY_V4_STORES = {
    chat_documents: '&chatKey, entityKey, updatedAt',
    chat_plugin_state: '&[pluginId+chatKey], pluginId, chatKey, updatedAt',
    chat_plugin_records: '++id, pluginId, chatKey, collection, recordId, ts, updatedAt, [pluginId+chatKey+collection], [pluginId+chatKey+collection+ts]',
    events: '&eventId, chatKey, ts, type, [chatKey+ts], [chatKey+type+ts]',
    templates: '&templateId, chatKey, [chatKey+createdAt], updatedAt',
    audit: '&auditId, chatKey, ts',
    meta: '&chatKey, updatedAt',
    memory_mutation_history: '&historyId, chatKey, [chatKey+ts], ts',
    memory_entry_audit_records: '&auditId, chatKey, entryId, summaryId, actionType, [chatKey+ts], [chatKey+entryId], ts',
    memory_entries: '&entryId, chatKey, [chatKey+entryType], [chatKey+category], [chatKey+updatedAt], updatedAt',
    memory_entry_types: '&typeId, chatKey, [chatKey+key], [chatKey+updatedAt]',
    actor_memory_profiles: '&[chatKey+actorKey], chatKey, actorKey, [chatKey+updatedAt]',
    role_entry_memory: '&roleMemoryId, chatKey, [chatKey+actorKey], [chatKey+entryId], [chatKey+actorKey+entryId], [chatKey+updatedAt]',
    memory_relationships: '&relationshipId, chatKey, [chatKey+sourceActorKey], [chatKey+targetActorKey], [chatKey+sourceActorKey+targetActorKey], [chatKey+updatedAt], updatedAt',
    summary_snapshots: '&summaryId, chatKey, [chatKey+updatedAt]',
    world_profile_bindings: '&chatKey, primaryProfile, updatedAt',
    llm_credentials: '&providerId, updatedAt',
    llm_request_logs: '&logId, requestId, sourcePluginId, sortTs, state, [sourcePluginId+sortTs], [state+sortTs], updatedAt',
} as const;

export interface LlmCredentialRecord {
    providerId: string;
    updatedAt: number;
    apiKeyMasked?: string;
    payload: Record<string, unknown>;
}

export interface LlmRequestLogRecord {
    logId: string;
    requestId: string;
    sourcePluginId: string;
    sortTs: number;
    state: string;
    updatedAt: number;
    [key: string]: unknown;
}

export interface MigrationEvidence {
    key: string;
    state: 'cutover' | 'no-legacy-source' | 'rollback-backup' | 'rolled-back';
    sourceDatabase?: string;
    sourceVersion?: number;
    targetDatabase: string;
    targetVersion: number;
    schemaDigest: string;
    credentialCount: number;
    requestLogCount: number;
    credentialChecksum: string;
    requestLogChecksum: string;
    completedAt: number;
}

export class SSHelperLLMDatabase extends Dexie {
    llm_credentials!: Table<LlmCredentialRecord, string>;
    llm_request_logs!: Table<LlmRequestLogRecord, string>;
    migration_evidence!: Table<MigrationEvidence, string>;

    constructor(name = LLM_DATABASE_NAME) {
        super(name);
        this.version(LLM_DATABASE_VERSION).stores({
            llm_credentials: '&providerId, updatedAt',
            llm_request_logs: '&logId, requestId, sourcePluginId, sortTs, state, [sourcePluginId+sortTs], [state+sortTs], updatedAt',
            migration_evidence: '&key, state, completedAt',
        });
    }
}

export interface MigrationOptions {
    legacyDatabaseName?: string;
    targetDatabaseName?: string;
    legacyVaultDatabaseName?: string;
    faultAt?: 'credentials-copy' | 'logs-copy' | 'parity-check' | 'marker-write';
    rollbackFaultAt?: 'backup-write' | 'credentials-write' | 'logs-write' | 'evidence-write';
}

export interface MigrationResult {
    database: SSHelperLLMDatabase;
    evidence?: MigrationEvidence;
    cutover: boolean;
    fallbackDatabase?: Dexie;
    error?: Error;
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, canonicalize(child)]));
    }
    return value;
}

function checksum(rows: readonly unknown[]): string {
    const text = JSON.stringify([...rows].map(canonicalize).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

function validateCredential(row: unknown): asserts row is LlmCredentialRecord {
    const value = row as Partial<LlmCredentialRecord> | null;
    if (!value || typeof value.providerId !== 'string' || !value.providerId || typeof value.updatedAt !== 'number' || !value.payload || typeof value.payload !== 'object') {
        throw new Error('Invalid legacy llm_credentials record');
    }
}

function validateRequestLog(row: unknown): asserts row is LlmRequestLogRecord {
    const value = row as Partial<LlmRequestLogRecord> | null;
    if (!value || typeof value.logId !== 'string' || !value.logId || typeof value.requestId !== 'string' || typeof value.sourcePluginId !== 'string' || typeof value.sortTs !== 'number' || typeof value.state !== 'string' || typeof value.updatedAt !== 'number') {
        throw new Error('Invalid legacy llm_request_logs record');
    }
}

async function readLegacyVault(name: string): Promise<LlmCredentialRecord[]> {
    if (!(await Dexie.exists(name))) return [];
    const vault = new Dexie(name);
    try {
        await vault.open();
        if (!vault.tables.some((table) => table.name === 'credentials')) return [];
        const rows = await vault.table<Record<string, unknown>, string>('credentials').toArray();
        return rows.map((row) => {
            const providerId = String(row.resourceId ?? row.providerId ?? '');
            const apiKey = String(row.key ?? '');
            return {
                providerId,
                updatedAt: Number(row.updatedAt ?? row.createdAt ?? 0),
                apiKeyMasked: '',
                payload: { apiKey, createdAt: Number(row.createdAt ?? Date.now()) },
            };
        }).filter((row) => row.providerId);
    } finally {
        vault.close();
    }
}

function mergeCredentials(mixedRows: LlmCredentialRecord[], vaultRows: LlmCredentialRecord[]): LlmCredentialRecord[] {
    const merged = new Map<string, LlmCredentialRecord>();
    for (const row of vaultRows) merged.set(row.providerId, row);
    for (const row of mixedRows) {
        const current = merged.get(row.providerId);
        if (!current || row.updatedAt >= current.updatedAt) merged.set(row.providerId, row);
    }
    return [...merged.values()];
}

function schemaSignature(database: Dexie): unknown {
    return database.tables.map((table) => ({
        name: table.name,
        primaryKey: {
            keyPath: table.schema.primKey.keyPath,
            auto: table.schema.primKey.auto,
            unique: table.schema.primKey.unique,
            multi: table.schema.primKey.multi,
        },
        indexes: table.schema.indexes.map((index) => ({
            keyPath: index.keyPath,
            auto: index.auto,
            unique: index.unique,
            multi: index.multi,
        })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    })).sort((left, right) => left.name.localeCompare(right.name));
}

function schemaDigest(database: Dexie): string {
    return checksum([schemaSignature(database)]);
}

function buildEvidence(
    key: string,
    state: MigrationEvidence['state'],
    credentials: LlmCredentialRecord[],
    logs: LlmRequestLogRecord[],
    databases: { sourceDatabase?: string; sourceVersion?: number; target: SSHelperLLMDatabase },
): MigrationEvidence {
    return {
        key,
        state,
        sourceDatabase: databases.sourceDatabase,
        sourceVersion: databases.sourceVersion,
        targetDatabase: databases.target.name,
        targetVersion: databases.target.verno,
        schemaDigest: schemaDigest(databases.target),
        credentialCount: credentials.length,
        requestLogCount: logs.length,
        credentialChecksum: checksum(credentials),
        requestLogChecksum: checksum(logs),
        completedAt: Date.now(),
    };
}

function requireLegacySchema(database: Dexie): void {
    if (database.verno !== 4) throw new Error(`Unsupported legacy database version: ${database.verno}`);
    const expected = new Dexie('__ss_helper_legacy_v4_schema__');
    expected.version(4).stores(LEGACY_V4_STORES);
    try {
        if (JSON.stringify(schemaSignature(database)) !== JSON.stringify(schemaSignature(expected))) {
            throw new Error('Legacy database does not match the frozen version-4 schema');
        }
    } finally {
        expected.close();
    }
}

async function verifyCopiedRows(database: SSHelperLLMDatabase, evidence: MigrationEvidence, logs: readonly LlmRequestLogRecord[]): Promise<void> {
    const copiedCredentials = await database.llm_credentials.toArray();
    const copiedLogs = await database.llm_request_logs.toArray();
    if (checksum(copiedCredentials) !== evidence.credentialChecksum || checksum(copiedLogs) !== evidence.requestLogChecksum) {
        throw new Error('LLM migration parity validation failed');
    }
    for (const log of logs) {
        const bySource = await database.llm_request_logs.where('[sourcePluginId+sortTs]').equals([log.sourcePluginId, log.sortTs]).primaryKeys();
        const byState = await database.llm_request_logs.where('[state+sortTs]').equals([log.state, log.sortTs]).primaryKeys();
        if (!bySource.includes(log.logId) || !byState.includes(log.logId)) throw new Error('LLM migration compound-index validation failed');
    }
}

async function verifyExistingMarker(database: SSHelperLLMDatabase, marker: MigrationEvidence): Promise<void> {
    if (marker.targetDatabase !== database.name || marker.targetVersion !== database.verno || marker.schemaDigest !== schemaDigest(database)) {
        throw new Error('Invalid LLM cutover marker target metadata');
    }
}

export async function migrateLlmDatabase(options: MigrationOptions = {}): Promise<MigrationResult> {
    const legacyName = options.legacyDatabaseName ?? LEGACY_DATABASE_NAME;
    const target = new SSHelperLLMDatabase(options.targetDatabaseName ?? LLM_DATABASE_NAME);
    await target.open();
    const existing = await target.migration_evidence.get(CUTOVER_MARKER_KEY);
    if (existing?.state === 'cutover' || existing?.state === 'no-legacy-source') {
        await verifyExistingMarker(target, existing);
        return { database: target, evidence: existing, cutover: true };
    }

    if (!(await Dexie.exists(legacyName))) {
        const evidence = buildEvidence(CUTOVER_MARKER_KEY, 'no-legacy-source', [], [], { target });
        await target.migration_evidence.put(evidence);
        return { database: target, evidence, cutover: true };
    }

    const legacy = new Dexie(legacyName);
    try {
        await legacy.open();
        requireLegacySchema(legacy);
        const mixedCredentials = await legacy.table<LlmCredentialRecord, string>('llm_credentials').toArray();
        const logs = await legacy.table<LlmRequestLogRecord, string>('llm_request_logs').toArray();
        mixedCredentials.forEach(validateCredential);
        logs.forEach(validateRequestLog);
        const vaultRows = await readLegacyVault(options.legacyVaultDatabaseName ?? 'stx_llm_vault');
        const credentials = mergeCredentials(mixedCredentials, vaultRows);
        credentials.forEach(validateCredential);
        const evidence = buildEvidence(CUTOVER_MARKER_KEY, 'cutover', credentials, logs, {
            sourceDatabase: legacyName,
            sourceVersion: legacy.verno,
            target,
        });

        await target.transaction('rw', target.llm_credentials, target.llm_request_logs, target.migration_evidence, async () => {
            await target.llm_credentials.clear();
            await target.llm_credentials.bulkPut(credentials);
            if (options.faultAt === 'credentials-copy') throw new Error('Injected credentials-copy failure');
            await target.llm_request_logs.clear();
            await target.llm_request_logs.bulkPut(logs);
            if (options.faultAt === 'logs-copy') throw new Error('Injected logs-copy failure');
            if (options.faultAt === 'parity-check') throw new Error('LLM migration parity validation failed');
            await verifyCopiedRows(target, evidence, logs);
            if (options.faultAt === 'marker-write') throw new Error('Injected marker-write failure');
            await target.migration_evidence.put(evidence);
        });
        legacy.close();
        return { database: target, evidence, cutover: true };
    } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        return { database: target, cutover: false, fallbackDatabase: legacy, error };
    }
}

export async function rollbackLlmDatabase(options: MigrationOptions = {}): Promise<MigrationEvidence> {
    const legacyName = options.legacyDatabaseName ?? LEGACY_DATABASE_NAME;
    if (!(await Dexie.exists(legacyName))) throw new Error('Cannot rollback without the legacy database');
    const target = new SSHelperLLMDatabase(options.targetDatabaseName ?? LLM_DATABASE_NAME);
    const legacy = new Dexie(legacyName);
    await Promise.all([target.open(), legacy.open()]);
    try {
        requireLegacySchema(legacy);
        const credentials = await target.llm_credentials.toArray();
        const logs = await target.llm_request_logs.toArray();
        credentials.forEach(validateCredential);
        logs.forEach(validateRequestLog);
        const legacyCredentials = await legacy.table<LlmCredentialRecord, string>('llm_credentials').toArray();
        const legacyLogs = await legacy.table<LlmRequestLogRecord, string>('llm_request_logs').toArray();
        const backup = buildEvidence(ROLLBACK_BACKUP_KEY, 'rollback-backup', legacyCredentials, legacyLogs, {
            sourceDatabase: legacyName,
            sourceVersion: legacy.verno,
            target,
        });
        if (options.rollbackFaultAt === 'backup-write') throw new Error('Injected backup-write failure');
        await target.migration_evidence.put(backup);
        await legacy.transaction('rw', legacy.table('llm_credentials'), legacy.table('llm_request_logs'), async () => {
            await legacy.table('llm_credentials').clear();
            await legacy.table('llm_credentials').bulkPut(credentials);
            if (options.rollbackFaultAt === 'credentials-write') throw new Error('Injected credentials-write failure');
            await legacy.table('llm_request_logs').clear();
            await legacy.table('llm_request_logs').bulkPut(logs);
            if (options.rollbackFaultAt === 'logs-write') throw new Error('Injected logs-write failure');
        });
        if (options.rollbackFaultAt === 'evidence-write') throw new Error('Injected evidence-write failure');
        const evidence = buildEvidence(ROLLBACK_EVIDENCE_KEY, 'rolled-back', credentials, logs, {
            sourceDatabase: legacyName,
            sourceVersion: legacy.verno,
            target,
        });
        await target.migration_evidence.put(evidence);
        return evidence;
    } finally {
        legacy.close();
        target.close();
    }
}

let activeMigration: Promise<MigrationResult> | undefined;
export function getActiveLlmStorage(): Promise<MigrationResult> {
    activeMigration ??= migrateLlmDatabase();
    return activeMigration;
}
