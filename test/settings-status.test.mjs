import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { API_VERSION, CORE_DISCOVERY_SYMBOL, SDK_PACKAGE_VERSION } from '@ss-helper/sdk';
import { LlmSettingsStatusMonitor, createWorkspaceLlmSettingsAdapter } from '../dist/index.js';

const wait = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
const llmConfig = JSON.parse(readFileSync(new URL('../plugin.config.json', import.meta.url), 'utf8'));
const sdkConfig = JSON.parse(readFileSync(new URL('../../SS-Helper-SDK/plugin.config.json', import.meta.url), 'utf8'));
const LLM_PLUGIN_VERSION = llmConfig.manifest.version;
const CORE_VERSION = sdkConfig.browser.coreVersion;

function fixture() {
  const target = new EventTarget();
  target[CORE_DISCOVERY_SYMBOL] = {
    kind: 'ss-helper-core-discovery',
    descriptor: {
      kind: 'ss-helper-core', id: 'ss-helper.core', coreVersion: CORE_VERSION, sdkPackageVersion: SDK_PACKAGE_VERSION,
      apiVersion: API_VERSION, generation: 7, state: 'ready', capabilities: [],
      artifact: { buildId: 'fixture', contentDigest: 'a'.repeat(64) },
    },
    port: {},
  };
  let current = { provider: 'openai', model: 'gpt-test' };
  let settings = { enabled: true };
  let generationStatus = () => ({ id: 'generation', configured: true, available: true, model: current.model });
  let repositoryListener;
  let hostListener;
  let capabilityListener;
  const repository = {
    subscribeChanges(listener) { repositoryListener = listener; return () => { repositoryListener = undefined; }; },
    async loadSettings() { return structuredClone(settings); },
    async updateSettings(mutator) { settings = structuredClone(mutator(structuredClone(settings))); repositoryListener?.(['generation']); return structuredClone(settings); },
    async saveSettings(values) { settings = structuredClone(values); repositoryListener?.(['generation']); return structuredClone(settings); },
    async reset() { settings = { enabled: true }; return structuredClone(settings); },
  };
  const session = {
    descriptor: { id: 'ss-helper.llm', displayName: 'LLM', pluginVersion: LLM_PLUGIN_VERSION, sdkPackageVersion: SDK_PACKAGE_VERSION, apiVersion: API_VERSION, minApiVersion: API_VERSION, capabilities: [] },
    generation: 7,
    host: {
      generation: { available: async () => true, current: async () => current },
      events: { subscribe(_name, listener) { hostListener = listener; return () => { hostListener = undefined; }; } },
    },
    events: { subscribe(_token, listener) { capabilityListener = listener; return () => { capabilityListener = undefined; }; } },
  };
  const handlers = {
    taskStatus: async () => ({
      revision: 1,
      tasks: [
        { taskKey: 'settings_generation', execution: 'structured', available: generationStatus().available, resourceId: 'resource:generation', model: current.model, route: { resourceId: 'resource:generation', source: 'custom', provider: current.provider, model: current.model, execution: 'structured', transport: 'json_schema' } },
        { taskKey: 'settings_embedding', execution: 'embedding', available: false, failure: { reasonCode: 'LLM_TASK_ROUTE_UNAVAILABLE', stage: 'settings.test' } },
        { taskKey: 'settings_rerank', execution: 'rerank', available: false, failure: { reasonCode: 'LLM_TASK_ROUTE_UNAVAILABLE', stage: 'settings.test' } },
      ],
      defaults: {}, assignments: [], resources: [],
    }),
  };
  return {
    target, repository, session, handlers,
    changeModel(next) { current = next; hostListener?.({}); },
    changeRepository() { repositoryListener?.(['generation']); },
    setSettings(next) { settings = structuredClone(next); repositoryListener?.(['generation']); },
    changeCapabilities() { capabilityListener?.({ revision: 2, taskKeys: ['settings_embedding'], resourceIds: [] }); },
    setGenerationStatus(factory) { generationStatus = factory; },
  };
}

test('LLM settings status is sourced live from Tavern, capabilities, and actual version descriptors', async () => {
  const value = fixture();
  const monitor = new LlmSettingsStatusMonitor(value.session, value.repository, value.handlers, value.target);
  const snapshots = [];
  const unsubscribe = monitor.subscribeStatus((snapshot) => snapshots.push(snapshot));
  await monitor.start();
  assert.equal(monitor.loadStatus().tavernStatus.value, '酒馆 · gpt-test');
  assert.equal(monitor.loadStatus().generationSourceStatus.value, '酒馆 · gpt-test');
  assert.equal(monitor.loadStatus().generationStatus.value, '可用');
  assert.equal(monitor.loadStatus().embeddingStatus.value, '未配置');
  assert.equal(monitor.loadStatus().rerankStatus.value, '未配置');
  assert.equal(monitor.loadStatus().about.value, `LLM v${LLM_PLUGIN_VERSION} · Core v${CORE_VERSION} · SDK v${SDK_PACKAGE_VERSION} · API ${API_VERSION}`);

  value.changeModel({ provider: 'claude', model: 'claude-test' });
  await wait();
  assert.equal(snapshots.at(-1).tavernStatus.value, '酒馆 · claude-test');
  assert.equal(snapshots.at(-1).generationSourceStatus.value, '酒馆 · claude-test');

  value.changeRepository();
  await wait();
  assert.equal(snapshots.at(-1).generationStatus.value, '可用');
  assert.equal(snapshots.at(-1).embeddingStatus.value, '未配置');
  assert.equal(snapshots.at(-1).rerankStatus.value, '未配置');
  value.changeCapabilities();
  await wait();
  assert.equal(snapshots.at(-1).generationStatus.value, '可用');
  assert.equal(snapshots.at(-1).embeddingStatus.value, '未配置');
  assert.equal(snapshots.at(-1).rerankStatus.value, '未配置');
  unsubscribe();
  monitor.dispose();
});

