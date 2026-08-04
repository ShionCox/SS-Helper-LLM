import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_TAVERN_RESOURCE_ID, ConsumerRegistry, TaskRouter, TavernProvider, createLlmSdkServiceHandlers } from '../dist/index.js';

const provider = (id) => ({
  id,
  capabilities: { chat: true, json: true, tools: false, embeddings: false, rerank: false },
  async request() { return { content: id }; },
});

test('Tavern provider omits an unset model at the SDK public boundary', async () => {
  let capturedRequest;
  const tavern = new TavernProvider({
    id: BUILTIN_TAVERN_RESOURCE_ID,
    generation: {
      async available() { return true; },
      async models() { return ['current-model']; },
      async generate(request) { capturedRequest = request; return { text: '{"facts":[]}', source: 'tavern', model: 'current-model' }; },
      async test() { return { text: 'OK', source: 'tavern', model: 'current-model' }; },
    },
  });

  await tavern.request({ messages: [{ role: 'user', content: 'hello' }], model: undefined });

  assert.equal(Object.hasOwn(capturedRequest, 'model'), false);
  assert.equal(capturedRequest.quiet, true);
  assert.match(capturedRequest.prompt, /user: hello/u);
});

test('Tavern provider preserves an explicitly selected model', async () => {
  let capturedRequest;
  const tavern = new TavernProvider({
    id: BUILTIN_TAVERN_RESOURCE_ID,
    generation: {
      async available() { return true; },
      async models() { return ['chosen-model']; },
      async generate(request) { capturedRequest = request; return { text: 'ok', source: 'tavern', model: 'chosen-model' }; },
      async test() { return { text: 'OK', source: 'tavern', model: 'chosen-model' }; },
    },
  });

  await tavern.request({ messages: [{ role: 'user', content: 'hello' }], model: ' chosen-model ' });

  assert.equal(capturedRequest.model, 'chosen-model');
});

test('Tavern provider sends structured output through the native jsonSchema argument', async () => {
  let capturedRequest;
  const tavern = new TavernProvider({
    id: BUILTIN_TAVERN_RESOURCE_ID,
    generation: {
      async available() { return true; },
      async models() { return ['current-model']; },
      async generate(request) { capturedRequest = request; return { text: '{"facts":[]}', source: 'tavern', model: 'current-model' }; },
      async test() { return { text: 'OK', source: 'tavern', model: 'current-model' }; },
    },
  });

  await tavern.request({
    messages: [{ role: 'system', content: 'Extract durable facts.' }, { role: 'user', content: 'Alice lives in Suzhou.' }],
    structuredOutput: {
      transport: 'tavern_json_schema',
      identity: { vendor: 'deepseek', evidence: 'tavern_source', confidence: 'high', provider: 'deepseek', model: 'deepseek-chat' },
      strictSchemaCompatible: false,
      spec: { name: 'memory_extract', schema: { type: 'object', properties: { facts: { type: 'array', items: { type: 'object' } } }, required: ['facts'] } },
      promptInstruction: 'Return valid JSON.',
    },
  });

  assert.match(capturedRequest.prompt, /Extract durable facts\./u);
  assert.deepEqual(capturedRequest.jsonSchema, {
    name: 'memory_extract',
    value: { type: 'object', properties: { facts: { type: 'array', items: { type: 'object' } } }, required: ['facts'] },
    strict: true,
    returnInvalid: true,
  });
});

test('Tavern prompt-only structured output requests isolated host generation', async () => {
  let capturedRequest;
  const tavern = new TavernProvider({
    id: BUILTIN_TAVERN_RESOURCE_ID,
    generation: {
      async available() { return true; },
      async current() { return { provider: 'custom', model: 'deepseek-v4-flash' }; },
      async models() { return ['deepseek-v4-flash']; },
      async generate(request) { capturedRequest = request; return { text: '{"facts":[]}' }; },
      async test() { return { text: 'OK' }; },
    },
  });

  await tavern.request({
    messages: [{ role: 'system', content: 'Return JSON only.' }],
    structuredOutput: {
      transport: 'prompt_only',
      identity: { vendor: 'deepseek', evidence: 'model_name', confidence: 'medium', provider: 'custom', model: 'deepseek-v4-flash' },
      strictSchemaCompatible: true,
      spec: { name: 'memory_extract', schema: { type: 'object', properties: { facts: { type: 'array' } }, required: ['facts'] } },
      promptInstruction: 'Return valid JSON.',
    },
  });

  assert.equal(capturedRequest.contextMode, 'isolated');
  assert.equal(capturedRequest.jsonSchema, undefined);
  const result = await tavern.request({
    messages: [{ role: 'system', content: 'Return JSON only.' }],
    structuredOutput: {
      transport: 'prompt_only',
      identity: { vendor: 'deepseek', evidence: 'model_name', confidence: 'medium', provider: 'custom', model: 'deepseek-v4-flash' },
      strictSchemaCompatible: true,
      spec: { name: 'memory_extract', schema: { type: 'object', properties: { facts: { type: 'array' } }, required: ['facts'] } },
      promptInstruction: 'Return valid JSON.',
    },
  });
  assert.equal(result.debugRequest.requestFormat, 'tavern_generate_raw');
  assert.equal(result.debugRequest.contextMode, 'isolated');
  assert.equal(result.debugRequest.nativeSchemaSent, false);
});

