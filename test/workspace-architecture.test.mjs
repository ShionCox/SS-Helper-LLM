import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LLM_SETTINGS_SCHEMA,
  LlmWorkspaceRepository,
  LLM_WORKSPACE_ID,
  createProductionLlmServices,
  createProviderFromResource,
  createWorkspaceLlmSettingsAdapter,
  GenerationSourceController,
} from '../dist/index.js';

function flattenSettingsFields(fields) {
  return fields.flatMap((field) => field.kind === 'section' ? flattenSettingsFields(field.children) : [field]);
}

function assertSettingsValuesMatchSchema(values) {
  const fields = flattenSettingsFields(LLM_SETTINGS_SCHEMA.fields)
    .filter((field) => field.kind !== 'action' && field.kind !== 'status');
  assert.deepEqual(Object.keys(values).sort(), fields.map((field) => field.id).sort());
  for (const field of fields) {
    const value = values[field.id];
    if (field.kind === 'toggle' || field.kind === 'checkbox') assert.equal(typeof value, 'boolean', field.id);
    else if (field.kind === 'select' || field.kind === 'radio') assert.equal(field.options.some((option) => option.value === value), true, field.id);
    else if (field.kind === 'number' || field.kind === 'range') {
      assert.equal(typeof value, 'number', field.id);
      const min = field.kind === 'range' ? field.min : field.validation?.min;
      const max = field.kind === 'range' ? field.max : field.validation?.max;
      if (min !== undefined) assert.ok(value >= min, field.id);
      if (max !== undefined) assert.ok(value <= max, field.id);
    }
  }
}

class MemoryWorkspace {
  constructor() {
    this.records = new Map(); this.collections = []; this.version = 1; this.transactionKeys = []; this.failNextTransaction = false;
    this.admin = {
      health: async () => ({ ready: true, status: 'ready', database: 'ss-helper.sqlite3', schemaVersion: 0 }),
      integrity: async () => ({ ok: true, messages: ['ok'] }),
      reset: async () => { const count = this.records.size; this.records.clear(); return count; },
    };
  }
  key(collection, recordId) { return `${collection}:${recordId}`; }
  async open({ id, schema }) {
    assert.equal(id, LLM_WORKSPACE_ID);
    this.collections.push(...schema.collections.map((item) => item.name));
    return this;
  }
  async get(collection, id) { const record = this.records.get(this.key(collection, id)); return record ? structuredClone(record) : null; }
  async put({ collection, id, value, expectedRevision }) {
    const key = this.key(collection, id); const previous = this.records.get(key);
    const currentRevision = previous?.revision ?? 0;
    if (expectedRevision !== undefined && currentRevision !== expectedRevision) { const error = new Error('conflict'); error.code = 'WORKSPACE_CONFLICT'; throw error; }
    const record = { id, value: structuredClone(value), revision: currentRevision + 1, updatedAt: Date.now() }; this.records.set(key, record); return structuredClone(record);
  }
  async remove({ collection, id, expectedRevision }) { const key = this.key(collection, id); const previous = this.records.get(key); const currentRevision = previous?.revision ?? 0; if (expectedRevision !== undefined && currentRevision !== expectedRevision) { const error = new Error('conflict'); error.code = 'WORKSPACE_CONFLICT'; throw error; } return this.records.delete(key); }
  async query(collection, { filter = {}, limit = 1000, cursor } = {}) { const values = [...this.records.entries()].filter(([key, record]) => key.startsWith(`${collection}:`) && Object.entries(filter).every(([field, value]) => record.value?.[field] === value)).map(([, record]) => structuredClone(record)); const offset = cursor ? Number(cursor) : 0; const page = values.slice(offset, offset + limit); return { records: page, nextCursor: offset + page.length < values.length ? String(offset + page.length) : null }; }
  async commit({ operations, idempotencyKey }) { this.transactionKeys.push(idempotencyKey); if (this.failNextTransaction) { this.failNextTransaction = false; const error = new Error('injected transaction failure'); error.code = 'WORKSPACE_FAILURE'; throw error; } const snapshot = new Map(this.records); const results = []; try { for (const operation of operations) { if (operation.action === 'put') { const record = await this.put(operation); results.push({ collection: operation.collection, id: record.id, action: 'put', revision: record.revision }); } else { const removed = await this.remove(operation); results.push({ collection: operation.collection, id: operation.id, action: 'delete', revision: (snapshot.get(this.key(operation.collection, operation.id))?.revision ?? 0) + (removed ? 1 : 0), removed }); } } return { requestId: idempotencyKey, replayed: false, results }; } catch (error) { this.records = snapshot; throw error; } }
}

test('permanent invalid settings stop runtime retries and explicit repository recovery restores nested output limits', async () => {
  const workspace = new MemoryWorkspace();
  let opens = 0;
  const open = workspace.open.bind(workspace);
  workspace.open = async input => { opens++; return open(input); };
  const original = { enabled: true, generationSource: 'tavern' };
  workspace.records.set('settings:global', { id: 'global', value: original, revision: 1, updatedAt: 0 });
  const repository = new LlmWorkspaceRepository(workspace, new MemorySecrets());
  let actualMaxTokens;
  const handlers = createProductionLlmServices({
    host: { has: () => false, generation: { available: async () => true, current: async () => ({ provider: 'openai', model: 'fixture' }), generate: async request => { actualMaxTokens = request.maxTokens; return { text: 'ok', model: 'fixture' }; } } },
    events: { publish() {}, subscribe() { return () => {}; } },
  }, { repository });
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    const stopped = opens;
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(opens, stopped);
    assert.deepEqual(workspace.records.get('settings:global').value, original);
    workspace.records.set('settings:global', { id: 'global', value: { enabled: true, maxTokensControl: { mode: 'manual', manualValue: 12345 } }, revision: 2, updatedAt: 1 });
    await repository.ready();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await handlers.completion({ messages: [{ role: 'user', content: 'fixture' }] }, new AbortController().signal)).text, 'ok');
    assert.equal(actualMaxTokens, 12345);
  } finally { handlers.dispose?.(); }
});

test('repository retries a failed first initialization and broadcasts one authoritative snapshot after recovery', async () => {
  class RetryWorkspace extends MemoryWorkspace {
    constructor() { super(); this.openAttempts = 0; this.lifecycle = []; }
    async open(input) {
      this.openAttempts += 1;
      this.lifecycle.push(`open:${this.openAttempts}`);
      if (this.openAttempts === 1) { const error = new Error('bridge warming'); error.code = 'HOST_NOT_READY'; throw error; }
      const result = await super.open(input);
      input.schema.collections.forEach((item) => this.lifecycle.push(`define:${item.name}`));
      return result;
    }
    async get(collection, id) { this.lifecycle.push(`get:${collection}:${id}`); return super.get(collection, id); }
  }

  const workspace = new RetryWorkspace();
  const repository = new LlmWorkspaceRepository(workspace, new MemorySecrets());
  await assert.rejects(repository.ready(), { code: 'HOST_NOT_READY' });
  const snapshots = [];
  const unsubscribe = repository.subscribeSettings((settings) => snapshots.push(settings));
  await repository.ready();
  await Promise.resolve();

  assert.equal(workspace.openAttempts, 2);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].globalProfile, 'balanced');
  assert.ok(workspace.lifecycle.indexOf('define:settings') < workspace.lifecycle.indexOf('get:settings:global'), 'settings must not be read before its collection exists');
  unsubscribe();
});

