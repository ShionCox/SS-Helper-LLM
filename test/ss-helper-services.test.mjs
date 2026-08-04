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

test('embedding and rerank preserve consumer task keys for task-specific routing', async () => {
  const calls = [];
  const handlers = createLlmSdkServiceHandlers({
    async runTask() { throw new Error('not used'); },
    async embed(input) {
      calls.push(input);
      return { ok: true, vectors: [[0.1, 0.2]], meta: { resourceId: 'embed-a', model: 'embed-model' } };
    },
    async rerank(input) {
      calls.push(input);
      return { ok: true, results: [{ index: 1, score: 0.9, doc: 'second' }], meta: { resourceId: 'rerank-a', model: 'rank-model' } };
    },
    registerConsumer() {},
    unregisterConsumer() {},
  });
  const signal = new AbortController().signal;

  const embedded = await handlers.embed({ task: 'memory_embed', input: ['hello'], dimensions: 2 }, signal, 'ss-helper.memory', 'embed-request');
  const reranked = await handlers.rerank({ task: 'memory_rerank', query: 'q', documents: [{ id: '0', text: 'first' }, { id: '1', text: 'second' }], topN: 1 }, signal, 'ss-helper.memory', 'rerank-request');

  assert.equal(calls[0].taskKey, 'memory_embed');
  assert.equal(calls[0].dimensions, 2);
  assert.equal(calls[1].taskKey, 'memory_rerank');
  assert.deepEqual(embedded.embeddings, [[0.1, 0.2]]);
  assert.deepEqual(reranked.results, [{ id: '1', index: 1, score: 0.9 }]);
});
