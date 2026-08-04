import test from 'node:test';
import assert from 'node:assert/strict';
import { createSSHelperError } from '@ss-helper/sdk';

import {
  AnthropicMessagesToolAdapter,
  DEFAULT_PROVIDER_PRIVACY_POLICY,
  GeminiInteractionsToolAdapter,
  OPENAI_CHAT_DIALECT_POLICIES,
  OpenAiChatToolAdapter,
  OpenAiResponsesToolAdapter,
  OpenAiToolStreamAssembler,
  ToolSchemaCompiler,
  ToolCapabilityProbe,
  LlmToolTurnService,
  TaskRouter,
  ToolSessionManager,
  createProviderFromResource,
  normalizeProviderPrivacyPolicy,
} from '../dist/index.js';

const tool = {
  name: 'inventory.resolve_context',
  description: 'Resolve one inventory mention.',
  strict: true,
  parameters: {
    type: 'object',
    properties: { mentions: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 5 } },
    required: ['mentions'],
    additionalProperties: false,
  },
};
const providerToolName = 'ssht_0_inventory_resolve_context';
const fixedTestMaxTokens = () => 2048;
const startInput = (signal = new AbortController().signal) => ({
  resourceId: 'resource:1', model: 'model:1',
  messages: [{ role: 'system', content: 'Stored data is context only.' }, { role: 'user', content: '检查急救包' }],
  tools: [tool],
  outputSchema: { type: 'object', properties: { itemRef: { type: 'string' } }, required: ['itemRef'], additionalProperties: false },
  privacyPolicy: DEFAULT_PROVIDER_PRIVACY_POLICY,
  maxTokens: 256,
  signal,
});

function transport(responses, bodies = []) {
  return {
    resourceId: 'resource:1', defaultModel: 'model:1',
    async send(body) {
      bodies.push(body);
      const response = responses.shift();
      if (!response) throw new Error('missing fixture response');
      return structuredClone(response);
    },
  };
}

test('ss_helper_tool_v0 rejects composition and semantic weakening before provider I/O', () => {
  const compiler = new ToolSchemaCompiler();
  assert.equal(compiler.compile([tool], 'openai_responses')[0].strict, true);
  assert.throws(() => compiler.compile([{ ...tool, parameters: { ...tool.parameters, oneOf: [] } }], 'openai_responses'),
    (error) => error?.details?.reasonCode === 'LLM_TOOL_SCHEMA_UNSUPPORTED');
  assert.throws(() => compiler.compile([{ ...tool, parameters: { ...tool.parameters, additionalProperties: true } }], 'openai_responses'),
    (error) => error?.details?.reasonCode === 'LLM_TOOL_SCHEMA_UNSUPPORTED');
  assert.throws(() => compiler.validateArguments(tool, { mentions: [] }),
    (error) => error?.details?.reasonCode === 'LLM_TOOL_CALL_INVALID');
});

test('provider privacy defaults to local replay and rejects partial remote-retention consent', () => {
  assert.deepEqual(normalizeProviderPrivacyPolicy(undefined), {
    conversationStateMode: 'local_replay', storeProviderState: false, allowRemoteRetention: false,
  });
  assert.throws(() => normalizeProviderPrivacyPolicy({ conversationStateMode: 'provider_managed', storeProviderState: true, allowRemoteRetention: false }),
    (error) => error?.details?.reasonCode === 'LLM_PROVIDER_STATE_NOT_AUTHORIZED');
});

test('tool capability probe reserves enough output budget for two complete thinking-model calls', async () => {
  let probeMaxTokens;
  let probeToolChoice;
  const adapter = {
    dialect: 'deepseek_chat', version: 1,
    async start(input) {
      probeMaxTokens = input.maxTokens;
      probeToolChoice = input.toolChoice;
      return {
        state: 'tool_calls',
        calls: [
          { callId: 'probe-1', name: 'ss_helper_tool_probe', arguments: { value: 'probe-a' } },
          { callId: 'probe-2', name: 'ss_helper_tool_probe', arguments: { value: 'probe-b' } },
        ],
        adapterState: { round: 1 },
      };
    },
    async continue() { return { state: 'final', output: { ok: true }, adapterState: { round: 2 } }; },
    async finalize() { throw new Error('unused'); },
    estimateStateBytes: () => 1,
    dispose() {},
  };
  const capability = await new ToolCapabilityProbe().verify({
    resourceId: 'resource:probe', model: 'thinking-model', adapter,
    privacyPolicy: DEFAULT_PROVIDER_PRIVACY_POLICY, signal: new AbortController().signal,
  });
  assert.equal(capability.status, 'verified');
  assert.equal(probeMaxTokens, 512);
  assert.equal(probeToolChoice, 'required');
});