test('settings adapter exposes only schema fields and preserves popup-managed configuration on save', async () => {
  const workspace = new MemoryWorkspace();
  const repository = new LlmWorkspaceRepository(workspace, new MemorySecrets());
  await repository.saveSettings({
    ...(await repository.loadSettings()),
    resources: [{ id: 'embed-main', type: 'embedding', source: 'custom', apiType: 'openai', label: 'Embedding', model: 'text-embedding-3-small', enabled: true }],
    globalAssignments: { embedding: { resourceId: 'embed-main' } },
  });
  const statusSource = {
    async loadStatus() { return {}; },
    subscribeStatus() { return () => {}; },
    async refreshNow() {},
  };
  const adapter = createWorkspaceLlmSettingsAdapter(repository, statusSource);
  const loaded = await adapter.load();
  assertSettingsValuesMatchSchema(loaded);
  assert.equal(Object.hasOwn(loaded, 'resources'), false);
  assert.equal(Object.hasOwn(loaded, 'requestLogging'), false);

  const snapshots = [];
  const unsubscribe = adapter.subscribe((values) => snapshots.push(values));
  await Promise.resolve();
  assertSettingsValuesMatchSchema(snapshots.at(-1));

  await adapter.save({ ...loaded, globalProfile: 'precise', maxTokensMode: 'manual', maxTokens: 12288, maxRequestsPerMinute: 30, 'requestLogging.maxBytesMb': 64 });
  const stored = await repository.loadSettings();
  assert.equal(stored.globalProfile, 'precise');
  assert.deepEqual(stored.maxTokensControl, { mode: 'manual', manualValue: 12288 });
  assert.equal(stored.maxRequestsPerMinute, 30);
  assert.equal(stored.requestLogging.maxBytes, 64 * 1024 * 1024);
  assert.equal(stored.resources[0].id, 'embed-main');
  assert.equal(stored.globalAssignments.embedding.resourceId, 'embed-main');

  const reset = await adapter.reset();
  assertSettingsValuesMatchSchema(reset);
  unsubscribe();
});

test('atomic settings mutations merge independent callers and reject a stale same-revision write', async () => {
  const repository = new LlmWorkspaceRepository(new MemoryWorkspace(), new MemorySecrets());
  await repository.ready();
  await Promise.all([
    repository.updateSettings((current) => ({ ...current, globalProfile: 'economy' })),
    repository.updateSettings((current) => ({ ...current, timeoutMs: 12_345 })),
  ]);
  const merged = await repository.loadSettings();
  assert.equal(merged.globalProfile, 'economy');
  assert.equal(merged.timeoutMs, 12_345);
  const expectedRevision = 2;
  const first = repository.updateSettings((current) => ({ ...current, maxTokens: 4_096 }), { expectedRevision });
  const second = repository.updateSettings((current) => ({ ...current, maxTokens: 8_192 }), { expectedRevision });
  await first;
  await assert.rejects(second, (error) => error?.code === 'CONFLICT' || error?.details?.reasonCode === 'WORKSPACE_CONFLICT');
  assert.equal((await repository.loadSettings()).maxTokensControl.manualValue, 4_096);
});

class MemorySecrets {
  constructor() { this.records = new Map(); this.failRead = false; this.failNextDelete = false; this.returnFalseNextDelete = false; this.failNextSet = false; }
  async set({ secretId, value, metadata }) { if (this.failNextSet) { this.failNextSet = false; const error = new Error('secret write failed'); error.code = 'WORKSPACE_FAILURE'; throw error; } const record = { secretId, value, metadata, maskedValue: `••••${value.slice(-2)}`, updatedAt: Date.now(), keyVersion: 0 }; this.records.set(secretId, record); return { ...record, value: undefined }; }
  async get({ secretId }) { if (this.failRead) { const error = new Error('secret read failed'); error.code = 'WORKSPACE_FAILURE'; throw error; } const record = this.records.get(secretId); return record ? structuredClone(record) : null; }
  async delete({ secretId }) { if (this.failNextDelete) { this.failNextDelete = false; const error = new Error('secret delete failed'); error.code = 'WORKSPACE_FAILURE'; throw error; } if (this.returnFalseNextDelete) { this.returnFalseNextDelete = false; return false; } return this.records.delete(secretId); }
  async list() { return [...this.records.values()].map(({ value, ...record }) => structuredClone(record)); }
}

test('settings schema exposes five progressive pages and generic popup actions', () => {
  const sections = LLM_SETTINGS_SCHEMA.fields.filter((field) => field.kind === 'section');
  assert.deepEqual(sections.map((section) => section.label), ['开始', '资源', '路由', '运行', '诊断']);
  const allFields = LLM_SETTINGS_SCHEMA.fields.flatMap(function flatten(field) {
    return field.kind === 'section' ? [field, ...field.children.flatMap(flatten)] : [field];
  });
  assert.equal(new Set(allFields.map((field) => field.id)).size, allFields.length, 'settings field IDs must be globally unique');
  assert.deepEqual(Object.fromEntries(sections.map((section) => [section.id, section.children.map((field) => field.label)])), {
    start: ['服务状态', '生成偏好', '高级：请求与展示', '模型来源'],
    resources: ['资源管理', '能力测试'],
    routing: ['通用路由', '高级配置'],
    runtime: ['额度与任务'],
    diagnostics: ['检查与日志', '日志记录策略', '数据管理', '关于'],
  });
  assert.ok(allFields.some((field) => field.id === 'globalProfile'));
  assert.equal(allFields.find((field) => field.id === 'tavernStatus')?.label, '大语言模型');
  assert.equal(allFields.some((field) => field.id === 'generationSource'), false);
  assert.deepEqual(
    [allFields.find((field) => field.id === 'streamingEnabled')?.kind, allFields.find((field) => field.id === 'streamingEnabled')?.defaultValue],
    ['toggle', true],
  );
  assert.deepEqual(
    [allFields.find((field) => field.id === 'maxRequestsPerMinute')?.kind, allFields.find((field) => field.id === 'maxRequestsPerMinute')?.defaultValue],
    ['number', 0],
  );
  assert.equal(allFields.some((field) => field.id === 'detailedLogs'), false);
  assert.equal(allFields.find((field) => field.id === 'requestLogging.detailMode')?.defaultValue, 'full');

  const actions = sections.flatMap((section) => section.children.flatMap(function flatten(field) {
    if (field.kind === 'section') return field.children.flatMap(flatten);
    return field.kind === 'action' ? [{ ...field, tabId: section.id }] : [];
  }));
  const expectedActions = {
    resourceWizard: ['resources', 'open-resource-wizard', 'resource-wizard', '打开向导'],
    resourceManager: ['resources', 'open-resource-manager', 'resource-manager', '打开'],
    rerankTest: ['resources', 'open-rerank-test', 'rerank-test', '开始测试'],
    routePreview: ['routing', 'open-route-preview', 'route-preview', '预览'],
    defaultRoutes: ['routing', 'open-default-routes', 'default-routes', '选择'],
    budgetManager: ['runtime', 'open-budget-manager', 'budget-manager', '配置'],
    serviceDiagnostics: ['diagnostics', 'open-diagnostics', 'diagnostics', '运行检查'],
    requestLogs: ['diagnostics', 'open-request-logs', 'request-logs', '查看'],
    generationSourceConfig: ['start', 'open-generation-source', 'generation-source', '设置'],
    backup: ['diagnostics', 'open-backup', 'backup', '管理'],
    reset: ['diagnostics', 'reset-llm', 'reset-confirm', '重置'],
  };
  assert.equal(actions.length, 11);
  assert.deepEqual(Object.fromEntries(actions.map((field) => [field.id, [field.tabId, field.actionId, field.popup?.name, field.buttonLabel]])), expectedActions);
  assert.ok(actions.every((field) => field.placement === 'inline'));
  assert.equal(actions.find((field) => field.id === 'reset')?.tone, 'danger');
});

