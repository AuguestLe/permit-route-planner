import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCandidates } from '../server/demo/validate.js';
import { FIELD_KEYS } from '../server/demo/schema.js';

const REFERENCE_DATE = '2026-11-09';

function validCandidates() {
  return {
    permitNumber: { value: 'SYN-PERMIT-0001' },
    plateNumber: { value: 'SYN-A0001' },
    issuingRegion: { value: '示例省' },
    validFrom: { value: '2026-01-01' },
    validTo: { value: '2026-12-31' },
    length: { value: 18, unit: 'm' },
    width: { value: 2.55, unit: 'm' },
    height: { value: 4, unit: 'm' },
    weight: { value: 49000, unit: 'kg' },
    axleCount: { value: 6 },
    passRoute: { value: '示例路—示例站' },
  };
}

function check(candidates, referenceDate = REFERENCE_DATE) {
  return validateCandidates(candidates, { referenceDate });
}

function hasError(result, path, code) {
  return result.errors.some((error) => error.path === path && error.code === code);
}

test('accepts canonical candidates and enforces date bounds inclusively', () => {
  assert.equal(check(validCandidates()).ok, true);

  const onBothBoundaries = validCandidates();
  onBothBoundaries.validFrom = { value: REFERENCE_DATE };
  onBothBoundaries.validTo = { value: REFERENCE_DATE };
  const result = check(onBothBoundaries);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('rejects each null candidate with a field-level missing_field error', () => {
  const candidates = Object.fromEntries(FIELD_KEYS.map((key) => [key, null]));
  const result = check(candidates);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, FIELD_KEYS.length);
  for (const key of FIELD_KEYS) {
    assert.equal(hasError(result, `/${key}`, 'missing_field'), true, `${key} must be reported`);
  }
  assert.deepEqual(
    result.errors.map((error) => error.path),
    FIELD_KEYS.map((key) => `/${key}`),
  );
});

test('reports a single missing field without flagging the valid ones', () => {
  const candidates = validCandidates();
  candidates.weight = null;
  const result = check(candidates);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(hasError(result, '/weight', 'missing_field'), true);
});

test('rejects permits not yet valid or already expired around referenceDate', () => {
  const notYetValid = validCandidates();
  notYetValid.validFrom = { value: '2026-11-10' };
  const futureResult = check(notYetValid);
  assert.equal(futureResult.ok, false);
  assert.equal(hasError(futureResult, '/validFrom', 'not_yet_valid'), true);

  const expired = validCandidates();
  expired.validTo = { value: '2026-11-08' };
  const expiredResult = check(expired);
  assert.equal(expiredResult.ok, false);
  assert.equal(hasError(expiredResult, '/validTo', 'expired'), true);
});

test('rejects impossible calendar dates for validFrom and validTo before comparing', () => {
  const impossibleDates = ['2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-32'];
  for (const key of ['validFrom', 'validTo']) {
    for (const value of impossibleDates) {
      const candidates = validCandidates();
      candidates[key] = { value };
      const result = check(candidates);
      assert.equal(result.ok, false, `${key}=${value} must fail`);
      assert.equal(hasError(result, `/${key}`, 'invalid_calendar_date'), true);
      assert.equal(hasError(result, `/${key}`, 'not_yet_valid'), false);
      assert.equal(hasError(result, `/${key}`, 'expired'), false);
    }
  }
});

test('accepts a real leap day and rejects non-leap leap days', () => {
  const leap = validCandidates();
  leap.validFrom = { value: '2024-02-29' };
  leap.validTo = { value: '2024-03-01' };
  const leapResult = validateCandidates(leap, { referenceDate: '2024-02-29' });
  assert.equal(leapResult.ok, true);
  assert.deepEqual(leapResult.errors, []);

  for (const value of ['2026-02-29', '2100-02-29']) {
    for (const key of ['validFrom', 'validTo']) {
      const candidates = validCandidates();
      candidates[key] = { value };
      const result = check(candidates);
      assert.equal(result.ok, false, `${key}=${value} must fail`);
      assert.equal(hasError(result, `/${key}`, 'invalid_calendar_date'), true);
    }
  }
});

test('rejects impossible referenceDate values before any date comparison', () => {
  for (const referenceDate of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01']) {
    const result = validateCandidates(validCandidates(), { referenceDate });
    assert.equal(result.ok, false, `referenceDate ${referenceDate} must fail`);
    assert.equal(result.errors.length, 1);
    assert.equal(hasError(result, '/referenceDate', 'invalid_reference_date'), true);
    assert.equal(
      result.errors.some((error) => error.code === 'not_yet_valid' || error.code === 'expired'),
      false,
    );
  }

  const leap = validCandidates();
  leap.validFrom = { value: '2024-01-01' };
  leap.validTo = { value: '2024-12-31' };
  const leapResult = validateCandidates(leap, { referenceDate: '2024-02-29' });
  assert.equal(leapResult.ok, true);
  assert.deepEqual(leapResult.errors, []);
});

test('rejects zero and negative measurements but accepts a tiny positive value', () => {
  for (const key of ['length', 'width', 'height', 'weight']) {
    for (const value of [0, -1]) {
      const candidates = validCandidates();
      candidates[key].value = value;
      const result = check(candidates);
      assert.equal(result.ok, false, `${key}=${value} must fail`);
      assert.equal(hasError(result, `/${key}`, 'non_positive_measurement'), true);
    }
  }

  const tiny = validCandidates();
  tiny.length = { value: 0.001, unit: 'm' };
  assert.equal(check(tiny).ok, true);
});

test('accepts axle counts 1 and 12 and rejects 0, 13 and non-integers', () => {
  for (const value of [1, 12]) {
    const candidates = validCandidates();
    candidates.axleCount = { value };
    assert.equal(check(candidates).ok, true, `axle ${value} must pass`);
  }

  for (const value of [0, 13, -1]) {
    const candidates = validCandidates();
    candidates.axleCount = { value };
    const result = check(candidates);
    assert.equal(result.ok, false, `axle ${value} must fail`);
    assert.equal(hasError(result, '/axleCount', 'axle_out_of_range'), true);
  }

  for (const value of [6.5, '6']) {
    const candidates = validCandidates();
    candidates.axleCount = { value };
    assert.equal(check(candidates).ok, false, `axle ${String(value)} must fail structurally`);
  }
});

test('rejects empty or whitespace-only routes and accepts a normal route', () => {
  for (const value of ['', '   ']) {
    const candidates = validCandidates();
    candidates.passRoute = { value };
    const result = check(candidates);
    assert.equal(result.ok, false);
    assert.equal(hasError(result, '/passRoute', 'empty_route'), true);
  }
  assert.equal(check(validCandidates()).ok, true);
});

test('structural failures surface Ajv paths for missing, extra and mistyped values', () => {
  const missing = validCandidates();
  delete missing.validTo;
  const missingResult = check(missing);
  assert.equal(missingResult.ok, false);
  assert.equal(hasError(missingResult, '/validTo', 'required'), true);

  const extra = { ...validCandidates(), state: 'approved' };
  const extraResult = check(extra);
  assert.equal(extraResult.ok, false);
  assert.equal(hasError(extraResult, '/state', 'additionalProperties'), true);

  const mistyped = validCandidates();
  mistyped.length = { value: '18', unit: 'm' };
  const mistypedResult = check(mistyped);
  assert.equal(mistypedResult.ok, false);
  assert.ok(mistypedResult.errors.some((error) => error.path.startsWith('/length')));

  const wrongUnit = validCandidates();
  wrongUnit.weight = { value: 49000, unit: 'm' };
  const wrongUnitResult = check(wrongUnit);
  assert.equal(wrongUnitResult.ok, false);
  assert.ok(wrongUnitResult.errors.some((error) => error.path.startsWith('/weight')));
});

test('rejects a missing or non-ISO referenceDate instead of guessing', () => {
  for (const referenceDate of [undefined, null, '', '2026/11/09', '2026-1-9', 20261109]) {
    const result = validateCandidates(validCandidates(), { referenceDate });
    assert.equal(result.ok, false, `referenceDate ${String(referenceDate)} must fail`);
    assert.equal(hasError(result, '/referenceDate', 'invalid_reference_date'), true);
  }
  const withoutOptions = validateCandidates(validCandidates());
  assert.equal(withoutOptions.ok, false);
  assert.equal(hasError(withoutOptions, '/referenceDate', 'invalid_reference_date'), true);
});

test('returns errors for non-object candidates without throwing or coercing', () => {
  for (const value of [null, undefined, 'candidates', 42, []]) {
    const result = validateCandidates(value, { referenceDate: REFERENCE_DATE });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
    for (const error of result.errors) {
      assert.equal(typeof error.path, 'string');
      assert.equal(typeof error.code, 'string');
      assert.equal(typeof error.message, 'string');
      assert.deepEqual(Object.keys(error).sort(), ['code', 'message', 'path']);
    }
  }
});

test('never mutates or coerces the candidate snapshot', () => {
  const candidates = validCandidates();
  candidates.length = { value: '18', unit: 'm' };
  const snapshot = structuredClone(candidates);
  const result = check(candidates);
  assert.equal(result.ok, false);
  assert.deepEqual(candidates, snapshot);
});
