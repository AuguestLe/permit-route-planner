import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { normalizeFields } from '../server/demo/normalize.js';
import { FIELD_KEYS, CANDIDATE_SCHEMA } from '../server/demo/schema.js';

const validateCandidates = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  validateFormats: false,
}).compile(CANDIDATE_SCHEMA);

const field = (raw) => ({ raw, confidence: null, evidenceQuote: raw });

function rawAll() {
  return {
    permitNumber: field('  DEMO-PERMIT-0001  '),
    plateNumber: field(' DEMO-A0001 '),
    issuingRegion: field(' 示例省 '),
    validFrom: field('2025-01-01'),
    validTo: field('2026年1月1日'),
    length: field('18000 mm'),
    width: field('255 cm'),
    height: field('4 m'),
    weight: field('49 吨'),
    axleCount: field('6 轴'),
    passRoute: field(' 示例路—示例站 '),
  };
}

function assertCandidateShape(candidates) {
  assert.deepEqual(Object.keys(candidates).sort(), [...FIELD_KEYS].sort());
  assert.equal(
    validateCandidates(candidates),
    true,
    JSON.stringify(validateCandidates.errors),
  );
}

test('normalization returns all eleven keys and never mutates the input', () => {
  const raw = rawAll();
  const snapshot = structuredClone(raw);
  const { candidates, errors } = normalizeFields(raw);

  assert.deepEqual(errors, []);
  assert.deepEqual(candidates, {
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
  });
  assertCandidateShape(candidates);
  assert.deepEqual(raw, snapshot);
});

test('normalization accepts a partial map and keeps the eleven-key contract', () => {
  const { candidates, errors } = normalizeFields({ length: { raw: '18.5' } });
  assert.deepEqual(Object.keys(candidates).sort(), [...FIELD_KEYS].sort());
  assert.equal(candidates.length, null);
  assert.ok(errors.some((error) => error.path === '/length' && error.code === 'missing_unit'));

  for (const input of [{}, null, undefined, 'not-a-map', []]) {
    const result = normalizeFields(input);
    assert.deepEqual(Object.keys(result.candidates).sort(), [...FIELD_KEYS].sort());
    assert.deepEqual(result.errors, []);
  }
});

test('dates accept ISO, slashed and Chinese forms and are emitted as ISO days', () => {
  for (const [raw, expected] of [
    ['2025-01-01', '2025-01-01'],
    ['2025/1/31', '2025-01-31'],
    ['2025/12/9', '2025-12-09'],
    ['2024年2月29日', '2024-02-29'],
    ['2025 年 3 月 7 日', '2025-03-07'],
    [' 2026-12-31 ', '2026-12-31'],
  ]) {
    const { candidates, errors } = normalizeFields({ validFrom: field(raw) });
    assert.deepEqual(candidates.validFrom, { value: expected }, raw);
    assert.deepEqual(errors, [], raw);
  }
});

test('dates reject impossible calendar days and unparseable formats deterministically', () => {
  for (const raw of [
    '2025-02-30',
    '2023-02-29',
    '2025-13-01',
    '2025-00-10',
    '2025-01-00',
    '2025/2/30',
    '2025年2月29日',
    '25-01-01',
    '2025-1-1',
    '01/02/2025',
    '2025.01.01',
    'not a date',
  ]) {
    const first = normalizeFields({ validTo: field(raw) });
    const second = normalizeFields({ validTo: field(raw) });
    assert.equal(first.candidates.validTo, null, raw);
    assert.equal(first.errors.length, 1, raw);
    assert.deepEqual(Object.keys(first.errors[0]).sort(), ['code', 'message', 'path']);
    assert.equal(first.errors[0].path, '/validTo');
    assert.equal(first.errors[0].code, 'invalid_date');
    assert.deepEqual(first.errors, second.errors, `${raw} must be deterministic`);
  }
});

