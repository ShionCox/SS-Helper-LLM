import test from 'node:test';
import assert from 'node:assert/strict';
import { registerLlmChatIndicator } from '../dist/src/ss-helper/chat-indicator.js';

const target = { key: '["character:a","chat"]', workspaceId: 'character:a', chatKey: 'chat' };

test('LLM registers a dependency-only indicator controlled by the global enabled setting', async () => {
  let registration; let settings = { enabled: true }; let settingsListener; let unsubscribed = 0;
  const unregister = () => {};
  const session = { registerChatIndicator: (value) => { registration = value; return unregister; } };
  const repository = {
    loadSettings: async () => settings,
    subscribeSettings: (listener) => { settingsListener = listener; return () => { unsubscribed += 1; }; },
  };
  assert.equal(registerLlmChatIndicator(session, repository), unregister);
  assert.equal(registration.kind, 'dependency');
  assert.equal(registration.icon, 'microchip');
  assert.deepEqual(await registration.resolve([target]), [{ targetKey: target.key, state: 'enabled' }]);
  settings = { enabled: false };
  assert.deepEqual(await registration.resolve([target]), [{ targetKey: target.key, state: 'hidden' }]);
  let invalidations = 0;
  const cleanup = registration.subscribe(() => { invalidations += 1; });
  settingsListener(settings);
  assert.equal(invalidations, 1);
  cleanup();
  assert.equal(unsubscribed, 1);
});

test('LLM skips the contribution against an older Core', () => {
  assert.doesNotThrow(() => registerLlmChatIndicator({}, { loadSettings: async () => ({ enabled: true }), subscribeSettings: () => () => {} })());
});
