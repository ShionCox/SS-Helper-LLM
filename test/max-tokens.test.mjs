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