test('tool capability verification persists and hydrates across service instances', async () => {
  const records = new Map();
  const store = {
    async listToolCapabilities() { return [...records.entries()].map(([cacheKey, capability]) => ({ cacheKey, capability: structuredClone(capability) })); },
    async saveToolCapability(cacheKey, capability) { records.set(cacheKey, structuredClone(capability)); },
    async deleteToolCapabilitiesForResource(resourceId) {
      let removed = 0;
      for (const [key, capability] of records) if (capability.resourceId === resourceId) { records.delete(key); removed += 1; }
      return removed;
    },
  };
  const adapter = {
    dialect: 'openai_chat_compatible', version: 1,
    async start() { return { state: 'tool_calls', calls: [{ callId: 'probe-1', name: 'ss_helper_tool_probe', arguments: { value: 'probe-a' } }], adapterState: { round: 1 } }; },
    async continue() { return { state: 'final', output: { ok: true }, adapterState: { round: 2 } }; },
    async finalize() { throw new Error('unused'); }, estimateStateBytes: () => 1, dispose() {},
  };
  const provider = { id: 'resource:persist', capabilities: { chat: true, json: true, tools: true }, createToolAdapter: () => adapter };
  const resource = { id: provider.id, type: 'generation', source: 'custom', apiType: 'generic', label: 'Persist', baseUrl: 'https://example.invalid/v1', model: 'model:persist', enabled: true };
  const createService = () => {
    const router = new TaskRouter();
    router.registerProvider(provider, 'generation', ['chat', 'json', 'tools'], resource.model);
    return new LlmToolTurnService(router, { getResource: (resourceId) => resourceId === resource.id ? resource : undefined }, fixedTestMaxTokens, store);
  };
  const first = createService();
  const verified = await first.verify(resource.id, resource.model, true, new AbortController().signal);
  assert.equal(verified.capability.status, 'verified');
  assert.equal(records.size, 1);
  first.dispose();

  const restored = createService();
  assert.equal((await restored.getCapability(resource.id, resource.model))?.status, 'verified');
  restored.invalidateResource(resource.id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(records.size, 0);
  restored.dispose();
});

test('aborted tool capability verification is neither cached nor persisted as a failed capability', async () => {
  let saves = 0;
  const adapter = {
    dialect: 'openai_chat_compatible', version: 1,
    async start() { throw new DOMException('aborted', 'AbortError'); },
    async continue() { throw new Error('unused'); }, async finalize() { throw new Error('unused'); },
    estimateStateBytes: () => 0, dispose() {},
  };
  const provider = { id: 'resource:abort-probe', capabilities: { chat: true, json: true, tools: true }, createToolAdapter: () => adapter };
  const resource = { id: provider.id, type: 'generation', source: 'custom', apiType: 'generic', label: 'Abort probe', baseUrl: 'https://example.invalid/v1', model: 'model:abort', enabled: true };
  const router = new TaskRouter();
  router.registerProvider(provider, 'generation', ['chat', 'json', 'tools'], resource.model);
  const store = {
    async listToolCapabilities() { return []; },
    async saveToolCapability() { saves += 1; },
    async deleteToolCapabilitiesForResource() { return 0; },
  };
  const service = new LlmToolTurnService(router, { getResource: () => resource }, fixedTestMaxTokens, store);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.verify(resource.id, resource.model, true, controller.signal),
    (error) => error?.details?.reasonCode === 'REQUEST_ABORTED');
  assert.equal(saves, 0);
  assert.equal(await service.getCapability(resource.id, resource.model), undefined);
  service.dispose();
});

