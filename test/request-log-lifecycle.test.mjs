import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestLogService } from '../dist/index.js';

function record() {
  return {
    llmTaskId: 'task-1',
    consumer: 'ss-helper.memory',
    consumerDisplayName: '记忆系统',
    taskKey: 'memory_capture',
    taskDescription: '提取单阶段结构化记忆',
    taskKind: 'generation',
    state: 'running',
    validity: { isCancelled: false, isSuperseded: false },
    enqueueOptions: { requestId: 'root-1' },
    requestId: 'root-1',
    activeAttemptRequestId: 'attempt-1',
    activeAttemptPhase: 'initial',
    attemptIndex: 1,
    queuedAt: 10,
    startedAt: 20,
    resultPromise: Promise.resolve(undefined),
    requestLogSnapshot: {
      taskKind: 'generation', schemaHash: 'schema-a',
      generationInput: { messages: [{ role: 'user', content: '不得写入日志的输入正文' }] },
      providerRequest: { requestFormat: 'openai_generation', payload: { model: 'model-a', messages: [{ role: 'user', content: '不得写入日志的发送正文' }], temperature: 0.3, max_tokens: 2048 } },
      metrics: { messageCount: 1, inputCharCount: 12, outputCharCount: 8 },
    },
    routeSnapshot: { resourceId: 'resource-a', resourceLabel: '测试资源', model: 'model-a', providerKind: 'openai', apiType: 'openai', endpointOrigin: 'https://relay.invalid', endpointPath: '/v1', streaming: true },
    workflow: { workflowId: 'workflow-1', workflowLabel: '初始化记忆', workflowKind: 'agent', jobId: 'job-1', batchIndex: 0, batchCount: 2 },
  };
}

test('queued persistence falls back to the bounded in-memory log when Workspace is unavailable', async () => {
  const service = new RequestLogService({
    async saveLog() { throw new Error('workspace offline'); },
  });
  await service.clearLogs();
  await service.beginAttempt({ record: record(), attemptId: 'attempt-1', attemptPhase: 'initial', plannedTransport: 'json_schema' });
  const rows = await service.listLogs();
  assert.equal(rows.find((row) => row.logId === 'attempt-1')?.state, 'queued');
});

test('Workspace fallback keeps configured off and summary retention modes', async () => {
  const disabled = new RequestLogService({
    async saveLog() { throw new Error('workspace offline'); },
    async loadSettings() { return { requestLogging: { enabled: false } }; },
  });
  await disabled.clearLogs();
  await disabled.beginAttempt({ record: record(), attemptId: 'attempt-off', attemptPhase: 'initial', plannedTransport: 'json_schema' });
  assert.equal((await disabled.listLogs()).some((row) => row.logId === 'attempt-off'), false);

  const summary = new RequestLogService({
    async saveLog() { throw new Error('workspace offline'); },
    async loadSettings() { return { requestLogging: { enabled: true, detailMode: 'summary', maxEntries: 20, retentionDays: 30, maxBytes: 1024 * 1024 } }; },
  });
  await summary.clearLogs();
  await summary.recordAgentTurn({
    request: { task: 'memory_extract_entities', pipelineRunId: 'pipeline-summary', chatKey: 'chat-1' },
    response: {
      requestId: 'turn-summary', state: 'tool_calls', toolSessionId: 'session-summary',
      calls: [{ callId: 'call-summary', name: 'entity.resolve_context', arguments: { mentions: ['不应保留'] } }],
      route: { route: 'resource-a', provider: 'openai', model: 'model-a' },
      diagnostics: { toolSessionRound: 1, totalCalls: 1, toolSchemaProfile: 'ss_helper_tool_v0', providerAdapterVersion: 2, capabilitySnapshotId: 'capability-1' },
    },
    callerPluginId: 'ss-helper.memory', taskDescription: '解析人物与地点实体', requestId: 'turn-summary', startedAt: Date.now(), finishedAt: Date.now(),
  });
  const [row] = await summary.listLogs({ workflowId: 'pipeline-summary' });
  assert.equal(row.contentMode, 'summary');
  assert.equal(row.agent.toolCalls[0].arguments, undefined);
  assert.equal(JSON.stringify(row).includes('不应保留'), false);
});

