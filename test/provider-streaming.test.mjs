import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeProvider, GeminiProvider, OpenAIProvider } from '../dist/index.js';

const sse = (...events) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
});

test('OpenAI-compatible generation always requests stream and assembles content, usage, and finish reason', async () => {
  let init;
  const provider = new OpenAIProvider({ id: 'xai', apiKey: 'secret', apiType: 'xai', model: 'grok', fetchImpl: async (_url, request) => {
    init = request;
    return sse(
      { choices: [{ delta: { content: '{"ok":' } }] },
      { choices: [{ delta: { content: 'true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
    );
  } });
  const result = await provider.request({ messages: [{ role: 'user', content: 'hello' }], timeoutMs: 180_000 });
  assert.equal(result.content, '{"ok":true}');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.usage, { promptTokens: 2, completionTokens: 3, totalTokens: 5 });
  assert.equal(JSON.parse(init.body).stream, true);
  assert.equal(init.timeoutMs, 180_000);
  assert.equal(init.idleTimeoutMs, 30_000);
  assert.deepEqual({ status: result.diagnostics.httpStatus, type: result.diagnostics.contentType, streamed: result.diagnostics.streamed, events: result.diagnostics.streamEventCount }, { status: 200, type: 'text/event-stream', streamed: true, events: 2 });
});

test('structured OpenAI-compatible generation uses one complete response with the configured long timeout', async () => {
  let init;
  const provider = new OpenAIProvider({
    id: 'deepseek-structured', apiKey: 'secret', apiType: 'deepseek', model: 'deepseek',
    fetchImpl: async (_url, request) => {
      init = request;
      return Response.json({
        choices: [{ message: { content: '{"value":"ok"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      });
    },
  });
  const structuredOutput = {
    transport: 'json_object',
    identity: { vendor: 'deepseek', evidence: 'manual', confidence: 'high', model: 'deepseek' },
    strictSchemaCompatible: true,
    spec: { name: 'extract', schema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string' } } } },
    promptInstruction: 'Return one JSON object.',
  };

  const result = await provider.request({ messages: [{ role: 'user', content: 'hello' }], structuredOutput });

  assert.equal(result.content, '{"value":"ok"}');
  assert.equal(JSON.parse(init.body).stream, false);
  assert.equal(init.timeoutMs, 600_000);
  assert.equal(init.idleTimeoutMs, 120_000);
  assert.equal(result.diagnostics.streamed, false);
});

test('Claude generation assembles message SSE events', async () => {
  const provider = new ClaudeProvider({ id: 'claude', apiKey: 'secret', model: 'claude', fetchImpl: async () => sse(
    { type: 'message_start', message: { usage: { input_tokens: 4 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ) });
  const result = await provider.request({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(result.content, 'done');
  assert.deepEqual(result.usage, { promptTokens: 4, completionTokens: 2, totalTokens: 6 });
  assert.deepEqual([result.diagnostics.httpStatus, result.diagnostics.streamed, result.diagnostics.streamEventCount], [200, true, 5]);
});

test('Gemini generation uses streamGenerateContent and joins response chunks', async () => {
  let requestedUrl = '';
  const provider = new GeminiProvider({ id: 'gemini', apiKey: 'secret', model: 'gemini', fetchImpl: async (url) => {
    requestedUrl = String(url);
    return sse(
      { candidates: [{ content: { parts: [{ text: '{"value":' }] } }] },
      { candidates: [{ content: { parts: [{ text: '1}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } },
    );
  } });
  const result = await provider.request({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(result.content, '{"value":1}');
  assert.match(requestedUrl, /:streamGenerateContent\?alt=sse$/u);
  assert.deepEqual([result.diagnostics.httpStatus, result.diagnostics.streamed, result.diagnostics.streamEventCount], [200, true, 2]);
});

test('a structured stream parameter rejection maps without exposing the response body', async () => {
  const provider = new OpenAIProvider({ id: 'relay', apiKey: 'secret', apiType: 'generic', fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'unsupported_stream', param: 'stream', message: 'private detail' } }), { status: 400 }) });
  await assert.rejects(
    provider.request({ messages: [{ role: 'user', content: 'hello' }] }),
    (error) => error?.details?.reasonCode === 'PROVIDER_STREAM_UNSUPPORTED'
      && !JSON.stringify(error).includes('private detail'),
  );
});

test('a malformed successful stream keeps response evidence for logging without serializing it on the error', async () => {
  const rawResponseText = 'data: {"choices":[';
  const provider = new OpenAIProvider({
    id: 'malformed-stream', apiKey: 'secret', apiType: 'generic', model: 'model',
    fetchImpl: async () => new Response(rawResponseText, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  await assert.rejects(
    provider.request({ messages: [{ role: 'user', content: 'hello' }] }),
    (error) => error?.details?.reasonCode === 'PROVIDER_RESPONSE_INVALID'
      && error.rawResponseText === rawResponseText
      && !JSON.stringify(error).includes(rawResponseText),
  );
});

test('streaming can be disabled for generation and tool calls', async () => {
  const requests = [];
  const provider = new OpenAIProvider({
    id: 'relay-non-stream', apiKey: 'secret', apiType: 'generic', model: 'model', streamingEnabled: false,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return Response.json({ choices: [{ message: { content: requests.length === 1 ? 'done' : '{}' }, finish_reason: 'stop' }] });
    },
  });

  const result = await provider.request({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(result.content, 'done');
  assert.deepEqual([result.diagnostics.httpStatus, result.diagnostics.streamed], [200, false]);
  const adapter = provider.createToolAdapter();
  await adapter.start({
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object', properties: {} } }],
  });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.url.endsWith('/chat/completions')));
  assert.ok(requests.every((request) => request.body.stream !== true));
  assert.equal(Array.isArray(requests[1].body.tools), true);
});