test('Agent turns log the provider kind and preserve cancellation on the real third round', async () => {
  const logged = [];
  const adapter = {
    dialect: 'openai_chat_compatible', version: 1,
    async start(input) {
      if (input.messages[0].content.includes('probe')) {
        return { state: 'tool_calls', calls: [{ callId: 'probe-1', name: 'ss_helper_tool_probe', arguments: { value: 'probe-a' } }], adapterState: { probe: true } };
      }
      return { state: 'tool_calls', calls: [{ callId: 'call-1', name: tool.name, arguments: { mentions: ['急救包'] } }], adapterState: { round: 1 } };
    },
    async continue(state, _results, signal) {
      if (state.probe) return { state: 'final', output: { ok: true }, adapterState: { probe: true, done: true } };
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return { state: 'tool_calls', calls: [{ callId: 'call-2', name: tool.name, arguments: { mentions: ['备用药品'] } }], adapterState: { round: 2 } };
    },
    async finalize() { throw new Error('unused'); }, estimateStateBytes: () => 1, dispose() {},
  };
  const provider = { id: 'resource:agent-log', capabilities: { chat: true, json: true, tools: true }, createToolAdapter: () => adapter };
  const resource = { id: provider.id, type: 'generation', source: 'custom', apiType: 'xai', label: 'Grok', baseUrl: 'https://api.x.ai/v1', model: 'grok-test', enabled: true };
  const router = new TaskRouter();
  router.registerProvider(provider, 'generation', ['chat', 'json', 'tools'], resource.model);
  router.applyGenerationSource('custom');
  const requestLogs = { async recordAgentTurn(input) { logged.push(input); } };
  const rateSlots = [];
  const requestRateLimiter = { async acquire(_signal, requestId) { rateSlots.push(requestId); } };
  let startedMaxTokens;
  const resolveAgentMaxTokens = () => 12288;
  const originalStart = adapter.start;
  adapter.start = async (input) => { startedMaxTokens = input.maxTokens; return originalStart(input); };
  const service = new LlmToolTurnService(router, { getResource: () => resource }, resolveAgentMaxTokens, undefined, requestLogs, () => ({ taskDescription: '提取物品与库存变化' }), requestRateLimiter);
  assert.equal((await service.verify(resource.id, resource.model, true, new AbortController().signal)).capability.status, 'verified');
  const base = { task: 'memory_extract_inventory', pipelineRunId: 'pipeline-1', chatKey: 'chat-1', route: resource.id };
  const first = await service.turn({ ...base, input: { messages: startInput().messages }, outputSchema: startInput().outputSchema, tools: [tool] }, 'ss-helper.memory', 'turn-1', new AbortController().signal);
  const second = await service.turn({ ...base, toolSessionId: first.toolSessionId, toolResults: [{ callId: 'call-1', name: tool.name, ok: true, content: { ref: 'O07' } }] }, 'ss-helper.memory', 'turn-2', new AbortController().signal);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.turn({ ...base, toolSessionId: second.toolSessionId, toolResults: [{ callId: 'call-2', name: tool.name, ok: true, content: { ref: 'O08' } }] }, 'ss-helper.memory', 'turn-3', controller.signal),
    (error) => error?.details?.reasonCode === 'REQUEST_ABORTED');
  assert.equal(logged[0].route.providerKind, 'xai');
  assert.equal(startedMaxTokens, 12288);
  assert.deepEqual(rateSlots, [undefined, undefined, 'turn-1', 'turn-2', 'turn-3']);
  assert.deepEqual({ round: logged.at(-1).toolSessionRound, reasonCode: logged.at(-1).failure.reasonCode }, { round: 3, reasonCode: 'REQUEST_ABORTED' });
  service.dispose();
});

test('Agent schema failures log the parsed output and every safe validation issue once', async () => {
  const logged = [];
  let actualMessages;
  const adapter = {
    dialect: 'openai_chat_compatible', version: 1,
    async start(input) {
      if (input.messages[0].content.includes('probe')) {
        return { state: 'tool_calls', calls: [{ callId: 'probe-1', name: 'ss_helper_tool_probe', arguments: { value: 'probe-a' } }], adapterState: { probe: true } };
      }
      actualMessages = input.messages;
      return {
        state: 'final', output: { extra: true }, adapterState: { done: true },
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      };
    },
    async continue(state) {
      if (state.probe) return { state: 'final', output: { ok: true }, adapterState: { probe: true, done: true } };
      throw new Error('unused');
    },
    async finalize() { throw new Error('unused'); }, estimateStateBytes: () => 1, dispose() {},
  };
  const provider = { id: 'resource:schema-log', capabilities: { chat: true, json: true, tools: true }, createToolAdapter: () => adapter };
  const resource = { id: provider.id, type: 'generation', source: 'custom', apiType: 'generic', label: 'Schema log', baseUrl: 'https://example.invalid/v1', model: 'model:schema', enabled: true };
  const router = new TaskRouter();
  router.registerProvider(provider, 'generation', ['chat', 'json', 'tools'], resource.model);
  router.applyGenerationSource('custom');
  const requestLogs = { async recordAgentTurn(input) { logged.push(input); } };
  const service = new LlmToolTurnService(router, { getResource: () => resource }, fixedTestMaxTokens, undefined, requestLogs);
  assert.equal((await service.verify(resource.id, resource.model, true, new AbortController().signal)).capability.status, 'verified');

  await assert.rejects(service.turn({
    task: 'memory_extract_inventory', pipelineRunId: 'pipeline-schema', chatKey: 'chat-schema', route: resource.id,
    input: { messages: startInput().messages }, outputSchema: startInput().outputSchema, tools: [tool],
  }, 'ss-helper.memory', 'turn-schema', new AbortController().signal),
  (error) => error?.details?.reasonCode === 'SCHEMA_VALIDATION_FAILED'
    && error?.details?.inputTokens === 20
    && error?.details?.outputTokens === 5
    && error?.details?.totalTokens === 25);

  const terminal = logged.filter((entry) => entry.phase !== 'started');
  assert.equal(terminal.length, 1);
  assert.deepEqual(terminal[0].parsedResponse, { extra: true });
  assert.equal(terminal[0].failure.reasonCode, 'SCHEMA_VALIDATION_FAILED');
  assert.equal(terminal[0].validationIssues.some((issue) => issue.path === '$.itemRef' && issue.keyword === 'required'), true);
  assert.equal(terminal[0].validationIssues.some((issue) => issue.path === '$.extra' && issue.keyword === 'additionalProperties'), true);
  assert.equal(actualMessages[0].role, 'system');
  assert.equal(actualMessages[0].content.includes('itemRef'), true);
  assert.equal(actualMessages[0].content.includes('additionalProperties'), true);
  service.dispose();
});

