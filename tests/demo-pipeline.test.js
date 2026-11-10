import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPipeline } from '../server/demo/pipeline.js';
import { FIELD_KEYS } from '../server/demo/schema.js';

const buffer = Buffer.from('89504e470d0a1a0a', 'hex');
const sha256 = createHash('sha256').update(buffer).digest('hex');
const manifest = {
  datasetVersion: 'synthetic-permit-v1',
  referenceDate: '2030-06-15',
  entries: [{ sampleId: 'SYN-001', sha256, filename: 'SYN-001.png', synthetic: true, watermark: true, expectedValid: true }],
};

function localResult() {
  const fields = {};
  for (const key of FIELD_KEYS) {
    fields[key] = {
      raw: 'value',
      candidate: key === 'axleCount' ? { value: 6 } : 'value',
      confidence: { score: null, source: 'unavailable' },
      evidence: { start: 0, end: 1, text: 'v' },
    };
  }
  return { fields, candidates: {}, ocrText: 'text', trace: [{ stage: 'local-ocr' }], usage: null };
}

function deps({ qualityStatus = 'pass', visionError = null, localError = null } = {}) {
  const calls = { quality: 0, local: 0, vision: 0 };
  return {
    calls,
    pipeline: createPipeline({
      manifest,
      config: { vision: { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'secret', timeoutMs: 5000 }, visionConfigured: true },
      quality: async () => { calls.quality += 1; return { status: qualityStatus, checks: [] }; },
      localAdapter: { run: async () => { calls.local += 1; if (localError) throw localError; return localResult(); } },
      visionAdapter: { run: async () => { calls.vision += 1; if (visionError) throw visionError; return localResult(); } },
      validate: () => ({ ok: true, errors: [] }),
    }),
  };
}

function input(overrides = {}) {
  return { buffer, filePath: '/tmp/SYN-001.png', imageId: 'SYN-001', sampleId: 'SYN-001', mode: 'local-ocr', externalConfirmed: false, ...overrides };
}

test('local run never calls vision and routes null confidence to review', async () => {
  const { calls, pipeline } = deps();
  const record = await pipeline.run(input());
  assert.deepEqual(calls, { quality: 1, local: 1, vision: 0 });
  assert.equal(record.mode, 'local-ocr');
  assert.equal(record.decision.action, 'review_required');
  assert.equal(record.fallbackUsed, false);
  assert.equal(record.datasetVersion, 'synthetic-permit-v1');
});

test('vision failure falls back to local extraction and forces review', async () => {
  const { calls, pipeline } = deps({ visionError: Object.assign(new Error('timeout'), { code: 'VISION_TIMEOUT' }) });
  const record = await pipeline.run(input({ mode: 'vision', externalConfirmed: true }));
  assert.equal(calls.vision, 1);
  assert.equal(record.mode, 'vision-fc');
  assert.equal(record.fallbackUsed, true);
  assert.equal(record.decision.action, 'review_required');
  assert.ok(record.trace.some(entry => entry.stage === 'fallback-local' && entry.code === 'VISION_TIMEOUT'));
});

test('unregistered hash never reaches quality or network', async () => {
  const { calls, pipeline } = deps();
  await assert.rejects(pipeline.run(input({ buffer: Buffer.from('other') })), error => error.code === 'SYNTHETIC_ONLY');
  assert.deepEqual(calls, { quality: 0, local: 0, vision: 0 });
});

test('vision requires explicit confirmation before any processing', async () => {
  const { calls, pipeline } = deps();
  await assert.rejects(pipeline.run(input({ mode: 'vision', externalConfirmed: false })), error => error.code === 'EXTERNAL_CONFIRMATION_REQUIRED');
  assert.deepEqual(calls, { quality: 0, local: 0, vision: 0 });
});

test('quality rejection stops extraction and records rejected', async () => {
  const { calls, pipeline } = deps({ qualityStatus: 'reject' });
  const record = await pipeline.run(input());
  assert.deepEqual(calls, { quality: 1, local: 0, vision: 0 });
  assert.equal(record.status, 'rejected');
  assert.equal(record.decision.action, 'rejected');
});

test('local OCR failure returns failed status without fabricating fields', async () => {
  const { pipeline } = deps({ localError: Object.assign(new Error('engine missing'), { code: 'OCR_ENGINE_MISSING' }) });
  const record = await pipeline.run(input());
  assert.equal(record.status, 'failed');
  assert.equal(record.error.code, 'OCR_ENGINE_MISSING');
  assert.deepEqual(record.fields, {});
});