test('Tavern provider selects transport from the actual SillyTavern source boundary', async () => {
  let current = { provider: 'custom', model: 'deepseek-v4-flash' };
  const tavern = new TavernProvider({
    id: BUILTIN_TAVERN_RESOURCE_ID,
    generation: {
      async available() { return true; },
      async current() { return current; },
      async models() { return [current.model]; },
      async generate() { return { text: '{}' }; },
      async test() { return { text: 'OK' }; },
    },
  });

  const customIdentity = await tavern.getStructuredOutputIdentity();
  assert.equal(customIdentity.vendor, 'deepseek');
  assert.deepEqual(tavern.getStructuredOutputCapability(customIdentity), {
    transports: ['prompt_only'],
    preferred: 'prompt_only',
  });

  current = { provider: 'deepseek', model: 'deepseek-v4-flash' };
  const nativeIdentity = await tavern.getStructuredOutputIdentity();
  assert.deepEqual(tavern.getStructuredOutputCapability(nativeIdentity), {
    transports: ['tavern_json_schema', 'prompt_only'],
    preferred: 'tavern_json_schema',
  });
});

test('Tavern provider reports a safe actionable reason when the host adapter rejects generation', async () => {
  const tavern = new TavernProvider({
    id: BUILTIN_TAVERN_RESOURCE_ID,
    generation: {
      async available() { return true; },
      async current() { return { provider: 'custom', model: 'deepseek-v4-flash' }; },
      async models() { return ['deepseek-v4-flash']; },
      async generate() { throw Object.assign(new Error('The Tavern host adapter failed'), { code: 'BRIDGE_CORRUPTED' }); },
      async test() { return { text: 'OK' }; },
    },
  });

  await assert.rejects(
    tavern.request({ messages: [{ role: 'user', content: 'hello' }] }),
    (error) => error?.details?.reasonCode === 'INTERNAL_ERROR' && error?.details?.stage === 'llm.provider.tavern',
  );
});

test('LLM service errors retain provider reason codes for consumers', async () => {
  const handlers = createLlmSdkServiceHandlers({
    async runTask() {
      return {
        ok: false,
        error: '模型返回内容不是有效 JSON',
        reasonCode: 'INVALID_JSON',
        meta: { usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 } },
      };
    },
    async embed() { return {}; },
    async rerank() { return {}; },
    registerConsumer() {},
    unregisterConsumer() {},
  });

  await assert.rejects(
    handlers.runTask({ task: 'memory_extract', input: {}, outputSchema: {} }, new AbortController().signal),
    (error) => error?.code === 'INVALID_PAYLOAD'
      && error?.details?.reasonCode === 'INVALID_JSON'
      && error?.details?.inputTokens === 12
      && error?.details?.outputTokens === 3
      && error?.details?.totalTokens === 15,
  );
});

function generationRouter(recommendedResourceId) {
  const router = new TaskRouter();
  const registry = new ConsumerRegistry();
  registry.registerConsumer({
    pluginId: 'fixture.consumer',
    displayName: 'Fixture',
    registrationVersion: 1,
    tasks: [{ taskKey: 'generate', taskKind: 'generation', requiredCapabilities: ['chat', 'json'], recommendedRoute: { resourceId: recommendedResourceId } }],
  });
  router.setRegistry(registry);
  router.registerProvider(provider(BUILTIN_TAVERN_RESOURCE_ID), 'generation', ['chat', 'json']);
  router.registerProvider(provider('custom-a'), 'generation', ['chat', 'json'], 'model-a');
  router.registerProvider(provider('custom-b'), 'generation', ['chat', 'json'], 'model-b');
  return router;
}