test('Agent protocol failures forward private response evidence to the request logger', async () => {
  const logged = [];
  const rawResponseText = 'data: {"choices":[';
  const adapter = {
    dialect: 'openai_chat_compatible', version: 1,
    async start(input) {
      if (input.messages[0].content.includes('probe')) {
        return { state: 'tool_calls', calls: [{ callId: 'probe-1', name: 'ss_helper_tool_probe', arguments: { value: 'probe-a' } }], adapterState: { probe: true } };
      }
      const error = createSSHelperError('HTTP_RESPONSE_PROTOCOL_INVALID', { stage: 'llm.bridge.http.response', httpStatus: 200 });
      Object.defineProperties(error, {
        rawResponseText: { value: rawResponseText, enumerable: false },
        providerResponse: { value: { incomplete: true }, enumerable: false },
      });
      throw error;
    },
    async continue(state) {
      if (state.probe) return { state: 'final', output: { ok: true }, adapterState: { probe: true, done: true } };
      throw new Error('unused');
    },
    async finalize() { throw new Error('unused'); }, estimateStateBytes: () => 1, dispose() {},
  };
  const provider = { id: 'resource:protocol-log', capabilities: { chat: true, json: true, tools: true }, createToolAdapter: () => adapter };
  const resource = { id: provider.id, type: 'generation', source: 'custom', apiType: 'generic', label: 'Protocol log', baseUrl: 'https://example.invalid/v1', model: 'model:protocol', enabled: true };
  const router = new TaskRouter();
  router.registerProvider(provider, 'generation', ['chat', 'json', 'tools'], resource.model);
  router.applyGenerationSource('custom');
  const requestLogs = { async recordAgentTurn(input) { logged.push(input); } };
  const service = new LlmToolTurnService(router, { getResource: () => resource }, fixedTestMaxTokens, undefined, requestLogs);
  assert.equal((await service.verify(resource.id, resource.model, true, new AbortController().signal)).capability.status, 'verified');

  await assert.rejects(service.turn({
    task: 'memory_extract_single', pipelineRunId: 'pipeline-protocol', chatKey: 'chat-protocol', route: resource.id,
    input: { messages: startInput().messages }, outputSchema: startInput().outputSchema, tools: [tool],
  }, 'ss-helper.memory', 'turn-protocol', new AbortController().signal),
  (error) => error?.details?.reasonCode === 'HTTP_RESPONSE_PROTOCOL_INVALID');

  const terminal = logged.filter((entry) => entry.phase !== 'started');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].rawResponseText, rawResponseText);
  assert.equal(terminal[0].providerResponse.incomplete, true);
  assert.equal(JSON.stringify(terminal[0].failure).includes(rawResponseText), false);
  service.dispose();
});

test('tool capability persistence failure clears an older verified result and degrades to unverified', async () => {
  const records = new Map();
  let failSave = false;
  const store = {
    async listToolCapabilities() { return [...records.entries()].map(([cacheKey, capability]) => ({ cacheKey, capability: structuredClone(capability) })); },
    async saveToolCapability(cacheKey, capability) {
      if (failSave) throw new Error('workspace unavailable');
      records.set(cacheKey, structuredClone(capability));
    },
    async deleteToolCapabilitiesForResource(resourceId) {
      let removed = 0;
      for (const [key, capability] of records) if (capability.resourceId === resourceId) { records.delete(key); removed += 1; }
      return removed;
    },
  };
  const adapter = {
    dialect: 'openai_chat_compatible', version: 1,
    async start() { return { state: 'tool_calls', calls: [{ callId: 'probe-1', name: 'ss_helper_tool_probe', arguments: { value: 'probe-a' } }], adapterState: { round: 1 } }; },
    async continue() { return { state: 'final', output: { ok: true }, adapterState: { round: 2 } }; },
    async finalize() { throw new Error('unused'); }, estimateStateBytes: () => 1, dispose() {},
  };
  const provider = { id: 'resource:persist-failure', capabilities: { chat: true, json: true, tools: true }, createToolAdapter: () => adapter };
  const resource = { id: provider.id, type: 'generation', source: 'custom', apiType: 'generic', label: 'Persist failure', baseUrl: 'https://example.invalid/v1', model: 'model:persist', enabled: true };
  const router = new TaskRouter();
  router.registerProvider(provider, 'generation', ['chat', 'json', 'tools'], resource.model);
  const service = new LlmToolTurnService(router, { getResource: (resourceId) => resourceId === resource.id ? resource : undefined }, fixedTestMaxTokens, store);
  assert.equal((await service.verify(resource.id, resource.model, true, new AbortController().signal)).capability.status, 'verified');
  failSave = true;
  await assert.rejects(service.verify(resource.id, resource.model, true, new AbortController().signal), /workspace unavailable/u);
  assert.equal(await service.getCapability(resource.id, resource.model), undefined);
  assert.equal(records.size, 0);
  service.dispose();
});

