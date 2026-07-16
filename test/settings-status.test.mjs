import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE_DISCOVERY_SYMBOL } from '@ss-helper/sdk';
import { LlmSettingsStatusMonitor, createWorkspaceLlmSettingsAdapter } from '../dist/index.js';

const wait = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture() {
  const target = new EventTarget();
  target[CORE_DISCOVERY_SYMBOL] = {
    kind: 'ss-helper-core-discovery',
    descriptor: {
      kind: 'ss-helper-core', id: 'ss-helper.core', coreVersion: '2.0.0', sdkPackageVersion: '2.0.0',
      apiMajor: 2, apiMinor: 0, generation: 7, state: 'ready', capabilities: [],
      artifact: { buildId: 'fixture', contentDigest: 'a'.repeat(64) },
    },
    port: {},
  };
  let current = { provider: 'openai', model: 'gpt-test' };
  let repositoryListener;
  let hostListener;
  let capabilityListener;
  const repository = {
    subscribeChanges(listener) { repositoryListener = listener; return () => { repositoryListener = undefined; }; },
    async loadSettings() { return { enabled: true }; },
    async saveSettings(values) { return values; },
    async reset() { return { enabled: true }; },
  };
  const session = {
    descriptor: { id: 'ss-helper.llm', displayName: 'LLM', pluginVersion: '0.3.0', sdkPackageVersion: '2.0.0', apiMajor: 2, minApiMinor: 0, capabilities: [] },
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
        { id: 'generation', configured: true, available: true, source: 'tavern', model: current.model },
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
  };
}

test('LLM settings status is sourced live from Tavern, capabilities, and actual version descriptors', async () => {
  const value = fixture();
  const monitor = new LlmSettingsStatusMonitor(value.session, value.repository, value.handlers, value.target);
  const snapshots = [];
  const unsubscribe = monitor.subscribeStatus((snapshot) => snapshots.push(snapshot));
  await monitor.start();
  assert.equal(monitor.loadStatus().tavernStatus.value, 'openai · gpt-test');
  assert.equal(monitor.loadStatus().serviceStatus.value, '生成可用');
  assert.equal(monitor.loadStatus().about.value, 'LLM v0.3.0 · Core v2.0.0 · SDK v2.0.0 · API 2.0');

  value.changeModel({ provider: 'claude', model: 'claude-test' });
  await wait();
  assert.equal(snapshots.at(-1).tavernStatus.value, 'claude · claude-test');

  value.changeRepository();
  await wait();
  assert.equal(snapshots.at(-1).serviceStatus.value, '生成可用');
  value.changeCapabilities();
  await wait();
  assert.equal(snapshots.at(-1).serviceStatus.value, '生成可用');
  unsubscribe();
  monitor.dispose();
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
