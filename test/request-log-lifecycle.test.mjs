import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestLogService } from '../dist/index.js';

function record() {
  return {
    llmTaskId: 'task-1',
    consumer: 'ss-helper.memory',
    taskKey: 'memory_capture',
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
    requestLogSnapshot: { taskKind: 'generation' },
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
      error: 'provider failed',
      reasonCode: 'PROVIDER_HTTP_ERROR',
      failure: {
        reasonCode: 'PROVIDER_HTTP_ERROR',
        stage: 'llm.provider.request',
        requestId: 'root-1',
        attemptId: 'attempt-context',
        httpStatus: 415,
        providerKind: 'openai',
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
  });
});

test('queued, running and final updates keep one attempt row and one root request id', async () => {
  const service = new RequestLogService();
  await service.clearLogs();
  const request = record();
  await service.beginAttempt({ record: request, attemptId: 'attempt-1', attemptPhase: 'initial', plannedTransport: 'json_schema' });
  await service.markAttemptRunning({ record: request, attemptId: 'attempt-1', attemptPhase: 'initial', plannedTransport: 'json_schema' });
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