test('generation source popup lists enabled custom resources without secrets and persists the selected default', async () => {
  let settings = {
    enabled: true,
    globalAssignments: { generation: { resourceId: 'tavern:active' } },
    resources: [
      { id: 'custom-main', type: 'generation', source: 'custom', apiType: 'openai', label: '自定义主模型', model: 'gpt-test', baseUrl: 'https://secret.example/v1', enabled: true },
      { id: 'disabled', type: 'generation', source: 'custom', apiType: 'generic', label: '停用资源', model: 'disabled', enabled: false },
      { id: 'embed', type: 'embedding', source: 'custom', apiType: 'openai', label: '向量', model: 'embed', enabled: true },
    ],
  };
  let closed = false;
  const repository = {
    async loadSettings() { return structuredClone(settings); },
    async updateSettings(mutator) { settings = structuredClone(mutator(structuredClone(settings))); return structuredClone(settings); },
    async saveSettings(next) { settings = structuredClone(next); return structuredClone(settings); },
  };
  const controller = await GenerationSourceController.create(repository, { close() { closed = true; } });
  const options = controller.snapshot().fieldOptions.resourceId;
  assert.deepEqual(options, [{ value: 'custom-main', label: '自定义主模型 · openai · gpt-test' }]);
  assert.equal(options[0].label.includes('https://'), false);
  controller.change('sourceKind', 'custom');
  controller.change('resourceId', 'custom-main');
  await controller.submit();
  assert.equal(settings.globalAssignments.generation.resourceId, 'custom-main');
  assert.equal(closed, true);
});

test('generation source popup refuses custom mode when no enabled generation resource exists', async () => {
  let settings = { enabled: true, globalAssignments: { generation: { resourceId: 'tavern:active' } }, resources: [] };
  const repository = {
    async loadSettings() { return structuredClone(settings); },
    async updateSettings(mutator) { settings = structuredClone(mutator(structuredClone(settings))); return structuredClone(settings); },
    async saveSettings(next) { settings = structuredClone(next); return structuredClone(settings); },
  };
  const controller = await GenerationSourceController.create(repository, { close() {} });
  controller.change('sourceKind', 'custom');
  assert.equal(controller.snapshot().submitDisabled, true);
  await controller.submit();
  assert.equal(settings.globalAssignments.generation.resourceId, 'tavern:active');
  assert.equal(controller.snapshot().status?.tone, 'error');
});

test('LLM browser repository summary policy keeps semantic metadata and excludes prompts, responses and credentials', async () => {
  const workspace = new MemoryWorkspace();
  const secrets = new MemorySecrets();
  const repository = new LlmWorkspaceRepository(workspace, secrets);
  await repository.ready();
  const expectedDefaults = { enabled: true, streamingEnabled: true, maxRequestsPerMinute: 0, globalProfile: 'balanced', maxTokensControl: { mode: 'adaptive', manualValue: 2048 }, timeoutMs: 60000 };
  const settingsDefaults = (settings) => Object.fromEntries(Object.keys(expectedDefaults).map((key) => [key, settings[key]]));
  const initialSettings = await repository.loadSettings();
  assert.deepEqual(settingsDefaults(initialSettings), expectedDefaults);
  assert.equal(Object.hasOwn(initialSettings, 'resources'), false);
  await assert.rejects(repository.saveSettings({ ...initialSettings, resources: [{ id: 'plain-resource', type: 'generation', source: 'custom', apiType: 'auto', label: 'Plain', model: 'plain-model', enabled: false }] }), { code: 'INVALID_PAYLOAD' });
  await repository.saveSettings({ ...initialSettings, resources: [{ id: 'plain-resource', type: 'generation', source: 'custom', apiType: 'generic', label: 'Plain', model: 'plain-model', enabled: false }] });
  assert.equal(Object.hasOwn((await repository.loadSettings()).resources[0], 'customParams'), false);
  await repository.saveSettings({ enabled: true, globalProfile: 'economy', maxTokensMode: 'manual', maxTokens: 4096 });
  assert.equal((await repository.loadSettings()).globalProfile, 'economy');
  assert.deepEqual(settingsDefaults(await repository.reset()), expectedDefaults);
  await repository.saveSettings({ requestLogging: { enabled: true, detailMode: 'summary', maxEntries: 500, retentionDays: 30, maxBytes: 100 * 1024 * 1024 } });
  await repository.setResourceSecret('resource-test', 'secret-value', { label: 'Test' });
  assert.equal([...workspace.records.values()].some((record) => JSON.stringify(record.value).includes('secret-value')), false, 'new keys must never be written to the plaintext workspace collection');
  assert.equal(secrets.records.get('resource:resource-test')?.value, 'secret-value');
  assert.equal(await repository.hasResourceSecret('resource-test'), true);
  assert.equal(await repository.getResourceSecret('resource-test'), 'secret-value');
  await repository.saveLog({ logId: 'fixture-log', requestId: 'fixture-request', attemptId: 'fixture-attempt', taskDescription: '测试用途', request: { taskKind: 'generation', schemaHash: 'fnv1a32:1234abcd', generationInput: { body: 'must persist' }, headers: { authorization: 'Bearer secret-value' } }, response: { meta: { resourceId: 'resource-test' }, body: 'visible response' }, state: 'completed', sourcePluginId: 'fixture' });
  const logs = await repository.queryLogs({ sourcePluginId: 'fixture' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].contentMode, 'summary');
  assert.equal(logs[0].logFormatVersion, 3);
  assert.equal(logs[0].taskDescription, '测试用途');
  assert.equal(logs[0].request.schemaHash, 'fnv1a32:1234abcd');
  const persistedLog = JSON.stringify(logs[0]);
  assert.equal(persistedLog.includes('must persist'), false);
  assert.equal(persistedLog.includes('visible response'), false);
  assert.equal(persistedLog.includes('secret-value'), false);
  await assert.rejects(
    repository.saveSettings({ budgets: { fixture: { maxCost: 1 } } }),
    (error) => error?.code === 'INVALID_PAYLOAD'
      && error?.details?.reasonCode === 'INVALID_PAYLOAD'
      && error?.details?.stage === 'llm.settings.validate',
  );
  await repository.saveSettings({ resources: [{ id: 'http', type: 'generation', source: 'custom', apiType: 'openai', label: 'HTTP', baseUrl: 'http://provider.example', model: 'http-model', enabled: false }] });
  await assert.rejects(repository.saveSettings({ resources: [{ id: 'unsafe-url', type: 'generation', source: 'custom', apiType: 'openai', label: 'Unsafe', baseUrl: 'https://user:pass@provider.example/v1?token=secret', model: 'unsafe-model', enabled: false }] }), { code: 'INVALID_PAYLOAD' });
  assert.equal((await repository.listSecrets()).length, 1);
  const exported = await repository.exportConfig();
  assert.equal(Object.hasOwn(exported.archive.settings, 'generationSource'), false);
  assert.equal(JSON.stringify(exported).includes('secret-value'), false);
  await repository.importConfig(exported.archive, exported.sha256);
  assert.equal(Object.hasOwn(await repository.loadSettings(), 'generationSource'), false);
  assert.equal(await repository.hasResourceSecret('resource-test'), false);
  await repository.clearAll();
  assert.equal(await repository.hasResourceSecret('resource-test'), false);
  assert.deepEqual(settingsDefaults(await repository.loadSettings()), expectedDefaults);
  await repository.saveSettings({ enabled: true, globalProfile: 'precise' });
  assert.equal((await repository.loadSettings()).globalProfile, 'precise');
});

