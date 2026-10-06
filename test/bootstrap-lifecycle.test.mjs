import test from 'node:test';
import assert from 'node:assert/strict';
import {
  API_VERSION,
  CORE_DISCOVERY_SYMBOL,
  CORE_LIFECYCLE_EVENT,
} from '@ss-helper/sdk';
import { ConsumerRegistry, LLM_REQUEST_LOGS_POPUP, LLM_SETTINGS_SCHEMA, startLlmPlugin } from '../dist/index.js';

const route = { resourceId: 'fixture', source: 'custom', provider: 'openai', model: 'fixture', execution: 'structured', transport: 'json_schema' };
const services = {
  completion: async () => ({ text: 'ok', route }),
  runTask: async () => ({ output: {}, route }),
  embed: async () => ({ embeddings: [], route: { ...route, execution: 'embedding', transport: 'embedding' } }),
  rerank: async () => ({ results: [], route: { ...route, execution: 'rerank', transport: 'rerank' } }),
  diagnostics: () => ({ entries: [] }),
};

test('async registry persistence failures are handled and disposal cancels pending persistence', async () => {
  const registry = new ConsumerRegistry();
  const unhandled = [];
  const listen = error => unhandled.push(error);
  process.on('unhandledRejection', listen);
  let persisted = 0;
  registry.setPersistCallback(async () => { persisted++; throw new Error('fixture persistence failure'); });
  const registration = { pluginId: 'example.persist', displayName: 'Persist', registrationVersion: 1, tasks: [{ taskKey: 'completion', taskKind: 'generation', requiredCapabilities: ['chat'] }] };
  try {
    registry.registerConsumer(registration);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(persisted, 1);
    assert.deepEqual(unhandled, []);
    registry.registerConsumer(registration);
    registry.dispose();
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(persisted, 1);
  } finally { registry.dispose(); process.off('unhandledRejection', listen); }
});

function coreDescriptor(generation, overrides = {}) {
  return {
    kind: 'ss-helper-core', id: 'ss-helper.core', coreVersion: '0.0.1', sdkPackageVersion: '0.0.1',
    apiVersion: API_VERSION, generation, state: 'ready',
    capabilities: ['tavern.generation.read', 'tavern.generation.execute', 'tavern.chat.events', 'tavern.plugin.request', 'core.ui.notification.v0', 'secrets.read', 'secrets.write'],
    artifact: { buildId: `fixture-${generation}`, contentDigest: 'a'.repeat(64) },
    ...overrides,
  };
}

function fixtureCore(generation, active, popupRegistrations = [], menuRegistrations = []) {
  let close;
  const closed = new Promise((resolve) => { close = resolve; });
  const openedPopups = [];
  const add = () => {
    const marker = {};
    active.add(marker);
    return () => active.delete(marker);
  };
  const session = {
    descriptor: { id: 'ss-helper.llm', displayName: 'LLM', pluginVersion: '0.0.1', sdkPackageVersion: '0.0.1', apiVersion: API_VERSION, minApiVersion: API_VERSION, capabilities: [] },
    generation,
    closed,
    host: { generation: {} },
    bus: { handle: add, request() {}, publish() {}, subscribe: add },
    ui: { showToast() {}, openPopup(token, input) { openedPopups.push({ token, input }); } },
    registerSettings: add,
    registerChatIndicator: add,
    registerPopup(registration) { popupRegistrations.push(registration); return add(); },
    registerExtensionMenuItem(registration) { menuRegistrations.push(registration); return add(); },
    dispose() { close({ reason: 'consumer_dispose', generation }); },
  };
  return { session, close, openedPopups };
}

function collectPopupTokens(fields, output = []) {
  for (const field of fields) {
    if (field.popup) output.push(field.popup);
    if (Array.isArray(field.children)) collectPopupTokens(field.children, output);
  }
  return output;
}

const popupKey = (token) => `${token.provider}:${token.name}:v${token.version}`;

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
  const firstPopupRegistrations = [];
  const firstMenuRegistrations = [];
  const first = fixtureCore(1, active, firstPopupRegistrations, firstMenuRegistrations);
  installSnapshot(target, coreDescriptor(1), first);
  const storage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  const bootstrap = await startLlmPlugin({ pluginVersion: '0.0.1', target, storage, services });
  assert.equal(active.size, 21, 'settings, chat indicator, menu item, status listener, popup, and typed bus handlers register once');
  const registeredPopupTokens = firstPopupRegistrations.map(({ token }) => token);
  const schemaPopupTokens = collectPopupTokens(LLM_SETTINGS_SCHEMA.fields);
  assert.equal(registeredPopupTokens.length, 11);
  assert.deepEqual(
    registeredPopupTokens.map(popupKey).sort(),
    schemaPopupTokens.map(popupKey).sort(),
    'every settings popup action must resolve to a registered popup token',
  );
  assert.ok(registeredPopupTokens.every(({ version }) => version === 0));
  const requestLogs = firstPopupRegistrations.find(({ token }) => token.name === 'request-logs');
  assert.equal(requestLogs?.presentation, 'workspace');
  assert.equal(requestLogs?.closeLabel, '关闭请求日志');
  assert.equal(firstMenuRegistrations.length, 1);
  assert.deepEqual(
    { ...firstMenuRegistrations[0], onActivate: undefined },
    { id: 'request-logs', label: 'LLM 请求日志', icon: 'clipboard-list', order: 200, onActivate: undefined },
  );
  firstMenuRegistrations[0].onActivate();
  assert.deepEqual(first.openedPopups, [{ token: LLM_REQUEST_LOGS_POPUP, input: {} }]);

  const second = fixtureCore(2, active);
  installSnapshot(target, coreDescriptor(2), second);
  first.close({ reason: 'core_replaced', generation: 1 });
  target.dispatchEvent(new Event(CORE_LIFECYCLE_EVENT));
  await waitFor(() => bootstrap.current.generation === 2 && active.size === 21);

  bootstrap.dispose();
  await bootstrap.closed;
  await waitFor(() => active.size === 0);
});

test('incompatible Core fails before any settings, popup, or service registration', async () => {
  const target = new EventTarget();
  const active = new Set();
  const fixture = fixtureCore(1, active);
  installSnapshot(target, coreDescriptor(1, { apiVersion: '0.0.0' }), fixture);
  const storage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  await assert.rejects(
    startLlmPlugin({ pluginVersion: '0.0.1', target, storage, services }),
    (error) => error?.code === 'INVALID_PAYLOAD',
  );
  assert.equal(active.size, 0);
});