test('measurements convert declared units to meters and kilograms', () => {
  const { candidates, errors } = normalizeFields({
    length: field('18000 mm'),
    width: field('255cm'),
    height: field('4.5 m'),
    weight: field('49 吨'),
    permitNumber: field('P-1'),
    validFrom: field('2025-01-01'),
    validTo: field('2026-01-01'),
    plateNumber: field('DEMO-A0001'),
    axleCount: field('6'),
    issuingRegion: field('示例省'),
    passRoute: field('示例路'),
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(candidates.length, { value: 18, unit: 'm' });
  assert.deepEqual(candidates.width, { value: 2.55, unit: 'm' });
  assert.deepEqual(candidates.height, { value: 4.5, unit: 'm' });
  assert.deepEqual(candidates.weight, { value: 49000, unit: 'kg' });
  assertCandidateShape(candidates);

  for (const [raw, expected] of [
    ['49000 kg', 49000],
    ['49000公斤', 49000],
    ['49000 千克', 49000],
    ['49t', 49000],
    ['49 吨', 49000],
  ]) {
    assert.deepEqual(normalizeFields({ weight: field(raw) }).candidates.weight, {
      value: expected,
      unit: 'kg',
    }, raw);
  }
  for (const [raw, expected] of [
    ['18000 毫米', 18],
    ['320厘米', 3.2],
    ['4 米', 4],
  ]) {
    assert.deepEqual(normalizeFields({ length: field(raw) }).candidates.length, {
      value: expected,
      unit: 'm',
    }, raw);
  }
});

test('measurements with missing, unknown or wrong-category units stay null with one deterministic error', () => {
  const cases = [
    ['length', '18.5', 'missing_unit'],
    ['width', '255 ', 'missing_unit'],
    ['height', '4', 'missing_unit'],
    ['weight', '49', 'missing_unit'],
    ['length', '18 km', 'unknown_unit'],
    ['weight', '49 lb', 'unknown_unit'],
    ['length', '49 kg', 'unknown_unit'],
    ['weight', '18 m', 'unknown_unit'],
  ];

  for (const [key, raw, code] of cases) {
    const first = normalizeFields({ [key]: field(raw) });
    const second = normalizeFields({ [key]: field(raw) });
    assert.equal(first.candidates[key], null, `${key}: ${raw}`);
    assert.equal(first.errors.length, 1, `${key}: ${raw}`);
    assert.equal(first.errors[0].path, `/${key}`);
    assert.equal(first.errors[0].code, code, `${key}: ${raw}`);
    assert.deepEqual(first.errors, second.errors, `${key}: ${raw} must be deterministic`);
  }
});

test('measurements never invent a value or unit from malformed raw text', () => {
  for (const raw of ['约 18 米', '十八 m', 'm', '18 m 长', '--1 m', '1,800 mm']) {
    const { candidates, errors } = normalizeFields({ length: field(raw) });
    assert.equal(candidates.length, null, raw);
    assert.equal(errors.length, 1, raw);
    assert.equal(errors[0].path, '/length');
  }
});

test('axle count normalizes only integer raw text', () => {
  for (const [raw, expected] of [['6', 6], [' 6 轴 ', 6], ['12轴', 12], ['-1', -1], ['0', 0], ['+6', 6]]) {
    const { candidates, errors } = normalizeFields({ axleCount: field(raw) });
    assert.deepEqual(candidates.axleCount, { value: expected }, raw);
    assert.deepEqual(errors, [], raw);
  }

  for (const raw of ['6.5', '6.0', '六', '6 轴半', '', 'abc']) {
    const first = normalizeFields({ axleCount: field(raw) });
    const second = normalizeFields({ axleCount: field(raw) });
    assert.equal(first.candidates.axleCount, null, raw);
    assert.equal(first.errors.length, 1, raw);
    assert.equal(first.errors[0].path, '/axleCount');
    assert.equal(first.errors[0].code, raw === '' ? 'empty_value' : 'invalid_axle_count');
    assert.deepEqual(first.errors, second.errors, `${raw} must be deterministic`);
  }
});

test('text fields are trimmed to a candidate and blank text stays null', () => {
  for (const key of ['permitNumber', 'plateNumber', 'issuingRegion', 'passRoute']) {
    assert.deepEqual(
      normalizeFields({ [key]: field('  value-1  ' ) }).candidates[key],
      { value: 'value-1' },
      key,
    );
    assert.equal(normalizeFields({ [key]: field('   ') }).candidates[key], null, key);
    assert.deepEqual(normalizeFields({ [key]: field(' 示 例 省 ') }).candidates[key], { value: '示例省' }, `${key} internal whitespace`);
  }
});

test('missing and null raws produce null candidates without errors and extras are ignored', () => {
  const { candidates, errors } = normalizeFields({
    state: field('approved'),
    length: field(null),
    weight: undefined,
    validFrom: null,
    passRoute: { raw: 123, confidence: 0.5, evidenceQuote: '123' },
  });

  assert.equal(candidates.state, undefined);
  for (const key of ['length', 'weight', 'validFrom']) {
    assert.equal(candidates[key], null, key);
  }
  assert.equal(candidates.passRoute, null);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].path, '/passRoute');
  assert.equal(errors[0].code, 'invalid_raw');
  assertCandidateShape(candidates);
});
