import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider, createStructuredOutputPlan, detectStructuredOutputIdentity } from '../dist/index.js';

const strictSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { value: { type: 'string' } },
  required: ['value'],
};

const identity = detectStructuredOutputIdentity({ manualVendor: 'openai', model: 'gpt-4o-mini' });

test('planner follows explicit provider capability instead of URL or model-name guessing', () => {
  const strict = createStructuredOutputPlan({
    identity,
    capability: { transports: ['json_schema', 'json_object', 'prompt_only'], preferred: 'json_schema' },
    spec: { name: 'extract', schema: strictSchema },
  });
  const jsonObject = createStructuredOutputPlan({
    identity,
    capability: { transports: ['json_object', 'prompt_only'], preferred: 'json_object' },
    spec: { name: 'extract', schema: strictSchema },
  });
  const promptOnly = createStructuredOutputPlan({
    identity,
    capability: { transports: ['prompt_only'], preferred: 'prompt_only' },
    spec: { name: 'extract', schema: strictSchema },
  });
  assert.equal(strict.transport, 'json_schema');
  assert.equal(jsonObject.transport, 'json_object');
  assert.equal(promptOnly.transport, 'prompt_only');
});

test('planner deterministically falls back when strict schema transport cannot represent the schema', () => {
  const incompatible = createStructuredOutputPlan({
    identity,
    capability: { transports: ['json_schema', 'json_object', 'prompt_only'], preferred: 'json_schema' },
    spec: { name: 'extract', schema: { type: 'object', properties: { value: { type: 'string' } } } },
  });
  assert.equal(incompatible.transport, 'json_object');
});

test('Tavern capability selects the host native schema transport regardless of model identity', () => {
  const plan = createStructuredOutputPlan({
    identity: detectStructuredOutputIdentity({ manualVendor: 'auto', provider: 'custom', model: 'oracle-x' }),
    capability: { transports: ['tavern_json_schema', 'prompt_only'], preferred: 'tavern_json_schema' },
    spec: { name: 'memory_capture', schema: strictSchema },
  });
  assert.equal(plan.transport, 'tavern_json_schema');
});

test('OpenAI provider performs exactly one HTTP call and leaves transport fallback to the coordinator', async () => {
  let calls = 0;
  const provider = new OpenAIProvider({
    id: 'openai', apiKey: 'secret', model: 'gpt-4o-mini',
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        error: {
          message: 'private provider explanation must not cross the boundary',
          type: 'invalid_request_error',
          param: 'response_format',
          code: 'unsupported_response_format',
        },
      }), { status: 400 });
    },
  });
  const plan = createStructuredOutputPlan({
    identity,
    capability: provider.capabilities.structuredOutput,
    spec: { name: 'extract', schema: strictSchema },
  });
  await assert.rejects(
    provider.request({ messages: [{ role: 'system', content: 'Return JSON.' }], structuredOutput: plan }),
    (error) => error?.details?.reasonCode === 'RESPONSE_FORMAT_UNSUPPORTED'
      && error?.details?.providerErrorCode === 'unsupported_response_format'
      && error?.details?.providerErrorType === 'invalid_request_error'
      && error?.details?.providerErrorParam === 'response_format'
      && !JSON.stringify(error).includes('private provider explanation'),
  );
  assert.equal(calls, 1);
});

test('OpenAI provider distinguishes a missing model from a missing endpoint without exposing response text', async () => {
  const missingModel = new OpenAIProvider({
    id: 'missing-model', apiKey: 'secret', model: 'retired-model',
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        message: 'private model inventory detail',
        type: 'invalid_request_error',
        param: 'model',
        code: 'model_not_found',
      },
    }), { status: 404 }),
  });
  await assert.rejects(
    missingModel.request({ messages: [{ role: 'user', content: 'hello' }] }),
    (error) => error?.details?.reasonCode === 'MODEL_NOT_FOUND'
      && error?.details?.providerErrorParam === 'model'
      && !JSON.stringify(error).includes('private model inventory detail'),
  );

  const missingEndpoint = new OpenAIProvider({
    id: 'missing-endpoint', apiKey: 'secret', model: 'model-a',
    fetchImpl: async () => new Response('not found', { status: 404 }),
  });
  await assert.rejects(
    missingEndpoint.request({ messages: [{ role: 'user', content: 'hello' }] }),
    (error) => error?.details?.reasonCode === 'ENDPOINT_NOT_FOUND'
      && !JSON.stringify(error).includes('not found'),
  );
});

test('Provider does not infer DeepSeek response_format support from an unsafe message', async () => {
  const provider = new OpenAIProvider({
    id: 'deepseek-v4', apiKey: 'secret', model: 'deepseek-v4', apiType: 'deepseek',
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        message: 'This response_format type is unavailable now',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_request_error',
      },
    }), { status: 400 }),
  });
  const plan = createStructuredOutputPlan({
    identity: detectStructuredOutputIdentity({ manualVendor: 'deepseek', model: 'deepseek-v4' }),
    capability: provider.capabilities.structuredOutput,
    spec: { name: 'extract', schema: strictSchema },
  });

  await assert.rejects(
    provider.request({ messages: [{ role: 'system', content: 'Return JSON.' }], structuredOutput: plan }),
    (error) => error?.details?.reasonCode === 'PROVIDER_HTTP_ERROR'
      && error?.details?.providerErrorCode === 'invalid_request_error'
      && !JSON.stringify(error).includes('This response_format type is unavailable now'),
  );
});

test('Provider recognizes response_format rejection from structured param evidence', async () => {
  const provider = new OpenAIProvider({
    id: 'structured-evidence', apiKey: 'secret', model: 'model-a',
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        message: 'private provider prose',
        type: 'invalid_request_error',
        param: 'response_format.type',
        code: 'invalid_request_error',
      },
    }), { status: 400 }),
  });
  await assert.rejects(
    provider.request({ messages: [{ role: 'user', content: 'hello' }] }),
    (error) => error?.details?.reasonCode === 'RESPONSE_FORMAT_UNSUPPORTED'
      && error?.details?.providerErrorParam === 'response_format.type'
      && !JSON.stringify(error).includes('private provider prose'),
  );
});

test('Provider keeps a bare HTTP 415 as a generic HTTP failure', async () => {
  const provider = new OpenAIProvider({
    id: 'bare-415', apiKey: 'secret', model: 'model-a',
    fetchImpl: async () => new Response('', { status: 415 }),
  });
  await assert.rejects(
    provider.request({ messages: [{ role: 'user', content: 'hello' }] }),
    (error) => error?.details?.reasonCode === 'PROVIDER_HTTP_ERROR'
      && error?.details?.httpStatus === 415,
  );
});
