import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonOutput } from '../dist/src/schema/validator.js';

test('rejects think text and Markdown fences instead of silently cleaning them', () => {
  assert.equal(parseJsonOutput('<think>内部推理</think>\n```json\n{"facts":[]}\n```').ok, false);
  assert.deepEqual(parseJsonOutput('{"facts":[]}'), { ok: true, data: { facts: [] } });
});

test('rejects multiple JSON roots instead of joining or choosing one', () => {
  const result = parseJsonOutput('{"facts":[]}\n{"facts":[1]}');
  assert.equal(result.ok, false);
});

test('rejects truncated JSON and root arrays', () => {
  assert.equal(parseJsonOutput('{"facts":[').ok, false);
  assert.equal(parseJsonOutput('[{"facts":[]} ]').ok, false);
});
