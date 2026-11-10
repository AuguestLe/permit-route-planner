import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { inspectQuality } from '../server/demo/quality.js';
import { decide } from '../server/demo/decision.js';
import { FIELD_KEYS } from '../server/demo/schema.js';

function noise(width = 800, height = 600, seed = 7) {
  const channels = 3;
  const buffer = Buffer.alloc(width * height * channels);
  let state = seed;
  for (let index = 0; index < buffer.length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    buffer[index] = state >>> 24;
  }
  return sharp(buffer, { raw: { width, height, channels } }).png().toBuffer();
}

async function fieldsWith(confidence = 0.96, overrides = {}) {
  const fields = {};
  for (const key of FIELD_KEYS) {
    fields[key] = {
      candidate: key === 'axleCount' ? 6 : key === 'length' ? { value: 18, unit: 'm' } : 'value',
      confidence: { score: confidence, source: 'model-self-report' },
      evidence: { start: 0, end: 1, text: 'v' },
    };
  }
  return { ...fields, ...overrides };
}

test('blank image is rejected with the blank check', async () => {
  const blank = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#fff' } }).png().toBuffer();
  const result = await inspectQuality(blank);
  assert.equal(result.status, 'reject');
  assert.ok(result.checks.some(check => check.code === 'blank' && check.status === 'reject'));
});

test('undersized image is rejected', async () => {
  const small = await noise(399, 400);
  assert.equal((await inspectQuality(small)).status, 'reject');
  assert.ok((await inspectQuality(small)).checks.some(check => check.code === 'resolution' && check.status === 'reject'));
});

test('readable textured image passes with every named check', async () => {
  const result = await inspectQuality(await noise());
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.checks.map(check => check.code).sort(), ['blank', 'blur', 'brightness', 'darkness', 'resolution']);
  assert.ok(result.checks.every(check => Object.hasOwn(check, 'value') && Object.hasOwn(check, 'threshold')));
});

test('heavily blurred image warns rather than pretending it is clean', async () => {
  const blurred = await sharp(await noise()).blur(24).png().toBuffer();
  const result = await inspectQuality(blurred);
  assert.notEqual(result.status, 'pass');
  assert.ok(result.checks.some(check => check.code === 'blur' && check.status === 'warn'));
});

test('missing local confidence never auto-approves', () => {
  const fields = {};
  for (const key of FIELD_KEYS) fields[key] = { candidate: 'x', confidence: { score: null, source: 'unavailable' }, evidence: { start: 0, end: 1 } };
  const decision = decide({ quality: { status: 'pass' }, validation: { ok: true }, fields });
  assert.equal(decision.level, 'unknown');
  assert.equal(decision.action, 'review_required');
});

test('all calibrated high-confidence fields pass hard gates and auto-approve', async () => {
  const decision = decide({ quality: { status: 'pass' }, validation: { ok: true }, fields: await fieldsWith(0.96) });
  assert.equal(decision.level, 'high');
  assert.equal(decision.action, 'auto_approved');
  assert.deepEqual(decision.reasons, []);
});

test('confidence threshold boundaries route medium and low to review', async () => {
  assert.equal(decide({ quality: { status: 'pass' }, validation: { ok: true }, fields: await fieldsWith(0.9) }).level, 'high');
  assert.equal(decide({ quality: { status: 'pass' }, validation: { ok: true }, fields: await fieldsWith(0.89) }).level, 'medium');
  assert.equal(decide({ quality: { status: 'pass' }, validation: { ok: true }, fields: await fieldsWith(0.7) }).level, 'medium');
  const low = decide({ quality: { status: 'pass' }, validation: { ok: true }, fields: await fieldsWith(0.69) });
  assert.equal(low.level, 'low');
  assert.equal(low.action, 'review_required');
});

test('validation failure and quality warning override high confidence', async () => {
  const fields = await fieldsWith(0.99);
  const invalid = decide({ quality: { status: 'pass' }, validation: { ok: false, errors: [{ path: '/validTo', code: 'expired' }] }, fields });
  assert.equal(invalid.action, 'review_required');
  assert.ok(invalid.reasons.some(reason => reason.includes('校验')));
  const warned = decide({ quality: { status: 'warn' }, validation: { ok: true }, fields });
  assert.equal(warned.action, 'review_required');
  assert.ok(warned.reasons.some(reason => reason.includes('质检')));
});

test('quality rejection stops with rejected action', async () => {
  const decision = decide({ quality: { status: 'reject' }, validation: { ok: true }, fields: await fieldsWith(0.99) });
  assert.equal(decision.action, 'rejected');
  assert.ok(decision.reasons.some(reason => reason.includes('质检')));
});
