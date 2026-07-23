import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonOutput } from '../dist/src/schema/validator.js';

test('accepts one JSON root object after deterministic think and fence cleanup', () => {
  assert.deepEqual(parseJsonOutput('<think>内部推理</think>\n```json\n{"facts":[]}\n```'), {
    ok: true,
    data: { facts: [] },
  });
});

test('rejects multiple JSON roots instead of joining or choosing one', () => {
  const result = parseJsonOutput('{"facts":[]}\n{"facts":[1]}');
  assert.equal(result.ok, false);
});

test('rejects truncated JSON and root arrays', () => {
  assert.equal(parseJsonOutput('{"facts":[').ok, false);
  assert.equal(parseJsonOutput('[{"facts":[]} ]').ok, false);
});