test('terminal attempt persistence failures never discard an already successful result', async () => {
  const service = new RequestLogService({
    async saveLog() { throw new Error('workspace offline'); },
  });
  await service.clearLogs();
  await service.recordAttempt({
    record: record(),
    requestId: 'attempt-1',
    result: { ok: true, data: { value: 'ok' }, meta: { requestId: 'root-1', resourceId: 'provider', capabilityKind: 'generation', queuedAt: 10 } },
    attemptTag: '初次请求',
    attemptOutcome: '成功',
    attemptPhase: 'initial',
    isFinalAttempt: true,
  });
  const rows = await service.listLogs();
  assert.equal(rows.find((row) => row.logId === 'attempt-1')?.state, 'completed');
});

test('cancelled attempt persistence failures remain diagnostic-only', async () => {
  const service = new RequestLogService({
    async saveLog() { throw new Error('workspace offline'); },
  });
  await service.clearLogs();
  const request = record();
  request.state = 'cancelled';
  request.finishedAt = 30;
  request.validity.isCancelled = true;
  await service.archiveRecord(request);
  const rows = await service.listLogs();
  assert.equal(rows.find((row) => row.logId === 'attempt-1')?.state, 'cancelled');
});

test('preserves a provider failure context instead of rebuilding a generic request-stage error', async () => {
  const service = new RequestLogService();
  await service.clearLogs();
  await service.recordAttempt({
    record: record(),
    requestId: 'attempt-context',
    result: {
      ok: false,
      reasonCode: 'PROVIDER_HTTP_ERROR',
      failure: {
        reasonCode: 'PROVIDER_HTTP_ERROR',
        stage: 'llm.provider.request',
        requestId: 'root-1',
        attemptId: 'attempt-context',
        httpStatus: 415,
        providerKind: 'openai',
        providerErrorCode: 'unsupported_media_type',
        providerErrorType: 'invalid_request_error',
        providerErrorParam: 'content_type',
      },
    },
    attemptTag: '初次请求',
    attemptOutcome: '失败',
    attemptPhase: 'initial',
    isFinalAttempt: true,
  });
  const row = (await service.listLogs()).find((entry) => entry.logId === 'attempt-context');
  assert.deepEqual(row?.response.failure, {
    reasonCode: 'PROVIDER_HTTP_ERROR',
    stage: 'llm.provider.request',
    requestId: 'root-1',
    attemptId: 'attempt-context',
    httpStatus: 415,
    providerKind: 'openai',
    providerErrorCode: 'unsupported_media_type',
    providerErrorType: 'invalid_request_error',
    providerErrorParam: 'content_type',
  });
  assert.deepEqual({ ...row.response.providerResponseMeta, receivedAt: undefined }, {
    outcome: 'http_error', httpStatus: 415, streamed: true, receivedAt: undefined,
    providerErrorCode: 'unsupported_media_type', providerErrorType: 'invalid_request_error', providerErrorParam: 'content_type',
  });
  assert.equal(row.response.providerResponseMeta.receivedAt > 0, true);
});

test('failed results without a recognized reason can never produce successful diagnostic metadata', async () => {
  const service = new RequestLogService();
  await service.clearLogs();
  await service.recordAttempt({
    record: record(),
    requestId: 'attempt-unknown-failure',
    result: {
      ok: false,
      reasonCode: 'NON_STANDARD_FAILURE',
    },
    attemptTag: '初次请求',
    attemptOutcome: '失败',
    attemptPhase: 'initial',
    isFinalAttempt: true,
  });
  const row = (await service.listLogs()).find((entry) => entry.logId === 'attempt-unknown-failure');
  assert.equal(row?.state, 'failed');
  assert.equal(row?.response.failure?.reasonCode, 'INTERNAL_ERROR');
  assert.equal(row?.response.failure?.stage, 'llm.request');
  assert.equal(row?.response.providerResponseMeta?.outcome, 'unknown_error');
  assert.equal(row?.response.parseMeta?.outcome, 'not_applicable');
});