test('tool capability hydration retries after a transient workspace failure', async () => {
  let attempts = 0;
  const capability = {
    status: 'verified', resourceId: 'resource:hydrate-retry', model: 'model:retry', dialect: 'openai_chat_compatible',
    parallelToolCalls: false, streamingToolCalls: false, strictToolSchema: 'none', reasoningReplay: 'none',
    verifiedAt: Date.now(), expiresAt: Date.now() + 60_000, probeVersion: 2,
  };
  const adapter = { dialect: 'openai_chat_compatible', version: 1, dispose() {} };
  const provider = { id: capability.resourceId, capabilities: { chat: true, json: true, tools: true }, createToolAdapter: () => adapter };
  const resource = { id: provider.id, type: 'generation', source: 'custom', apiType: 'generic', label: 'Retry', baseUrl: 'https://example.invalid/v1', model: capability.model, enabled: true };
  const router = new TaskRouter();
  router.registerProvider(provider, 'generation', ['chat', 'json', 'tools'], resource.model);
  const store = {
    async listToolCapabilities() {
      attempts += 1;
      if (attempts === 1) throw new Error('workspace starting');
      return [{ cacheKey: 'fnv1a64:0000000000000000', capability }];
    },
    async saveToolCapability() {}, async deleteToolCapabilitiesForResource() { return 0; },
  };
  const service = new LlmToolTurnService(router, { getResource: () => resource }, fixedTestMaxTokens, store);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await service.getCapability(resource.id, resource.model);
  assert.equal(attempts, 2);
  service.dispose();
});

test('OpenAI Responses pairs call_id, sends store=false and locally replays output items', async () => {
  const bodies = [];
  const adapter = new OpenAiResponsesToolAdapter(transport([
    { id: 'resp-1', output: [{ type: 'function_call', call_id: 'call-1', name: providerToolName, arguments: '{"mentions":["急救包"]}' }] },
    { id: 'resp-2', output_text: '{"itemRef":"O07"}', output: [] },
  ], bodies));
  const first = await adapter.start({ ...startInput(), toolChoice: 'required' });
  assert.equal(first.state, 'tool_calls');
  assert.deepEqual(first.calls, [{ callId: 'call-1', name: tool.name, arguments: { mentions: ['急救包'] } }]);
  const second = await adapter.continue(first.adapterState, [{ callId: 'call-1', name: tool.name, ok: true, content: { contextOnly: true, data: { ref: 'O07' } } }], startInput().signal);
  assert.equal(second.state, 'final');
  assert.deepEqual(second.output, { itemRef: 'O07' });
  assert.equal(bodies[0].store, false);
  assert.equal(bodies[0].tool_choice, 'required');
  assert.equal(bodies[1].tool_choice, 'auto');
  assert.equal(bodies[0].tools[0].name, providerToolName);
  assert.equal('previous_response_id' in bodies[1], false);
  assert.equal(bodies[1].input.some((item) => item.type === 'function_call'), true);
  assert.equal(bodies[1].input.some((item) => item.type === 'function_call_output' && item.call_id === 'call-1'), true);
});

test('Anthropic preserves complete assistant blocks and returns one tool_result per tool_use_id', async () => {
  const bodies = [];
  const adapter = new AnthropicMessagesToolAdapter(transport([
    { stop_reason: 'tool_use', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'toolu-1', name: providerToolName, input: { mentions: ['急救包'] } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"itemRef":"O07"}' }] },
  ], bodies));
  const first = await adapter.start(startInput());
  const second = await adapter.continue(first.adapterState, [{ callId: 'toolu-1', name: tool.name, ok: true, content: { ref: 'O07' } }], startInput().signal);
  assert.equal(second.state, 'final');
  assert.equal(bodies[0].tools[0].name, providerToolName);
  assert.deepEqual(bodies[1].messages.at(-2).content.map((block) => block.type), ['text', 'tool_use']);
  assert.deepEqual(bodies[1].messages.at(-1).content.map((block) => [block.type, block.tool_use_id]), [['tool_result', 'toolu-1']]);
});

