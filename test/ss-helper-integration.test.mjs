import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { LLM_COMPLETION_V1, LLM_EMBEDDING_V1, LLM_RERANK_V1, LLM_ROUTE_CHANGED_V1, LLM_ROUTE_DIAGNOSTICS_V1, LLM_STRUCTURED_TASK_V1 } from '@ss-helper/sdk';
import { createLlmSettingsAdapter, LLM_ADVANCED_ROUTING_KEY, LLM_SETTINGS_KEY, LLM_SETTINGS_SCHEMA } from '../dist/src/ss-helper/settings.js';
import { createLlmSdkServiceHandlers, exposeLlmServices, publishRouteChanged } from '../dist/src/ss-helper/services.js';
import { createProductionLlmServices, OpenAIProvider, registerLlmPopup, RequestLogService } from '../dist/index.js';

test('schema adapter persists ordinary settings without mounting a second root', async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const adapter = createLlmSettingsAdapter(storage);
  assert.equal(LLM_SETTINGS_SCHEMA.id, 'ss-helper.llm');
  await adapter.save({ enabled: true, route: 'primary', timeoutMs: 30000 });
  assert.deepEqual(await adapter.load(), { enabled: true, route: 'primary', timeoutMs: 30000 });
  assert.ok(values.has(LLM_SETTINGS_KEY));
  assert.equal(values.has(LLM_ADVANCED_ROUTING_KEY), false);
  assert.deepEqual(await adapter.reset(), { enabled: true, route: 'default', timeoutMs: 60000 });
});

test('personalized advanced routing remains a Core popup with isolated storage', () => {
  let contribution;
  const cleanup = () => {};
  const session = { registerPopup(value) { contribution = value; return cleanup; } };
  const storage = { getItem() { return null; }, setItem() {} };
  assert.equal(registerLlmPopup(session, storage), cleanup);
  assert.deepEqual(contribution.token, { kind: 'popup', provider: 'ss-helper.llm', name: 'advanced-routing', version: 1 });
  assert.equal(LLM_ADVANCED_ROUTING_KEY, 'ss-helper.llm.advanced-routing.v1');
  assert.notEqual(LLM_ADVANCED_ROUTING_KEY, LLM_SETTINGS_KEY);
  const action = LLM_SETTINGS_SCHEMA.fields.find((field) => field.kind === 'action');
  assert.deepEqual(action.popup, contribution.token);
});

test('structured task, embedding and rerank services call the existing LLMSDK provider paths', async () => {
  const calls = [];
  const sdk = {
    async runTask(args) { calls.push(['runTask', args.taskKey, args.input]); args.onLifecycle?.({ requestId: 'req-task', stage: 'completed', resourceId: 'openai', model: 'gpt', ts: 1 }); return { ok: true, data: { answer: 42 }, meta: { requestId: 'req-task', resourceId: 'openai', model: 'gpt', capabilityKind: 'generation', queuedAt: 1 } }; },
    async embed(args) { calls.push(['embed', args.texts]); return { ok: true, vectors: [[0.1, 0.2]], meta: { requestId: 'req-embed', resourceId: 'openai', model: 'embedding', capabilityKind: 'embedding', queuedAt: 1 } }; },
    async rerank(args) { calls.push(['rerank', args.docs]); return { ok: true, results: [{ index: 1, score: 0.9 }], meta: { requestId: 'req-rerank', resourceId: 'cohere', model: 'rerank', capabilityKind: 'rerank', queuedAt: 1 } }; },
  };
  const exposed = [];
  const session = { services: { expose(contract, handler) { const item = { contract, handler }; exposed.push(item); return () => exposed.splice(exposed.indexOf(item), 1); } }, events: { publish() {} } };
  const cleanup = exposeLlmServices(session, createLlmSdkServiceHandlers(sdk));
  assert.deepEqual(exposed.map((item) => item.contract), [LLM_COMPLETION_V1, LLM_STRUCTURED_TASK_V1, LLM_EMBEDDING_V1, LLM_RERANK_V1, LLM_ROUTE_DIAGNOSTICS_V1]);
  const context = { signal: new AbortController().signal, callerPluginId: 'fixture.consumer' };
  assert.deepEqual(await exposed[1].handler({ task: 'extract', input: { text: 'hello' } }, context), { output: { answer: 42 }, route: { route: 'openai', provider: 'openai', model: 'gpt' } });
  assert.deepEqual(await exposed[2].handler({ input: ['hello'] }, context), { embeddings: [[0.1, 0.2]], route: { route: 'openai', provider: 'openai', model: 'embedding' } });
  assert.deepEqual(await exposed[3].handler({ query: 'q', documents: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }, context), { results: [{ id: 'b', score: 0.9, index: 1 }], route: { route: 'cohere', provider: 'cohere', model: 'rerank' } });
  assert.deepEqual(calls.map((item) => item[0]), ['runTask', 'embed', 'rerank']);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(exposed[2].handler({ input: 'blocked' }, { ...context, signal: aborted.signal }), (error) => error.code === 'CALL_ABORTED');
  cleanup();
  assert.equal(exposed.length, 0);
});