test('resource health is strictly validated, persisted independently, and can commit atomically with settings', async () => {
  const workspace = new MemoryWorkspace();
  const repository = new LlmWorkspaceRepository(workspace, new MemorySecrets());
  await repository.ready();
  assert.ok(workspace.collections.includes('resource-health'));
  const success = { resourceId: 'resource-health-a', state: 'success', checkedAt: 1_700_000_000_000, durationMs: 321 };
  await repository.saveResourceHealth(success);
  assert.deepEqual(await repository.listResourceHealth(), [success]);
  await assert.rejects(repository.saveResourceHealth({ ...success, state: 'failed', reasonCode: 'private response' }), { code: 'INVALID_PAYLOAD' });

  const settings = await repository.loadSettings();
  const failed = {
    resourceId: 'resource-health-b',
    state: 'failed',
    checkedAt: 1_700_000_000_100,
    durationMs: 654,
    failure: { reasonCode: 'AUTH_FAILED', stage: 'llm.resource.test', resourceId: 'resource-health-b' },
  };
  await repository.saveSettings({ ...settings, globalProfile: 'precise' }, { resourceHealth: failed });
  assert.equal((await repository.loadSettings()).globalProfile, 'precise');
  assert.deepEqual((await repository.listResourceHealth()).find((record) => record.resourceId === failed.resourceId), failed);

  workspace.failNextTransaction = true;
  await assert.rejects(repository.saveSettings({ ...(await repository.loadSettings()), globalProfile: 'economy' }, {
    resourceHealth: { resourceId: failed.resourceId, state: 'success', checkedAt: failed.checkedAt + 1, durationMs: 1 },
  }), { code: 'WORKSPACE_FAILURE' });
  assert.equal((await repository.loadSettings()).globalProfile, 'precise');
  assert.equal((await repository.listResourceHealth()).find((record) => record.resourceId === failed.resourceId).state, 'failed');
});

test('provider factory covers direct browser generation and rerank resources', () => {
  const openai = createProviderFromResource({ id: 'openai', type: 'generation', source: 'custom', apiType: 'openai', label: 'OpenAI', baseUrl: 'https://example.invalid/v1', model: 'gpt' }, 'secret-value');
  const rerank = createProviderFromResource({ id: 'rerank', type: 'rerank', source: 'custom', apiType: 'generic', label: 'Rerank', baseUrl: 'https://example.invalid', model: 'rank' }, 'secret-value');
  assert.equal(openai.id, 'openai');
  assert.equal(rerank.id, 'rerank');
  openai.dispose?.(); rerank.dispose?.();
});

