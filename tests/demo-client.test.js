import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoApi } from '../client/src/demo/api.js';
import { formatPrecision, fieldStatus, modeLabel, confidenceLabel, candidateText } from '../client/src/demo/format.js';

test('report formats null denominator as a dash and percentages deterministically', () => {
  assert.equal(formatPrecision(null), '—');
  assert.equal(formatPrecision(0.75), '75.0%');
  assert.equal(formatPrecision(1), '100.0%');
});

test('mode, confidence source and candidate formatting never invent a score', () => {
  assert.equal(modeLabel('local-ocr'), '本地 OCR');
  assert.equal(modeLabel('vision-fc'), '视觉 Function Calling');
  assert.equal(modeLabel('other'), '未知模式');
  assert.equal(confidenceLabel({ confidence: { score: null, source: 'unavailable' } }), '未提供（转人工）');
  assert.equal(confidenceLabel({ confidence: { score: 0.963, source: 'model-self-report' } }), '模型自报 96.3%');
  assert.equal(candidateText({ value: 18, unit: 'm' }), '18 m');
  assert.equal(candidateText(null), '—');
});

test('field status distinguishes correct, missing and wrong', () => {
  assert.equal(fieldStatus({ value: 'DEMO' }, { value: 'DEMO' }), 'correct');
  assert.equal(fieldStatus({ value: 'DEMO' }, null), 'missing');
  assert.equal(fieldStatus({ value: 'DEMO' }, { value: 'OTHER' }), 'wrong');
});

test('demo API uses fixed encoded endpoints and explicit vision confirmation', async () => {
  const calls = [];
  const api = createDemoApi(async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ id: 'r1' }), { status: 200 });
  });
  await api.record('a/b');
  await api.runRecord('a/b', { version: 2, mode: 'vision', externalConfirmed: true });
  await api.reviewRecord('r1', { version: 3, fields: { passRoute: 'route' }, conclusion: 'approved' });
  assert.deepEqual(calls.map(call => call.url), ['/api/demo/records/a%2Fb', '/api/demo/records/a%2Fb/run', '/api/demo/records/r1/review']);
  assert.deepEqual(JSON.parse(calls[1].options.body), { version: 2, mode: 'vision', externalConfirmed: true });
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[1].options.credentials, 'same-origin');
});
