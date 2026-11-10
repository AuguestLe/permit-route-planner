import { FIELD_KEYS } from './schema.js';

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function same(actual, expected) {
  return stable(actual) === stable(expected);
}

function nearestRank(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index];
}

export function computeMetrics(results) {
  const total = results.length;
  const fields = {};
  let allCorrectDocuments = 0;
  let autoApproved = 0;
  let autoCorrect = 0;
  for (const key of FIELD_KEYS) {
    fields[key] = { applicable: 0, correct: 0, predictedMissing: 0, wrong: 0, unexpected: 0, nullExpected: 0, nullCorrect: 0 };
  }
  for (const result of results) {
    const expected = result.expectedCandidates ?? {};
    const actual = Object.fromEntries(FIELD_KEYS.map(key => [key, result.fields?.[key]?.candidate ?? null]));
    let documentCorrect = true;
    for (const key of FIELD_KEYS) {
      const field = fields[key];
      const expectedValue = expected[key] ?? null;
      const actualValue = actual[key];
      if (expectedValue === null) {
        field.nullExpected += 1;
        if (actualValue === null) field.nullCorrect += 1;
        else field.unexpected += 1;
      } else {
        field.applicable += 1;
        if (same(actualValue, expectedValue)) field.correct += 1;
        else if (actualValue === null) field.predictedMissing += 1;
        else field.wrong += 1;
      }
      if (!same(actualValue, expectedValue)) documentCorrect = false;
    }
    if (documentCorrect) allCorrectDocuments += 1;
    const action = result.decision?.action;
    if (action === 'auto_approved') {
      autoApproved += 1;
      if (documentCorrect && result.expectedValid === true) autoCorrect += 1;
    }
  }
  for (const field of Object.values(fields)) {
    field.accuracy = field.applicable ? field.correct / field.applicable : null;
    field.nullAccuracy = field.nullExpected ? field.nullCorrect / field.nullExpected : null;
  }
  const applicable = Object.values(fields).reduce((sum, field) => sum + field.applicable, 0);
  const correct = Object.values(fields).reduce((sum, field) => sum + field.correct, 0);
  const measured = Object.values(fields).map(field => field.accuracy).filter(value => value !== null);
  const decisionMatches = results.filter(result => (result.validation?.ok === true) === (result.expectedValid === true)).length;
  const reviewCount = results.filter(result => result.decision?.action === 'review_required').length;
  const rejectCount = results.filter(result => result.decision?.action === 'rejected').length;
  const fallbackCount = results.filter(result => result.fallbackUsed === true).length;
  const latencies = results.map(result => result.timings?.totalMs).filter(Number.isFinite);
  const modelCalls = results.reduce((sum, result) => sum + (result.trace ?? []).filter(entry => entry.stage === 'vision-request' || entry.stage === 'vision-repair').length, 0);
  return {
    total,
    fields,
    micro: applicable ? correct / applicable : null,
    macro: measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null,
    wholeDocumentAccuracy: total ? allCorrectDocuments / total : null,
    decisionAccuracy: total ? decisionMatches / total : null,
    autoApprovePrecision: autoApproved ? autoCorrect / autoApproved : null,
    reviewRate: total ? reviewCount / total : null,
    rejectRate: total ? rejectCount / total : null,
    fallbackRate: total ? fallbackCount / total : null,
    latencyP50Ms: nearestRank(latencies, 0.5),
    latencyP95Ms: nearestRank(latencies, 0.95),
    modelCalls,
  };
}
