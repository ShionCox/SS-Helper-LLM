import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { isLlmStructuredTaskResponse } from '@ss-helper/sdk';
import { createLlmSdkServiceHandlers } from '../dist/src/ss-helper/services.js';

test('structured-task accepts a successful plain result from another execution realm', async () => {
  const foreignOutput = vm.runInNewContext(
    '({ actorCandidates: [], locationCandidates: [], episodes: [], claims: [] })',
  );
  const handlers = createLlmSdkServiceHandlers({
    async runTask() {
      return {
        ok: true,
        data: foreignOutput,
        meta: { resourceId: '__builtin_tavern__' },
      };
    },
    async embed() {
      throw new Error('not used');
    },
    async rerank() {
      throw new Error('not used');
    },
    registerConsumer() {},
    unregisterConsumer() {},
  });

  const response = await handlers.runTask(
    {
      task: 'memory_capture',
      input: {},
      outputSchema: { type: 'object' },
    },
    new AbortController().signal,
    'ss-helper.memory',
  );

  assert.deepEqual(JSON.parse(JSON.stringify(response.output)), {
    actorCandidates: [],
    locationCandidates: [],
    episodes: [],
    claims: [],
  });
  assert.equal(isLlmStructuredTaskResponse(response), true);
});
