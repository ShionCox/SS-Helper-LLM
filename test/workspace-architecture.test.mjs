import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LLM_SETTINGS_SCHEMA,
  LlmWorkspaceRepository,
  LLM_WORKSPACE_ID,
  createProviderFromResource,
} from '../dist/index.js';

class MemoryWorkspace {
  constructor() { this.records = new Map(); this.secrets = new Map(); this.collections = []; this.version = 1; }
  key(collection, recordId) { return `${collection}:${recordId}`; }
  async health() { return { ready: true, database: 'ss-helper.sqlite3', schemaVersion: 3, secretReady: true }; }
  async integrity() { return { ok: true, messages: ['ok'] }; }
  async open({ workspaceId }) { assert.equal(workspaceId, LLM_WORKSPACE_ID); return { ownerPluginId: 'ss-helper.llm', workspaceId, created: true, version: this.version }; }
  async defineCollection({ name }) { this.collections.push(name); }
  async get({ collection = 'default', recordId }) { const record = this.records.get(this.key(collection, recordId)); return record ? structuredClone(record) : null; }
  async upsert({ collection = 'default', recordId, value, expectedVersion }) {
    const key = this.key(collection, recordId); const previous = this.records.get(key);
    if (expectedVersion !== undefined && previous?.version !== expectedVersion) { const error = new Error('conflict'); error.code = 'WORKSPACE_CONFLICT'; throw error; }
    const record = { recordId, value: structuredClone(value), version: (previous?.version ?? 0) + 1, updatedAt: Date.now() }; this.records.set(key, record); return structuredClone(record);
  }
  async delete({ collection = 'default', recordId, expectedVersion }) { const key = this.key(collection, recordId); const previous = this.records.get(key); if (expectedVersion !== undefined && previous?.version !== expectedVersion) { const error = new Error('conflict'); error.code = 'WORKSPACE_CONFLICT'; throw error; } return this.records.delete(key); }
  async query({ collection = 'default', filter = {}, limit = 1000 }) { const values = [...this.records.entries()].filter(([key, record]) => key.startsWith(`${collection}:`) && Object.entries(filter).every(([field, value]) => record.value?.[field] === value)).map(([, record]) => structuredClone(record)); return { records: values.slice(0, limit), nextCursor: null }; }
  async transaction({ operations }) { const snapshot = new Map(this.records); const results = []; try { for (const operation of operations) { if (operation.action === 'upsert') { const record = await this.upsert(operation); results.push({ collection: operation.collection ?? 'default', recordId: record.recordId, action: 'upsert', version: record.version }); } else { const removed = await this.delete(operation); results.push({ collection: operation.collection ?? 'default', recordId: operation.recordId, action: 'delete', removed }); } } return { operationCount: results.length, replayed: false, results }; } catch (error) { this.records = snapshot; throw error; } }
  async secretSet({ workspaceId, secretId, value, metadata }) { const item = { secretId, value, metadata, maskedValue: `••••${value.slice(-2)}`, updatedAt: Date.now(), keyVersion: 1 }; this.secrets.set(`${workspaceId}:${secretId}`, item); return { ...item, value: undefined }; }
  async secretGet({ workspaceId, secretId }) { return this.secrets.get(`${workspaceId}:${secretId}`) ?? null; }
  async secretDelete({ workspaceId, secretId }) { return this.secrets.delete(`${workspaceId}:${secretId}`); }
  async secretList({ workspaceId }) { return [...this.secrets.values()].filter((item) => item.secretId.startsWith('resource:')).map(({ value, ...metadata }) => metadata); }
  async clearOwned() { const count = this.records.size; this.records.clear(); this.secrets.clear(); return count; }
  async exportAll() { return { archive: { format: 'ss-helper-workspace-owner', version: 1, ownerPluginId: 'ss-helper.llm', exportedAt: Date.now(), workspaces: [] }, sha256: 'fixture' }; }
  async importAll() {}
}

test('settings schema exposes five progressive pages and generic popup actions', () => {
  const sections = LLM_SETTINGS_SCHEMA.fields.filter((field) => field.kind === 'section');
  assert.deepEqual(sections.map((section) => section.label), ['开始', '资源', '路由', '运行', '诊断']);
  const fields = sections.flatMap((section) => section.children);
  assert.ok(fields.some((field) => field.id === 'globalProfile'));
  assert.ok(fields.some((field) => field.id === 'detailedLogs'));
  assert.ok(fields.filter((field) => field.kind === 'action').length >= 10);
});

test('LLM repository uses the shared workspace, encrypted Secret boundary and redacted logs', async () => {
  const workspace = new MemoryWorkspace();
  const repository = new LlmWorkspaceRepository(workspace);
  await repository.ready();
  assert.ok(workspace.collections.includes('request-logs'));
  await repository.saveSettings({ enabled: true, detailedLogs: false, globalProfile: 'economy' });
  assert.equal((await repository.loadSettings()).globalProfile, 'economy');
  await repository.setResourceSecret('resource-test', 'secret-value', { label: 'Test' });
  assert.equal(await repository.getResourceSecret('resource-test'), 'secret-value');
  await repository.saveLog({ request: { taskKind: 'generation', taskDescription: 'hidden prompt', metrics: { total: 1 }, body: 'must not persist' }, response: { meta: { resourceId: 'resource-test' }, body: 'hidden response' }, state: 'completed', sourcePluginId: 'fixture' });
  const logs = await repository.queryLogs({ sourcePluginId: 'fixture' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].request.body, undefined);
  assert.equal(logs[0].response.body, undefined);
  assert.equal((await repository.listSecrets()).length, 1);
  await repository.clearAll();
  assert.equal(await repository.getResourceSecret('resource-test'), undefined);
  await repository.saveSettings({ enabled: true, globalProfile: 'precise' });
  assert.equal((await repository.loadSettings()).globalProfile, 'precise');
});

test('provider factory covers custom generation and rerank resources', () => {
  const openai = createProviderFromResource({ id: 'openai', type: 'generation', source: 'custom', apiType: 'openai', label: 'OpenAI', baseUrl: 'https://example.invalid/v1', model: 'gpt' }, 'key');
  const rerank = createProviderFromResource({ id: 'rerank', type: 'rerank', source: 'custom', apiType: 'generic', label: 'Rerank', baseUrl: 'https://example.invalid', model: 'rank' }, 'key');
  assert.equal(openai.id, 'openai');
  assert.equal(rerank.id, 'rerank');
  openai.dispose?.(); rerank.dispose?.();
});