test('Tavern generation source fails closed for an explicit custom task assignment', () => {
  const router = generationRouter('custom-a');
  router.applyGenerationSource('tavern');
  router.applyTaskAssignments([{ pluginId: 'fixture.consumer', taskKey: 'generate', taskKind: 'generation', resourceId: 'custom-b', isStale: false }]);
  router.applyPluginAssignments([{ pluginId: 'fixture.consumer', generation: { resourceId: 'custom-a' } }]);
  router.applyGlobalAssignments({ generation: { resourceId: 'custom-b' } });

  assert.throws(() => router.resolveRoute({
    consumer: 'fixture.consumer',
    taskKind: 'generation',
    taskKey: 'generate',
    requiredCapabilities: ['chat', 'json'],
    routeHint: { resourceId: 'custom-a' },
  }), (error) => error?.details?.reasonCode === 'LLM_TASK_ROUTE_UNAVAILABLE');
  router.applyTaskAssignments([]);
  const route = router.resolveRoute({ consumer: 'fixture.consumer', taskKind: 'generation', taskKey: 'generate', requiredCapabilities: ['chat', 'json'], routeHint: { resourceId: 'custom-a' } });
  assert.equal(route.resourceId, BUILTIN_TAVERN_RESOURCE_ID);
  assert.equal(route.resolvedBy, 'builtin_tavern_fallback');
});

test('custom generation source fails closed for Tavern task assignments and otherwise preserves custom priority', () => {
  const router = generationRouter(BUILTIN_TAVERN_RESOURCE_ID);
  router.applyGenerationSource('custom');
  router.applyTaskAssignments([{ pluginId: 'fixture.consumer', taskKey: 'generate', taskKind: 'generation', resourceId: BUILTIN_TAVERN_RESOURCE_ID, isStale: false }]);
  router.applyPluginAssignments([{ pluginId: 'fixture.consumer', generation: { resourceId: BUILTIN_TAVERN_RESOURCE_ID } }]);
  router.applyGlobalAssignments({ generation: { resourceId: 'custom-a' } });

  assert.throws(() => router.resolveRoute({
    consumer: 'fixture.consumer',
    taskKind: 'generation',
    taskKey: 'generate',
    requiredCapabilities: ['chat', 'json'],
    routeHint: { resourceId: BUILTIN_TAVERN_RESOURCE_ID },
  }), (error) => error?.details?.reasonCode === 'LLM_TASK_ROUTE_UNAVAILABLE');
  router.applyTaskAssignments([]);
  const route = router.resolveRoute({ consumer: 'fixture.consumer', taskKind: 'generation', taskKey: 'generate', requiredCapabilities: ['chat', 'json'], routeHint: { resourceId: BUILTIN_TAVERN_RESOURCE_ID } });
  assert.equal(route.resourceId, 'custom-a');
  assert.equal(route.resolvedBy, 'user_global_default');

  const hinted = router.resolveRoute({
    consumer: 'fixture.consumer',
    taskKind: 'generation',
    taskKey: 'generate',
    requiredCapabilities: ['chat', 'json'],
    routeHint: { resourceId: 'custom-b' },
  });
  assert.equal(hinted.resourceId, 'custom-b');
  assert.equal(hinted.resolvedBy, 'route_hint');
});

test('custom generation fails closed when no custom provider is available', () => {
  const router = new TaskRouter();
  router.registerProvider(provider(BUILTIN_TAVERN_RESOURCE_ID), 'generation', ['chat', 'json']);
  router.applyGenerationSource('custom');
  assert.throws(
    () => router.resolveRoute({ consumer: 'fixture.consumer', taskKind: 'generation', requiredCapabilities: ['chat', 'json'] }),
    (error) => error?.details?.reasonCode === 'PROVIDER_UNAVAILABLE',
  );
});

test('embedding and rerank never use Tavern and retain custom capability fallback', () => {
  const router = new TaskRouter();
  router.registerProvider(provider(BUILTIN_TAVERN_RESOURCE_ID), 'generation', ['chat', 'json']);
  router.applyGenerationSource('tavern');
  assert.throws(() => router.resolveRoute({ consumer: 'fixture.consumer', taskKind: 'embedding' }), (error) => error?.details?.reasonCode === 'PROVIDER_UNAVAILABLE');
  assert.throws(() => router.resolveRoute({ consumer: 'fixture.consumer', taskKind: 'rerank' }), (error) => error?.details?.reasonCode === 'PROVIDER_UNAVAILABLE');

  router.registerProvider(provider('custom-multi'), 'generation', ['chat', 'json', 'embeddings', 'rerank']);
  assert.equal(router.resolveRoute({ consumer: 'fixture.consumer', taskKind: 'embedding', requiredCapabilities: ['embeddings'] }).resourceId, 'custom-multi');
  assert.equal(router.resolveRoute({ consumer: 'fixture.consumer', taskKind: 'rerank', requiredCapabilities: ['rerank'] }).resourceId, 'custom-multi');
  assert.equal(router.resolveRoute({ consumer: 'fixture.consumer', taskKind: 'generation', requiredCapabilities: ['chat', 'json'] }).resourceId, BUILTIN_TAVERN_RESOURCE_ID);
});
