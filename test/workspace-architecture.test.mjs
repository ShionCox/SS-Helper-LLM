import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LLM_SETTINGS_SCHEMA,
  LlmWorkspaceRepository,
  LLM_WORKSPACE_ID,
  createProductionLlmServices,
  createProviderFromResource,
} from '../dist/index.js';

class MemoryWorkspace {
  constructor() { this.records = new Map(); this.collections = []; this.version = 1; this.transactionKeys = []; this.failNextTransaction = false; this.failCredentialRead = false; }
  key(collection, recordId) { return `${collection}:${recordId}`; }
  async health() { return { ready: true, database: 'ss-helper.sqlite3', schemaVersion: 0 }; }
  async integrity() { return { ok: true, messages: ['ok'] }; }
  async open({ workspaceId }) { assert.equal(workspaceId, LLM_WORKSPACE_ID); return { ownerPluginId: 'ss-helper.llm', workspaceId, created: true, version: this.version }; }
  async defineCollection({ name }) { this.collections.push(name); }
  async get({ collection = 'default', recordId }) { if (this.failCredentialRead && collection === 'credentials') { const error = new Error('credential read failed'); error.code = 'WORKSPACE_FAILURE'; throw error; } const record = this.records.get(this.key(collection, recordId)); return record ? structuredClone(record) : null; }
  async upsert({ collection = 'default', recordId, value, expectedVersion, expectedRevision }) {
    const key = this.key(collection, recordId); const previous = this.records.get(key);
    const currentRevision = previous?.revision ?? previous?.version ?? 0;
    if ((expectedRevision ?? expectedVersion) !== undefined && currentRevision !== (expectedRevision ?? expectedVersion)) { const error = new Error('conflict'); error.code = 'WORKSPACE_CONFLICT'; throw error; }
    const record = { recordId, value: structuredClone(value), version: (previous?.version ?? 0) + 1, revision: currentRevision + 1, updatedAt: Date.now() }; this.records.set(key, record); return structuredClone(record);
  }
  async delete({ collection = 'default', recordId, expectedVersion, expectedRevision }) { const key = this.key(collection, recordId); const previous = this.records.get(key); const currentRevision = previous?.revision ?? previous?.version ?? 0; if ((expectedRevision ?? expectedVersion) !== undefined && currentRevision !== (expectedRevision ?? expectedVersion)) { const error = new Error('conflict'); error.code = 'WORKSPACE_CONFLICT'; throw error; } return this.records.delete(key); }
  async query({ collection = 'default', filter = {}, limit = 1000, cursor }) { const values = [...this.records.entries()].filter(([key, record]) => key.startsWith(`${collection}:`) && Object.entries(filter).every(([field, value]) => record.value?.[field] === value)).map(([, record]) => structuredClone(record)); const offset = cursor ? Number(cursor) : 0; const page = values.slice(offset, offset + limit); return { records: page, nextCursor: offset + page.length < values.length ? String(offset + page.length) : null }; }
  async transaction({ operations, idempotencyKey }) { this.transactionKeys.push(idempotencyKey); if (this.failNextTransaction) { this.failNextTransaction = false; const error = new Error('injected transaction failure'); error.code = 'WORKSPACE_FAILURE'; throw error; } const snapshot = new Map(this.records); const results = []; try { for (const operation of operations) { if (operation.action === 'upsert') { const record = await this.upsert(operation); results.push({ collection: operation.collection ?? 'default', recordId: record.recordId, action: 'upsert', version: record.version, revision: record.revision }); } else { const removed = await this.delete(operation); results.push({ collection: operation.collection ?? 'default', recordId: operation.recordId, action: 'delete', removed }); } } return { operationCount: results.length, replayed: false, results }; } catch (error) { this.records = snapshot; throw error; } }
  async clearOwned() { const count = this.records.size; this.records.clear(); return count; }
}

