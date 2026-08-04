import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BudgetManager,
  ConsumerRegistry,
  RequestLogService,
  RequestOrchestrator,
  TaskRouter,
  LLMSDKImpl,
} from '../dist/index.js';
import { createSSHelperError } from '@ss-helper/sdk';

function fixture(structuredPolicy = { maxProviderAttempts: 2, repairOn: ['INVALID_JSON', 'SCHEMA_VALIDATION_FAILED'] }) {
  const calls = [];
  const provider = {
    id: 'fixture-provider',
    kind: 'custom',
    capabilities: {
      chat: true,
      json: true,
      tools: false,
      embeddings: false,
      structuredOutput: { transports: ['json_schema', 'prompt_only'], preferred: 'json_schema' },
    },
    getStructuredOutputIdentity() {
      return { vendor: 'unknown', evidence: 'manual', confidence: 'high', model: 'fixture-model' };
    },
    async request(request) {
      calls.push(request);
      return {
        content: calls.length === 1 ? '{"value":1}' : '{"value":"ok"}',
        finishReason: 'stop',
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        structuredOutput: { plannedTransport: request.structuredOutput.transport, actualTransport: request.structuredOutput.transport },
      };
    },
  };
  const registry = new ConsumerRegistry();
  const router = new TaskRouter();
  router.setRegistry(registry);
  router.applyGenerationSource('custom');
  router.registerProvider(provider, 'generation', ['chat', 'json'], 'fixture-model');
  registry.registerConsumer({
    pluginId: 'ss-helper.memory',
    displayName: 'Memory',
    registrationVersion: 1,
    tasks: [{
      taskKey: 'memory_capture',
      description: '提取单阶段结构化记忆',
      taskKind: 'generation',
      requiredCapabilities: ['chat', 'json'],
      structuredPolicy,
      recommendedRoute: { resourceId: provider.id },
    }],
  });
  const logs = new RequestLogService();
  const rateSlots = [];
  const sdk = new LLMSDKImpl(router, new BudgetManager(), new RequestOrchestrator(), registry, logs, {
    async acquire(_signal, requestId) { rateSlots.push(requestId); },
  });
  return { sdk, calls, logs, provider, rateSlots };
}

test('Schema failure performs one same-provider repair and logs both attempts under one root request', async () => {
  const { sdk, calls, logs, rateSlots } = fixture();
  const result = await sdk.runTask({
    consumer: 'ss-helper.memory',
    taskKey: 'memory_capture',
    taskKind: 'generation',
    input: { messages: [{ role: 'user', content: 'extract' }] },
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['value'],
      properties: { value: { type: 'string' } },
    },
    enqueue: { requestId: 'root-capture-1' },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.data, { value: 'ok' });
  assert.equal(result.meta.requestId, 'root-capture-1');
  assert.equal(result.meta.attemptCount, 2);
  assert.equal(result.meta.repairCount, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(rateSlots, ['root-capture-1', 'root-capture-1']);
  assert.match(calls[1].messages.at(-1).content, /安全校验问题/u);
  assert.doesNotMatch(calls[1].messages.at(-1).content, /\{"value":1\}/u);

  const rows = (await logs.listLogs({ limit: 10 })).sort((left, right) => left.attemptIndex - right.attemptIndex);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [row.requestId, row.attemptPhase, row.state]), [
    ['root-capture-1', 'initial', 'failed'],
    ['root-capture-1', 'schema_repair', 'completed'],
  ]);
  assert.equal(rows[0].taskDescription, '提取单阶段结构化记忆');
  assert.equal(rows[0].consumerDisplayName, 'Memory');
  assert.deepEqual([rows[0].resourceId, rows[0].model, rows[0].providerKind], ['fixture-provider', 'fixture-model', 'custom']);
});

test('empty and truncated structured results do not consume the repair attempt', async () => {
  for (const response of [
    { content: '', finishReason: 'stop' },
    { content: '{"value":"unfinished"', finishReason: 'length' },
  ]) {
    const { sdk, calls, provider } = fixture();
    calls.length = 0;
    provider.request = async (request) => { calls.push(request); return response; };
    const result = await sdk.runTask({
      consumer: 'ss-helper.memory',
      taskKey: 'memory_capture',
      taskKind: 'generation',
      input: { messages: [{ role: 'user', content: 'extract' }] },
      schema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string' } } },
      enqueue: { requestId: `root-${response.finishReason}` },
    });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1, JSON.stringify(result));
  }
});