test('Gemini Interactions uses store=false and replays thought/function_call/function_result steps', async () => {
  const bodies = [];
  const adapter = new GeminiInteractionsToolAdapter(transport([
    { id: 'interaction-1', steps: [{ type: 'thought', signature: 'opaque' }, { type: 'function_call', call_id: 'g-1', name: providerToolName, arguments: { mentions: ['急救包'] } }] },
    { id: 'interaction-2', output_text: '{"itemRef":"O07"}', steps: [] },
  ], bodies));
  const first = await adapter.start(startInput());
  const second = await adapter.continue(first.adapterState, [{ callId: 'g-1', name: tool.name, ok: true, content: { ref: 'O07' } }], startInput().signal);
  assert.equal(second.state, 'final');
  assert.equal(bodies[0].store, false);
  assert.equal(bodies[0].tools[0].name, providerToolName);
  assert.equal(bodies[1].input.find((step) => step.type === 'function_result')?.name, providerToolName);
  assert.equal(bodies[1].input.some((step) => step.type === 'thought' && step.signature === 'opaque'), true);
  assert.equal(bodies[1].input.some((step) => step.type === 'function_result' && step.call_id === 'g-1'), true);
});

test('Chat dialects preserve assistant messages, enforce thinking replay integrity and remove tools on finalize', async () => {
  const deepSeekBodies = [];
  const ordinaryDeepSeek = new OpenAiChatToolAdapter(transport([
    { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'd-1', function: { name: providerToolName, arguments: '{"mentions":["急救包"]}' } }] } }] },
  ], deepSeekBodies), OPENAI_CHAT_DIALECT_POLICIES.deepseek);
  assert.equal((await ordinaryDeepSeek.start({ ...startInput(), toolChoice: 'required' })).state, 'tool_calls');
  assert.equal(deepSeekBodies[0].tool_choice, 'auto');
  assert.deepEqual(deepSeekBodies[0].response_format, { type: 'json_object' });
  assert.equal(deepSeekBodies[0].tools[0].function.strict, true);
  assert.equal(deepSeekBodies[0].tools[0].function.name, providerToolName);

  const nonStreamingBodies = [];
  const nonStreamingDeepSeek = new OpenAiChatToolAdapter({
    resourceId: 'resource:1', defaultModel: 'model:1',
    async send(body) {
      nonStreamingBodies.push(body);
      return { choices: [{ message: { role: 'assistant', content: '{"itemRef":"O07"}' } }] };
    },
    async sendStream() { throw new Error('DeepSeek tool turns must not stream'); },
  }, OPENAI_CHAT_DIALECT_POLICIES.deepseek, { enableToolStream: true });
  assert.equal((await nonStreamingDeepSeek.start(startInput())).state, 'final');
  assert.equal(nonStreamingBodies[0].stream, false);

  const mixedStrictBodies = [];
  const mixedStrictDeepSeek = new OpenAiChatToolAdapter(transport([
    { choices: [{ message: { role: 'assistant', content: '{}' } }] },
  ], mixedStrictBodies), OPENAI_CHAT_DIALECT_POLICIES.deepseek);
  await mixedStrictDeepSeek.start({
    ...startInput(),
    tools: [tool, { ...tool, name: 'reference.get_details', strict: false }],
  });
  assert.equal(mixedStrictBodies[0].tools.every(candidate => !('strict' in candidate.function)), true);
  const mixedProviderNames = mixedStrictBodies[0].tools.map(candidate => candidate.function.name);
  assert.equal(mixedProviderNames.every(name => /^[A-Za-z0-9_-]{1,64}$/.test(name)), true);
  assert.equal(new Set(mixedProviderNames).size, 2);

  const standardBodies = [];
  const standard = new OpenAiChatToolAdapter(transport([
    { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 's-1', function: { name: providerToolName, arguments: '{"mentions":["急救包"]}' } }] } }] },
    { choices: [{ message: { role: 'assistant', content: '{"itemRef":"O07"}' } }] },
  ], standardBodies), OPENAI_CHAT_DIALECT_POLICIES.standard);
  const standardFirst = await standard.start({ ...startInput(), toolChoice: 'required' });
  await standard.continue(standardFirst.adapterState, [{ callId: 's-1', name: tool.name, ok: true, content: { ref: 'O07' } }], startInput().signal);
  assert.equal(standardBodies[0].tool_choice, 'required');
  assert.equal(standardBodies[1].tool_choice, 'auto');

  const thinkingDeepSeek = new OpenAiChatToolAdapter(transport([
    { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'd-1', function: { name: providerToolName, arguments: '{"mentions":["急救包"]}' } }] } }] },
  ]), OPENAI_CHAT_DIALECT_POLICIES.deepseek, { requireReasoningContent: true });
  await assert.rejects(thinkingDeepSeek.start(startInput()), (error) => error?.details?.reasonCode === 'LLM_TOOL_CONTEXT_INTEGRITY_FAILED');

  const bodies = [];
  const glm = new OpenAiChatToolAdapter(transport([
    { choices: [{ message: { role: 'assistant', reasoning_content: 'r', tool_calls: [{ id: 'z-1', function: { name: providerToolName, arguments: '{"mentions":["急救包"]}' } }] } }] },
    { choices: [{ message: { role: 'assistant', content: '{"itemRef":"O07"}' } }] },
  ], bodies), OPENAI_CHAT_DIALECT_POLICIES.glm);
  const first = await glm.start(startInput());
  const final = await glm.finalize(first.adapterState, 'Return final JSON.', startInput().outputSchema, startInput().signal);
  assert.equal(final.state, 'final');
  assert.equal(bodies[0].tool_choice, 'auto');
  assert.equal('tools' in bodies[1], false);
  assert.equal('tool_choice' in bodies[1], false);
});

