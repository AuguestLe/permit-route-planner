import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  FIELD_KEYS,
  TOOL_SCHEMA,
  CANDIDATE_SCHEMA,
  validateToolArguments,
} from '../server/demo/schema.js';

const EXPECTED_KEYS = [
  'permitNumber',
  'plateNumber',
  'issuingRegion',
  'validFrom',
  'validTo',
  'length',
  'width',
  'height',
  'weight',
  'axleCount',
  'passRoute',
];

const emptyField = () => ({ raw: null, confidence: null, evidenceQuote: null });

function makeArgs() {
  return Object.fromEntries(FIELD_KEYS.map((key) => [key, emptyField()]));
}

function validateCandidates() {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
    validateFormats: false,
  });
  return ajv.compile(CANDIDATE_SCHEMA);
}

function hasError(result, expected) {
  return result.errors.some(
    (error) => error.path === expected.path && error.code === expected.code,
  );
}

test('FIELD_KEYS is the frozen list of the eleven existing permit fields', () => {
  assert.deepEqual(FIELD_KEYS, EXPECTED_KEYS);
  assert.equal(new Set(FIELD_KEYS).size, 11);
  assert.ok(Object.isFrozen(FIELD_KEYS));
});

test('tool schemas are plain JSON Schema and compile under Ajv 2020-12', () => {
  assert.equal(TOOL_SCHEMA.type, 'object');
  assert.equal(TOOL_SCHEMA.additionalProperties, false);
  assert.deepEqual(TOOL_SCHEMA.required, FIELD_KEYS);
  assert.deepEqual(Object.keys(TOOL_SCHEMA.properties), FIELD_KEYS);
  assert.equal(CANDIDATE_SCHEMA.type, 'object');
  assert.equal(CANDIDATE_SCHEMA.additionalProperties, false);
  assert.deepEqual(CANDIDATE_SCHEMA.required, FIELD_KEYS);
  for (const schema of [TOOL_SCHEMA, CANDIDATE_SCHEMA]) {
    assert.equal(JSON.parse(JSON.stringify(schema)).type, 'object');
  }
  // strict: true would throw if either schema used unknown or misused keywords.
  assert.equal(typeof validateCandidates(), 'function');
});

test('valid tool arguments accept nulls and concrete values without coercion', () => {
  const allNull = makeArgs();
  const accepted = validateToolArguments(allNull);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.errors, []);

  const populated = Object.fromEntries(FIELD_KEYS.map((key, index) => [
    key,
    { raw: `raw-${index}`, confidence: index % 2 === 0 ? 0 : 1, evidenceQuote: `quote-${index}` },
  ]));
  const populatedResult = validateToolArguments(populated);
  assert.equal(populatedResult.ok, true);
  assert.deepEqual(populatedResult.errors, []);
  assert.deepEqual(populated.length, { raw: 'raw-5', confidence: 1, evidenceQuote: 'quote-5' });
});

test('tool arguments require every one of the eleven fields', () => {
  const args = makeArgs();
  delete args.passRoute;
  const result = validateToolArguments(args);
  assert.equal(result.ok, false);
  assert.equal(hasError(result, { path: '/passRoute', code: 'required' }), true);
  assert.ok(result.errors.some((error) => error.message.includes('passRoute')));
});

test('tool arguments reject extra properties at root and inside fields', () => {
  const withRootExtra = { ...makeArgs(), state: 'approved' };
  const rootResult = validateToolArguments(withRootExtra);
  assert.equal(rootResult.ok, false);
  assert.equal(hasError(rootResult, { path: '/state', code: 'additionalProperties' }), true);

  const args = makeArgs();
  args.length = { raw: '18 m', confidence: 0.9, evidenceQuote: '18 m', normalized: 18 };
  const fieldResult = validateToolArguments(args);
  assert.equal(fieldResult.ok, false);
  assert.equal(hasError(fieldResult, { path: '/length/normalized', code: 'additionalProperties' }), true);
});

test('tool field objects require raw, confidence and evidenceQuote', () => {
  const args = makeArgs();
  args.plateNumber = { confidence: 0.9, evidenceQuote: 'DEMO-A0001' };
  const result = validateToolArguments(args);
  assert.equal(result.ok, false);
  assert.equal(hasError(result, { path: '/plateNumber/raw', code: 'required' }), true);
  assert.ok(result.errors.some((error) => error.message.includes('raw')));
});