class MemorySecrets {
  constructor() { this.records = new Map(); this.failRead = false; }
  async set({ secretId, value, metadata }) { const record = { secretId, value, metadata, maskedValue: `••••${value.slice(-2)}`, updatedAt: Date.now(), keyVersion: 0 }; this.records.set(secretId, record); return { ...record, value: undefined }; }
  async get({ secretId }) { if (this.failRead) { const error = new Error('secret read failed'); error.code = 'WORKSPACE_FAILURE'; throw error; } const record = this.records.get(secretId); return record ? structuredClone(record) : null; }
  async delete({ secretId }) { return this.records.delete(secretId); }
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
    start: ['服务状态', '生成偏好', '请求与展示'],
    resources: ['资源管理', '能力测试'],
    routing: ['路由配置', '高级配置'],
    runtime: ['额度与任务', '权限与展示'],
    diagnostics: ['检查与日志', '日志记录策略', '数据管理', '关于'],
  });
  assert.ok(allFields.some((field) => field.id === 'globalProfile'));
  assert.equal(allFields.find((field) => field.id === 'tavernStatus')?.label, '大语言模型');
  const generationSource = allFields.find((field) => field.id === 'generationSource');
  assert.deepEqual(
    [generationSource?.kind, generationSource?.defaultValue, generationSource?.options?.map((option) => option.value)],
    ['select', 'tavern', ['tavern', 'custom']],
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

test('LLM browser repository stores complete sanitized logs and excludes credentials', async () => {
  const workspace = new MemoryWorkspace();
  const secrets = new MemorySecrets();
  const repository = new LlmWorkspaceRepository(workspace, secrets);
  await repository.ready();
  const expectedDefaults = { enabled: true, generationSource: 'tavern', globalProfile: 'balanced', maxTokensMode: 'adaptive', maxTokens: 2048, timeoutMs: 60000, resultDisplay: 'auto' };
  const settingsDefaults = (settings) => Object.fromEntries(Object.keys(expectedDefaults).map((key) => [key, settings[key]]));
  const initialSettings = await repository.loadSettings();
  assert.deepEqual(settingsDefaults(initialSettings), expectedDefaults);
  assert.equal(Object.hasOwn(initialSettings, 'resources'), false);
  await repository.saveSettings({ ...initialSettings, resources: [{ id: 'plain-resource', type: 'generation', source: 'custom', apiType: 'auto', label: 'Plain', enabled: false }] });
  assert.equal(Object.hasOwn((await repository.loadSettings()).resources[0], 'customParams'), false);
  await repository.saveSettings({ enabled: true, globalProfile: 'economy', maxTokensMode: 'manual', maxTokens: 4096 });
  assert.equal((await repository.loadSettings()).globalProfile, 'economy');
  assert.deepEqual(settingsDefaults(await repository.reset()), expectedDefaults);
  await repository.setResourceSecret('resource-test', 'secret-value', { label: 'Test' });
  assert.equal([...workspace.records.values()].some((record) => JSON.stringify(record.value).includes('secret-value')), false, 'new keys must never be written to the plaintext workspace collection');
  assert.equal(secrets.records.get('resource:resource-test')?.value, 'secret-value');
  assert.equal(await repository.hasResourceSecret('resource-test'), true);
  assert.equal(await repository.getResourceSecret('resource-test'), 'secret-value');
  await repository.saveLog({ request: { taskKind: 'generation', taskDescription: 'visible prompt', metrics: { total: 1 }, body: 'must persist', headers: { authorization: 'Bearer secret-value' } }, response: { meta: { resourceId: 'resource-test' }, body: 'visible response' }, state: 'completed', sourcePluginId: 'fixture' });
  const logs = await repository.queryLogs({ sourcePluginId: 'fixture' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].contentMode, 'full');
  assert.equal(logs[0].request.body, 'must persist');
  assert.equal(logs[0].request.taskDescription, 'visible prompt');
  assert.equal(logs[0].response.body, 'visible response');
  assert.equal(logs[0].request.headers, '[已脱敏]');
  assert.equal(JSON.stringify(logs[0]).includes('secret-value'), false);
  await assert.rejects(repository.saveSettings({ budgets: { fixture: { maxCost: 1 } } }), { code: 'LLM_DEPRECATED_MAX_COST' });
  await assert.rejects(repository.saveSettings({ resources: [{ id: 'http', type: 'generation', source: 'custom', apiType: 'openai', label: 'HTTP', baseUrl: 'http://provider.example', enabled: false }] }), { code: 'PAYLOAD_INVALID' });
  assert.equal((await repository.listSecrets()).length, 1);
  await repository.saveSettings({ ...(await repository.loadSettings()), generationSource: 'custom' });
  const exported = await repository.exportConfig();
  assert.equal(exported.archive.settings.generationSource, 'custom');
  assert.equal(JSON.stringify(exported).includes('secret-value'), false);
  await repository.importConfig(exported.archive, exported.sha256);
  assert.equal((await repository.loadSettings()).generationSource, 'custom');
  assert.equal(await repository.hasResourceSecret('resource-test'), false);
  await repository.clearAll();
  assert.equal(await repository.hasResourceSecret('resource-test'), false);
  assert.deepEqual(settingsDefaults(await repository.loadSettings()), expectedDefaults);
  await repository.saveSettings({ enabled: true, globalProfile: 'precise' });
  assert.equal((await repository.loadSettings()).globalProfile, 'precise');
});

test('legacy plaintext credentials migrate only after encrypted verification and retry safely', async () => {
  const workspace = new MemoryWorkspace();
  const secrets = new MemorySecrets();
  workspace.records.set('credentials:resource:legacy', {
    recordId: 'resource:legacy',
    value: { resourceId: 'legacy', apiKey: 'legacy-secret' },
    version: 1,
    revision: 1,
    updatedAt: Date.now(),
  });
  const repository = new LlmWorkspaceRepository(workspace, secrets);
  await repository.ready();
  assert.equal(await repository.getResourceSecret('legacy'), 'legacy-secret');
  assert.equal(workspace.records.has('credentials:resource:legacy'), false);

  await secrets.set({ workspaceId: LLM_WORKSPACE_ID, secretId: 'resource:preferred', value: 'encrypted-key', metadata: {} });
  workspace.records.set('credentials:resource:preferred', {
    recordId: 'resource:preferred',
    value: { resourceId: 'preferred', apiKey: 'old-plaintext-key' },
    version: 1,
    revision: 1,
    updatedAt: Date.now(),
  });
  const preferEncrypted = new LlmWorkspaceRepository(workspace, secrets);
  await preferEncrypted.ready();
  assert.equal(await preferEncrypted.getResourceSecret('preferred'), 'encrypted-key');
  assert.equal(workspace.records.has('credentials:resource:preferred'), false);

  const retryWorkspace = new MemoryWorkspace();
  retryWorkspace.records.set('credentials:resource:retry', {
    recordId: 'resource:retry',
    value: { resourceId: 'retry', apiKey: 'retry-secret' },
    version: 1,
    revision: 1,
    updatedAt: Date.now(),
  });
  const retrySecrets = new MemorySecrets();
  retrySecrets.failRead = true;
  const retry = new LlmWorkspaceRepository(retryWorkspace, retrySecrets);
  await retry.ready();
  await assert.rejects(retry.getResourceSecret('retry'), { code: 'LLM_SECRET_MIGRATION_FAILED' });
  assert.equal(retryWorkspace.records.has('credentials:resource:retry'), true, 'failed migration must retain the original record');
  retrySecrets.failRead = false;
  assert.equal(await retry.getResourceSecret('retry'), 'retry-secret');
  assert.equal(retryWorkspace.records.has('credentials:resource:retry'), false);
});

test('provider factory covers direct browser generation and rerank resources', () => {
  const openai = createProviderFromResource({ id: 'openai', type: 'generation', source: 'custom', apiType: 'openai', label: 'OpenAI', baseUrl: 'https://example.invalid/v1', model: 'gpt' }, 'secret-value');
  const rerank = createProviderFromResource({ id: 'rerank', type: 'rerank', source: 'custom', apiType: 'generic', label: 'Rerank', baseUrl: 'https://example.invalid', model: 'rank' }, 'secret-value');
  assert.equal(openai.id, 'openai');
  assert.equal(rerank.id, 'rerank');
  openai.dispose?.(); rerank.dispose?.();
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
  assert.equal(new Set(workspace.transactionKeys.filter(Boolean)).size, 2);
});

test('settings validation rejects coercion and malformed nested routing values', async () => {
  const repository = new LlmWorkspaceRepository(new MemoryWorkspace(), new MemorySecrets());
  await assert.rejects(repository.saveSettings({ enabled: 'false' }), { code: 'PAYLOAD_INVALID' });
  await assert.rejects(repository.saveSettings({ globalProfile: 'unknown' }), { code: 'PAYLOAD_INVALID' });
  await assert.rejects(repository.saveSettings({ generationSource: 'automatic' }), { code: 'PAYLOAD_INVALID' });
  await assert.rejects(repository.saveSettings({ resources: [{ id: 'bad', type: 'generation', source: 'custom', label: 'Bad', enabled: 'false' }] }), { code: 'PAYLOAD_INVALID' });
  await assert.rejects(repository.saveSettings({ globalAssignments: { generation: { resourceId: 42 } } }), { code: 'PAYLOAD_INVALID' });
  assert.equal((await repository.loadSettings()).globalProfile, 'balanced');
});

test('clearLogs paginates beyond one thousand records and can resume after a failed batch', async () => {
  const workspace = new MemoryWorkspace();
  const repository = new LlmWorkspaceRepository(workspace, new MemorySecrets());
  await repository.ready();
  for (let index = 0; index < 2_501; index += 1) workspace.records.set(`request-logs:seed-${index}`, { recordId: `seed-${index}`, value: { state: 'completed' }, version: 1, revision: 1, updatedAt: index });
  assert.equal(await repository.clearLogs(), 2_501);
  assert.equal((await repository.queryLogs({ limit: 500 })).length, 0);
  for (let index = 0; index < 3; index += 1) workspace.records.set(`request-logs:retry-${index}`, { recordId: `retry-${index}`, value: { state: 'failed' }, version: 1, revision: 1, updatedAt: index });
  workspace.failNextTransaction = true;
  await assert.rejects(repository.clearLogs(), { code: 'LLM_LOG_CLEAR_PARTIAL' });
  assert.equal(await repository.clearLogs(), 3);
});

test('config import is atomic and resource deletion removes its credential in one transaction', async () => {
  const workspace = new MemoryWorkspace();
  const repository = new LlmWorkspaceRepository(workspace, new MemorySecrets());
  await repository.saveSettings({ enabled: true, globalProfile: 'economy', resources: [{ id: 'resource-a', type: 'generation', source: 'custom', apiType: 'auto', label: 'A', enabled: false }] });
  await repository.setResourceSecret('resource-a', 'secret-value');
  const exported = await repository.exportConfig();
  workspace.failNextTransaction = true;
  await assert.rejects(repository.importConfig(exported.archive, exported.sha256), { code: 'WORKSPACE_FAILURE' });
  assert.equal(await repository.getResourceSecret('resource-a'), 'secret-value');
  assert.equal((await repository.loadSettings()).globalProfile, 'economy');
  await repository.deleteResource('resource-a');
  assert.equal(await repository.getResourceSecret('resource-a'), null);
  assert.equal((await repository.loadSettings()).resources?.some((resource) => resource.id === 'resource-a'), false);
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
  await assert.rejects(repository.saveSettings({ ...(await repository.loadSettings()), globalProfile: 'economy' }), { code: 'LLM_RUNTIME_APPLY_FAILED' });
  secrets.failRead = false;
  assert.equal((await repository.loadSettings()).globalProfile, 'balanced');
  handlers.dispose?.();
});

test('generation source hot-switches Tavern to custom and back without crossing the source gate', async () => {
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
    const providerOnly = await handlers.capabilityStatus({ checks: [{ id: 'generation', taskKey: 'completion', taskKind: 'generation' }] }, signal);
    assert.deepEqual(providerOnly.checks[0], { id: 'generation', source: 'tavern', configured: true, available: true });

    const resource = { id: 'custom-generation', type: 'generation', source: 'custom', apiType: 'openai', label: 'Custom', baseUrl: 'https://provider.example/v1', model: 'custom-model', enabled: true, capabilities: ['chat', 'json'] };
    await repository.saveSettings({ ...(await repository.loadSettings()), generationSource: 'custom', resources: [resource], globalAssignments: { generation: { resourceId: resource.id } } });
    await assert.rejects(handlers.completion({ messages: [{ role: 'user', content: 'missing key' }] }, signal));
    const unavailable = await handlers.capabilityStatus({ checks: [{ id: 'generation', taskKey: 'completion', taskKind: 'generation' }] }, signal);
    assert.deepEqual(unavailable.checks[0], { id: 'generation', source: 'custom', configured: false, available: false, reason: 'credential_missing' });
    await repository.setResourceSecret(resource.id, 'runtime-secret');
    assert.equal((await handlers.completion({ messages: [{ role: 'user', content: 'two' }] }, signal)).text, 'custom-ok');

    await repository.saveSettings({ ...(await repository.loadSettings()), generationSource: 'tavern' });
    assert.equal((await handlers.completion({ messages: [{ role: 'user', content: 'three' }], route: resource.id }, signal)).text, 'tavern-ok');
    assert.deepEqual(calls.map((call) => call.kind), ['tavern', 'custom', 'tavern']);
    assert.equal((await repository.loadSettings()).globalAssignments.generation.resourceId, resource.id, 'custom assignment remains stored');
  } finally {
    handlers.dispose?.();
    globalThis.fetch = originalFetch;
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
      publish() { throw Object.assign(new Error('An event listener failed'), { code: 'PAYLOAD_INVALID' }); },
      subscribe() { return () => {}; },
    },
  };
  const handlers = createProductionLlmServices(session, { repository });
  const signal = new AbortController().signal;
  try {
    await repository.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await repository.saveSettings({ ...(await repository.loadSettings()), generationSource: 'custom' });
    const saved = await repository.saveSettings({ ...(await repository.loadSettings()), generationSource: 'tavern' });
    assert.equal(saved.generationSource, 'tavern');
    assert.equal((await repository.loadSettings()).generationSource, 'tavern');
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
    if (url.includes('generateContent')) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini-ok' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } }), { status: 200 });
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
    await assert.rejects(provider.request({ messages: [{ role: 'user', content: 'hello' }] }), (error) => error?.code === 'LLM_PROVIDER_HTTP_ERROR' && !String(error).includes('provider-secret-error-body'));
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