test('generic resources honor the configured native tool dialect instead of guessing by apiType', () => {
  const provider = createProviderFromResource({
    id: 'resource:generic', type: 'generation', source: 'custom', apiType: 'generic',
    label: 'Generic GLM gateway', baseUrl: 'https://example.invalid/v1', model: 'glm-test',
    enabled: true, capabilities: ['chat', 'json', 'tools'], toolDialect: 'glm_chat',
  }, 'secret', async () => { throw new Error('network must not be used while selecting an adapter'); });
  assert.equal(provider.createToolAdapter().dialect, 'glm_chat');
});

test('streamed OpenAI-compatible arguments assemble by index only after completion', () => {
  const assembler = new OpenAiToolStreamAssembler();
  assembler.push({ index: 0, id: 'call-1', name: tool.name, arguments: '{"mentions":[' });
  assembler.push({ index: 0, arguments: '"急救包"]}' });
  assert.deepEqual(assembler.finish(), [{ callId: 'call-1', name: tool.name, arguments: { mentions: ['急救包'] } }]);
});

test('GLM tool_stream aggregates reasoning and fragmented arguments before exposing calls', async () => {
  const bodies = [];
  const adapter = new OpenAiChatToolAdapter({
    resourceId: 'resource:1', defaultModel: 'model:1',
    async send() { throw new Error('stream path expected'); },
    async sendStream(body) {
      bodies.push(body);
      return [
        { choices: [{ delta: { reasoning_content: '先检查', tool_calls: [{ index: 0, id: 'g-1', function: { name: providerToolName, arguments: '{"mentions":[' } }] } }] },
        { choices: [{ delta: { reasoning_content: '库存', tool_calls: [{ index: 0, function: { arguments: '"急救包"]}' } }] } }] },
      ];
    },
  }, OPENAI_CHAT_DIALECT_POLICIES.glm, { enableToolStream: true });
  const step = await adapter.start(startInput());
  assert.equal(step.state, 'tool_calls');
  assert.deepEqual(step.calls, [{ callId: 'g-1', name: tool.name, arguments: { mentions: ['急救包'] } }]);
  assert.equal(bodies[0].stream, true);
  assert.equal(bodies[0].tool_stream, true);
  assert.equal(step.adapterState.lastAssistant.reasoning_content, '先检查库存');
});

test('OpenAI-compatible dialects without tool streaming use the complete response path', async () => {
  const adapter = new OpenAiChatToolAdapter({
    resourceId: 'resource:1', defaultModel: 'model:1',
    async send(body) {
      assert.equal(body.stream, false);
      return { choices: [{ message: { role: 'assistant', content: '{"itemRef":"O07' }, finish_reason: 'length' }] };
    },
    async sendStream() { throw new Error('stream path must not be used'); },
  }, OPENAI_CHAT_DIALECT_POLICIES.standard, { enableToolStream: true });
  await assert.rejects(adapter.start(startInput()),
    (error) => error?.details?.reasonCode === 'STRUCTURED_OUTPUT_TRUNCATED');
});

test('OpenAI Responses reports max_output_tokens as output truncation', async () => {
  const adapter = new OpenAiResponsesToolAdapter(transport([{
    status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    output_text: '{"itemRef":"O07', output: [],
  }]));
  await assert.rejects(adapter.start(startInput()),
    (error) => error?.details?.reasonCode === 'STRUCTURED_OUTPUT_TRUNCATED');
});

