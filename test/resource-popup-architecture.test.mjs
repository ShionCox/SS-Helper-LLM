import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ResourceVerificationCoordinator, ResourceWizardController } from '../dist/index.js';

const resource = {
  id: 'resource-test',
  type: 'generation',
  source: 'custom',
  apiType: 'openai',
  label: 'Test resource',
  baseUrl: 'https://api.example.test/v1',
  model: 'model-a',
  enabled: true,
  capabilities: ['chat', 'json'],
};

function resourceWizard(source) {
  return new ResourceWizardController({
    mode: source ? 'edit' : 'create',
    source,
    hasStoredSecret: source !== undefined,
    timeoutMs: 30_000,
    repository: {},
    ui: {},
    notify() {},
    verification: {},
    toolServices: {},
  });
}

test('resource wizard shows only purpose-specific connection fields', () => {
  const controller = resourceWizard();
  controller.change('apiType', 'xai');
  let snapshot = controller.snapshot();
  assert.equal(snapshot.values.connectionMode, 'official');
  assert.equal(snapshot.values.baseUrl, 'https://api.x.ai/v1');
  assert.equal(snapshot.values.toolDialect, 'openai_chat_compatible');
  assert.deepEqual(snapshot.disabledFieldIds, ['baseUrl']);
  assert.equal(snapshot.hiddenFieldIds.includes('toolDialect'), false);
  assert.equal(snapshot.hiddenFieldIds.includes('embeddingPath'), true);
  assert.equal(snapshot.hiddenFieldIds.includes('rerankProtocol'), true);

  controller.change('type', 'embedding');
  snapshot = controller.snapshot();
  assert.equal(snapshot.hiddenFieldIds.includes('toolDialect'), true);
  assert.equal(snapshot.hiddenFieldIds.includes('embeddingPath'), false);
  assert.equal(snapshot.hiddenFieldIds.includes('embeddingDimensions'), false);
  assert.equal(snapshot.hiddenFieldIds.includes('rerankProtocol'), true);

  controller.change('type', 'rerank');
  snapshot = controller.snapshot();
  assert.equal(snapshot.hiddenFieldIds.includes('embeddingPath'), true);
  assert.equal(snapshot.hiddenFieldIds.includes('rerankProtocol'), false);
  assert.equal(snapshot.hiddenFieldIds.includes('rerankPath'), false);
  controller.change('rerankProtocol', 'chat');
  assert.equal(controller.snapshot().hiddenFieldIds.includes('rerankPath'), true);
  controller.dispose();
});

test('editing a generic Grok relay keeps its endpoint when switching to the xAI template', () => {
  const controller = resourceWizard({
    id: 'grok-relay', type: 'generation', source: 'custom', apiType: 'generic', label: 'Grok relay',
    baseUrl: 'https://relay.example.test/v1', model: 'grok-model', enabled: true,
  });
  controller.change('apiType', 'xai');
  const snapshot = controller.snapshot();
  assert.equal(snapshot.values.baseUrl, 'https://relay.example.test/v1');
  assert.equal(snapshot.values.connectionMode, 'relay');
  assert.equal(snapshot.values.toolDialect, 'openai_chat_compatible');
  assert.equal(snapshot.disabledFieldIds.includes('baseUrl'), false);
  controller.dispose();
});

test('DeepSeek official resources switch between standard and Beta endpoints without becoming relays', () => {
  const controller = resourceWizard({
    id: 'deepseek-beta', type: 'generation', source: 'custom', apiType: 'deepseek', label: 'DeepSeek Beta',
    baseUrl: 'https://api.deepseek.com/beta', model: 'deepseek-chat', enabled: true,
  });
  let snapshot = controller.snapshot();
  assert.equal(snapshot.values.connectionMode, 'official');
  assert.equal(snapshot.values.deepseekApiMode, 'beta');
  assert.equal(snapshot.values.baseUrl, 'https://api.deepseek.com/beta');
  assert.equal(snapshot.hiddenFieldIds.includes('deepseekApiMode'), false);
  assert.equal(snapshot.disabledFieldIds.includes('baseUrl'), true);

  controller.change('deepseekApiMode', 'standard');
  snapshot = controller.snapshot();
  assert.equal(snapshot.values.baseUrl, 'https://api.deepseek.com');
  controller.change('deepseekApiMode', 'beta');
  assert.equal(controller.snapshot().values.baseUrl, 'https://api.deepseek.com/beta');

  controller.change('connectionMode', 'relay');
  snapshot = controller.snapshot();
  assert.equal(snapshot.hiddenFieldIds.includes('deepseekApiMode'), true);
  assert.equal(snapshot.disabledFieldIds.includes('baseUrl'), false);
  controller.change('connectionMode', 'official');
  assert.equal(controller.snapshot().values.baseUrl, 'https://api.deepseek.com/beta');
  controller.dispose();
});