test('itemized partial validation returns valid siblings without an immediate repair call', async () => {
  const policy = {
    maxProviderAttempts: 2,
    repairOn: ['INVALID_JSON', 'SCHEMA_VALIDATION_FAILED'],
    itemFailure: 'return_partial',
    envelopeFailure: 'repair_once',
    itemCollections: ['claims'],
  };
  const { sdk, calls, logs, provider } = fixture(policy);
  calls.length = 0;
  provider.request = async (request) => {
    calls.push(request);
    return {
      content: JSON.stringify({
        claims: [
          { localId: 'valid-1', sourceRef: 'message:1' },
          { localId: 'bad id', sourceRef: 'message:2', rawSecret: 'never-log-me' },
        ],
      }),
      finishReason: 'stop',
      usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
      structuredOutput: {
        plannedTransport: request.structuredOutput.transport,
        actualTransport: request.structuredOutput.transport,
      },
    };
  };
  const result = await sdk.runTask({
    consumer: 'ss-helper.memory',
    taskKey: 'memory_capture',
    taskKind: 'generation',
    input: { messages: [{ role: 'user', content: 'extract' }] },
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['claims'],
      properties: {
        claims: {
          type: 'array',
          maxItems: 4,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['localId', 'sourceRef'],
            properties: {
              localId: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
              sourceRef: { type: 'string', enum: ['message:1', 'message:2'] },
            },
          },
        },
      },
    },
    enqueue: { requestId: 'root-partial-1' },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1);
  assert.deepEqual(result.data, { claims: [{ localId: 'valid-1', sourceRef: 'message:1' }] });
  assert.equal(result.meta.validationOutcome, 'partial');
  assert.equal(result.meta.attemptCount, 1);
  assert.equal(result.meta.repairCount, 0);
  assert.deepEqual(result.meta.itemRejections, [{
    collection: 'claims',
    itemIndex: 1,
    issues: [
      { path: '$.claims[1].rawSecret', keyword: 'additionalProperties', expected: 'property to be absent' },
      { path: '$.claims[1].localId', keyword: 'pattern', expected: '^[A-Za-z0-9_-]+$' },
    ],
    sourceRefs: ['message:2'],
  }]);
  assert.equal(JSON.stringify(result.meta.itemRejections).includes('never-log-me'), false);
  const rows = (await logs.listLogs({ limit: 20 }))
    .filter(row => row.requestId === 'root-partial-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'completed');
  assert.equal(JSON.stringify(rows[0].itemRejections ?? []).includes('never-log-me'), false);
});

test('provider-specific capability is resolved before the first structured request', async () => {
  const { sdk, calls, provider } = fixture();
  provider.getStructuredOutputIdentity = () => ({
    vendor: 'deepseek',
    evidence: 'model_name',
    confidence: 'medium',
    provider: 'custom',
    model: 'deepseek-v4-flash',
  });
  provider.getStructuredOutputCapability = () => ({
    transports: ['prompt_only'],
    preferred: 'prompt_only',
  });
  provider.request = async (request) => {
    calls.push(request);
    return {
      content: '{"value":"ok"}',
      finishReason: 'stop',
      structuredOutput: {
        plannedTransport: request.structuredOutput.transport,
        actualTransport: request.structuredOutput.transport,
      },
    };
  };

  const result = await sdk.runTask({
    consumer: 'ss-helper.memory',
    taskKey: 'memory_capture',
    taskKind: 'generation',
    input: { messages: [{ role: 'user', content: 'extract' }] },
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['value'],
      properties: { value: { type: 'string' } },
    },
    enqueue: { requestId: 'preflight-custom-deepseek' },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.meta.attemptCount, 1);
  assert.equal(result.meta.transport, 'prompt_only');
  assert.deepEqual(calls.map(call => call.structuredOutput.transport), ['prompt_only']);
  assert.match(calls[0].messages[0].content, /JSON Schema/u);
});

for (const scenario of [
  {
    name: 'Tavern native schema',
    transports: ['tavern_json_schema', 'prompt_only'],
    preferred: 'tavern_json_schema',
  },
  {
    name: 'DeepSeek json_object',
    transports: ['json_object', 'prompt_only'],
    preferred: 'json_object',
  },
]) {
  test(`${scenario.name} falls back to prompt-only and caches the unsupported transport`, async () => {
    const { sdk, calls, provider } = fixture();
    provider.capabilities.structuredOutput = {
      transports: scenario.transports,
      preferred: scenario.preferred,
    };
    provider.request = async (request) => {
      calls.push(request);
      if (request.structuredOutput.transport !== 'prompt_only') {
        throw createSSHelperError('RESPONSE_FORMAT_UNSUPPORTED', {
          stage: 'fixture.response-format',
          providerKind: 'fixture',
        });
      }
      return {
        content: '{"value":"ok"}',
        finishReason: 'stop',
        structuredOutput: {
          plannedTransport: request.structuredOutput.transport,
          actualTransport: request.structuredOutput.transport,
        },
      };
    };
    const run = (requestId) => sdk.runTask({
      consumer: 'ss-helper.memory',
      taskKey: 'memory_capture',
      taskKind: 'generation',
      input: { messages: [{ role: 'user', content: 'extract' }] },
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: { value: { type: 'string' } },
      },
      enqueue: { requestId },
    });

    const first = await run(`fallback-${scenario.preferred}-1`);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual(calls.map(call => call.structuredOutput.transport), [scenario.preferred, 'prompt_only']);
    assert.equal(first.meta.transport, 'prompt_only');

    calls.length = 0;
    const second = await run(`fallback-${scenario.preferred}-2`);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.deepEqual(calls.map(call => call.structuredOutput.transport), ['prompt_only']);
  });
}