test('LLM settings status identifies a selected custom generation default without exposing credentials', async () => {
  const value = fixture();
  const monitor = new LlmSettingsStatusMonitor(value.session, value.repository, value.handlers, value.target);
  await monitor.start();
  value.setSettings({
    enabled: true,
    globalAssignments: { generation: { resourceId: 'custom-main' } },
    resources: [{ id: 'custom-main', type: 'generation', source: 'custom', apiType: 'openai', label: '自定义主模型', model: 'gpt-custom', baseUrl: 'https://secret.example/v1', enabled: true }],
  });
  await wait();
  assert.equal(monitor.loadStatus().generationSourceStatus.value, '自定义 · 自定义主模型');
  assert.match(monitor.loadStatus().generationSourceStatus.description, /gpt-custom/u);
  assert.equal(monitor.loadStatus().generationSourceStatus.description.includes('https://'), false);
  monitor.dispose();
});

test('adapter saves execution settings without a source-switch side channel', async () => {
  const value = fixture();
  const monitor = new LlmSettingsStatusMonitor(value.session, value.repository, value.handlers, value.target);
  await monitor.start();
  const notifications = [];
  const adapter = createWorkspaceLlmSettingsAdapter(value.repository, monitor, (notification) => notifications.push(notification));
  await adapter.load();
  value.setGenerationStatus(() => ({ id: 'generation', configured: false, available: false, reason: 'no_resource' }));
  await adapter.save({ enabled: true, globalProfile: 'economy' });
  await wait(0);
  assert.equal(notifications.length, 0);
  await adapter.save({ enabled: true, globalProfile: 'precise' });
  value.changeCapabilities();
  await wait();
  assert.equal(notifications.length, 0);
  monitor.dispose();
});

test('source status probing never blocks the committed settings save', async () => {
  let settings = { enabled: true };
  const repository = {
    async loadSettings() { return structuredClone(settings); },
    async updateSettings(mutator) { settings = structuredClone(mutator(structuredClone(settings))); return structuredClone(settings); },
    async saveSettings(values) { settings = structuredClone(values); return structuredClone(settings); },
    async reset() { return { enabled: true }; },
  };
  const statusSource = {
    loadStatus() { return {}; },
    subscribeStatus() { return () => {}; },
    refreshNow() { return new Promise(() => {}); },
  };
  const adapter = createWorkspaceLlmSettingsAdapter(repository, statusSource, () => assert.fail('a pending status probe must not emit'));
  await adapter.load();
  const result = await Promise.race([
    adapter.save({ enabled: true, globalProfile: 'economy' }).then(() => 'saved'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 100)),
  ]);
  assert.equal(result, 'saved');
  assert.equal(settings.globalProfile, 'economy');
});

test('adapter exposes live status and disposed monitors ignore later host events', async () => {
  const value = fixture();
  const monitor = new LlmSettingsStatusMonitor(value.session, value.repository, {}, value.target);
  await monitor.start();
  const adapter = createWorkspaceLlmSettingsAdapter(value.repository, monitor);
  assert.equal((await adapter.loadStatus()).generationStatus.value, '状态不可用');
  assert.equal((await adapter.loadStatus()).embeddingStatus.value, '状态不可用');
  assert.equal((await adapter.loadStatus()).rerankStatus.value, '状态不可用');
  const before = monitor.loadStatus().tavernStatus.value;
  monitor.dispose();
  value.changeModel({ provider: 'gemini', model: 'gemini-test' });
  await wait();
  assert.equal(monitor.loadStatus().tavernStatus.value, before);
});

test('background status refresh isolates broken observers and never leaks an unhandled rejection', async () => {
  const value = fixture();
  const monitor = new LlmSettingsStatusMonitor(value.session, value.repository, value.handlers, value.target);
  await monitor.start();
  let failObserver = false;
  const unsubscribe = monitor.subscribeStatus(() => {
    if (failObserver) throw new Error('observer failure must be isolated');
  });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    failObserver = true;
    value.changeRepository();
    value.changeModel({ provider: 'openai', model: 'after-observer-error' });
    await wait(160);
    assert.equal(unhandled.length, 0);
    assert.equal(monitor.loadStatus().tavernStatus.value, '酒馆 · after-observer-error');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    unsubscribe();
    monitor.dispose();
  }
});
