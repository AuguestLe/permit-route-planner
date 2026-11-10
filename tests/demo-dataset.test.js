import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDatasetDefinition, generateDataset } from '../demo/dataset.mjs';

test('definition has the exact approved category split', () => {
  const entries = buildDatasetDefinition();
  assert.equal(entries.length, 30);
  assert.equal(entries.filter(entry => entry.scenario === 'normal').length, 18);
  assert.equal(entries.filter(entry => entry.scenario === 'quality').length, 6);
  assert.equal(entries.filter(entry => entry.scenario === 'missing').length, 4);
  assert.equal(entries.filter(entry => entry.scenario === 'business').length, 2);
  assert.equal(entries.filter(entry => entry.expectedValid).length, 24);
  assert.deepEqual(entries.map(entry => entry.sampleId), Array.from({ length: 30 }, (_, index) => `SYN-${String(index + 1).padStart(3, '0')}`));
});

test('truth is constructed independently and covers missing/business cases', () => {
  const entries = buildDatasetDefinition();
  const missing = entries.filter(entry => entry.scenario === 'missing');
  assert.ok(missing.some(entry => entry.expectedCandidates.width === null));
  assert.ok(missing.some(entry => entry.expectedCandidates.passRoute === null));
  const inverted = entries.find(entry => entry.sampleId === 'SYN-029');
  assert.equal(inverted.expectedValid, false);
  assert.equal(inverted.expectedCandidates.validFrom.value, '2030-06-30');
  assert.equal(inverted.expectedCandidates.validTo.value, '2030-06-01');
  const negative = entries.find(entry => entry.sampleId === 'SYN-030');
  assert.deepEqual(negative.expectedCandidates.length, { value: -1, unit: 'm' });
  assert.equal(negative.expectedValid, false);
  assert.equal(entries[0].expectedCandidates.length.value, 18);
});

test('generator writes thirty unique visibly synthetic PNGs and a frozen manifest', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'demo-dataset-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const manifest = await generateDataset({ outputDir, seed: 20261109 });
  assert.equal(manifest.datasetVersion, 'synthetic-permit-v1');
  assert.equal(manifest.seed, 20261109);
  assert.equal(manifest.referenceDate, '2030-06-15');
  assert.equal(manifest.entries.length, 30);
  assert.equal(new Set(manifest.entries.map(entry => entry.sha256)).size, 30);
  assert.ok(manifest.entries.every(entry => entry.synthetic && entry.watermark && entry.mime === 'image/png'));
  for (const entry of manifest.entries) {
    const filePath = join(outputDir, entry.filename);
    assert.ok((await stat(filePath)).size > 0);
    const bytes = await readFile(filePath);
    assert.equal(bytes[0], 0x89);
    assert.ok(bytes.length > 1000);
  }
  const second = await generateDataset({ outputDir, seed: 20261109 });
  assert.deepEqual(second.entries.map(entry => entry.sha256), manifest.entries.map(entry => entry.sha256));
});
