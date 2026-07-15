import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTypeScriptModule } from './support/load-typescript-module.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const silentLogger = {
  info() {},
  warn() {},
  error() {},
  success() {},
  debug() {},
};

function source(relativePath) {
  return path.join(projectRoot, 'src', ...relativePath.split('/'));
}

function provider(id, capabilities) {
  return {
    id,
    kind: 'custom',
    capabilities: {
      chat: false,
      json: false,
      tools: false,
      embeddings: false,
      rerank: false,
      ...capabilities,
    },
    async request() {
      return { content: id };
    },
  };
}

test('路由保持 routeHint 优先并按能力过滤', async () => {
  const { TaskRouter } = await loadTypeScriptModule(source('router/router.ts'));
  const router = new TaskRouter();
  router.registerProvider(provider('global', { chat: true }), 'generation', ['chat'], 'global-model');
  router.registerProvider(provider('hint', { chat: true, json: true }), 'generation', ['chat', 'json'], 'hint-model');
  router.applyGlobalAssignments({ generation: { resourceId: 'global' } });

  const hinted = router.resolveRoute({
    consumer: 'memory',
    taskKind: 'generation',
    requiredCapabilities: ['json'],
    routeHint: { resourceId: 'hint' },
  });
  assert.deepEqual(
    { resourceId: hinted.resourceId, model: hinted.model, resolvedBy: hinted.resolvedBy },
    { resourceId: 'hint', model: 'hint-model', resolvedBy: 'route_hint' },
  );

  const fallback = router.resolveRoute({
    consumer: 'memory',
    taskKind: 'generation',
    requiredCapabilities: ['chat'],
  });
  assert.equal(fallback.resourceId, 'global');
  assert.equal(fallback.resolvedBy, 'user_global_default');
});

test('OpenAI provider 保持请求头、模型、参数和响应快照行为', async () => {
  const requests = [];
  const fakeFetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: 'baseline-ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        };
      },
    };
  };
  const { OpenAIProvider } = await loadTypeScriptModule(source('providers/openai-provider.ts'), {
    globals: { fetch: fakeFetch },
  });
  const instance = new OpenAIProvider({
    id: 'openai-main',
    apiKey: 'secret-key',
    baseUrl: 'https://example.invalid/v1/',
    model: 'baseline-model',
    customParams: { seed: 7, temperature: 0.1 },
  });
  const result = await instance.request({
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.8,
    maxTokens: 123,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://example.invalid/v1//chat/completions');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer secret-key');
  assert.equal(requests[0].body.model, 'baseline-model');
  assert.equal(requests[0].body.temperature, 0.8);
  assert.equal(requests[0].body.max_tokens, 123);
  assert.equal(requests[0].body.seed, 7);
  assert.equal(result.content, 'baseline-ok');
  assert.equal(result.debugRequest.resourceId, 'openai-main');
});

test('orchestrator 保持全局串行和 silent 自动完成语义', async () => {
  const { RequestOrchestrator } = await loadTypeScriptModule(source('orchestrator/orchestrator.ts'), {
    stubs: { '../index': { logger: silentLogger } },
  });
  const orchestrator = new RequestOrchestrator();
  const started = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  orchestrator.setExecuteCallback(async (record) => {
    started.push(record.taskKey);
    if (record.taskKey === 'first') await firstGate;
    return { ok: true, data: record.taskKey };
  });

  const first = orchestrator.enqueue('consumer', 'first', 'generation', { displayMode: 'silent' });
  const second = orchestrator.enqueue('consumer', 'second', 'generation', { displayMode: 'silent' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ['first']);
  releaseFirst();
  const [firstResult, secondResult] = await Promise.all([first.resultPromise, second.resultPromise]);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  assert.deepEqual(started, ['first', 'second']);
  assert.equal(first.state, 'completed');
  assert.equal(second.state, 'completed');
});

test('credential vault 保持混淆存储、掩码和 CRUD 行为', async () => {
  const rows = new Map();
  const localValues = new Map();
  const llmCredentials = {
    async get(key) { return rows.get(key); },
    async put(value) { rows.set(value.providerId, value); },
    async delete(key) { rows.delete(key); },
    async bulkPut(values) { for (const value of values) rows.set(value.providerId, value); },
    toCollection() { return { async primaryKeys() { return [...rows.keys()]; } }; },
  };
  const { VaultManager } = await loadTypeScriptModule(source('vault/vault-manager.ts'), {
    stubs: {
      '../storage/database': {
        async getActiveLlmStorage() {
          return { cutover: true, database: { llm_credentials: llmCredentials } };
        },
      },
    },
    globals: {
      localStorage: {
        getItem(key) { return localValues.get(key) ?? null; },
        setItem(key, value) { localValues.set(key, String(value)); },
      },
    },
  });
  const vault = new VaultManager();
  await vault.setCredential('provider-a', 'sk-baseline-secret');

  assert.notEqual(rows.get('provider-a').payload.apiKey, 'sk-baseline-secret');
  assert.equal(rows.get('provider-a').apiKeyMasked, 'sk-b***cret');
  assert.equal(await vault.getCredential('provider-a'), 'sk-baseline-secret');
  assert.deepEqual(Array.from(await vault.listResourceIds()), ['provider-a']);
  await vault.removeCredential('provider-a');
  assert.equal(await vault.hasCredential('provider-a'), false);
});

test('request log 保持持久化字段和读取归一化行为', async () => {
  const persisted = [];
  let trimmedTo = 0;
  const dbStub = {
    async appendLlmRequestLog(row) { persisted.push(row); },
    async trimLlmRequestLogs(limit) { trimmedTo = limit; },
    async clearLlmRequestLogs() { const count = persisted.length; persisted.length = 0; return count; },
    async queryLlmRequestLogs() {
      return [{
        llmTaskId: 'task-legacy',
        requestId: 'request-legacy',
        sourcePluginId: 'memory',
        consumer: 'memory',
        taskKey: 'extract',
        taskKind: 'unexpected',
        state: 'overlay_waiting',
        attemptIndex: 0,
        payload: { logId: 'legacy-log', requestId: 'request-legacy' },
      }];
    },
  };
  const { RequestLogService } = await loadTypeScriptModule(source('log/requestLogService.ts'), {
    stubs: {
      '../storage/request-log-store': dbStub,
      '../runtime/logger': { logger: silentLogger },
    },
  });
  const service = new RequestLogService();
  await service.recordAttempt({
    record: {
      llmTaskId: 'task-1',
      requestId: 'request-1',
      consumer: 'memory',
      taskKey: 'extract',
      taskKind: 'generation',
      state: 'running',
      validity: { isCancelled: false, isSuperseded: false, isObsolete: false },
      enqueueOptions: {},
      queuedAt: 10,
      startedAt: 20,
      finishedAt: 35,
      attemptIndex: 1,
      scope: { pluginId: 'memory', sessionId: 'session-1' },
    },
    requestId: 'request-1',
    result: { ok: false, error: 'baseline failure', reasonCode: 'provider_unavailable' },
    attemptTag: '初次请求',
    attemptOutcome: '失败',
    isFinalAttempt: true,
  });

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].sourcePluginId, 'memory');
  assert.equal(persisted[0].reasonCode, 'provider_unavailable');
  assert.equal(persisted[0].latencyMs, 15);
  assert.equal(trimmedTo, 2000);

  const logs = await service.listLogs();
  assert.equal(logs[0].taskKind, 'generation');
  assert.equal(logs[0].state, 'completed');
  assert.equal(logs[0].attemptIndex, 1);
});

