import test from 'node:test';
import assert from 'node:assert/strict';
import { renderConfigurationPopup } from '../dist/src/ss-helper/configuration-popups.js';
import { FakeDocument } from '../../SS-Helper-SDK/tests/helpers/fake-dom.mjs';
import { createSSHelperError } from '@ss-helper/sdk';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture() {
  const document = new FakeDocument();
  const container = document.createElement('div'); document.body.append(container);
  let settings = { resources: [{ id: 'embed', type: 'embedding', label: 'Embedding', model: 'model' }], taskAssignments: [{ pluginId: 'memory', taskKey: 'extract', resourceId: 'dedicated' }], budgets: { unknown: { maxRPM: 12, maxTokens: 400 } } };
  let fail = false;
  const notifications = [];
  const selects = [];
  const ui = {
    createSelect(options) { selects.push(options); return document.createElement('button'); },
    createInput(options) { const input = document.createElement('input'); Object.assign(input, options); input.setAttribute('aria-label', options.label); return input; },
    createButton(options) { const button = document.createElement('button'); button.textContent = options.label; return button; },
  };
  const repository = {
    loadSettings: async () => structuredClone(settings), loadConsumers: async () => ({ memory: { displayName: 'Memory' } }),
    updateSettings: async (update) => {
      if (fail) throw createSSHelperError('WORKSPACE_CONFLICT', { stage: 'test.settings', requestId: 'settings-test' });
      settings = update(structuredClone(settings)); return structuredClone(settings);
    },
  };
  return { document, container, selects, ui, repository, notifications, settings: () => settings, fail: () => { fail = true; } };
}

test('default resource form changes one route without touching task assignments or budgets', async () => {
  const f = fixture();
  const dispose = await renderConfigurationPopup(f.container, 'default-routes', f.repository, f.ui);
  assert.equal(f.container.querySelectorAll('textarea').length, 0);
  f.selects[1].onChange('embed'); await tick();
  assert.equal(f.settings().globalAssignments.embedding.resourceId, 'embed');
  assert.equal(f.settings().taskAssignments[0].resourceId, 'dedicated');
  assert.equal(f.settings().budgets.unknown.maxRPM, 12);
  f.selects[1].onChange(''); await tick();
  assert.equal(f.settings().globalAssignments.embedding, undefined);
  dispose();
});

test('budget form keeps unknown consumers, preserves sibling limits, clears and rolls back failed saves', async () => {
  const f = fixture();
  const dispose = await renderConfigurationPopup(f.container, 'budget-manager', f.repository, f.ui, (message) => f.notifications.push(message));
  const groups = f.container.querySelectorAll('fieldset');
  const unknown = groups.find((group) => group.querySelector('legend').textContent === 'unknown');
  assert.ok(unknown);
  const [rpm, tokens, latency] = unknown.querySelectorAll('input');
  latency.value = '2.5'; latency.dispatchEvent({ type: 'input' }); latency.dispatchEvent({ type: 'blur' }); await tick();
  assert.deepEqual(f.settings().budgets.unknown, { maxRPM: 12, maxTokens: 400, maxLatencyMs: 2500 });
  tokens.value = ''; tokens.dispatchEvent({ type: 'input' }); tokens.dispatchEvent({ type: 'blur' }); await tick();
  assert.equal(f.settings().budgets.unknown.maxTokens, undefined);
  f.fail(); rpm.value = '99'; rpm.dispatchEvent({ type: 'input' }); rpm.dispatchEvent({ type: 'blur' }); await tick();
  assert.equal(rpm.value, '12');
  assert.equal(f.notifications.at(-1).code, 'WORKSPACE_CONFLICT');
  dispose();
});

test('clear budget cancels pending edits instead of writing them back later', async () => {
  const f = fixture();
  const dispose = await renderConfigurationPopup(f.container, 'budget-manager', f.repository, f.ui);
  const unknown = f.container.querySelectorAll('fieldset').find((group) => group.querySelector('legend').textContent === 'unknown');
  const input = unknown.querySelector('input'); input.value = '99'; input.dispatchEvent({ type: 'input' });
  unknown.querySelector('button').dispatchEvent({ type: 'click' }); await tick();
  assert.equal(f.settings().budgets.unknown, undefined);
  dispose();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(f.settings().budgets.unknown, undefined);
});
