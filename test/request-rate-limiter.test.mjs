import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestRateLimiter } from '../dist/index.js';

test('global request limiter is disabled at zero and spaces enabled request starts', async () => {
  const limiter = new RequestRateLimiter();
  assert.equal(limiter.getMaxRequestsPerMinute(), 0);
  await limiter.acquire();

  limiter.setMaxRequestsPerMinute(6_000);
  const startedAt = Date.now();
  await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
  assert.equal(limiter.getMaxRequestsPerMinute(), 6_000);
  assert.ok(Date.now() - startedAt >= 15, 'three 10 ms slots should not start as one burst');
});

test('queued request rate waits preserve structured abort diagnostics', async () => {
  const limiter = new RequestRateLimiter();
  limiter.setMaxRequestsPerMinute(60);
  await limiter.acquire();
  const controller = new AbortController();
  const pending = limiter.acquire(controller.signal, 'request-rate-test');
  controller.abort();
  await assert.rejects(pending, (error) => error?.details?.reasonCode === 'REQUEST_ABORTED'
    && error?.details?.stage === 'llm.rate_limit.wait'
    && error?.details?.requestId === 'request-rate-test');
});
