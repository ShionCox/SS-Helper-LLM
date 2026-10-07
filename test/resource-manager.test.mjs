import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { FakeDocument } from '../../SS-Helper-SDK/tests/helpers/fake-dom.mjs';

const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../src/ss-helper/resource-popups.ts', import.meta.url))], bundle: true, format: 'esm', platform: 'browser', write: false });
const { registerResourcePopups } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

test('resource manager loads evidence, exclusively expands clicked rows, preserves focus, filters and rolls back failed saves', async () => {
  const document = new FakeDocument();
  const container = document.createElement('div');
  document.body.append(container);
  let settings = { resources: [
    { id: 'gen', type: 'generation', source: 'custom', apiType: 'deepseek', label: 'DS-flash', model: 'model-a' },
    { id: 'embed', type: 'embedding', source: 'custom', apiType: 'openai', label: 'Embedding', model: 'model-b' },
    { id: 'rerank', type: 'rerank', source: 'custom', apiType: 'openai', label: 'Reranker', model: 'model-c' },
  ] };
  let capability = { status: 'verified', expiresAt: Date.now() + 60_000, dialect: 'deepseek' };
  let failSave = false;
  const selects = new Map();
  const registrations = [];
  const notifications = [];
  const opened = [];
  const listeners = new Set();
  const ui = {
    createIcon: () => document.createElement('ss-helper-icon'),
    createInput: () => document.createElement('input'),
    createButton(options) { const button = document.createElement('button'); button.textContent = options.label; button.disabled = options.disabled; button.setAttribute('aria-label', options.ariaLabel ?? options.label); return button; },
    createSelect(options) { selects.set(options.label, options); return document.createElement('button'); },
    createMenu: () => ({ element: document.createElement('button'), dispose() {} }),
    refreshControls() {},
  };
  const repository = {
    loadSettings: async () => settings,
    listResourceHealth: async () => settings.resources.map(resource => ({ resourceId: resource.id, state: 'success', checkedAt: Date.now(), durationMs: 10 })),
    hasResourceSecret: async () => true,
    subscribeSettings(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async updateSettings(update) { if (failSave) throw new Error('save failed'); settings = update(settings); },
  };
  const session = { host: { has: () => false }, ui: { showToast: notification => notifications.push(notification), openPopup: (...args) => opened.push(args) }, registerPopup: registration => { registrations.push(registration); return () => {}; } };
  const services = { taskStatus: async () => ({ resources: [{ resourceId: 'gen', toolCapabilities: capability, reasoningCapabilities: { status: 'failed', executions: [] } }] }) };
  registerResourcePopups(session, repository, services);
  const cleanup = registrations.find(registration => registration.title === '资源管理').render(container, {}, ui);
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  await tick();
  const rows = () => container.querySelectorAll('.ss-helper-llm-resource-row');
  const cell = () => rows()[0].children[4];
  assert.equal(rows().length, 3);
  rows()[0].querySelectorAll('button').find(button => button.getAttribute('aria-label') === 'DS-flash 编辑').dispatchEvent({ type: 'click' });
  assert.equal(opened[0][0].name, 'resource-editor');
  let mounted;
  const editor = registrations.find(registration => registration.token.name === 'resource-editor');
  assert.equal(editor.title, '编辑资源');
  const editorCleanup = editor.render(document.createElement('div'), opened[0][1], { mountWizard(definition, controller) { mounted = { definition, controller }; return { dispose() {} }; } });
  await tick();
  assert.equal(mounted.definition.steps.length, 0);
  assert.equal(mounted.definition.submitLabel, '保存');
  assert.equal(mounted.definition.form.sections[0].title, '连接配置');
  assert.equal(mounted.definition.form.sections[1].column, 'secondary');
  assert.equal(mounted.controller.snapshot().activeStepId, 'connection');
  assert.equal(mounted.controller.snapshot().values.apiKey, '');
  editorCleanup();
  assert.equal(container.querySelectorAll('.ss-helper-llm-resource-columns').length, 1);
  assert.equal(cell().dataset.capabilityState, 'verified', 'initial render must load cached evidence');
  assert.equal(rows()[0].children[5].dataset.capabilityState, 'failed', 'failed reasoning cannot appear verified when executions are empty');
  assert.equal(rows()[0].children[3].dataset.capabilityState, 'configured', 'connection success alone must not verify configured capabilities');
  const expand = rows()[0].querySelector('[data-resource-expand]');
  let expansionPropagationStopped = false;
  expand.focus(); expand.dispatchEvent({ type: 'click', stopPropagation() { expansionPropagationStopped = true; } });
  assert.equal(expansionPropagationStopped, true);
  assert.equal(document.activeElement.getAttribute('aria-expanded'), 'false');
  assert.equal(document.getElementById('llm-resource-detail-gen').hidden, true);
  for (const [index, id] of [[0, 'gen'], [1, 'embed'], [2, 'rerank']]) {
    rows()[index].dispatchEvent({ type: 'click', target: rows()[index].children[3].children[0] });
    assert.equal(document.activeElement.dataset.resourceExpand, id);
    assert.equal(document.activeElement.getAttribute('aria-expanded'), 'true');
    assert.equal(container.querySelectorAll('.ss-helper-llm-resource-detail').filter(detail => !detail.hidden).length, 1);
    assert.equal(document.getElementById(`llm-resource-detail-${id}`).hidden, false);
  }
  const rerankRow = rows()[2];
  for (const target of [rerankRow.querySelector('[data-resource-expand]'), ...rerankRow.children[8].children]) {
    rerankRow.dispatchEvent({ type: 'click', target });
    assert.equal(document.getElementById('llm-resource-detail-rerank').hidden, false, 'buttons must not also toggle through the row listener');
  }
  rows()[2].dispatchEvent({ type: 'click' });
  assert.equal(container.querySelectorAll('.ss-helper-llm-resource-detail').every(detail => detail.hidden), true);
  assert.equal(document.activeElement.getAttribute('aria-expanded'), 'false');
  capability = { ...capability, expiresAt: Date.now() - 1 };
  for (const listener of listeners) listener();
  await tick();
  assert.equal(cell().dataset.capabilityState, 'expired');
  capability = undefined;
  for (const listener of listeners) listener();
  await tick();
  assert.equal(cell().dataset.capabilityState, 'unknown');
  const search = container.querySelector('input');
  search.value = 'missing'; search.dispatchEvent({ type: 'input' });
  assert.equal(rows().length, 0);
  assert.equal(container.querySelector('.ss-helper-llm-resource-empty').textContent, '没有符合当前筛选条件的资源。');
  search.value = ''; search.dispatchEvent({ type: 'input' });
  failSave = true;
  selects.get('DS-flash 思考模式').onChange('disabled');
  await tick();
  assert.equal(selects.get('DS-flash 思考模式').value, 'provider_default');
  assert.equal(notifications.at(-1).title, '思考策略保存失败');
  assert.equal(settings.resourcePolicies, undefined);
  failSave = false;
  selects.get('DS-flash 思考模式').onChange('disabled');
  await tick();
  assert.deepEqual(settings.resourcePolicies.gen, { mode: 'disabled', effort: 'provider_default' });
  assert.equal(selects.get('DS-flash 思考强度').disabled, true);
  cleanup();
  assert.equal(listeners.size, 0);
  assert.equal(container.children.length, 0);
});