test('ToolSessionManager enforces scope, exact result pairing and bounded active sessions', async () => {
  const manager = new ToolSessionManager();
  const fakeAdapter = {
    dialect: 'openai_chat_compatible', version: 1,
    async start() { return { state: 'tool_calls', calls: [{ callId: 'call-1', name: tool.name, arguments: { mentions: ['x'] } }], adapterState: { turn: 1 } }; },
    async continue(_state, results) { return { state: 'final', output: { itemRef: results[0].content.ref }, adapterState: { turn: 2 } }; },
    async finalize() { throw new Error('unused'); }, estimateStateBytes: (state) => JSON.stringify(state).length, dispose() {},
  };
  const scope = { callerPluginId: 'memory', taskKey: 'inventory', pipelineRunId: 'p1', chatKey: 'c1', resourceId: 'r1', model: 'm1' };
  const started = await manager.start({ ...scope, adapter: fakeAdapter, capability: { status: 'verified', resourceId: 'r1', model: 'm1', dialect: 'openai_chat_compatible', parallelToolCalls: false, streamingToolCalls: false, strictToolSchema: 'none', reasoningReplay: 'none', probeVersion: 1 }, messages: startInput().messages, tools: [tool], outputSchema: startInput().outputSchema, privacyPolicy: DEFAULT_PROVIDER_PRIVACY_POLICY, maxTokens: 128, signal: startInput().signal });
  await assert.rejects(manager.continue(started.toolSessionId, { ...scope, chatKey: 'other' }, [{ callId: 'call-1', name: tool.name, ok: true, content: { ref: 'O07' } }], startInput().signal),
    (error) => error?.details?.reasonCode === 'LLM_TOOL_SESSION_SCOPE_MISMATCH');
  const completed = await manager.continue(started.toolSessionId, scope, [{ callId: 'call-1', name: tool.name, ok: true, content: { ref: 'O07' } }], startInput().signal);
  assert.equal(completed.step.state, 'final');
  assert.equal(manager.activeCount, 0);
});

test('ToolSessionManager admits six calls in one round and records a rejected seventh call safely', async () => {
  let disposed = 0;
  const manager = new ToolSessionManager();
  let callCount = 6;
  const fakeAdapter = {
    dialect: 'openai_chat_compatible', version: 1,
    async start() { return { state: 'tool_calls', calls: Array.from({ length: callCount }, (_, index) => ({ callId: `call-${index}`, name: tool.name, arguments: { mentions: ['x'] } })), adapterState: { allocated: true }, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } }; },
    async continue() { throw new Error('unused'); }, async finalize() { throw new Error('unused'); },
    estimateStateBytes: () => 1, dispose() { disposed += 1; },
  };
  const base = { callerPluginId: 'memory', taskKey: 'inventory', pipelineRunId: 'p1', chatKey: 'c1', resourceId: 'r1', model: 'm1', adapter: fakeAdapter, capability: { status: 'verified', resourceId: 'r1', model: 'm1', dialect: 'openai_chat_compatible', parallelToolCalls: false, streamingToolCalls: false, strictToolSchema: 'none', reasoningReplay: 'none', probeVersion: 1 }, messages: startInput().messages, tools: [tool], outputSchema: startInput().outputSchema, privacyPolicy: DEFAULT_PROVIDER_PRIVACY_POLICY, maxTokens: 128, signal: startInput().signal };
  const admitted = await manager.start(base);
  assert.equal(admitted.step.state, 'tool_calls');
  assert.equal(admitted.step.calls.length, 6);
  manager.cancel(admitted.toolSessionId);

  callCount = 7;
  await assert.rejects(manager.start({ ...base, pipelineRunId: 'p2' }), (error) => {
    assert.equal(error?.details?.reasonCode, 'LLM_TOOL_CALL_LIMIT_EXCEEDED');
    assert.deepEqual(error?.providerResponse?.usage, { inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    assert.equal(error?.providerResponse?.calls.length, 7);
    return true;
  });
  assert.equal(disposed, 2);
});

test('ToolSessionManager admits large bounded local replay state and rejects state above one MiB', async () => {
  let stateBytes = 512 * 1024;
  let disposed = 0;
  const manager = new ToolSessionManager();
  const fakeAdapter = {
    dialect: 'deepseek_chat', version: 1,
    async start() { return { state: 'tool_calls', calls: [{ callId: 'call-1', name: tool.name, arguments: { mentions: ['x'] } }], adapterState: { replay: true } }; },
    async continue() { return { state: 'final', output: { itemRef: 'O07' }, adapterState: { done: true } }; },
    async finalize() { throw new Error('unused'); }, estimateStateBytes: () => stateBytes, dispose() { disposed += 1; },
  };
  const capability = { status: 'verified', resourceId: 'r1', model: 'm1', dialect: 'deepseek_chat', parallelToolCalls: false, streamingToolCalls: false, strictToolSchema: 'beta', reasoningReplay: 'required', probeVersion: 1 };
  const base = { callerPluginId: 'memory', taskKey: 'narrative', pipelineRunId: 'p1', chatKey: 'c1', resourceId: 'r1', model: 'm1', adapter: fakeAdapter, capability, messages: startInput().messages, tools: [tool], outputSchema: startInput().outputSchema, privacyPolicy: DEFAULT_PROVIDER_PRIVACY_POLICY, maxTokens: 128, signal: startInput().signal };

  const admitted = await manager.start(base);
  assert.equal(manager.activeCount, 1);
  manager.cancel(admitted.toolSessionId);

  stateBytes = 1024 * 1024 + 1;
  await assert.rejects(manager.start({ ...base, pipelineRunId: 'p2' }),
    (error) => error?.details?.reasonCode === 'LLM_TOOL_SESSION_CAPACITY_EXCEEDED');
  assert.equal(manager.activeCount, 0);
  assert.equal(disposed, 2);
});