test('production factory routes runTask, embedding and rerank through registered providers', async () => {
  const originalFetch = globalThis.fetch;
  const providerCalls = [];
  let hostGenerationCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    providerCalls.push({ url: String(url), body: JSON.parse(String(init.body)), signal: init.signal });
    if (String(url).endsWith('/embeddings')) {
      return new Response(JSON.stringify({ data: [{ embedding: [0.25, 0.75] }] }), { status: 200 });
    }
    const body = JSON.parse(String(init.body));
    const rerank = body.messages?.some((message) => String(message.content).includes('文档重排器'));
    return new Response(JSON.stringify({
      choices: [{ message: { content: rerank ? '{"results":[{"index":1,"score":0.95}]}' : '{"answer":42}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200 });
  };
  try {
    const requestLogs = new RequestLogService();
    await requestLogs.clearLogs();
    const providerConfig = { apiKey: 'test-key', baseUrl: 'https://provider.invalid/v1', model: 'test-model' };
    const handlers = createProductionLlmServices(
      { host: { generation: { async generate() { hostGenerationCalls += 1; return { text: 'host fallback' }; }, async listModels() { return []; } } } },
      { providers: [
        { provider: new OpenAIProvider({ id: 'prod-generation', ...providerConfig }), resourceType: 'generation', capabilities: ['chat', 'json'], defaultModel: 'test-model' },
        { provider: new OpenAIProvider({ id: 'prod-embedding', ...providerConfig }), resourceType: 'embedding', capabilities: ['embeddings'], defaultModel: 'test-embedding' },
        { provider: new OpenAIProvider({ id: 'prod-rerank', ...providerConfig, enableRerank: true }), resourceType: 'rerank', capabilities: ['rerank'], defaultModel: 'test-rerank' },
      ] },
    );
    const signal = new AbortController().signal;
    assert.deepEqual(await handlers.runTask({ task: 'extract', input: { text: 'hello' }, route: 'prod-generation' }, signal), { output: '{"answer":42}', route: { route: 'prod-generation', provider: 'prod-generation', model: 'test-model' } });
    assert.deepEqual(await handlers.embed({ input: 'hello', route: 'prod-embedding' }, signal), { embeddings: [[0.25, 0.75]], route: { route: 'prod-embedding', provider: 'prod-embedding', model: 'test-embedding' } });
    assert.deepEqual(await handlers.rerank({ query: 'q', documents: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], route: 'prod-rerank' }, signal), { results: [{ id: 'b', score: 0.95, index: 1 }], route: { route: 'prod-rerank', provider: 'prod-rerank', model: 'test-rerank' } });
    assert.equal(hostGenerationCalls, 0, 'embed/rerank and explicitly routed runTask must not use Tavern host generation');
    assert.deepEqual(providerCalls.map((call) => new URL(call.url).pathname), ['/v1/chat/completions', '/v1/embeddings', '/v1/chat/completions']);
    assert.ok(providerCalls.every((call) => call.signal === signal));
    const logs = await requestLogs.listLogs({ sourcePluginId: 'ss-helper.llm.contract' });
    assert.equal(logs.length, 3);
    assert.ok(logs.every((entry) => entry.state === 'completed'));
    assert.deepEqual(new Set(logs.map((entry) => entry.taskKind)), new Set(['generation', 'embedding', 'rerank']));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('disabled production settings reject typed services before any provider call', async () => {
  let providerCalls = 0;
  const provider = {
    id: 'disabled-provider', kind: 'custom', capabilities: { chat: true, json: true, embeddings: true, rerank: true },
    async request() { providerCalls += 1; return { ok: true, text: 'unexpected' }; },
    async embed() { providerCalls += 1; return { ok: true, vectors: [[1]] }; },
    async rerank() { providerCalls += 1; return { ok: true, results: [] }; },
  };
  const handlers = createProductionLlmServices(
    { host: { generation: { async generate() { providerCalls += 1; return { text: 'unexpected' }; }, async listModels() { return []; } } } },
    { settings: () => ({ enabled: false }), providers: [
      { provider, resourceType: 'generation', capabilities: ['chat', 'json'] },
      { provider: { ...provider, id: 'disabled-embedding' }, resourceType: 'embedding', capabilities: ['embeddings'] },
      { provider: { ...provider, id: 'disabled-rerank' }, resourceType: 'rerank', capabilities: ['rerank'] },
    ] },
  );
  const signal = new AbortController().signal;
  await assert.rejects(handlers.runTask({ task: 'disabled', input: {} }, signal), /LLMHub 未启用/);
  await assert.rejects(handlers.embed({ input: 'disabled' }, signal), /LLMHub 未启用/);
  await assert.rejects(handlers.rerank({ query: 'disabled', documents: [] }, signal), /LLMHub 未启用/);
  assert.equal(providerCalls, 0);
});

test('service cleanup disposes registered production providers exactly once', () => {
  let disposed = 0;
  const provider = {
    id: 'disposable', kind: 'custom', capabilities: { chat: true },
    async request() { return { ok: true, text: 'unused' }; },
    dispose() { disposed += 1; },
  };
  const handlers = createProductionLlmServices(
    { host: { generation: { async generate() { return { text: 'unused' }; }, async listModels() { return []; } } } },
    { providers: [{ provider, resourceType: 'generation', capabilities: ['chat'] }] },
  );
  const registrations = [];
  const cleanup = exposeLlmServices({ services: { expose(_contract, _handler) { const entry = {}; registrations.push(entry); return () => registrations.splice(registrations.indexOf(entry), 1); } } }, handlers);
  assert.equal(registrations.length, 5);
  cleanup();
  cleanup();
  assert.equal(registrations.length, 0);
  assert.equal(disposed, 1);
});

test('production provider transport is aborted mid-flight and late results stay quarantined', async () => {
  const originalFetch = globalThis.fetch;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  let transportSignal;
  globalThis.fetch = (_url, init = {}) => new Promise((_resolve, reject) => {
    transportSignal = init.signal;
    started();
    init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new DOMException('Aborted', 'AbortError')), { once: true });
  });
  try {
    const handlers = createProductionLlmServices(
      { host: { generation: { async generate() { throw new Error('host fallback forbidden'); }, async listModels() { return []; } } } },
      { providers: [{
        provider: new OpenAIProvider({ id: 'abortable-embedding', apiKey: 'test', baseUrl: 'https://provider.invalid/v1' }),
        resourceType: 'embedding', capabilities: ['embeddings'], defaultModel: 'embedding-model',
      }] },
    );
    const controller = new AbortController();
    const pending = handlers.embed({ input: 'hello', route: 'abortable-embedding' }, controller.signal);
    await startedPromise;
    assert.equal(transportSignal.aborted, false);
    controller.abort();
    await assert.rejects(pending, (error) => error.code === 'CALL_ABORTED');
    assert.equal(transportSignal.aborted, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const nextController = new AbortController();
    nextController.abort();
    await assert.rejects(handlers.embed({ input: 'late', route: 'abortable-embedding' }, nextController.signal), (error) => error.code === 'CALL_ABORTED');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('production factory quarantines an ignored-signal late result from diagnostics and request logs', async () => {
  let providerStarted;
  const providerStartedPromise = new Promise((resolve) => { providerStarted = resolve; });
  let lateResolved = false;
  let providerSignal;
  const ignoredSignalProvider = {
    id: 'ignored-signal-embedding',
    kind: 'custom',
    capabilities: { chat: false, json: false, tools: false, embeddings: true },
    async request() { throw new Error('generation unused'); },
    async embed({ signal }) {
      providerSignal = signal;
      providerStarted();
      await new Promise((resolve) => setTimeout(resolve, 60));
      lateResolved = true;
      return { embeddings: [[0.5, 0.25]] };
    },
  };
  const requestLogs = new RequestLogService();
  await requestLogs.clearLogs();
  const handlers = createProductionLlmServices(
    { host: { generation: { async generate() { throw new Error('host fallback forbidden'); }, async listModels() { return []; } } } },
    { providers: [{ provider: ignoredSignalProvider, resourceType: 'embedding', capabilities: ['embeddings'], defaultModel: 'embedding-model' }] },
  );
  const controller = new AbortController();
  const pending = handlers.embed({ input: 'late', route: ignoredSignalProvider.id }, controller.signal);
  await providerStartedPromise;
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'CALL_ABORTED');
  assert.equal(providerSignal.aborted, true, 'the cooperative transport signal is still propagated');
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(lateResolved, true, 'the deliberately non-cooperative provider resolves late');

  const entries = (await handlers.diagnostics()).entries;
  const requestId = entries.findLast((entry) => entry.state === 'aborted')?.requestId;
  assert.ok(requestId);
  const requestDiagnostics = entries.filter((entry) => entry.requestId === requestId);
  assert.equal(requestDiagnostics.at(-1).state, 'aborted');
  assert.equal(requestDiagnostics.some((entry) => entry.state === 'completed'), false);

  const logs = await requestLogs.listLogs({ sourcePluginId: 'ss-helper.llm.contract' });
  assert.equal(logs.some((entry) => entry.state === 'completed'), false);
  assert.equal(logs.filter((entry) => entry.state === 'cancelled').length, 1);
});

test('rerank contract refuses the lexical fallback instead of reporting it as a provider result', async () => {
  const handlers = createLlmSdkServiceHandlers({
    async runTask() { throw new Error('unused'); }, async embed() { throw new Error('unused'); },
    async rerank() { return { ok: true, results: [{ index: 0, score: 1 }], meta: { requestId: 'r', resourceId: 'openai:fallback', capabilityKind: 'rerank', queuedAt: 1, fallbackUsed: true } }; },
  });
  await assert.rejects(handlers.rerank({ query: 'q', documents: [{ id: 'a', text: 'A' }] }, new AbortController().signal), (error) => error.code === 'PAYLOAD_INVALID');
});

test('typed completion service and route event use SDK contract tokens', async () => {
  const exposed = [];
  const events = [];
  const session = {
    services: {
      expose(contract, handler) { exposed.push({ contract, handler }); return () => exposed.splice(0); },
    },
    events: { publish(contract, payload) { events.push({ contract, payload }); } },
  };
  const cleanup = exposeLlmServices(session, {
    completion: async (request) => ({ text: request.messages[0].content, route: 'primary', model: 'model-a' }),
    runTask: async () => ({ output: {}, route: { route: 'primary' } }),
    embed: async () => ({ embeddings: [], route: { route: 'primary' } }),
    rerank: async () => ({ results: [], route: { route: 'primary' } }),
    diagnostics: () => ({ entries: [] }),
  });
  assert.equal(exposed.length, 5);
  assert.deepEqual(exposed[0].contract, LLM_COMPLETION_V1);
  const response = await exposed[0].handler({ messages: [{ role: 'user', content: 'hello' }] }, { signal: new AbortController().signal, callerPluginId: 'fixture.consumer' });
  assert.deepEqual(response, { text: 'hello', route: 'primary', model: 'model-a' });
  publishRouteChanged(session, 'fallback', 'primary', 'configured');
  assert.deepEqual(events, [{ contract: LLM_ROUTE_CHANGED_V1, payload: { previousRoute: 'fallback', route: 'primary', reason: 'configured' } }]);
  cleanup();
  assert.equal(exposed.length, 0);
});