test('queued, running and final updates keep one attempt row and one root request id', async () => {
  const service = new RequestLogService();
  await service.clearLogs();
  const request = record();
  await service.beginAttempt({ record: request, attemptId: 'attempt-1', attemptPhase: 'initial', plannedTransport: 'json_schema' });
  await service.markAttemptRunning({ record: request, attemptId: 'attempt-1', attemptPhase: 'initial', plannedTransport: 'json_schema' });
  request.debug = {
    rawResponseText: '{"summary":"模型完整返回"}',
    providerResponse: { content: 'API 完整返回', diagnostics: { httpStatus: 200, contentType: 'application/json', receivedBytes: 321, streamed: true, streamEventCount: 3, receivedAt: 25 } },
    parsedResponse: { summary: '解析后的记忆' },
    normalizedResponse: { summary: '标准化记忆' },
  };
  await service.recordAttempt({
    record: request,
    requestId: 'attempt-1',
    result: { ok: true, data: { value: 'ok' }, meta: { requestId: 'root-1', resourceId: 'provider', capabilityKind: 'generation', queuedAt: 10 } },
    attemptTag: '初次请求',
    attemptOutcome: '成功',
    attemptPhase: 'initial',
    plannedTransport: 'json_schema',
    actualTransport: 'json_schema',
    isFinalAttempt: true,
  });
  const rows = await service.listLogs();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].request.providerRequestMeta, {
    requestFormat: 'openai_generation', operation: 'generation', method: 'POST', providerKind: 'openai', apiType: 'openai',
    resourceId: 'resource-a', model: 'model-a', endpointOrigin: 'https://relay.invalid', endpointPath: '/v1',
    headerNames: ['authorization', 'content-type'], authScheme: 'bearer', streaming: true, idleTimeoutMs: 30000, sentAt: 20,
    messageCount: 1, messageRoles: ['user'], inputCharCount: 12, schemaHash: 'schema-a', structuredTransport: 'json_schema',
    maxTokens: 2048, temperature: 0.3, payloadBytes: rows[0].request.providerRequestMeta.payloadBytes,
  });
  assert.equal(JSON.stringify(rows[0]).includes('不得写入日志'), false);
  assert.equal(rows[0].response.rawResponseText, '{"summary":"模型完整返回"}');
  assert.equal(rows[0].response.providerResponse.content, 'API 完整返回');
  assert.equal(rows[0].response.parsedResponse.summary, '解析后的记忆');
  assert.equal(rows[0].response.normalizedResponse.summary, '标准化记忆');
  assert.deepEqual(rows[0].response.providerResponseMeta, {
    outcome: 'success', httpStatus: 200, contentType: 'application/json', receivedBytes: 321, streamed: true,
    streamEventCount: 3, receivedAt: 25,
  });
  assert.deepEqual(rows[0].response.parseMeta, { stage: 'llm.provider.response', outcome: 'success', responseCharCount: 8, candidateJsonCount: 1, parsedRootType: 'object' });
  assert.deepEqual({
    logId: rows[0].logId,
    requestId: rows[0].requestId,
    attemptId: rows[0].attemptId,
    state: rows[0].state,
    phase: rows[0].attemptPhase,
  }, {
    logId: 'attempt-1',
    requestId: 'root-1',
    attemptId: 'attempt-1',
    state: 'completed',
    phase: 'initial',
  });
});

test('cancelling an active attempt terminalizes its existing row without adding a duplicate', async () => {
  const service = new RequestLogService();
  await service.clearLogs();
  const request = record();
  await service.beginAttempt({ record: request, attemptId: 'attempt-1', attemptPhase: 'initial', plannedTransport: 'json_schema' });
  await service.markAttemptRunning({ record: request, attemptId: 'attempt-1', attemptPhase: 'initial', plannedTransport: 'json_schema' });
  request.state = 'cancelled';
  request.finishedAt = 30;
  request.validity.isCancelled = true;
  await service.archiveRecord(request);

  const rows = await service.listLogs();
  assert.equal(rows.length, 1);
  assert.deepEqual({
    logId: rows[0].logId,
    requestId: rows[0].requestId,
    attemptId: rows[0].attemptId,
    state: rows[0].state,
  }, {
    logId: 'attempt-1',
    requestId: 'root-1',
    attemptId: 'attempt-1',
    state: 'cancelled',
  });
});

