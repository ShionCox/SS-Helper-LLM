import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { API_MAJOR, API_MINOR, CORE_DISCOVERY_SYMBOL, SDK_PACKAGE_VERSION } from '@ss-helper/sdk';
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
      apiMajor: API_MAJOR, apiMinor: API_MINOR, generation: 7, state: 'ready', capabilities: [],
      artifact: { buildId: 'fixture', contentDigest: 'a'.repeat(64) },
    },
    port: {},
  };
  let current = { provider: 'openai', model: 'gpt-test' };
  let settings = { enabled: true, generationSource: 'tavern' };
  let generationStatus = () => ({ id: 'generation', configured: true, available: true, source: 'tavern', model: current.model });
  let repositoryListener;
  let hostListener;
  let capabilityListener;
  const repository = {
    subscribeChanges(listener) { repositoryListener = listener; return () => { repositoryListener = undefined; }; },
    async loadSettings() { return structuredClone(settings); },
    async saveSettings(values) { settings = structuredClone(values); repositoryListener?.(['generation']); return structuredClone(settings); },
    async reset() { settings = { enabled: true, generationSource: 'tavern' }; return structuredClone(settings); },
  };
  const session = {
    descriptor: { id: 'ss-helper.llm', displayName: 'LLM', pluginVersion: LLM_PLUGIN_VERSION, sdkPackageVersion: SDK_PACKAGE_VERSION, apiMajor: API_MAJOR, minApiMinor: API_MINOR, capabilities: [] },
    generation: 7,
    host: {
      generation: { available: async () => true, current: async () => current },
      events: { subscribe(_name, listener) { hostListener = listener; return () => { hostListener = undefined; }; } },
    },
    events: { subscribe(_token, listener) { capabilityListener = listener; return () => { capabilityListener = undefined; }; } },
  };
  const handlers = {
    capabilityStatus: async () => ({
      revision: 1,
      checks: [
        generationStatus(),
        { id: 'embedding', configured: false, available: false, reason: 'no_resource' },
        { id: 'rerank', configured: false, available: false, reason: 'no_resource' },
      ],
    }),
  };
  return {
    target, repository, session, handlers,
    changeModel(next) { current = next; hostListener?.({}); },
    changeRepository() { repositoryListener?.(['generation']); },
    changeCapabilities() { capabilityListener?.({ revision: 2, kinds: ['embedding'] }); },
    setGenerationStatus(factory) { generationStatus = factory; },
  };
}

test('LLM settings status is sourced live from Tavern, capabilities, and actual version descriptors', async () => {
  const value = fixture();
  const monitor = new LlmSettingsStatusMonitor(value.session, value.repository, value.handlers, value.target);
  const snapshots = [];
  const unsubscribe = monitor.subscribeStatus((snapshot) => snapshots.push(snapshot));
  await monitor.start();
  assert.equal(monitor.loadStatus().tavernStatus.value, 'openai · gpt-test');
  assert.equal(monitor.loadStatus().serviceStatus.value, '生成可用 · 酒馆 · gpt-test');
  assert.equal(monitor.loadStatus().about.value, `LLM v${LLM_PLUGIN_VERSION} · Core v${CORE_VERSION} · SDK v${SDK_PACKAGE_VERSION} · API ${API_MAJOR}.${API_MINOR}`);

  value.changeModel({ provider: 'claude', model: 'claude-test' });
  await wait();
  assert.equal(snapshots.at(-1).tavernStatus.value, 'claude · claude-test');

  value.changeRepository();
  await wait();
  assert.equal(snapshots.at(-1).serviceStatus.value, '生成可用 · 酒馆 · claude-test');
  value.changeCapabilities();
  await wait();
  assert.equal(snapshots.at(-1).serviceStatus.value, '生成可用 · 酒馆 · claude-test');
  unsubscribe();
  monitor.dispose();
});

test('adapter warns once for a user source switch and background refreshes stay silent', async () => {
  const value = fixture();
  const monitor = new LlmSettingsStatusMonitor(value.session, value.repository, value.handlers, value.target);
  await monitor.start();
  const notifications = [];
  const adapter = createWorkspaceLlmSettingsAdapter(value.repository, monitor, (notification) => notifications.push(notification));
  await adapter.load();
  value.setGenerationStatus(() => ({ id: 'generation', configured: false, available: false, reason: 'no_resource' }));
  await adapter.save({ enabled: true, generationSource: 'custom' });
  await wait(0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].code, 'LLM_GENERATION_SOURCE_UNAVAILABLE');
  await adapter.save({ enabled: true, generationSource: 'custom', globalProfile: 'economy' });
  value.changeCapabilities();
  await wait();
  assert.equal(notifications.length, 1);
  monitor.dispose();
});

test('source status probing never blocks the committed settings save', async () => {
  let settings = { enabled: true, generationSource: 'tavern' };
  const repository = {
    async loadSettings() { return structuredClone(settings); },
    async saveSettings(values) { settings = structuredClone(values); return structuredClone(settings); },
    async reset() { return { enabled: true, generationSource: 'tavern' }; },
  };
  const statusSource = {
    loadStatus() { return {}; },
    subscribeStatus() { return () => {}; },
    refreshNow() { return new Promise(() => {}); },
  };
  const adapter = createWorkspaceLlmSettingsAdapter(repository, statusSource, () => assert.fail('a pending status probe must not emit'));
  await adapter.load();
  const result = await Promise.race([
    adapter.save({ enabled: true, generationSource: 'custom' }).then(() => 'saved'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 100)),
  ]);
  assert.equal(result, 'saved');
  assert.equal(settings.generationSource, 'custom');
});

test('adapter exposes live status and disposed monitors ignore later host events', async () => {
  const value = fixture();
  const monitor = new LlmSettingsStatusMonitor(value.session, value.repository, {}, value.target);
  await monitor.start();
  const adapter = createWorkspaceLlmSettingsAdapter(value.repository, monitor);
  assert.equal((await adapter.loadStatus()).serviceStatus.value, '状态不可用');
  const before = monitor.loadStatus().tavernStatus.value;
  monitor.dispose();
  value.changeModel({ provider: 'gemini', model: 'gemini-test' });
  await wait();
  assert.equal(monitor.loadStatus().tavernStatus.value, before);
});
