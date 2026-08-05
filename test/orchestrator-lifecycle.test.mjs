import assert from 'node:assert/strict';
import test from 'node:test';

import { RequestOrchestrator } from '../dist/index.js';

function success(record, data = record.taskKey) {
  const now = Date.now();
  return {
    ok: true,
    data,
    meta: {
      requestId: record.requestId,
      resourceId: 'fixture',
      model: 'fixture',
      capabilityKind: record.taskKind,
      queuedAt: record.queuedAt,
      startedAt: record.startedAt,
      finishedAt: now,
      latencyMs: Math.max(0, now - (record.startedAt ?? record.queuedAt)),
    },
  };
}

test('generation requests use the bounded two-request lane without an overlay-close signal', async () => {
  const orchestrator = new RequestOrchestrator();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const executed = [];

  orchestrator.setExecuteCallback(async (record) => {
    executed.push(record.taskKey);
    if (record.taskKey === 'first') await firstGate;
    return success(record);
  });

  const first = orchestrator.enqueue('fixture.consumer', 'first', 'generation');
  const second = orchestrator.enqueue('fixture.consumer', 'second', 'generation');
  await Promise.resolve();

  assert.deepEqual(executed, ['first', 'second']);
  assert.equal(orchestrator.getQueueSnapshot().pending.length, 0);

  releaseFirst();
  assert.equal((await first.resultPromise).ok, true);
  assert.equal((await second.resultPromise).ok, true);
  assert.deepEqual(executed, ['first', 'second']);

  const snapshot = orchestrator.getQueueSnapshot();
  assert.equal(snapshot.active, null);
  assert.deepEqual(snapshot.pending, []);
  assert.deepEqual(snapshot.recentHistory.map((entry) => [entry.taskKey, entry.state]).sort(), [
    ['first', 'completed'],
    ['second', 'completed'],
  ]);
});

test('disposing the orchestrator settles queued work instead of leaving unresolved promises', async () => {
  const orchestrator = new RequestOrchestrator();
  let releaseActive;
  const activeGate = new Promise((resolve) => { releaseActive = resolve; });

  orchestrator.setExecuteCallback(async (record) => {
    await activeGate;
    return success(record);
  });

  const active = orchestrator.enqueue('fixture.consumer', 'active', 'generation');
  const queued = orchestrator.enqueue('fixture.consumer', 'queued', 'generation');
  await Promise.resolve();
  orchestrator.dispose();

  const queuedResult = await queued.resultPromise;
  assert.equal(queuedResult.ok, false);
  assert.equal(queuedResult.reasonCode, 'CANCELLED');

  releaseActive();
  const activeResult = await active.resultPromise;
  assert.equal(activeResult.ok, false);
  assert.equal(activeResult.reasonCode, 'CANCELLED');
});

test('a successful validated result wins over a cancellation arriving after the Provider attempt', async () => {
  const orchestrator = new RequestOrchestrator();
  orchestrator.setExecuteCallback(async (record) => {
    const result = success(record);
    orchestrator.cancel(record.requestId, 'late cancellation');
    return result;
  });

  const request = orchestrator.enqueue('fixture.consumer', 'late-cancel-success', 'generation');
  const result = await request.resultPromise;

  assert.equal(result.ok, true);
  assert.deepEqual(orchestrator.getQueueSnapshot().recentHistory.map((entry) => [entry.taskKey, entry.state]), [
    ['late-cancel-success', 'completed'],
  ]);
});

test('a cancellation before a non-successful result remains cancelled', async () => {
  const orchestrator = new RequestOrchestrator();
  orchestrator.setExecuteCallback(async (record) => {
    orchestrator.cancel(record.requestId, 'active cancellation');
    return {
      ok: false,
      reasonCode: 'CANCELLED',
      retryable: false,
      failure: { reasonCode: 'CANCELLED', stage: 'llm.orchestrator.cancel', requestId: record.requestId },
    };
  });

  const request = orchestrator.enqueue('fixture.consumer', 'active-cancel', 'generation');
  const result = await request.resultPromise;

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'CANCELLED');
  assert.deepEqual(orchestrator.getQueueSnapshot().recentHistory.map((entry) => [entry.taskKey, entry.state]), [
    ['active-cancel', 'cancelled'],
  ]);
});
