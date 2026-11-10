import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { computeMetrics } from '../server/demo/metrics.js';
import { runEvaluation } from '../server/demo/evaluation.js';
import { FIELD_KEYS } from '../server/demo/schema.js';
import { buildDatasetDefinition } from '../demo/dataset.mjs';

const expected = {
  permitNumber: { value: 'DEMO-PERMIT-0001' }, plateNumber: { value: 'DEMO-A0001' },
  issuingRegion: { value: '示例省' }, validFrom: { value: '2030-06-01' }, validTo: { value: '2030-06-30' },
  length: { value: 18, unit: 'm' }, width: { value: 3.2, unit: 'm' }, height: { value: 4, unit: 'm' },
  weight: { value: 49000, unit: 'kg' }, axleCount: { value: 6 }, passRoute: { value: '示例入口-S01-示例出口' },
};

function result({ action = 'review_required', fieldOverrides = {}, expectedCandidates = expected, expectedValid = true, fallbackUsed = false, trace = [], totalMs = 10 } = {}) {
  const fields = {};
  for (const key of FIELD_KEYS) fields[key] = { raw: 'raw', candidate: expectedCandidates[key], confidence: { score: null, source: 'unavailable' }, evidence: null, ...(fieldOverrides[key] ?? {}) };
  return {
    status: 'completed', sampleId: 'SYN-001', scenario: 'normal', expectedCandidates, expectedValid,
    fields, validation: { ok: expectedValid, errors: [] }, decision: { level: action === 'auto_approved' ? 'high' : 'unknown', action, reasons: [] },
    fallbackUsed, trace, timings: { totalMs },
  };
}

test('zero auto approvals show null precision, never fake one', () => {
  const metrics = computeMetrics([result()]);
  assert.equal(metrics.autoApprovePrecision, null);
  assert.equal(metrics.reviewRate, 1);
});

test('field, micro, macro, whole-document and auto-pass metrics use explicit denominators', () => {
  const wrong = result({ action: 'auto_approved', fieldOverrides: { height: { candidate: { value: 5, unit: 'm' } } } });
  const metrics = computeMetrics([result({ action: 'auto_approved' }), wrong]);
  assert.equal(metrics.fields.height.accuracy, 0.5);
  assert.equal(metrics.micro, 21 / 22);
  assert.equal(metrics.wholeDocumentAccuracy, 0.5);
  assert.equal(metrics.autoApprovePrecision, 0.5);
  assert.equal(metrics.reviewRate, 0);
});

test('expected null fields are excluded from field accuracy but counted separately', () => {
  const expectedCandidates = { ...expected, width: null };
  const item = result({ expectedCandidates, fieldOverrides: { width: { candidate: null } } });
  const metrics = computeMetrics([item]);
  assert.equal(metrics.fields.width.applicable, 0);
  assert.equal(metrics.fields.width.accuracy, null);
  assert.equal(metrics.fields.width.nullExpected, 1);
  assert.equal(metrics.fields.width.nullCorrect, 1);
  assert.equal(metrics.micro, 1);
});

test('evaluation rejects unconfirmed vision before pipeline or file reads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'demo-eval-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(runEvaluation({
    pipeline: { run: async () => { calls += 1; return result(); } },
    manifest: { entries: [{ sampleId: 'SYN-001', filename: 'SYN-001.png', synthetic: true, watermark: true, sha256: 'a'.repeat(64) }], referenceDate: '2030-06-15', datasetVersion: 'synthetic-permit-v1' },
    sampleDir: root, reportDir: join(root, 'reports'), mode: 'vision', all: true, externalConfirmed: false,
  }), error => error.code === 'EXTERNAL_CONFIRMATION_REQUIRED');
  assert.equal(calls, 0);
});

test('evaluation writes actual metrics and all export formats from the same run', async t => {
  const root = await mkdtemp(join(tmpdir(), 'demo-eval-report-'));
  const sampleDir = join(root, 'samples');
  const reportDir = join(root, 'reports');
  await mkdir(sampleDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const definitions = buildDatasetDefinition().slice(0, 2);
  const entries = [];
  for (const definition of definitions) {
    const bytes = Buffer.from(definition.sampleId);
    await writeFile(join(sampleDir, `${definition.sampleId}.png`), bytes);
    entries.push({ ...definition, filename: `${definition.sampleId}.png`, sha256: createHash('sha256').update(bytes).digest('hex'), synthetic: true, watermark: true, mime: 'image/png' });
  }
  const manifest = { datasetVersion: 'synthetic-permit-v1', referenceDate: '2030-06-15', entries };
  const report = await runEvaluation({
    pipeline: { run: async ({ sampleId }) => ({ ...result({ action: 'review_required' }), sampleId, expectedCandidates: definitions.find(item => item.sampleId === sampleId).expectedCandidates, scenario: definitions.find(item => item.sampleId === sampleId).scenario, expectedValid: definitions.find(item => item.sampleId === sampleId).expectedValid }) },
    manifest, sampleDir, reportDir, mode: 'local', all: true, externalConfirmed: false,
    model: 'local-tesseract', runId: '00000000-0000-4000-8000-000000000001', now: () => new Date('2026-11-09T10:00:00Z'),
  });
  assert.equal(report.samples.length, 2);
  assert.equal(report.metrics.autoApprovePrecision, null);
  const dir = join(reportDir, report.runId);
  for (const file of ['report.json', 'field-accuracy.csv', 'samples.csv', 'summary.md']) {
    assert.ok((await readFile(join(dir, file), 'utf8')).length > 0);
  }
  const index = JSON.parse(await readFile(join(reportDir, 'index.json'), 'utf8'));
  assert.deepEqual(index.map(item => item.runId), [report.runId]);
});
