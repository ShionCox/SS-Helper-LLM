import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStoredLog, MAX_SINGLE_LOG_BYTES, sanitizeStoredLogForRead } from '../dist/src/log/log-sanitizer.js';

function agentEntry() {
  return {
    logId: 'turn-1', requestId: 'turn-1', llmTaskId: 'pipeline-1:entities:1', attemptId: 'turn-1',
    sourcePluginId: 'ss-helper.memory', consumer: 'ss-helper.memory',
    taskKey: 'memory_extract_entities', taskDescription: '解析人物与地点实体', taskKind: 'generation',
    entryKind: 'agent_turn', state: 'completed', attemptIndex: 1, attemptPhase: 'initial', attemptTag: '初次请求', isFinalAttempt: true, queuedAt: 1,
    workflow: { workflowId: 'pipeline-1', workflowLabel: '初始化记忆', workflowKind: 'agent' },
    prompt: 'private-top-level-prompt',
    arbitraryPayload: { modelReply: 'private-top-level-reply' },
    request: {
      taskKind: 'generation', generationInput: { messages: [{ role: 'user', content: 'private-prompt' }] },
      providerRequest: { headers: { authorization: 'Bearer private-token' }, payload: { messages: [{ content: 'private-wire-prompt' }] } },
      providerRequestMeta: { requestFormat: 'agent_tool_turn', method: 'POST', endpointOrigin: 'https://relay.invalid', endpointPath: '/v1', queryParameterNames: ['token'], messageCount: 1, inputCharCount: 14, rawBody: 'private-meta-request' },
    },
    agent: {
      state: 'tool_calls', toolSessionRound: 1, totalCalls: 1, toolDescriptions: { 'entity.resolve_context': 'private-tool-description' },
      toolCalls: [{ callId: 'call-1', name: 'entity.resolve_context', arguments: { apiKey: 'private-key', query: 'private-query', embedded: '{"access_token":"private-embedded-token"}' } }],
      toolResults: [{ callId: 'call-1', name: 'entity.resolve_context', ok: true, content: { data: { items: [{ ref: 'private-ref' }] }, diagnostic: 'password=private-embedded-password' } }],
      finalOutput: { memorySummary: '最终记忆总结', secret: 'private-agent-secret' },
      finalOutputMeta: { valueType: 'object', serializedBytes: 20, privatePreview: 'private-final-meta-preview' },
    },
    response: {
      rawResponseText: '{"summary":"模型完整返回","apiKey":"private-raw-key"}', providerResponse: { content: 'API 完整返回', headers: { authorization: 'Bearer private-token' }, debugRequest: { payload: { messages: [{ role: 'user', content: 'private-provider-echo-prompt' }] } } }, parsedResponse: { summary: '解析后的记忆' }, normalizedResponse: { summary: '标准化记忆', apiKey: 'private-response-key' },
      providerResponseMeta: { outcome: 'success', receivedBytes: 20, rawResponse: 'private-meta-response' }, parseMeta: { stage: 'llm.provider.response', outcome: 'success', responseCharCount: 20, candidateText: 'private-parse-candidate' },
    },
  };
}

