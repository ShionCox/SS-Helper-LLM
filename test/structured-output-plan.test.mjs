import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OpenAIProvider, createStructuredOutputPlan, detectStructuredOutputIdentity } from '../dist/index.js';

const strictSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { value: { type: 'string' } },
  required: ['value'],
};

test('structured output planner identifies DeepSeek and preserves its JSON-object requirements', () => {
  const identity = detectStructuredOutputIdentity({ manualVendor: 'auto', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
  const plan = createStructuredOutputPlan({ providerKind: 'openai', identity, spec: { name: 'extract', schema: strictSchema } });
  assert.equal(identity.vendor, 'deepseek');
  assert.equal(identity.evidence, 'api_url');
  assert.equal(plan.transport, 'json_object');
  assert.match(plan.promptInstruction, /json/u);
  assert.match(plan.promptInstruction, /"value"/u);
  const routed = detectStructuredOutputIdentity({ manualVendor: 'auto', provider: 'openrouter', model: 'deepseek-chat' });
  assert.deepEqual({ vendor: routed.vendor, evidence: routed.evidence }, { vendor: 'deepseek', evidence: 'model_name' });
});

test('planner uses strict OpenAI schema only for compatible schemas and prompt-only for unknown providers', () => {
  const openai = createStructuredOutputPlan({
    providerKind: 'openai',
    identity: detectStructuredOutputIdentity({ manualVendor: 'openai', model: 'gpt-4o-mini' }),
    spec: { name: 'extract', schema: strictSchema },
  });
  const incompatible = createStructuredOutputPlan({
    providerKind: 'openai',
    identity: detectStructuredOutputIdentity({ manualVendor: 'openai', model: 'gpt-4o-mini' }),
    spec: { name: 'extract', schema: { type: 'object', properties: { value: { type: 'string' } } } },
  });
  const unknown = createStructuredOutputPlan({
    providerKind: 'openai',
    identity: detectStructuredOutputIdentity({ manualVendor: 'auto', baseUrl: 'https://proxy.example/v1', model: 'oracle-x' }),
    spec: { name: 'extract', schema: strictSchema },
  });
  assert.equal(openai.transport, 'json_schema');
  assert.equal(incompatible.transport, 'json_object');
  assert.equal(unknown.transport, 'prompt_only');
});

test('Tavern Custom and unknown sources always use isolated Schema Prompt output', () => {
  for (const model of ['deepseek-v4-flash', 'gpt-4o-mini', 'claude-sonnet', 'gemini-2.5-flash', 'oracle-x']) {
    const plan = createStructuredOutputPlan({
      providerKind: 'tavern',
      identity: detectStructuredOutputIdentity({ manualVendor: 'auto', provider: 'custom', model }),
      spec: { name: 'memory_extract', schema: strictSchema },
    });
    assert.equal(plan.transport, 'prompt_only', `Custom ${model} must not receive Tavern native schema`);
    assert.match(plan.promptInstruction, /JSON Schema/u);
    assert.match(plan.promptInstruction, /"value"/u);
  }

  const unknownOfficialSource = createStructuredOutputPlan({
    providerKind: 'tavern',
    identity: detectStructuredOutputIdentity({ manualVendor: 'auto', provider: 'koboldcpp', model: 'local-model' }),
    spec: { name: 'memory_extract', schema: strictSchema },
  });
  assert.equal(unknownOfficialSource.transport, 'prompt_only');
});

test('Tavern official provider sources retain native Schema transport', () => {
  for (const [provider, model] of [['deepseek', 'deepseek-chat'], ['openai', 'gpt-4o-mini'], ['claude', 'claude-sonnet'], ['gemini', 'gemini-2.5-flash']]) {
    const plan = createStructuredOutputPlan({
      providerKind: 'tavern',
      identity: detectStructuredOutputIdentity({ manualVendor: 'auto', provider, model }),
      spec: { name: 'memory_extract', schema: strictSchema },
    });
    assert.equal(plan.transport, 'tavern_json_schema', `${provider} should use Tavern native schema`);
  }
});

test('static gate prevents Tavern Custom from returning to native schema translation', async () => {
  const source = await readFile(new URL('../src/schema/structured-output-plan.ts', import.meta.url), 'utf8');
  assert.match(source, /tavernSource === 'custom' \|\| input\.identity\.vendor === 'unknown'/u);
  assert.doesNotMatch(source, /tavernSource === 'custom' && input\.identity\.vendor === 'deepseek'/u);
});

test('OpenAI falls back to JSON object only after an explicit format rejection', async () => {
  const requests = [];
  const provider = new OpenAIProvider({
    id: 'openai', apiKey: 'secret', model: 'gpt-4o-mini',
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(String(init.body)));
      if (requests.length === 1) return new Response('{"error":{"message":"response_format json_schema is unsupported"}}', { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"value":"ok"}' }, finish_reason: 'stop' }] }), { status: 200 });
    },
  });
  const plan = createStructuredOutputPlan({ providerKind: 'openai', identity: detectStructuredOutputIdentity({ manualVendor: 'openai', model: 'gpt-4o-mini' }), spec: { name: 'extract', schema: strictSchema } });
  const result = await provider.request({ messages: [{ role: 'system', content: 'Return JSON.' }], structuredOutput: plan });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].response_format.type, 'json_schema');
  assert.deepEqual(requests[1].response_format, { type: 'json_object' });
  assert.deepEqual(result.structuredOutput, { plannedTransport: 'json_schema', actualTransport: 'json_object', fallbackReason: 'response_format_unsupported' });
});

test('OpenAI does not downgrade non-format errors', async () => {
  let calls = 0;
  const provider = new OpenAIProvider({
    id: 'openai', apiKey: 'secret', model: 'gpt-4o-mini',
    fetchImpl: async () => { calls += 1; return new Response('{"error":{"message":"invalid API key"}}', { status: 401 }); },
  });
  const plan = createStructuredOutputPlan({ providerKind: 'openai', identity: detectStructuredOutputIdentity({ manualVendor: 'openai', model: 'gpt-4o-mini' }), spec: { name: 'extract', schema: strictSchema } });
  await assert.rejects(provider.request({ messages: [{ role: 'system', content: 'Return JSON.' }], structuredOutput: plan }));
  assert.equal(calls, 1);
});