test('persists failures that happen before any provider attempt with Chinese purpose and route metadata', async () => {
  const service = new RequestLogService();
  await service.clearLogs();
  const request = record();
  request.activeAttemptRequestId = undefined;
  await service.recordUnattemptedRequest(request, {
    ok: false,
    reasonCode: 'LLM_CAPABILITY_UNAVAILABLE',
    failure: { reasonCode: 'LLM_CAPABILITY_UNAVAILABLE', stage: 'llm.route.resolve', requestId: 'root-1' },
  });
  const [row] = await service.listLogs();
  assert.equal(row.entryKind, 'provider_attempt');
  assert.equal(row.taskDescription, '提取单阶段结构化记忆');
  assert.equal(row.consumerDisplayName, '记忆系统');
  assert.deepEqual([row.resourceLabel, row.model, row.providerKind], ['测试资源', 'model-a', 'openai']);
  assert.equal(row.response.failure.reasonCode, 'LLM_CAPABILITY_UNAVAILABLE');
});

test('stores Agent model turns as workflow children and pairs tool calls with later results', async () => {
  const service = new RequestLogService();
  await service.clearLogs();
  const trace = {
    workflowId: 'pipeline-1', workflowLabel: '初始化记忆', workflowKind: 'agent',
    jobId: 'job-1', batchIndex: 0, batchCount: 2, stageKey: 'memory_extract_entities', stageDescription: '解析人物与地点实体',
  };
  const baseRequest = {
    task: 'memory_extract_entities', pipelineRunId: 'pipeline-1', chatKey: 'chat-1', input: { sourceCount: 2 }, trace,
    tools: [{ name: 'entity.resolve_context', description: '解析当前批次中的人物与地点短引用', parameters: {} }],
  };
  await service.recordAgentTurn({
    request: baseRequest,
    response: {
      requestId: 'turn-1', state: 'tool_calls', toolSessionId: 'session-1',
      calls: [{ callId: 'call-1', name: 'entity.resolve_context', arguments: { mentions: ['紫罗'], apiKey: 'private-tool-key' } }],
      route: { route: 'resource-a', provider: 'openai', model: 'model-a' },
      diagnostics: { toolSessionRound: 1, totalCalls: 1, toolSchemaProfile: 'ss_helper_tool_v0', providerAdapterVersion: 2, capabilitySnapshotId: 'capability-1' },
    },
    callerPluginId: 'ss-helper.memory', consumerDisplayName: '记忆系统', taskDescription: '解析人物与地点实体', requestId: 'turn-1', startedAt: 10, finishedAt: 20,
  });
  await service.recordAgentTurn({
    request: { ...baseRequest, toolSessionId: 'session-1', toolResults: [{ callId: 'call-1', name: 'entity.resolve_context', ok: true, content: { data: { items: [{ ref: 'A01' }] }, authorization: 'Bearer private-tool-token' } }] },
    response: {
      requestId: 'turn-2', state: 'final', output: { actorCandidates: [] },
      route: { route: 'resource-a', provider: 'openai', model: 'model-a' },
      diagnostics: { toolSessionRound: 2, totalCalls: 1, toolSchemaProfile: 'ss_helper_tool_v0', providerAdapterVersion: 2, capabilitySnapshotId: 'capability-1' },
    },
    callerPluginId: 'ss-helper.memory', consumerDisplayName: '记忆系统', taskDescription: '解析人物与地点实体', requestId: 'turn-2', startedAt: 21, finishedAt: 30,
  });
  const rows = (await service.listLogs({ workflowId: 'pipeline-1', entryKind: 'agent_turn' })).sort((a, b) => a.attemptIndex - b.attemptIndex);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => [row.entryKind, row.attemptIndex, row.agent.state]), [
    ['agent_turn', 1, 'tool_calls'],
    ['agent_turn', 2, 'final'],
  ]);
  assert.equal(rows[0].agent.toolCalls[0].callId, rows[1].agent.toolResults[0].callId);
  assert.ok(rows[0].agent.toolCalls[0].argumentBytes > 0);
  assert.ok(rows[1].agent.toolResults[0].resultBytes > 0);
  assert.deepEqual(rows[0].agent.toolCalls[0].arguments, { mentions: ['紫罗'], apiKey: '[已脱敏]' });
  assert.deepEqual(rows[1].agent.toolResults[0].content, { data: { items: [{ ref: 'A01' }] }, authorization: '[已脱敏]' });
  assert.equal(rows[0].agent.toolDescriptions, undefined);
  assert.deepEqual(rows[1].agent.finalOutputMeta, { valueType: 'object', serializedBytes: 22, keyCount: 1 });
  assert.deepEqual(rows[1].agent.finalOutput, { actorCandidates: [] });
  assert.deepEqual(rows[1].response.parsedResponse, { actorCandidates: [] });
  assert.deepEqual(rows[1].response.normalizedResponse, { actorCandidates: [] });
  assert.equal(JSON.stringify(rows).includes('紫罗'), true);
  assert.equal(JSON.stringify(rows).includes('A01'), true);
  assert.equal(JSON.stringify(rows).includes('private-tool-'), false);
});