test('xAI resources use the official endpoint and OpenAI-compatible tool transport', async () => {
  const calls = [];
  const xai = createProviderFromResource({
    id: 'xai', type: 'generation', source: 'custom', apiType: 'xai', label: 'xAI', model: 'grok-model',
  }, 'secret-value', async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ data: [{ id: 'grok-model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.equal(xai.apiType, 'xai');
  assert.equal(xai.createToolAdapter().dialect, 'openai_chat_compatible');
  assert.equal((await xai.listModels()).ok, true);
  assert.deepEqual(calls, ['https://api.x.ai/v1/models']);
  xai.dispose?.();
});

test('tool capability snapshots are strictly persisted without provider payloads and removed with their resource', async () => {
  const workspace = new MemoryWorkspace();
  const repository = new LlmWorkspaceRepository(workspace, new MemorySecrets());
  await repository.ready();
  assert.ok(workspace.collections.includes('tool-capabilities'));
  const capability = {
    status: 'failed', resourceId: 'tool-resource', model: 'tool-model', dialect: 'openai_chat_compatible',
    parallelToolCalls: false, streamingToolCalls: 'whole_call', strictToolSchema: 'unsupported', reasoningReplay: 'none',
    verifiedAt: 1_700_000_000_000, expiresAt: 1_700_000_600_000, probeVersion: 2,
    failure: { reasonCode: 'LLM_MODEL_PROBE_FAILED', stage: 'llm.tools.capability_probe', requestId: 'request:probe', resourceId: 'tool-resource', model: 'tool-model' },
  };
  await repository.saveToolCapability('fnv1a64:0123456789abcdef', capability);
  workspace.records.set('tool-capabilities:fnv1a64:fedcba9876543210', {
    id: 'fnv1a64:fedcba9876543210',
    value: { ...capability, failure: undefined, failureCode: 'PROVIDER_UNAVAILABLE' },
    revision: 1,
    updatedAt: Date.now(),
  });
  assert.deepEqual(await repository.listToolCapabilities(), [{ cacheKey: 'fnv1a64:0123456789abcdef', capability }]);
  assert.equal(workspace.records.has('tool-capabilities:fnv1a64:fedcba9876543210'), false, 'invalid cache rows must be removed without blocking valid snapshots');
  assert.doesNotMatch(JSON.stringify(workspace.records.get('tool-capabilities:fnv1a64:0123456789abcdef')?.value), /api[_-]?key|authorization|provider response/iu);
  await assert.rejects(repository.saveToolCapability('unsafe-key', capability), { code: 'INVALID_PAYLOAD' });

  await repository.saveSettings({ resources: [{ id: 'tool-resource', type: 'generation', source: 'custom', apiType: 'openai', label: 'Tool', model: 'tool-model', enabled: true }] });
  await repository.deleteResource('tool-resource');
  assert.deepEqual(await repository.listToolCapabilities(), []);
});

test('embedding resources use the configured operation path and dimensions', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestedBody;
  globalThis.fetch = async (input, init = {}) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const embedding = createProviderFromResource({
      id: 'embedding', type: 'embedding', source: 'custom', apiType: 'openai', label: 'Embedding',
      baseUrl: 'https://provider.example/v1', model: 'embed-model', embeddingPath: '/custom/embeddings', embeddingDimensions: 3,
    }, 'embedding-secret');
    const response = await embedding.embed({ texts: ['hello'] });
    assert.equal(requestedUrl, 'https://provider.example/v1/custom/embeddings');
    assert.deepEqual(requestedBody, { model: 'embed-model', input: ['hello'], dimensions: 3 });
    assert.deepEqual(response.embeddings, [[0.1, 0.2, 0.3]]);
    embedding.dispose?.();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat and native rerank resource protocols both expose rerank execution', () => {
  const chat = createProviderFromResource({ id: 'chat-rerank', type: 'rerank', source: 'custom', apiType: 'deepseek', label: 'Chat rank', baseUrl: 'https://provider.example/v1', model: 'deepseek-chat', rerankProtocol: 'chat' }, 'secret');
  const native = createProviderFromResource({ id: 'native-rerank', type: 'rerank', source: 'custom', apiType: 'generic', label: 'Native rank', baseUrl: 'https://provider.example', model: 'rank', rerankProtocol: 'native', rerankPath: '/rank' }, 'secret');
  assert.equal(typeof chat.rerank, 'function');
  assert.equal(typeof native.rerank, 'function');
  assert.equal(chat.capabilities.rerank, true);
  assert.equal(native.capabilities.rerank, true);
  chat.dispose?.(); native.dispose?.();
});

test('request log policy supports summary mode and prunes by count', async () => {
  const workspace = new MemoryWorkspace();
  const repository = new LlmWorkspaceRepository(workspace, new MemorySecrets());
  await repository.saveSettings({ requestLogging: { enabled: true, detailMode: 'summary', maxEntries: 2, retentionDays: 3650, maxBytes: 1024 * 1024 } });
  for (let index = 0; index < 3; index += 1) {
    await repository.saveLog({ logId: `log-${index}`, requestId: `request-${index}`, state: 'completed', sourcePluginId: 'fixture', taskKey: 'memory.extract', taskKind: 'generation', request: { taskKind: 'generation', generationInput: { messages: [{ content: `private-${index}` }] }, metrics: { inputCharCount: 10 } }, response: { rawResponseText: `raw-${index}`, meta: { resourceId: 'resource-test', model: 'model-test' } }, createdAt: Date.now() + index });
  }
  const logs = await repository.queryLogs({ limit: 10 });
  assert.equal(logs.length, 2);
  assert.equal(logs[0].contentMode, 'summary');
  assert.equal(logs[0].request.generationInput, undefined);
  assert.equal(logs.some((row) => row.logId === 'log-0'), false);
  const stats = await repository.getLogStats();
  assert.equal(stats.count, 2);
  assert.equal(stats.policy.maxEntries, 2);
});

test('request log reason filtering is applied before limit and offset', async () => {
  const workspace = new MemoryWorkspace();
  const repository = new LlmWorkspaceRepository(workspace, new MemorySecrets());
  await repository.ready();
  for (let index = 0; index < 120; index += 1) {
    const reasonCode = index >= 110 ? 'AUTH_FAILED' : 'RATE_LIMITED';
    workspace.records.set(`request-logs:filter-${index}`, {
      id: `filter-${index}`,
      value: {
        logId: `filter-${index}`,
        createdAt: index,
        response: { failure: { reasonCode } },
      },
      revision: 1,
      updatedAt: index,
    });
  }
  const logs = await repository.queryLogs({ reasonCode: 'AUTH_FAILED', limit: 3, offset: 2 });
  assert.equal(logs.length, 3);
  assert.ok(logs.every((row) => row.response.failure.reasonCode === 'AUTH_FAILED'));
});

test('explicit legacy log sanitization rewrites once to the current summary allowlist', async () => {
  const workspace = new MemoryWorkspace();
  const repository = new LlmWorkspaceRepository(workspace, new MemorySecrets());
  await repository.ready();
  await workspace.put({
    collection: 'request-logs',
    id: 'legacy-log',
    value: {
      logId: 'legacy-log',
      requestId: 'legacy-request',
      attemptId: 'legacy-attempt',
      sourcePluginId: 'fixture',
      state: 'completed',
      taskKind: 'generation',
      request: { taskKind: 'generation', generationInput: { messages: [{ content: 'PROMPT_SENTINEL' }] } },
      response: { rawResponseText: 'MODEL_SENTINEL', providerResponse: { content: 'PROVIDER_SENTINEL' } },
      logFormatVersion: 2,
      createdAt: 1,
    },
  });
  assert.equal(await repository.sanitizeStoredLogs(), 1);
  assert.equal(await repository.sanitizeStoredLogs(), 0);
  const [log] = await repository.queryLogs({ sourcePluginId: 'fixture' });
  const serialized = JSON.stringify(log);
  assert.equal(log.logFormatVersion, 3);
  assert.equal(serialized.includes('PROMPT_SENTINEL'), false);
  assert.equal(serialized.includes('MODEL_SENTINEL'), false);
  assert.equal(serialized.includes('PROVIDER_SENTINEL'), false);
});

test('Workspace mutations use unique idempotency keys even when the clock is frozen', async () => {
  const workspace = new MemoryWorkspace();
  const repository = new LlmWorkspaceRepository(workspace, new MemorySecrets());
  const originalNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    await repository.saveSettings({ enabled: true, globalProfile: 'economy' });
    await repository.saveSettings({ enabled: true, globalProfile: 'precise' });
  } finally {
    Date.now = originalNow;
  }
  assert.equal((await repository.loadSettings()).globalProfile, 'precise');
  const settingsKeys = workspace.transactionKeys.filter((key) => key?.startsWith('llm-settings:'));
  assert.equal(settingsKeys.length, 2);
  assert.equal(new Set(settingsKeys).size, 2);
});

test('settings validation rejects coercion and malformed nested routing values', async () => {
  const repository = new LlmWorkspaceRepository(new MemoryWorkspace(), new MemorySecrets());
  await repository.saveSettings({ resources: [{ id: 'xai-ok', type: 'generation', source: 'custom', apiType: 'xai', label: 'xAI', baseUrl: 'https://api.x.ai/v1', model: 'grok-model' }] });
  assert.equal((await repository.loadSettings()).resources[0].apiType, 'xai');
  await assert.rejects(repository.saveSettings({ enabled: 'false' }), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(repository.saveSettings({ globalProfile: 'unknown' }), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(repository.saveSettings({ generationSource: 'automatic' }), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(repository.saveSettings({ maxRequestsPerMinute: -1 }), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(repository.saveSettings({ maxRequestsPerMinute: 1.5 }), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(repository.saveSettings({ resources: [{ id: 'bad', type: 'generation', source: 'custom', label: 'Bad', enabled: 'false' }] }), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(repository.saveSettings({ globalAssignments: { generation: { resourceId: 42 } } }), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(repository.saveSettings({ resources: [{ id: 'bad-embed', type: 'embedding', source: 'custom', apiType: 'deepseek', label: 'Bad embed', embeddingPath: '/embeddings' }] }), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(repository.saveSettings({ resources: [{ id: 'bad-xai-embed', type: 'embedding', source: 'custom', apiType: 'xai', label: 'Bad xAI embed', embeddingPath: '/embeddings' }] }), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(repository.saveSettings({ resources: [{ id: 'bad-xai-rerank', type: 'rerank', source: 'custom', apiType: 'xai', label: 'Bad xAI rerank', rerankProtocol: 'native', rerankPath: '/rerank' }] }), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(repository.saveSettings({ resources: [{ id: 'bad-rerank', type: 'rerank', source: 'custom', apiType: 'generic', label: 'Bad rerank', rerankProtocol: 'native', rerankPath: 'https://wrong.example/rerank' }] }), { code: 'INVALID_PAYLOAD' });
  assert.equal((await repository.loadSettings()).globalProfile, 'balanced');
});

test('stored log sanitization removes Provider request echoes without discarding full response diagnostics', async () => {
  const workspace = new MemoryWorkspace();
  const repository = new LlmWorkspaceRepository(workspace, new MemorySecrets());
  await repository.ready();
  await workspace.put({
    collection: 'request-logs',
    id: 'unsafe-current-log',
    value: {
      logId: 'unsafe-current-log', requestId: 'unsafe-current-request', sourcePluginId: 'fixture',
      state: 'failed', taskKind: 'generation', contentMode: 'full', logFormatVersion: 3, createdAt: 2,
      response: {
        rawResponseText: 'VISIBLE_MODEL_RESPONSE',
        providerResponse: { content: 'VISIBLE_PROVIDER_RESPONSE', debugRequest: { payload: { messages: [{ content: 'PROMPT_ECHO_SENTINEL' }] } } },
        parsedResponse: { visible: true },
      },
    },
  });
  assert.equal(await repository.sanitizeStoredLogs(), 1);
  assert.equal(await repository.sanitizeStoredLogs(), 0);
  const [log] = await repository.queryLogs({ sourcePluginId: 'fixture' });
  const serialized = JSON.stringify(log);
  assert.equal(log.contentMode, 'full');
  assert.equal(log.response.rawResponseText, 'VISIBLE_MODEL_RESPONSE');
  assert.equal(log.response.providerResponse.content, 'VISIBLE_PROVIDER_RESPONSE');
  assert.equal(log.response.providerResponse.debugRequest, '[未记录]');
  assert.deepEqual(log.response.parsedResponse, { visible: true });
  assert.equal(serialized.includes('PROMPT_ECHO_SENTINEL'), false);
});

test('clearLogs paginates beyond one thousand records and can resume after a failed batch', async () => {
  const workspace = new MemoryWorkspace();
  const repository = new LlmWorkspaceRepository(workspace, new MemorySecrets());
  await repository.ready();
  for (let index = 0; index < 2_501; index += 1) workspace.records.set(`request-logs:seed-${index}`, { id: `seed-${index}`, value: { state: 'completed' }, revision: 1, updatedAt: index });
  assert.equal(await repository.clearLogs(), 2_501);
  assert.equal((await repository.queryLogs({ limit: 500 })).length, 0);
  for (let index = 0; index < 3; index += 1) workspace.records.set(`request-logs:retry-${index}`, { id: `retry-${index}`, value: { state: 'failed' }, revision: 1, updatedAt: index });
  workspace.failNextTransaction = true;
  await assert.rejects(
    repository.clearLogs(),
    (error) => error?.code === 'INTERNAL' && error?.details?.reasonCode === 'INTERNAL_ERROR',
  );
  assert.equal(await repository.clearLogs(), 3);
});

test('config import is atomic and resource deletion removes its credential in one transaction', async () => {
  const workspace = new MemoryWorkspace();
  const secrets = new MemorySecrets();
  const repository = new LlmWorkspaceRepository(workspace, secrets);
  await repository.saveSettings({ enabled: true, globalProfile: 'economy', resources: [{ id: 'resource-a', type: 'generation', source: 'custom', apiType: 'generic', label: 'A', model: 'model-a', enabled: false }] });
  await repository.setResourceSecret('resource-a', 'secret-value');
  await repository.saveResourceHealth({
    resourceId: 'resource-a',
    state: 'failed',
    checkedAt: 1_700_000_000_000,
    durationMs: 50,
    failure: { reasonCode: 'AUTH_FAILED', stage: 'llm.resource.test', resourceId: 'resource-a' },
  });
  const exported = await repository.exportConfig();
  workspace.failNextTransaction = true;
  await assert.rejects(repository.importConfig(exported.archive, exported.sha256), { code: 'WORKSPACE_FAILURE' });
  assert.equal(await repository.getResourceSecret('resource-a'), 'secret-value');
  assert.equal((await repository.loadSettings()).globalProfile, 'economy');
  workspace.failNextTransaction = true;
  await assert.rejects(repository.deleteResource('resource-a'), { code: 'WORKSPACE_FAILURE' });
  assert.equal(await repository.getResourceSecret('resource-a'), 'secret-value');
  assert.equal((await repository.loadSettings()).resources?.some((resource) => resource.id === 'resource-a'), true);
  assert.equal((await repository.listResourceHealth()).some((record) => record.resourceId === 'resource-a'), true);
  secrets.failNextDelete = true;
  await assert.rejects(repository.deleteResource('resource-a'), { code: 'WORKSPACE_FAILURE' });
  assert.equal(await repository.getResourceSecret('resource-a'), 'secret-value');
  assert.equal((await repository.loadSettings()).resources?.some((resource) => resource.id === 'resource-a'), true);
  assert.equal((await repository.listResourceHealth()).some((record) => record.resourceId === 'resource-a'), true);
  secrets.returnFalseNextDelete = true;
  await assert.rejects(
    repository.deleteResource('resource-a'),
    (error) => error?.code === 'CORE_UNAVAILABLE'
      && error?.details?.reasonCode === 'WORKSPACE_SECRET_UNAVAILABLE'
      && error?.details?.stage === 'llm.resource.delete.secret',
  );
  assert.equal(await repository.getResourceSecret('resource-a'), 'secret-value');
  assert.equal((await repository.loadSettings()).resources?.some((resource) => resource.id === 'resource-a'), true);
  assert.equal((await repository.listResourceHealth()).some((record) => record.resourceId === 'resource-a'), true);
  await repository.deleteResource('resource-a');
  assert.equal(await repository.getResourceSecret('resource-a'), null);
  assert.equal((await repository.loadSettings()).resources?.some((resource) => resource.id === 'resource-a'), false);
  assert.equal((await repository.listResourceHealth()).some((record) => record.resourceId === 'resource-a'), false);
});

test('resource deletion restores the credential when the Workspace commit fails after secret deletion', async () => {
  const workspace = new MemoryWorkspace();
  const secrets = new MemorySecrets();
  const repository = new LlmWorkspaceRepository(workspace, secrets);
  await repository.saveSettings({
    enabled: true,
    resources: [{ id: 'resource-compensated', type: 'generation', source: 'custom', apiType: 'openai', label: 'Compensated', model: 'compensated-model', enabled: false }],
  });
  await repository.setResourceSecret('resource-compensated', 'secret-value', { label: 'Compensated' });
  workspace.failNextTransaction = true;

  await assert.rejects(repository.deleteResource('resource-compensated'), { code: 'WORKSPACE_FAILURE' });
  assert.equal(await repository.getResourceSecret('resource-compensated'), 'secret-value');
  assert.deepEqual(secrets.records.get('resource:resource-compensated')?.metadata, { label: 'Compensated' });
  assert.equal((await repository.loadSettings()).resources?.some((resource) => resource.id === 'resource-compensated'), true);
});

test('bulk secret removal restores earlier keys and leaves Workspace settings unchanged when a later delete returns false', async () => {
  const workspace = new MemoryWorkspace();
  const secrets = new MemorySecrets();
  const repository = new LlmWorkspaceRepository(workspace, secrets);
  await repository.saveSettings({ enabled: true, globalProfile: 'precise' });
  await repository.setResourceSecret('resource-a', 'secret-a', { label: 'A' });
  await repository.setResourceSecret('resource-b', 'secret-b', { label: 'B' });
  const originalDelete = secrets.delete.bind(secrets);
  let deleteCount = 0;
  secrets.delete = async (input) => {
    deleteCount += 1;
    if (deleteCount === 2) return false;
    return originalDelete(input);
  };

  await assert.rejects(
    repository.reset(),
    (error) => error?.code === 'CORE_UNAVAILABLE'
      && error?.details?.reasonCode === 'WORKSPACE_SECRET_UNAVAILABLE'
      && error?.details?.stage === 'llm.settings.reset.secret',
  );
  assert.equal((await repository.loadSettings()).globalProfile, 'precise');
  assert.equal(await repository.getResourceSecret('resource-a'), 'secret-a');
  assert.equal(await repository.getResourceSecret('resource-b'), 'secret-b');
  assert.deepEqual(secrets.records.get('resource:resource-a')?.metadata, { label: 'A' });
});

test('runtime preparation failure leaves persisted settings and the active runtime unchanged', async () => {
  const workspace = new MemoryWorkspace();
  const secrets = new MemorySecrets();
  const repository = new LlmWorkspaceRepository(workspace, secrets);
  const session = {
    host: { generation: { available: async () => false, current: async () => ({}) }, has: () => false },
    events: { publish() {}, subscribe() { return () => {}; } },
  };
  const handlers = createProductionLlmServices(session, { repository });
  await repository.ready();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const resource = { id: 'resource-runtime', type: 'generation', source: 'custom', apiType: 'openai', label: 'Runtime', baseUrl: 'https://provider.example/v1', model: 'gpt', enabled: true, capabilities: ['chat', 'json'] };
  await repository.saveSettings({ enabled: true, globalProfile: 'balanced', resources: [resource], globalAssignments: { generation: { resourceId: resource.id } } });
  await repository.setResourceSecret(resource.id, 'runtime-secret');
  secrets.failRead = true;
  await assert.rejects(
    repository.saveSettings({ ...(await repository.loadSettings()), globalProfile: 'economy' }),
    (error) => error?.code === 'INTERNAL' && error?.details?.reasonCode === 'INTERNAL_ERROR',
  );
  secrets.failRead = false;
  assert.equal((await repository.loadSettings()).globalProfile, 'balanced');
  handlers.dispose?.();
});

test('execution defaults switch between the dynamic Tavern resource and an explicit custom resource', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push({ kind: 'custom', input: String(input) });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'custom-ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const workspace = new MemoryWorkspace();
  const repository = new LlmWorkspaceRepository(workspace, new MemorySecrets());
  let tavernCurrent = { provider: 'openai', model: 'tavern-model' };
  const session = {
    host: {
      generation: {
        available: async () => true,
        current: async () => tavernCurrent,
        models: async () => ['tavern-model'],
        generate: async () => { calls.push({ kind: 'tavern' }); return { text: 'tavern-ok', model: 'tavern-model' }; },
        test: async () => ({ text: 'ok', model: 'tavern-model' }),
      },
      has: () => false,
      events: { subscribe() { return () => {}; } },
    },
    events: { publish() {}, subscribe() { return () => {}; } },
  };
  const handlers = createProductionLlmServices(session, { repository });
  const signal = new AbortController().signal;
  try {
    await repository.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await handlers.completion({ messages: [{ role: 'user', content: 'one' }] }, signal)).text, 'tavern-ok');
    tavernCurrent = { provider: 'novel' };
    const providerOnly = await handlers.taskStatus({}, 'ss-helper.memory');
    assert.equal(providerOnly.resources.find((item) => item.resourceId === 'tavern:active')?.available, true);

    const resource = { id: 'custom-generation', type: 'generation', source: 'custom', apiType: 'openai', label: 'Custom', baseUrl: 'https://provider.example/v1', model: 'custom-model', enabled: true, capabilities: ['chat', 'json'] };
    const currentSettings = await repository.loadSettings();
    await repository.saveSettings({ ...currentSettings, resources: [resource], globalAssignments: { ...(currentSettings.globalAssignments ?? {}), generation: { resourceId: resource.id } } });
    await assert.rejects(handlers.completion({ messages: [{ role: 'user', content: 'missing key' }] }, signal));
    const unavailable = await handlers.taskStatus({}, 'ss-helper.memory');
    assert.equal(unavailable.resources.find((item) => item.resourceId === resource.id)?.available, false);
    await repository.setResourceSecret(resource.id, 'runtime-secret');
    assert.equal((await handlers.completion({ messages: [{ role: 'user', content: 'two' }] }, signal)).text, 'custom-ok');
    const routing = await handlers.taskStatus({}, 'ss-helper.memory');
    assert.equal(routing.resources.find((item) => item.resourceId === resource.id)?.capabilities.includes('tools'), true);

    const customSettings = await repository.loadSettings();
    await repository.saveSettings({ ...customSettings, globalAssignments: { ...(customSettings.globalAssignments ?? {}), generation: { resourceId: 'tavern:active' } } });
    assert.equal((await handlers.completion({ messages: [{ role: 'user', content: 'three' }] }, signal)).text, 'tavern-ok');
    assert.deepEqual(calls.map((call) => call.kind), ['tavern', 'custom', 'tavern']);
    assert.equal((await repository.loadSettings()).globalAssignments.generation.resourceId, 'tavern:active');
  } finally {
    handlers.dispose?.();
    globalThis.fetch = originalFetch;
  }
});

test('task route bindings persist the current contract for generation, embedding and rerank', async () => {
  const repository = new LlmWorkspaceRepository(new MemoryWorkspace(), new MemorySecrets());
  const session = {
    host: { generation: { available: async () => false, current: async () => ({}) }, has: () => false },
    events: { publish() {}, subscribe() { return () => {}; } },
  };
  const handlers = createProductionLlmServices(session, { repository });
  try {
    await repository.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const kinds = ['generation', 'embedding', 'rerank'];
    const tasks = kinds.map((kind) => ({ taskKey: `test-${kind}`, taskKind: kind, execution: kind === 'generation' ? 'structured' : kind, requiredCapabilities: kind === 'generation' ? ['chat', 'json'] : kind === 'embedding' ? ['embeddings'] : ['rerank'] }));
    for (const task of tasks) {
      await repository.saveResource({ id: task.taskKey, type: task.taskKind, source: 'custom', apiType: 'openai', label: task.taskKey, baseUrl: 'https://provider.example/v1', model: 'test-model', enabled: true, capabilities: task.requiredCapabilities }, 'test-secret');
    }
    await repository.updateSettings((current) => ({ ...current, globalAssignments: Object.fromEntries(kinds.map((kind) => [kind, { resourceId: `test-${kind}` }])) }));
    const automatic = { ...tasks[0], taskKey: 'automatic-generation' };
    handlers.registerConsumer({ displayName: 'Route test', tasks: [...tasks, automatic] }, 'ss-helper.memory');
    const snapshot = await handlers.taskStatus({}, 'ss-helper.memory');
    const saved = await handlers.taskRouteSet({ expectedRevision: snapshot.revision, assignments: [...tasks.map((task) => ({ taskKey: task.taskKey, resourceId: task.taskKey })), { taskKey: automatic.taskKey }] }, 'ss-helper.memory');
    assert.equal(saved.tasks.every((task) => task.available), true);
    handlers.registerConsumer({ displayName: 'Required capability', tasks: [{ taskKey: 'strict-required', taskKind: 'generation', execution: 'tool_turn', requiredCapabilities: ['chat', 'tools'], requirements: { strictToolSchema: 'required' } }] }, 'example.required');
    const requiredStatus = await handlers.taskStatus({}, 'example.required');
    assert.equal(requiredStatus.tasks[0].available, false);
    assert.equal(requiredStatus.tasks[0].failure.reasonCode, 'LLM_TASK_REQUIREMENT_UNSUPPORTED');
    assert.deepEqual(saved.defaults, { completion: 'test-generation', structured: 'test-generation', tool_turn: 'test-generation', embedding: 'test-embedding', rerank: 'test-rerank' });
    assert.equal(saved.tasks.find((task) => task.taskKey === automatic.taskKey)?.resourceId, 'test-generation');
    assert.deepEqual((await repository.loadSettings()).taskAssignments, tasks.map((task) => ({ pluginId: 'ss-helper.memory', taskKey: task.taskKey, taskKind: task.taskKind, resourceId: task.taskKey, isStale: false })));
  } finally {
    handlers.dispose?.();
  }
});

test('event listener failures cannot turn an applied generation source change into a failed save', async () => {
  const workspace = new MemoryWorkspace();
  const repository = new LlmWorkspaceRepository(workspace, new MemorySecrets());
  const session = {
    host: {
      generation: {
        available: async () => true,
        current: async () => ({ provider: 'openai', model: 'tavern-model' }),
        models: async () => ['tavern-model'],
        generate: async () => ({ text: 'tavern-ok', model: 'tavern-model' }),
        test: async () => ({ text: 'ok', model: 'tavern-model' }),
      },
      has: () => false,
      events: { subscribe() { return () => {}; } },
    },
    events: {
      publish() { throw Object.assign(new Error('An event listener failed'), { code: 'INVALID_PAYLOAD' }); },
      subscribe() { return () => {}; },
    },
  };
  const handlers = createProductionLlmServices(session, { repository });
  const signal = new AbortController().signal;
  try {
    await repository.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await repository.saveSettings({ ...(await repository.loadSettings()), globalProfile: 'economy' });
    const saved = await repository.saveSettings({ ...(await repository.loadSettings()), globalProfile: 'precise' });
    assert.equal(saved.globalProfile, 'precise');
    assert.equal((await repository.loadSettings()).globalProfile, 'precise');
    assert.equal((await handlers.completion({ messages: [{ role: 'user', content: 'still applied' }] }, signal)).text, 'tavern-ok');
  } finally {
    handlers.dispose?.();
  }
});

test('direct browser Provider sends the Workspace credential only to the configured origin', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestedHeaders;
  globalThis.fetch = async (input, init = {}) => {
    requestedUrl = String(input);
    requestedHeaders = new Headers(init.headers);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const provider = createProviderFromResource({ id: 'openai', type: 'generation', source: 'custom', apiType: 'openai', label: 'OpenAI', baseUrl: 'https://provider.example/v1', model: 'gpt' }, 'workspace-secret');
    const response = await provider.request({ messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(response.content, 'ok');
    assert.equal(requestedUrl, 'https://provider.example/v1/chat/completions');
    assert.equal(requestedHeaders.get('authorization'), 'Bearer workspace-secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Claude, Gemini and custom rerank adapters keep provider credentials and error bodies scoped', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    calls.push({ url, headers });
    if (url.includes('/messages')) return new Response(JSON.stringify({ content: [{ type: 'text', text: 'claude-ok' }], usage: { input_tokens: 1, output_tokens: 2 } }), { status: 200 });
    if (url.includes('GenerateContent')) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini-ok' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } }), { status: 200 });
    return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9, document: 'doc' }] }), { status: 200 });
  };
  try {
    const claude = createProviderFromResource({ id: 'claude', type: 'generation', source: 'custom', apiType: 'claude', label: 'Claude', baseUrl: 'https://anthropic.example/v1', model: 'claude' }, 'claude-secret');
    const gemini = createProviderFromResource({ id: 'gemini', type: 'generation', source: 'custom', apiType: 'gemini', label: 'Gemini', baseUrl: 'https://google.example/v1beta', model: 'gemini' }, 'gemini-secret');
    const rerank = createProviderFromResource({ id: 'rerank', type: 'rerank', source: 'custom', apiType: 'generic', label: 'Rerank', baseUrl: 'https://rerank.example', model: 'rank' }, 'rerank-secret');
    assert.equal((await claude.request({ messages: [{ role: 'user', content: 'hello' }] })).content, 'claude-ok');
    assert.equal((await gemini.request({ messages: [{ role: 'user', content: 'hello' }] })).content, 'gemini-ok');
    assert.equal((await rerank.rerank({ query: 'q', docs: ['doc'], topK: 1 })).results[0].score, 0.9);
    assert.equal(calls[0].headers.get('x-api-key'), 'claude-secret');
    assert.equal(calls[1].headers.get('x-goog-api-key'), 'gemini-secret');
    assert.equal(calls[2].headers.get('authorization'), 'Bearer rerank-secret');
    claude.dispose?.(); gemini.dispose?.(); rerank.dispose?.();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Provider HTTP failures expose a safe code without returning response bodies', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('provider-secret-error-body', { status: 500 });
  try {
    const provider = createProviderFromResource({ id: 'openai', type: 'generation', source: 'custom', apiType: 'openai', label: 'OpenAI', baseUrl: 'https://provider.example/v1', model: 'gpt' }, 'secret-value');
    await assert.rejects(
      provider.request({ messages: [{ role: 'user', content: 'hello' }] }),
      (error) => error?.code === 'CORE_UNAVAILABLE'
        && error?.details?.reasonCode === 'PROVIDER_SERVICE_UNAVAILABLE'
        && !String(error).includes('provider-secret-error-body'),
    );
    provider.dispose?.();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Provider network and abort failures do not surface request payloads', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init = {}) => {
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    throw new TypeError('Failed to fetch');
  };
  try {
    const provider = createProviderFromResource({ id: 'openai', type: 'generation', source: 'custom', apiType: 'openai', label: 'OpenAI', baseUrl: 'https://provider.example/v1', model: 'gpt' }, 'secret-value');
    await assert.rejects(provider.request({ messages: [{ role: 'user', content: 'prompt-secret-body' }] }), (error) => !String(error).includes('prompt-secret-body'));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(provider.request({ messages: [{ role: 'user', content: 'prompt-secret-body' }], signal: controller.signal }), (error) => !String(error).includes('prompt-secret-body'));
    provider.dispose?.();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
