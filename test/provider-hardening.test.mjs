import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider, TavernProvider } from '../dist/index.js';

function rerankProvider(content) {
  return new OpenAIProvider({
    id: 'rerank-provider',
    apiKey: 'secret',
    model: 'model-a',
    enableRerank: true,
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content } }],
    }), { status: 200 }),
  });
}

const rerankRequest = {
  query: 'query',
  docs: ['first', 'second'],
  topK: 1,
};

test('OpenAI-compatible rerank accepts one strict root object and applies topK after validation', async () => {
  const result = await rerankProvider('{"results":[{"index":1,"score":0.9},{"index":0,"score":0.2}]}').rerank(rerankRequest);
  assert.deepEqual(result.results, [{ index: 1, score: 0.9, doc: 'second' }]);
});

for (const [name, content, reasonCode] of [
  ['markdown fence', '```json\n{"results":[{"index":0,"score":1}]}\n```', 'INVALID_JSON'],
  ['leading prose', 'result: {"results":[{"index":0,"score":1}]}', 'INVALID_JSON'],
  ['multiple roots', '{"results":[{"index":0,"score":1}]} {"results":[]}', 'INVALID_JSON'],
  ['duplicate index', '{"results":[{"index":0,"score":1},{"index":0,"score":0.5}]}', 'SCHEMA_VALIDATION_FAILED'],
  ['out of range index', '{"results":[{"index":2,"score":1}]}', 'SCHEMA_VALIDATION_FAILED'],
  ['non-integer index', '{"results":[{"index":0.5,"score":1}]}', 'SCHEMA_VALIDATION_FAILED'],
  ['invalid score', '{"results":[{"index":0,"score":1.1}]}', 'SCHEMA_VALIDATION_FAILED'],
  ['empty results', '{"results":[]}', 'SCHEMA_VALIDATION_FAILED'],
  ['extra property', '{"results":[{"index":0,"score":1,"doc":"forged"}]}', 'SCHEMA_VALIDATION_FAILED'],
]) {
  test(`OpenAI-compatible rerank rejects ${name}`, async () => {
    await assert.rejects(
      rerankProvider(content).rerank(rerankRequest),
      (error) => error?.details?.reasonCode === reasonCode
        && typeof error?.details?.stage === 'string'
        && !JSON.stringify(error).includes(content),
    );
  });
}

test('Tavern model discovery returns unified failures for unavailable, errors, and abort', async () => {
  const unavailable = new TavernProvider({
    id: 'tavern-a',
    generation: {
      available: async () => false,
      models: async () => [],
      current: async () => ({}),
      generate: async () => ({ text: '' }),
      test: async () => ({ text: '' }),
    },
  });
  const unavailableResult = await unavailable.listModels();
  assert.equal(unavailableResult.ok, false);
  assert.equal(unavailableResult.failure?.reasonCode, 'PROVIDER_UNAVAILABLE');
  assert.equal(unavailableResult.failure?.stage, 'llm.provider.models');

  const failing = new TavernProvider({
    id: 'tavern-b',
    generation: {
      available: async () => true,
      models: async () => { throw new Error('private model inventory'); },
      current: async () => ({}),
      generate: async () => ({ text: '' }),
      test: async () => ({ text: '' }),
    },
  });
  const failedResult = await failing.listModels();
  assert.equal(failedResult.ok, false);
  assert.equal(failedResult.failure?.reasonCode, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(failedResult).includes('private model inventory'), false);

  const controller = new AbortController();
  controller.abort();
  const abortedResult = await failing.listModels(controller.signal);
  assert.equal(abortedResult.ok, false);
  assert.equal(abortedResult.failure?.reasonCode, 'REQUEST_ABORTED');
});

test('Tavern model discovery preserves an AbortError thrown by the host', async () => {
  const provider = new TavernProvider({
    id: 'tavern-abort',
    generation: {
      available: async () => true,
      models: async () => { throw new DOMException('private abort detail', 'AbortError'); },
      current: async () => ({}),
      generate: async () => ({ text: '' }),
      test: async () => ({ text: '' }),
    },
  });
  const result = await provider.listModels();
  assert.equal(result.ok, false);
  assert.equal(result.failure?.reasonCode, 'REQUEST_ABORTED');
  assert.equal(JSON.stringify(result).includes('private abort detail'), false);
});