test('Agent schema failure keeps the last parsed output and all safe validation issues on one terminal row', async () => {
  const service = new RequestLogService();
  await service.clearLogs();
  const request = {
    task: 'memory_extract_entities', pipelineRunId: 'pipeline-invalid', chatKey: 'chat-1',
    trace: { workflowId: 'pipeline-invalid', workflowLabel: '初始化记忆', workflowKind: 'agent', stageKey: 'memory_extract_entities' },
  };
  await service.recordAgentTurn({
    phase: 'started', request, callerPluginId: 'ss-helper.memory', taskDescription: '解析人物与地点实体',
    requestId: 'turn-invalid', toolSessionRound: 1, startedAt: 10,
  });
  const validationIssues = [
    { path: '$.actorCandidates[0].displayName', keyword: 'required', expected: 'property to be present' },
    { path: '$.extra', keyword: 'additionalProperties', expected: 'no additional properties' },
  ];
  await service.recordAgentTurn({
    request,
    failure: { reasonCode: 'SCHEMA_VALIDATION_FAILED', stage: 'llm.tools.turn.final_validate', requestId: 'turn-invalid', path: validationIssues[0].path, keyword: validationIssues[0].keyword, expected: validationIssues[0].expected },
    parsedResponse: { actorCandidates: [{ ref: 'actor-1' }], extra: true },
    validationIssues,
    callerPluginId: 'ss-helper.memory', taskDescription: '解析人物与地点实体', requestId: 'turn-invalid',
    toolSessionRound: 1, startedAt: 10, finishedAt: 20,
  });
  const rows = await service.listLogs({ workflowId: 'pipeline-invalid' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'failed');
  assert.equal(rows[0].agent.state, 'failed');
  assert.deepEqual(rows[0].response.parsedResponse, { actorCandidates: [{ ref: 'actor-1' }], extra: true });
  assert.deepEqual(rows[0].response.validationIssues, validationIssues);
  assert.equal(rows[0].response.normalizedResponse, undefined);
  assert.equal(rows[0].agent.finalOutput, undefined);
});

test('Agent turn persists safe request metadata before Provider I/O and terminalizes the same row after failure', async () => {
  const service = new RequestLogService();
  await service.clearLogs();
  const request = {
    task: 'memory_extract_entities', pipelineRunId: 'pipeline-start', chatKey: 'chat-1',
    input: { messages: [{ role: 'user', content: 'private-agent-prompt' }] },
    trace: { workflowId: 'pipeline-start', workflowLabel: '初始化记忆', workflowKind: 'agent' },
  };
  const route = {
    resourceId: 'resource-a', resourceLabel: 'Agent 资源', model: 'model-a', providerKind: 'openai', apiType: 'openai',
    endpointOrigin: 'https://relay.invalid', endpointPath: '/v1/chat/completions', streaming: true,
  };
  await service.recordAgentTurn({
    phase: 'started', request, callerPluginId: 'ss-helper.memory', taskDescription: '解析人物与地点实体',
    requestId: 'turn-start', route, toolSessionRound: 1, startedAt: 10,
  });
  let rows = await service.listLogs({ workflowId: 'pipeline-start' });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].state, rows[0].agent, rows[0].request.providerRequestMeta.endpointPath], ['running', undefined, '/v1/chat/completions']);
  assert.equal(JSON.stringify(rows).includes('private-agent-prompt'), false);

  await service.recordAgentTurn({
    request, failure: { reasonCode: 'RATE_LIMITED', stage: 'llm.provider.http', requestId: 'turn-start', httpStatus: 429, providerErrorCode: 'rate_limit_exceeded' },
    callerPluginId: 'ss-helper.memory', taskDescription: '解析人物与地点实体', requestId: 'turn-start', route,
    toolSessionRound: 1, startedAt: 10, finishedAt: 20,
  });
  rows = await service.listLogs({ workflowId: 'pipeline-start' });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].state, rows[0].response.providerResponseMeta.httpStatus, rows[0].response.providerResponseMeta.providerErrorCode], ['failed', 429, 'rate_limit_exceeded']);
});