test('tool confidence is a nullable number bounded to 0..1', () => {
  for (const confidence of [0, 1, null]) {
    const args = makeArgs();
    args.axleCount = { raw: '6', confidence, evidenceQuote: '6' };
    assert.equal(validateToolArguments(args).ok, true, `confidence ${confidence} must pass`);
  }

  for (const confidence of [-0.01, 1.01, 2, '0.9', true]) {
    const args = makeArgs();
    args.axleCount = { raw: '6', confidence, evidenceQuote: '6' };
    const result = validateToolArguments(args);
    assert.equal(result.ok, false, `confidence ${String(confidence)} must fail`);
    assert.equal(hasError(result, { path: '/axleCount/confidence', code: 'anyOf' }), true);
  }
});

test('tool arguments reject non-string raw and evidenceQuote and task-level null field', () => {
  const badRaw = makeArgs();
  badRaw.permitNumber = { raw: 123, confidence: 0.5, evidenceQuote: '123' };
  assert.equal(validateToolArguments(badRaw).ok, false);

  const badQuote = makeArgs();
  badQuote.permitNumber = { raw: '123', confidence: 0.5, evidenceQuote: ['123'] };
  assert.equal(validateToolArguments(badQuote).ok, false);

  const nullField = makeArgs();
  nullField.length = null;
  assert.equal(validateToolArguments(nullField).ok, false);
});

test('tool validation returns bounded errors and never mutates input', () => {
  const args = { ...makeArgs(), state: 'approved', extra: 1 };
  args.length = { raw: '18 m', confidence: '0.9', evidenceQuote: '18 m' };
  const snapshot = structuredClone(args);
  const result = validateToolArguments(args);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  for (const error of result.errors) {
    assert.equal(typeof error.path, 'string');
    assert.equal(typeof error.code, 'string');
    assert.equal(typeof error.message, 'string');
    assert.deepEqual(Object.keys(error).sort(), ['code', 'message', 'path']);
  }
  assert.deepEqual(args, snapshot, 'validation must not coerce or remove properties');
});

test('tool validation rejects non-object arguments without throwing', () => {
  for (const value of [null, undefined, 'args', 42, [], () => makeArgs()]) {
    assert.equal(validateToolArguments(value).ok, false);
  }
});

test('candidate schema accepts null for all eleven missing fields', () => {
  const candidates = Object.fromEntries(FIELD_KEYS.map((key) => [key, null]));
  assert.equal(validateCandidates()(candidates), true);
});

test('candidate schema accepts canonical values with measurement units and integer axle', () => {
  const validate = validateCandidates();
  const candidates = {
    permitNumber: { value: 'DEMO-PERMIT-0001' },
    plateNumber: { value: 'DEMO-A0001' },
    issuingRegion: { value: '示例省' },
    validFrom: { value: '2025-01-01' },
    validTo: { value: '2026-01-01' },
    length: { value: 18, unit: 'm' },
    width: { value: 2.55, unit: 'm' },
    height: { value: 4, unit: 'm' },
    weight: { value: 49000, unit: 'kg' },
    axleCount: { value: 6 },
    passRoute: { value: '示例路—示例站' },
  };
  assert.equal(validate(candidates), true, JSON.stringify(validate.errors));
});

test('candidate schema requires all fields and rejects extras', () => {
  const validate = validateCandidates();

  const missing = Object.fromEntries(FIELD_KEYS.map((key) => [key, null]));
  delete missing.passRoute;
  assert.equal(validate(missing), false);

  const extra = Object.fromEntries(FIELD_KEYS.map((key) => [key, null]));
  extra.state = { value: 'approved' };
  assert.equal(validate(extra), false);

  const extraField = Object.fromEntries(FIELD_KEYS.map((key) => [key, null]));
  extraField.length = { value: 18, unit: 'm', normalized: 18 };
  assert.equal(validate(extraField), false);
});

test('candidate schema enforces canonical units, numeric values and integer axle', () => {
  const validate = validateCandidates();
  const base = Object.fromEntries(FIELD_KEYS.map((key) => [key, null]));

  const cases = [
    { field: 'length', candidate: { value: 18 }, label: 'length without unit' },
    { field: 'length', candidate: { value: 18, unit: 'cm' }, label: 'length in non-canonical unit' },
    { field: 'length', candidate: { value: '18', unit: 'm' }, label: 'length with string value' },
    { field: 'weight', candidate: { value: 49000, unit: 'm' }, label: 'weight with length unit' },
    { field: 'axleCount', candidate: { value: 6.5 }, label: 'fractional axle' },
    { field: 'axleCount', candidate: { value: '6' }, label: 'string axle' },
    { field: 'validFrom', candidate: { value: '2025/01/01' }, label: 'non-canonical date' },
    { field: 'plateNumber', candidate: { value: 123 }, label: 'non-string plate' },
  ];

  for (const { field, candidate, label } of cases) {
    const value = { ...base, [field]: candidate };
    assert.equal(validate(value), false, `${label} must be rejected`);
  }
});
