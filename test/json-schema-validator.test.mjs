import test from 'node:test';
import assert from 'node:assert/strict';
import {
  preflightJsonSchema,
  validateJsonSchema,
  validateJsonSchemaItemized,
} from '../dist/src/schema/json-schema-validator.js';

const captureSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['facts', 'confidence'],
  properties: {
    facts: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'localId'],
        properties: {
          kind: { type: 'string', enum: ['identity', 'event', 'other'] },
          localId: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', minLength: 1, maxLength: 12 },
        },
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

test('validates the complete Memory schema subset without changing values', () => {
  const input = { facts: [{ kind: 'event', localId: 'event-1' }], confidence: 0.8 };
  assert.deepEqual(preflightJsonSchema(captureSchema), { valid: true });
  assert.deepEqual(validateJsonSchema(input, captureSchema), { valid: true });
  assert.deepEqual(input, { facts: [{ kind: 'event', localId: 'event-1' }], confidence: 0.8 });
});

test('rejects enum case changes, numeric strings, duplicates, patterns and extra fields', () => {
  const invalid = {
    facts: [
      { kind: ' Event ', localId: 'bad id' },
      { kind: ' Event ', localId: 'bad id' },
    ],
    confidence: '80%',
    extra: true,
  };
  const result = validateJsonSchema(invalid, captureSchema);
  assert.equal(result.valid, false);
  assert.deepEqual(invalid.confidence, '80%');
  assert.ok(result.issues.some((issue) => issue.path === '$.confidence' && issue.keyword === 'type'));
  assert.ok(result.issues.some((issue) => issue.path === '$.facts' && issue.keyword === 'uniqueItems'));
  assert.ok(result.issues.some((issue) => issue.path === '$.facts[0].kind' && issue.keyword === 'enum'));
  assert.ok(result.issues.some((issue) => issue.path === '$.facts[0].localId' && issue.keyword === 'pattern'));
  assert.ok(result.issues.some((issue) => issue.path === '$.extra' && issue.keyword === 'additionalProperties'));
});

test('preflight rejects unsupported keywords instead of silently ignoring them', () => {
  const result = preflightJsonSchema({ type: 'object', unevaluatedProperties: false });
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues, [{
    path: '$',
    keyword: 'unevaluatedProperties',
    expected: 'a supported SS-Helper JSON Schema keyword',
  }]);
});

test('itemized validation returns valid siblings unchanged and only safe rejection metadata', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['claims'],
    properties: {
      claims: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['localId', 'sourceRef'],
          properties: {
            localId: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
            sourceRef: { type: 'string', enum: ['msg:1', 'msg:2'] },
          },
        },
      },
    },
  };
  const validSibling = { localId: 'claim-1', sourceRef: 'msg:1' };
  const input = {
    claims: [
      validSibling,
      { localId: 'bad id', sourceRef: 'msg:2', secret: 'must-not-leak' },
    ],
  };
  const result = validateJsonSchemaItemized(input, schema, ['claims']);
  assert.equal(result.valid, true);
  assert.deepEqual(result.value, { claims: [validSibling] });
  assert.equal(result.value.claims[0], validSibling);
  assert.deepEqual(result.rejections, [{
    collection: 'claims',
    itemIndex: 1,
    issues: [
      { path: '$.claims[1].secret', keyword: 'additionalProperties', expected: 'property to be absent' },
      { path: '$.claims[1].localId', keyword: 'pattern', expected: '^[A-Za-z0-9_-]+$' },
    ],
    sourceRefs: ['msg:2'],
  }]);
  assert.equal(JSON.stringify(result.rejections).includes('must-not-leak'), false);
});

test('itemized validation treats root and collection constraints as envelope failures', () => {
  const missingCollection = validateJsonSchemaItemized(
    { confidence: 0.7 },
    captureSchema,
    ['facts'],
  );
  assert.equal(missingCollection.valid, false);
  assert.ok(missingCollection.issues.some(issue => issue.path === '$.facts' && issue.keyword === 'required'));

  const tooMany = validateJsonSchemaItemized(
    {
      facts: [
        { kind: 'event', localId: 'a' },
        { kind: 'event', localId: 'b' },
        { kind: 'event', localId: 'c' },
      ],
      confidence: 0.7,
    },
    captureSchema,
    ['facts'],
  );
  assert.equal(tooMany.valid, false);
  assert.ok(tooMany.issues.some(issue => issue.path === '$.facts' && issue.keyword === 'maxItems'));
});

test('itemized rejection source refs must be allowed by the item schema enum', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['claims'],
    properties: {
      claims: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['localId', 'sourceRef'],
          properties: {
            localId: { type: 'string', pattern: '^[A-Z]+$' },
            sourceRef: { type: 'string', enum: ['msg:1'] },
          },
        },
      },
    },
  };
  const result = validateJsonSchemaItemized(
    { claims: [{ localId: 'bad', sourceRef: 'forged:99' }] },
    schema,
    ['claims'],
  );
  assert.equal(result.valid, true);
  assert.deepEqual(result.rejections[0].sourceRefs, []);
});