test('full retention persists complete response and Agent result while stripping request bodies and redacting secrets', () => {
  const stored = buildStoredLog(agentEntry(), 'full');
  assert.ok(stored);
  assert.equal(stored.contentMode, 'full');
  assert.equal(stored.value.request.providerRequestMeta.requestFormat, 'agent_tool_turn');
  assert.equal(stored.value.response.providerResponseMeta.outcome, 'success');
  assert.deepEqual({ callId: stored.value.agent.toolCalls[0].callId, name: stored.value.agent.toolCalls[0].name }, { callId: 'call-1', name: 'entity.resolve_context' });
  assert.equal(stored.value.agent.toolCalls[0].argumentBytes > 0, true);
  assert.equal(stored.value.agent.toolResults[0].resultBytes > 0, true);
  assert.deepEqual(stored.value.agent.toolCalls[0].arguments, { apiKey: '[已脱敏]', query: 'private-query', embedded: '{"access_token":"[已脱敏]"}' });
  assert.deepEqual(stored.value.agent.toolResults[0].content, { data: { items: [{ ref: 'private-ref' }] }, diagnostic: 'password=[已脱敏]' });
  assert.equal(stored.value.agent.finalOutputMeta.serializedBytes > 0, true);
  assert.equal(stored.value.response.rawResponseText, '{"summary":"模型完整返回","apiKey":"[已脱敏]"}');
  assert.equal(stored.value.response.providerResponse.content, 'API 完整返回');
  assert.equal(stored.value.response.providerResponse.debugRequest, '[未记录]');
  assert.equal(stored.value.response.parsedResponse.summary, '解析后的记忆');
  assert.equal(stored.value.response.normalizedResponse.summary, '标准化记忆');
  assert.equal(stored.value.response.normalizedResponse.apiKey, '[已脱敏]');
  assert.equal(stored.value.agent.finalOutput.memorySummary, '最终记忆总结');
  assert.equal(stored.value.agent.finalOutput.secret, '[已脱敏]');
  const serialized = JSON.stringify(stored.value);
  for (const secret of ['private-prompt', 'private-wire-prompt', 'private-provider-echo-prompt', 'private-token', 'private-key', 'private-embedded-token', 'private-embedded-password', 'private-raw-key', 'private-agent-secret', 'private-response-key', 'private-top-level-prompt', 'private-top-level-reply', 'private-meta-request', 'private-meta-response', 'private-parse-candidate', 'private-tool-description', 'private-final-meta-preview']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('summary retention keeps route and failure classification without diagnostic payloads', () => {
  const entry = agentEntry();
  entry.state = 'failed';
  entry.response.failure = { reasonCode: 'RATE_LIMITED', stage: 'llm.provider.http', requestId: 'turn-1', httpStatus: 429, providerKind: 'xai', providerErrorCode: 'rate_limit_exceeded', providerErrorType: 'rate_limit_error' };
  const stored = buildStoredLog(entry, 'summary');
  assert.ok(stored);
  assert.equal(stored.contentMode, 'summary');
  assert.deepEqual(stored.value.response.failure, entry.response.failure);
  assert.equal(stored.value.request.providerRequestMeta, undefined);
  assert.equal(stored.value.response.parsedResponse, undefined);
  assert.equal(stored.value.response.normalizedResponse, undefined);
  assert.equal(stored.value.response.validationIssues, undefined);
  assert.equal(stored.value.agent.finalOutput, undefined);
  assert.equal(stored.value.agent.toolCalls[0].arguments, undefined);
  assert.equal(stored.value.agent.toolResults[0].content, undefined);
  assert.equal(JSON.stringify(stored.value).includes('private-'), false);
});

test('failed-full retention keeps invalid parsed output and safe schema issues without promoting a final result', () => {
  const entry = agentEntry();
  entry.state = 'failed';
  entry.agent.state = 'failed';
  delete entry.agent.finalOutput;
  delete entry.response.normalizedResponse;
  entry.response.parsedResponse = { actorCandidates: [{ ref: 'actor-1' }], apiKey: 'private-invalid-key' };
  entry.response.failure = { reasonCode: 'SCHEMA_VALIDATION_FAILED', stage: 'llm.tools.turn.final_validate', path: '$.actorCandidates[0].displayName', keyword: 'required', expected: 'property to be present' };
  entry.response.validationIssues = [
    { path: '$.actorCandidates[0].displayName', keyword: 'required', expected: 'property to be present' },
    { path: '$.extra', keyword: 'additionalProperties', expected: 'no additional properties' },
  ];
  const stored = buildStoredLog(entry, 'failed-full');
  assert.ok(stored);
  assert.equal(stored.contentMode, 'full');
  assert.equal(stored.value.response.parsedResponse.apiKey, '[已脱敏]');
  assert.deepEqual(stored.value.response.validationIssues, entry.response.validationIssues);
  assert.equal(stored.value.response.normalizedResponse, undefined);
  assert.equal(stored.value.agent.finalOutput, undefined);
  assert.deepEqual(stored.value.agent.toolCalls[0].arguments, { apiKey: '[已脱敏]', query: 'private-query', embedded: '{"access_token":"[已脱敏]"}' });
  assert.deepEqual(stored.value.agent.toolResults[0].content, { data: { items: [{ ref: 'private-ref' }] }, diagnostic: 'password=[已脱敏]' });
  assert.equal(JSON.stringify(stored.value).includes('private-invalid-key'), false);
});

test('disabled logging stores nothing', () => {
  assert.equal(buildStoredLog(agentEntry(), 'off'), null);
});

test('oversized complete response keeps a bounded sanitized head-tail preview', () => {
  const entry = agentEntry();
  entry.response.rawResponseText = `start\napiKey=private-oversized-key\n${'x'.repeat(MAX_SINGLE_LOG_BYTES + 1024)}\nend`;
  const stored = buildStoredLog(entry, 'full');
  assert.ok(stored);
  assert.equal(stored.contentMode, 'summary');
  assert.equal(stored.value.truncated.reason, 'single_record_limit');
  assert.deepEqual(stored.value.truncated.paths, [
    'response.rawResponseText',
    'response.providerResponse',
    'response.parsedResponse',
    'response.normalizedResponse',
    'agent.toolCalls[*].arguments',
    'agent.toolResults[*].content',
    'agent.finalOutput',
    'request.providerRequestMeta',
    'response.providerResponseMeta',
    'response.parseMeta',
  ]);
  assert.equal(stored.value.response.responsePreview.kind, 'truncated_text');
  assert.equal(stored.value.response.responsePreview.prefix.startsWith('start'), true);
  assert.equal(stored.value.response.responsePreview.prefix.includes('[已脱敏]'), true);
  assert.equal(stored.value.response.responsePreview.suffix.endsWith('end'), true);
  assert.equal(stored.value.response.responsePreview.retainedBytes < 512 * 1024, true);
  assert.equal(JSON.stringify(stored.value).includes('private-oversized-key'), false);
  assert.equal(JSON.stringify(stored.value).includes('x'.repeat(100_000)), false);
});

test('provider reasoning is never persisted or returned from legacy stored rows', () => {
  const entry = agentEntry();
  entry.response.rawResponseText = 'data: {"choices":[{"delta":{"content":"visible","reasoning_content":"private-reasoning"}}]}';
  entry.response.providerResponse = {
    content: 'visible',
    reasoning_content: 'private-object-reasoning',
    nested: { thinking: 'private-thinking' },
  };
  const stored = buildStoredLog(entry, 'full');
  assert.ok(stored);
  const serialized = JSON.stringify(stored.value);
  assert.equal(serialized.includes('private-reasoning'), false);
  assert.equal(serialized.includes('private-object-reasoning'), false);
  assert.equal(serialized.includes('private-thinking'), false);
  assert.equal(serialized.includes('visible'), true);

  const legacy = sanitizeStoredLogForRead({
    response: {
      responsePreview: {
        prefix: 'data: {"choices":[{"delta":{"reasoning_content":"legacy-private","content":"safe"}}]}',
        suffix: 'data: {\\"choices\\":[{\\"delta\\":{\\"reasoning_content\\":\\"legacy-escaped-private\\",\\"content\\":null}}]}',
      },
      providerResponse: { reasoning: 'legacy-object-private', content: 'safe' },
    },
  });
  const legacySerialized = JSON.stringify(legacy);
  assert.equal(legacySerialized.includes('legacy-private'), false);
  assert.equal(legacySerialized.includes('legacy-escaped-private'), false);
  assert.equal(legacySerialized.includes('legacy-object-private'), false);
  assert.equal(legacySerialized.includes('safe'), true);
  assert.equal(legacy.response.responsePreview.prefix, 'safe');
  assert.equal(legacy.response.responsePreview.suffix, 'Provider 已返回流式响应，但没有可展示的 assistant content；内部推理与协议字段未记录。');
});
