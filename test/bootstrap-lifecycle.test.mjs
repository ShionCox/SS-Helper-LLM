import test from 'node:test';
import assert from 'node:assert/strict';
import {
  API_MAJOR,
  API_MINOR,
  CORE_DISCOVERY_SYMBOL,
  CORE_LIFECYCLE_EVENT,
} from '@ss-helper/sdk';
import { startLlmPlugin } from '../dist/index.js';

const services = {
  completion: async () => ({ text: 'ok', route: 'fixture', model: 'fixture' }),
  runTask: async () => ({ output: {}, route: { route: 'fixture' } }),
  embed: async () => ({ embeddings: [], route: { route: 'fixture' } }),
  rerank: async () => ({ results: [], route: { route: 'fixture' } }),
  diagnostics: () => ({ entries: [] }),
};

function coreDescriptor(generation, overrides = {}) {
  return {
    kind: 'ss-helper-core', id: 'ss-helper.core', coreVersion: '1.0.0', sdkPackageVersion: '1.0.0',
    apiMajor: API_MAJOR, apiMinor: API_MINOR, generation, state: 'ready',
    capabilities: ['tavern.generation.read', 'tavern.generation.execute', 'tavern.chat.events', 'core.ui.notification.v1'],
    artifact: { buildId: `fixture-${generation}`, contentDigest: 'a'.repeat(64) },
    ...overrides,
  };
}

function fixtureCore(generation, active) {
  let close;
  const closed = new Promise((resolve) => { close = resolve; });
  const add = () => {
    const marker = {};
    active.add(marker);
    return () => active.delete(marker);
  };
  const session = {
    descriptor: { id: 'ss-helper.llm', displayName: 'LLM', pluginVersion: '1.0.0', sdkPackageVersion: '2.0.0', apiMajor: 2, minApiMinor: 0, capabilities: [] },
    generation,
    closed,
    host: { generation: {} },
    services: { expose: add },
    events: { publish() {}, subscribe: add },
    ui: { showToast() {} },
    registerSettings: add,
    registerPopup: add,
    dispose() { close({ reason: 'consumer_dispose', generation }); },
  };
  return { session, close };
}

function installSnapshot(target, descriptor, fixture) {
  target[CORE_DISCOVERY_SYMBOL] = {
    kind: 'ss-helper-core-discovery',
    descriptor,
    port: { connect: () => fixture.session, diagnostics: () => ({ generation: descriptor.generation, events: [] }) },
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for lifecycle state');
}

test('Core replacement cleans the old generation and registers one fresh typed surface', async () => {
  const target = new EventTarget();
  const active = new Set();
  const first = fixtureCore(1, active);
  installSnapshot(target, coreDescriptor(1), first);
  const storage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  const bootstrap = await startLlmPlugin({ pluginVersion: '1.0.0', target, storage, services });
  assert.equal(active.size, 24, 'settings, status listener, popup, and typed services register once');

  const second = fixtureCore(2, active);
  installSnapshot(target, coreDescriptor(2), second);
  first.close({ reason: 'core_replaced', generation: 1 });
  target.dispatchEvent(new Event(CORE_LIFECYCLE_EVENT));
  await waitFor(() => bootstrap.current.generation === 2 && active.size === 24);

  bootstrap.dispose();
  await bootstrap.closed;
  await waitFor(() => active.size === 0);
});

test('incompatible Core fails before any settings, popup, or service registration', async () => {
  const target = new EventTarget();
  const active = new Set();
  const fixture = fixtureCore(1, active);
  installSnapshot(target, coreDescriptor(1, { apiMajor: API_MAJOR + 1 }), fixture);
  const storage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  await assert.rejects(
    startLlmPlugin({ pluginVersion: '1.0.0', target, storage, services }),
    (error) => error?.code === 'API_INCOMPATIBLE',
  );
  assert.equal(active.size, 0);
});
