import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeJsonSchemaEnumFallbacks,
  validateJsonSchema,
} from '../dist/src/schema/json-schema-validator.js';

const captureSchema = {
  type: 'object',
  required: ['facts', 'status'],
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind'],
        properties: {
          kind: {
            type: 'string',
            enum: ['identity', 'event', 'other'],
          },
        },
      },
    },
    status: {
      type: 'string',
      enum: ['confirmed', 'pending', 'unknown'],
    },
  },
};

test('normalizes case-only enum deviations to the canonical schema spelling', () => {
  const input = { facts: [{ kind: ' Event ' }], status: 'pending' };
  const normalized = normalizeJsonSchemaEnumFallbacks(input, captureSchema);

  assert.deepEqual(normalized.data, { facts: [{ kind: 'event' }], status: 'pending' });
  assert.deepEqual(normalized.repairs, [{
    path: '$.facts[0].kind',
    from: ' Event ',
    to: 'event',
    reason: 'case_normalized',
  }]);
  assert.deepEqual(input, { facts: [{ kind: ' Event ' }], status: 'pending' });
  assert.deepEqual(validateJsonSchema(normalized.data, captureSchema), { valid: true });
});

test('keeps an unknown enum strict even when the schema explicitly provides other', () => {
  const input = { facts: [{ kind: 'action' }], status: 'pending' };
  const normalized = normalizeJsonSchemaEnumFallbacks(input, captureSchema);

  assert.equal(normalized.data, input);
  assert.deepEqual(normalized.repairs, []);
  assert.deepEqual(validateJsonSchema(normalized.data, captureSchema), {
    valid: false,
    errors: ['$.facts[0].kind: value is not in enum (allowed: "identity"|"event"|"other")'],
  });
});

test('keeps enums without an explicit other fallback strict and improves diagnostics', () => {
  const input = { facts: [{ kind: 'event' }], status: 'approved' };
  const normalized = normalizeJsonSchemaEnumFallbacks(input, captureSchema);

  assert.equal(normalized.data, input);
  assert.deepEqual(normalized.repairs, []);
  assert.deepEqual(validateJsonSchema(normalized.data, captureSchema), {
    valid: false,
    errors: ['$.status: value is not in enum (allowed: "confirmed"|"pending"|"unknown")'],
  });
});
