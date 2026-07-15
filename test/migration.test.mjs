import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import Dexie from 'dexie';
import {
  CUTOVER_MARKER_KEY,
  ROLLBACK_BACKUP_KEY,
  ROLLBACK_EVIDENCE_KEY,
  migrateLlmDatabase,
  rollbackLlmDatabase,
} from '../dist/src/storage/database.js';

const names = new Set();

async function createLegacy(name) {
  names.add(name);
  const db = new Dexie(name);
  db.version(4).stores({
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
  });
  await db.open();
  await db.table('llm_credentials').put({ providerId: 'provider-a', updatedAt: 10, apiKeyMasked: 'mask', payload: { apiKey: 'secret' } });
  await db.table('llm_request_logs').put({ logId: 'log-a', requestId: 'request-a', sourcePluginId: 'consumer-a', sortTs: 20, state: 'completed', updatedAt: 20, payload: { ok: true } });
  await db.table('chat_documents').put({ chatKey: 'keep', entityKey: 'unrelated', updatedAt: 1, payload: { untouched: true } });
  return db;
}

test.afterEach(async () => {
  for (const name of names) await Dexie.delete(name);
  names.clear();
});

test('v4 cutover is non-destructive, validated, indexed and idempotent', async () => {
  const legacyName = `legacy-success-${Date.now()}`;
  const targetName = `target-success-${Date.now()}`;
  const vaultName = `vault-missing-${Date.now()}`;
  names.add(targetName);
  const legacy = await createLegacy(legacyName);
  const before = {
    version: legacy.verno,
    unrelated: await legacy.table('chat_documents').toArray(),
    credentials: await legacy.table('llm_credentials').toArray(),
    logs: await legacy.table('llm_request_logs').toArray(),
  };
  legacy.close();

  const result = await migrateLlmDatabase({ legacyDatabaseName: legacyName, targetDatabaseName: targetName, legacyVaultDatabaseName: vaultName });
  assert.equal(result.cutover, true);
  assert.equal(result.evidence?.state, 'cutover');
  assert.equal(result.evidence?.sourceVersion, 4);
  assert.equal(result.evidence?.sourceDatabase, legacyName);
  assert.equal(result.evidence?.targetDatabase, targetName);
  assert.equal(result.evidence?.targetVersion, 1);
  assert.match(result.evidence?.schemaDigest ?? '', /^[0-9a-f]{8}$/);
  assert.deepEqual(result.database.tables.map(({ name }) => name).sort(), ['llm_credentials', 'llm_request_logs', 'migration_evidence']);
  assert.equal(await result.database.llm_credentials.count(), 1);
  assert.equal((await result.database.llm_request_logs.where('[sourcePluginId+sortTs]').equals(['consumer-a', 20]).toArray()).length, 1);
  assert.equal((await result.database.llm_request_logs.where('[state+sortTs]').equals(['completed', 20]).toArray()).length, 1);
  await result.database.llm_credentials.put({ providerId: 'newer', updatedAt: 99, payload: { apiKey: 'new' } });
  result.database.close();

  const second = await migrateLlmDatabase({ legacyDatabaseName: legacyName, targetDatabaseName: targetName, legacyVaultDatabaseName: vaultName });
  assert.equal(await second.database.llm_credentials.count(), 2, 'valid marker prevents overwrite on second startup');
  second.database.close();

  const reopened = new Dexie(legacyName);
  await reopened.open();
  assert.equal(reopened.verno, before.version);
  assert.deepEqual(await reopened.table('chat_documents').toArray(), before.unrelated);
  assert.deepEqual(await reopened.table('llm_credentials').toArray(), before.credentials);
  assert.deepEqual(await reopened.table('llm_request_logs').toArray(), before.logs);
  reopened.close();
});

