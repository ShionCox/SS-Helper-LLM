import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveMaxTokens } from '../dist/index.js';

const args = {
  consumer: 'ss-helper.memory',
  taskKey: 'memory_extract_single',
  taskKind: 'generation',
  input: { messages: [{ role: 'user', content: '测试输入' }] },
  schema: { type: 'object' },
  budget: { maxTokens: 3072 },
};

test('manual output length is authoritative for ordinary and Agent requests', () => {
  assert.deepEqual(resolveMaxTokens(args, {
    globalControl: { mode: 'manual', manualValue: 12288 },
    taskRegisteredMaxTokens: 4096,
    requestBudgetMaxTokens: args.budget.maxTokens,
    profileMaxTokens: 2048,
  }), {
    value: 12288,
    source: 'global_manual',
    detail: { mode: 'manual' },
  });
});

test('inherit mode keeps an explicit consumer request budget without a stage constant', () => {
  assert.deepEqual(resolveMaxTokens(args, {
    globalControl: { mode: 'inherit' },
    requestBudgetMaxTokens: args.budget.maxTokens,
    profileMaxTokens: 2048,
  }), {
    value: 3072,
    source: 'request_budget',
  });
});

test('adaptive memory extraction reserves a 32K thinking/tool budget by default', () => {
  const result = resolveMaxTokens({
    ...args,
    budget: {},
    input: { messages: [{ role: 'user', content: 'x'.repeat(100000) }] },
  }, {
    globalControl: { mode: 'adaptive' },
  });
  assert.equal(result.value, 32768);
  assert.equal(result.source, 'adaptive');
  assert.equal(result.detail.defaultMax, 32768);
});

test('adaptive memory extraction does not lower the output budget for shorter tool or baseline batches', () => {
  const result = resolveMaxTokens({
    ...args,
    budget: {},
    input: { messages: [{ role: 'user', content: 'short batch' }] },
  }, {
    globalControl: { mode: 'adaptive' },
  });
  assert.equal(result.value, 32768);
  assert.equal(result.source, 'adaptive');
});

test('adaptive ordinary tasks keep the conservative 4K output ceiling', () => {
  const result = resolveMaxTokens({
    ...args,
    taskKey: 'memory_cast_plan',
    budget: {},
    input: { messages: [{ role: 'user', content: 'x'.repeat(100000) }] },
  }, {
    globalControl: { mode: 'adaptive' },
  });
  assert.equal(result.value, 4096);
  assert.equal(result.detail.defaultMax, 4096);
});