test('DeepSeek Beta skips unsupported model discovery and verifies the selected model directly', async () => {
  const calls = [];
  const coordinator = new ResourceVerificationCoordinator({
    request: async (input) => {
      calls.push(input);
      return {
        status: 200,
        ok: true,
        body: { choices: [{ message: { content: 'OK' } }] },
      };
    },
  });
  const betaResource = {
    ...resource,
    apiType: 'deepseek',
    baseUrl: 'https://api.deepseek.com/beta',
    model: 'deepseek-chat',
  };
  const discovered = await coordinator.discoverModels(betaResource, 'secret');
  assert.deepEqual(discovered, {
    ok: false,
    supported: false,
    reasonCode: 'LLM_MODEL_DISCOVERY_UNSUPPORTED',
    models: [],
  });
  const verified = await coordinator.verify(betaResource, 'secret');
  assert.equal(verified.ok, true);
  assert.deepEqual(Object.values(verified.checks).map((check) => check.state), ['success', 'success', 'success', 'success']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/backends/chat-completions/generate');
  assert.equal(calls[0].body.reverse_proxy, 'https://api.deepseek.com/beta');
});

test('resource verification checks network, auth, model, and capability with one disposable provider', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), signal: init.signal });
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const snapshots = [];
    const result = await new ResourceVerificationCoordinator().verify(resource, 'secret', {
      onProgress: (snapshot) => snapshots.push(snapshot),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.values(result.checks).map((check) => check.state), ['success', 'success', 'success', 'success']);
    assert.deepEqual(result.models.map((model) => model.id), ['model-a', 'model-b']);
    assert.equal(calls.length, 2);
    assert.equal(snapshots.some((snapshot) => snapshot.network.state === 'running'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resource verification returns safe auth diagnostics without exposing provider response bodies', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('private upstream response', { status: 401 });
  try {
    const result = await new ResourceVerificationCoordinator().verify(resource, 'bad-secret');
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'AUTH_FAILED');
    assert.equal(result.checks.network.state, 'success');
    assert.equal(result.checks.auth.state, 'error');
    assert.doesNotMatch(JSON.stringify(result), /private upstream response|bad-secret/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('model discovery returns a deduplicated provider list without persisting a resource', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    return new Response(JSON.stringify({
      data: [
        { id: 'deepseek-v4-flash' },
        { id: 'deepseek-v4-pro' },
        { id: 'deepseek-v4-flash' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await new ResourceVerificationCoordinator().discoverModels(resource, 'secret');
    assert.equal(result.ok, true);
    assert.equal(result.supported, true);
    assert.deepEqual(result.models.map((model) => model.id), ['deepseek-v4-flash', 'deepseek-v4-pro']);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/models$/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('HTTP resources use the injected Core Bridge transport for discovery and verification', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async () => { throw new Error('browser native fetch must not be used'); };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const coordinator = new ResourceVerificationCoordinator({ fetchImpl });
    const httpResource = { ...resource, baseUrl: 'http://api.example.test/v1' };
    const discovered = await coordinator.discoverModels(httpResource, 'secret');
    assert.equal(discovered.ok, true);
    const verified = await coordinator.verify(httpResource, 'secret');
    assert.equal(verified.ok, true);
    assert.deepEqual(calls.map((call) => call.url), [
      'http://api.example.test/v1/models',
      'http://api.example.test/v1/chat/completions',
      'http://api.example.test/v1/models',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('xAI discovery and verification avoid the Tavern proxy response logger', async () => {
  const calls = [];
  let tavernCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'grok-test' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const coordinator = new ResourceVerificationCoordinator({
    fetchImpl,
    request: async () => {
      tavernCalls += 1;
      throw new Error('xAI must not use the Tavern chat-completions proxy');
    },
  });
  const xaiResource = { ...resource, apiType: 'xai', model: 'grok-test' };
  const discovered = await coordinator.discoverModels(xaiResource, 'secret');
  const verified = await coordinator.verify(xaiResource, 'secret');

  assert.equal(discovered.ok, true);
  assert.equal(verified.ok, true);
  assert.equal(tavernCalls, 0);
  assert.deepEqual(calls.map((call) => call.url), [
    'https://api.example.test/v1/models',
    'https://api.example.test/v1/chat/completions',
    'https://api.example.test/v1/models',
  ]);
});

test('tavern same-origin probe discovers models with a draft key and verifies the selected model before persistence', async () => {
  const calls = [];
  const request = async (input, options) => {
    calls.push({ input, signal: options?.signal });
    if (input.path.endsWith('/status')) {
      return {
        status: 200,
        ok: true,
        body: {
          data: [
            { id: 'deepseek-v4-flash' },
            { id: 'deepseek-v4-pro' },
            { id: 'deepseek-v4-flash' },
          ],
        },
      };
    }
    return {
      status: 200,
      ok: true,
      body: {
        choices: [{ message: { content: 'OK' } }],
      },
    };
  };
  const coordinator = new ResourceVerificationCoordinator({ request });
  const discovered = await coordinator.discoverModels({ ...resource, model: 'deepseek-v4-flash' }, 'draft-secret');
  assert.equal(discovered.ok, true);
  assert.deepEqual(discovered.models.map((model) => model.id), ['deepseek-v4-flash', 'deepseek-v4-pro']);
  const verified = await coordinator.verify({ ...resource, model: 'deepseek-v4-pro' }, 'draft-secret');
  assert.equal(verified.ok, true);
  assert.deepEqual(Object.values(verified.checks).map((check) => check.state), ['success', 'success', 'success', 'success']);
  assert.equal(calls.length, 3);
  assert.equal(calls.every((call) => call.input.body.proxy_password === 'draft-secret'), true);
  assert.equal(calls.every((call) => call.signal instanceof AbortSignal), true);
});

test('tavern probe rejects an unavailable draft endpoint without exposing the draft key', async () => {
  const coordinator = new ResourceVerificationCoordinator({
    request: async () => ({
      status: 200,
      ok: true,
      body: { error: true, data: { data: [] } },
    }),
  });
  const result = await coordinator.verify(resource, 'never-log-this-key');
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'LLM_PROVIDER_TEST_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /never-log-this-key/u);
});

test('resource verification honors an already-aborted caller signal', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init = {}) => {
    calls += 1;
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return new Response('{}', { status: 200 });
  };
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await new ResourceVerificationCoordinator().verify(resource, 'secret', { signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'REQUEST_ABORTED');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('legacy resource popup DOM, prompt editing, and save-before-test paths are removed', async () => {
  const plugin = await readFile(new URL('../src/ss-helper/plugin.ts', import.meta.url), 'utf8');
  const resourcePopups = await readFile(new URL('../src/ss-helper/resource-popups.ts', import.meta.url), 'utf8');
  const resourceStyles = await readFile(new URL('../src/ui/request-log-viewer.css', import.meta.url), 'utf8');
  assert.doesNotMatch(plugin, /function\s+(?:button|field)\s*\(/u);
  assert.doesNotMatch(plugin, /text_pole|stx-ui-btn|window\.prompt/u);
  assert.doesNotMatch(plugin, /步骤 1：选择用途|配置已保存；连接测试通过后可启用/u);
  assert.doesNotMatch(resourcePopups, /window\.prompt|text_pole|stx-ui-btn|data-ss-helper-control/u);
  assert.doesNotMatch(resourcePopups, /window\.confirm|document\.createElement\(['"]select['"]\)/u);
  assert.match(resourcePopups, /ResourceVerificationCoordinator/u);
  assert.match(resourcePopups, /createMenu|presentation:\s*'workspace'/u);
  assert.match(resourcePopups, /验证工具调用|verifyResourceCapability/u);
  assert.match(resourcePopups, /ss-helper-llm-resource-checked-primary/u);
  assert.match(resourceStyles, /ss-helper-llm-resource-row\s*\{\s*height:\s*54px/u);
  assert.match(resourceStyles, /grid-template-columns:[^;]+170px;/u);
  assert.match(resourceStyles, /grid-template-rows:\s*auto auto auto auto minmax\(0, 1fr\) auto/u);
  assert.match(resourceStyles, /ss-helper-llm-tavern-reasoning-policy[\s\S]+display:\s*grid/u);
  assert.match(resourceStyles, /resource-columns\s*>\s*:last-child\s*\{\s*text-align:\s*right/u);
  assert.match(resourcePopups, /listResourceHealth|saveResourceHealth|deleteResource/u);
  assert.match(resourcePopups, /工具调用（Agent，可选）[\s\S]+force:\s*true/u);
  assert.match(resourcePopups, /describeSSHelperFailure\(capability\?\.failure/u);
  assert.match(resourcePopups, /diagnostic\.title[\s\S]+diagnostic\.reason[\s\S]+diagnostic\.action/u);
  assert.match(resourcePopups, /enabled:\s*true/u);
  for (const field of ['customParams', 'toolDialect', 'privacyPolicy']) {
    assert.match(resourcePopups, new RegExp(`this\\.#source\\?\\.${field}`, 'u'));
  }
  assert.match(resourcePopups, /await this\.#verification\.verify[\s\S]+await this\.#repository\.saveResource/u);
});

test('LLM UI has no Memory-owned task routing surface and protects consumer assignments', async () => {
  const plugin = await readFile(new URL('../src/ss-helper/plugin.ts', import.meta.url), 'utf8');
  const settings = await readFile(new URL('../src/ss-helper/settings.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(plugin, /route-manager|MEMORY_ROUTING_TASKS|memory_extract_(?:single|entities|narrative|inventory|repair)/u);
  assert.doesNotMatch(settings, /route-manager|routeManager|open-route-manager/u);
  assert.match(plugin, /editableGenericRoutingSettings[\s\S]+taskAssignments:\s*_consumerOwnedTaskAssignments/u);
  assert.match(plugin, /mergeGenericRoutingSettings[\s\S]+Object\.hasOwn\(edited, 'taskAssignments'\)[\s\S]+current\.taskAssignments/u);
  assert.doesNotMatch(plugin, /pluginAssignments:[^\n]+taskAssignments/u);
});