test('fault rolls back target transaction and explicit rollback touches only LLM stores', async () => {
  const legacyName = `legacy-fault-${Date.now()}`;
  const targetName = `target-fault-${Date.now()}`;
  const vaultName = `vault-missing-${Date.now()}`;
  names.add(targetName);
  const legacy = await createLegacy(legacyName);
  const unrelated = await legacy.table('chat_documents').toArray();
  legacy.close();

  const failed = await migrateLlmDatabase({ legacyDatabaseName: legacyName, targetDatabaseName: targetName, legacyVaultDatabaseName: vaultName, faultAt: 'marker-write' });
  assert.equal(failed.cutover, false);
  assert.equal(await failed.database.migration_evidence.get(CUTOVER_MARKER_KEY), undefined);
  failed.fallbackDatabase?.close();
  failed.database.close();

  const success = await migrateLlmDatabase({ legacyDatabaseName: legacyName, targetDatabaseName: targetName, legacyVaultDatabaseName: vaultName });
  await success.database.llm_credentials.put({ providerId: 'target-only', updatedAt: 100, payload: { apiKey: 'target' } });
  success.database.close();
  await assert.rejects(
    rollbackLlmDatabase({ legacyDatabaseName: legacyName, targetDatabaseName: targetName, rollbackFaultAt: 'logs-write' }),
    /Injected logs-write failure/,
  );
  const targetAfterFault = new Dexie(targetName);
  await targetAfterFault.open();
  assert.equal((await targetAfterFault.table('migration_evidence').get(CUTOVER_MARKER_KEY)).state, 'cutover');
  assert.ok(await targetAfterFault.table('migration_evidence').get(ROLLBACK_BACKUP_KEY));
  assert.equal(await targetAfterFault.table('migration_evidence').get(ROLLBACK_EVIDENCE_KEY), undefined);
  targetAfterFault.close();

  const evidence = await rollbackLlmDatabase({ legacyDatabaseName: legacyName, targetDatabaseName: targetName });
  assert.equal(evidence.state, 'rolled-back');
  assert.equal(evidence.key, ROLLBACK_EVIDENCE_KEY);

  const reopened = new Dexie(legacyName);
  await reopened.open();
  assert.ok(await reopened.table('llm_credentials').get('target-only'));
  assert.deepEqual(await reopened.table('chat_documents').toArray(), unrelated);
  assert.equal(reopened.verno, 4);
  reopened.close();
});

test('legacy vault merges by updatedAt and mixed database wins ties', async () => {
  const legacyName = `legacy-vault-${Date.now()}`;
  const targetName = `target-vault-${Date.now()}`;
  const vaultName = `vault-${Date.now()}`;
  names.add(targetName);
  names.add(vaultName);
  const legacy = await createLegacy(legacyName);
  await legacy.table('llm_credentials').bulkPut([
    { providerId: 'mixed-newer', updatedAt: 20, payload: { apiKey: 'mixed-new' } },
    { providerId: 'tie', updatedAt: 30, payload: { apiKey: 'mixed-tie' } },
  ]);
  legacy.close();
  const vault = new Dexie(vaultName);
  vault.version(1).stores({ credentials: '&resourceId, updatedAt' });
  await vault.open();
  await vault.table('credentials').bulkPut([
    { resourceId: 'vault-only', updatedAt: 40, key: 'vault-only-key' },
    { resourceId: 'mixed-newer', updatedAt: 10, key: 'vault-old' },
    { resourceId: 'tie', updatedAt: 30, key: 'vault-tie' },
  ]);
  vault.close();

  const result = await migrateLlmDatabase({ legacyDatabaseName: legacyName, targetDatabaseName: targetName, legacyVaultDatabaseName: vaultName });
  assert.equal((await result.database.llm_credentials.get('vault-only')).payload.apiKey, 'vault-only-key');
  assert.equal((await result.database.llm_credentials.get('mixed-newer')).payload.apiKey, 'mixed-new');
  assert.equal((await result.database.llm_credentials.get('tie')).payload.apiKey, 'mixed-tie');
  result.database.close();
});

test('missing legacy source does not create it and records an explicit marker', async () => {
  const legacyName = `legacy-absent-${Date.now()}`;
  const targetName = `target-absent-${Date.now()}`;
  names.add(targetName);
  const result = await migrateLlmDatabase({ legacyDatabaseName: legacyName, targetDatabaseName: targetName });
  assert.equal(result.evidence?.state, 'no-legacy-source');
  assert.equal(await Dexie.exists(legacyName), false);
  result.database.close();
});
