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
  const allFields = LLM_SETTINGS_SCHEMA.fields.flatMap(function flatten(field) {
    return field.kind === 'section' ? [field, ...field.children.flatMap(flatten)] : [field];
  });
  assert.equal(new Set(allFields.map((field) => field.id)).size, allFields.length, 'settings field IDs must be globally unique');
  assert.deepEqual(Object.fromEntries(sections.map((section) => [section.id, section.children.map((field) => field.label)])), {
    start: ['服务状态', '生成偏好', '请求与展示'],
    resources: ['资源管理', '能力测试'],
    routing: ['路由配置', '高级配置'],
    runtime: ['额度与任务', '权限与展示'],
    diagnostics: ['检查与日志', '数据管理', '关于'],
  });
  assert.ok(allFields.some((field) => field.id === 'globalProfile'));
  assert.ok(allFields.some((field) => field.id === 'detailedLogs'));

  const actions = sections.flatMap((section) => section.children.flatMap(function flatten(field) {
    if (field.kind === 'section') return field.children.flatMap(flatten);
    return field.kind === 'action' ? [{ ...field, tabId: section.id }] : [];
  }));
  const expectedActions = {
    resourceWizard: ['resources', 'open-resource-wizard', 'resource-wizard', '打开向导'],
    resourceManager: ['resources', 'open-resource-manager', 'resource-manager', '打开'],
    rerankTest: ['resources', 'open-rerank-test', 'rerank-test', '开始测试'],
    routeManager: ['routing', 'open-route-manager', 'route-manager', '配置'],
    routePreview: ['routing', 'open-route-preview', 'route-preview', '预览'],
    advanced: ['routing', 'open-advanced', 'advanced-routing', '编辑'],
    budgetManager: ['runtime', 'open-budget-manager', 'budget-manager', '配置'],
    queueManager: ['runtime', 'open-queue-manager', 'queue-manager', '查看'],
    permissionManager: ['runtime', 'open-permission-manager', 'permission-manager', '配置'],
    displayRules: ['runtime', 'open-display-rules', 'display-rules', '配置'],
    serviceDiagnostics: ['diagnostics', 'open-diagnostics', 'diagnostics', '运行检查'],
    requestLogs: ['diagnostics', 'open-request-logs', 'request-logs', '查看'],
    backup: ['diagnostics', 'open-backup', 'backup', '管理'],
    reset: ['diagnostics', 'reset-llm', 'reset-confirm', '重置'],
  };
  assert.equal(actions.length, 14);
  assert.deepEqual(Object.fromEntries(actions.map((field) => [field.id, [field.tabId, field.actionId, field.popup?.name, field.buttonLabel]])), expectedActions);
  assert.ok(actions.every((field) => field.placement === 'inline'));
  assert.equal(actions.find((field) => field.id === 'reset')?.tone, 'danger');
});

test('LLM repository uses the shared workspace, encrypted Secret boundary and redacted logs', async () => {
  const workspace = new MemoryWorkspace();
  const repository = new LlmWorkspaceRepository(workspace);
  await repository.ready();
  assert.ok(workspace.collections.includes('request-logs'));
  const expectedDefaults = { enabled: true, globalProfile: 'balanced', maxTokensMode: 'adaptive', maxTokens: 2048, timeoutMs: 60000, resultDisplay: 'auto', detailedLogs: false };
  const settingsDefaults = (settings) => Object.fromEntries(Object.keys(expectedDefaults).map((key) => [key, settings[key]]));
  const initialSettings = await repository.loadSettings();
  assert.deepEqual(settingsDefaults(initialSettings), expectedDefaults);
  assert.equal(Object.hasOwn(initialSettings, 'resources'), false);
  await repository.saveSettings({ ...initialSettings, resources: [{ id: 'plain-resource', type: 'generation', source: 'custom', label: 'Plain', enabled: false }] });
  assert.equal(Object.hasOwn((await repository.loadSettings()).resources[0], 'customParams'), false);
  await repository.saveSettings({ enabled: true, detailedLogs: false, globalProfile: 'economy', maxTokensMode: 'manual', maxTokens: 4096 });
  assert.equal((await repository.loadSettings()).globalProfile, 'economy');
  assert.deepEqual(settingsDefaults(await repository.reset()), expectedDefaults);
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
  assert.deepEqual(settingsDefaults(await repository.loadSettings()), expectedDefaults);
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