test('Agent protocol failure retains the sanitized incomplete response under the full log policy', async () => {
  const service = new RequestLogService();
  await service.clearLogs();
  await service.recordAgentTurn({
    request: {
      task: 'memory_extract_single', pipelineRunId: 'pipeline-protocol', chatKey: 'chat-1',
      trace: { workflowId: 'pipeline-protocol', workflowLabel: '初始化记忆', workflowKind: 'agent' },
    },
    failure: { reasonCode: 'HTTP_RESPONSE_PROTOCOL_INVALID', stage: 'llm.bridge.http.response', requestId: 'turn-protocol', httpStatus: 200 },
    rawResponseText: 'data: {"summary":"partial","apiKey":"private-response-key"',
    providerResponse: { incomplete: true, diagnostics: { httpStatus: 200, contentType: 'text/event-stream', receivedBytes: 61 } },
    callerPluginId: 'ss-helper.memory', taskDescription: '单阶段结构化记忆提取', requestId: 'turn-protocol',
    toolSessionRound: 1, startedAt: 10, finishedAt: 20,
  });
  const row = (await service.listLogs({ workflowId: 'pipeline-protocol' }))[0];
  assert.equal(row.response.providerResponseMeta.outcome, 'protocol_error');
  assert.equal(row.response.providerResponseMeta.receivedBytes > 0, true);
  assert.equal(row.response.parseMeta.outcome, 'protocol_error');
  assert.equal(row.response.providerResponse.incomplete, true);
  assert.equal(row.response.rawResponseText.includes('private-response-key'), false);
  assert.equal(row.response.rawResponseText, 'Provider 已返回流式响应，但没有可展示的 assistant content；内部推理与协议字段未记录。');
});

test('callScope returns Agent workflows while ordinary excludes them', async () => {
  const service = new RequestLogService();
  await service.clearLogs();
  const ordinary = record(); ordinary.workflow = undefined; ordinary.activeAttemptRequestId = 'ordinary-1';
  await service.recordAttempt({ record: ordinary, requestId: 'ordinary-1', result: { ok: true, data: {}, meta: { requestId: 'ordinary-1', resourceId: 'resource-a', capabilityKind: 'generation', queuedAt: 10 } }, attemptTag: '初次请求', attemptOutcome: '成功', isFinalAttempt: true });
  const traced = record(); traced.workflow = { workflowId: 'agent-1', workflowLabel: 'agent', workflowKind: 'agent' }; traced.activeAttemptRequestId = 'agent-1-provider';
  await service.recordAttempt({ record: traced, requestId: traced.activeAttemptRequestId, result: { ok: true, data: {}, meta: { requestId: traced.activeAttemptRequestId, resourceId: 'resource-a', capabilityKind: 'generation', queuedAt: 10 } }, attemptTag: '初次请求', attemptOutcome: '成功', isFinalAttempt: true });
  assert.deepEqual((await service.listLogs({ callScope: 'ordinary' })).map(row => row.logId), ['ordinary-1']);
  assert.deepEqual(new Set((await service.listLogs({ callScope: 'agent_workflow' })).map(row => row.workflow.workflowKind)), new Set(['agent']));
});

test('records an aborted third Agent turn with its real round and cancellation state', async () => {
  const service = new RequestLogService();
  await service.clearLogs();
  await service.recordAgentTurn({
    request: {
      task: 'memory_extract_content', pipelineRunId: 'pipeline-abort', chatKey: 'chat-1',
      toolSessionId: 'session-1', toolResults: [{ callId: 'call-2', name: 'inventory.resolve_context', ok: true, content: {} }],
    },
    failure: { reasonCode: 'REQUEST_ABORTED', stage: 'llm.tools.turn', requestId: 'turn-3' },
    callerPluginId: 'ss-helper.memory', taskDescription: '提取物品与库存变化', requestId: 'turn-3',
    toolSessionRound: 3, startedAt: 30, finishedAt: 35,
  });
  const row = (await service.listLogs()).find((entry) => entry.logId === 'turn-3');
  assert.deepEqual({ state: row.state, agentState: row.agent.state, round: row.agent.toolSessionRound, outcome: row.attemptOutcome }, {
    state: 'cancelled', agentState: 'cancelled', round: 3, outcome: '取消',
  });
});
