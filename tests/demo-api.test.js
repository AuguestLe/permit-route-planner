import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readdir, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { createDemoRuntime } from '../server/demo/app.js';
import { loadDemoConfig } from '../server/demo/config.js';
import { FIELD_KEYS } from '../server/demo/schema.js';

const sample = sharp({ create: { width: 800, height: 600, channels: 3, background: '#eee' } }).png().toBuffer();
const other = sharp({ create: { width: 800, height: 600, channels: 3, background: '#123456' } }).png().toBuffer();

function completed() {
  const fields = {};
  for (const key of FIELD_KEYS) {
    const candidate = key === 'length' || key === 'width' || key === 'height' ? { value: 3, unit: 'm' }
      : key === 'weight' ? { value: 40000, unit: 'kg' }
        : key === 'axleCount' ? { value: 6 }
          : key === 'validFrom' ? { value: '2030-06-01' }
            : key === 'validTo' ? { value: '2030-06-30' }
              : { value: key === 'passRoute' ? '示例入口→S01→示例出口' : 'DEMO' };
    fields[key] = {
      raw: key === 'length' || key === 'width' || key === 'height' ? '3m' : key === 'weight' ? '40000kg' : String(candidate.value),
      candidate, confidence: { score: null, source: 'unavailable' }, evidence: null,
    };
  }
  return { status: 'completed', mode: 'local-ocr', referenceDate: '2030-06-15', fields, candidates: {}, quality: { status: 'pass' }, validation: { ok: true, errors: [] }, decision: { level: 'unknown', action: 'review_required', reasons: [] }, trace: [], fallbackUsed: false, usage: null };
}

async function setup(t, { config = loadDemoConfig({}) } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'demo-api-'));
  const sampleDir = join(root, 'samples');
  const buffer = await sample;
  await mkdir(sampleDir, { recursive: true });
  await writeFile(join(sampleDir, 'registered.png'), buffer);
  const manifest = { datasetVersion: 'synthetic-permit-v1', referenceDate: '2030-06-15', entries: [{ sampleId: 'SYN-001', filename: 'registered.png', sha256: createHash('sha256').update(buffer).digest('hex'), synthetic: true, watermark: true, mime: 'image/png', scenario: 'normal' }] };
  const runtime = await createDemoRuntime({ dataDir: join(root, '.data-demo'), config, manifest, sampleDir, pipeline: { run: async () => completed() }, reportDir: join(root, 'reports') });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { ...runtime, client: request(runtime.app), root, manifest, buffer };
}

async function upload(client, buffer, fileName = 'registered.png') {
  return client.post('/api/demo/records').set('Idempotency-Key', 'test').field('sampleId', 'SYN-001').attach('file', buffer, { filename: fileName, contentType: 'image/png' });
}

test('registered synthetic upload runs, returns image and supports review', async t => {
  const { client, queue, buffer } = await setup(t);
  const created = await upload(client, buffer);
  assert.equal(created.status, 201);
  assert.equal(created.body.sha256, createHash('sha256').update(buffer).digest('hex'));
  assert.equal(created.body.token, undefined);
  const image = await client.get(`/api/demo/records/${created.body.id}/file`);
  assert.deepEqual(image.body, buffer);
  const run = await client.post(`/api/demo/records/${created.body.id}/run`).send({ version: 1, mode: 'local-ocr', externalConfirmed: false });
  assert.equal(run.status, 202);
  await queue.whenIdle();
  const completedRecord = (await client.get(`/api/demo/records/${created.body.id}`)).body;
  assert.equal(completedRecord.status, 'completed');
  assert.equal(completedRecord.version, 2);
  const reviewed = await client.patch(`/api/demo/records/${created.body.id}/review`).send({ version: 2, fields: { passRoute: '示例入口→S01→人工出口' }, conclusion: 'approved' });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.review.status, 'approved');
  assert.equal((await client.patch(`/api/demo/records/${created.body.id}/review`).send({ version: 2, conclusion: 'approved' })).status, 409);
  assert.equal((await client.delete(`/api/demo/records/${created.body.id}`).send({ version: 3 })).status, 204);
});

test('unregistered or disguised upload is rejected before persistence', async t => {
  const { client, dataDir } = await setup(t);
  const bad = await upload(client, await other);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'SYNTHETIC_ONLY');
  assert.equal((await client.get('/api/demo/records')).body.records.length, 0);
  assert.deepEqual(await readdir(join(dataDir, 'tmp')), []);
});

test('vision mode requires explicit confirmation and configured service', async t => {
  const { client, buffer } = await setup(t);
  const created = (await upload(client, buffer)).body;
  const unconfirmed = await client.post(`/api/demo/records/${created.id}/run`).send({ version: 1, mode: 'vision', externalConfirmed: false });
  assert.equal(unconfirmed.status, 400);
  assert.equal(unconfirmed.body.error.code, 'EXTERNAL_CONFIRMATION_REQUIRED');
  const unconfigured = await client.post(`/api/demo/records/${created.id}/run`).send({ version: 1, mode: 'vision', externalConfirmed: true });
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.body.error.code, 'VISION_NOT_CONFIGURED');
});

test('sample metadata and file endpoints expose only registered synthetic files', async t => {
  const { client } = await setup(t);
  const samples = (await client.get('/api/demo/samples')).body.samples;
  assert.deepEqual(samples.map(item => item.sampleId), ['SYN-001']);
  assert.equal(samples[0].sha256, undefined);
  assert.equal((await client.get('/api/demo/samples/SYN-001/file')).status, 200);
  assert.equal((await client.get('/api/demo/samples/%2E%2E%2Fsecret/file')).status, 404);
});

test('blocks nonlocal and cross-site access', async t => {
  const { client } = await setup(t);
  assert.equal((await client.get('/api/demo/health').set('Host', 'evil.example')).status, 403);
  assert.equal((await client.get('/api/demo/health').set('Sec-Fetch-Site', 'cross-site')).status, 403);
});

test('expired records remove image directories', async t => {
  const { client, store, cleanup, dataDir, buffer } = await setup(t);
  const created = (await upload(client, buffer)).body;
  await cleanup(store.get(created.id).expiresAt);
  assert.equal((await client.get(`/api/demo/records/${created.id}`)).status, 404);
  await assert.rejects(access(join(dataDir, 'images', created.id)));
});

test('reports are served only from registered run files and export formats', async t => {
  const { client, root } = await setup(t);
  const reportDir = join(root, 'reports');
  const runId = '00000000-0000-4000-8000-000000000001';
  await mkdir(join(reportDir, runId), { recursive: true });
  await writeFile(join(reportDir, 'index.json'), JSON.stringify([{ runId, mode: 'local-ocr', total: 30 }]));
  await writeFile(join(reportDir, runId, 'report.json'), JSON.stringify({ runId, samples: [], metrics: {} }));
  await writeFile(join(reportDir, runId, 'field-accuracy.csv'), 'field,accuracy\nlength,1\n');
  await writeFile(join(reportDir, runId, 'summary.md'), '# report\n');
  assert.deepEqual((await client.get('/api/demo/reports')).body.reports.map(item => item.runId), [runId]);
  assert.equal((await client.get(`/api/demo/reports/${runId}`)).body.runId, runId);
  const exported = await client.get(`/api/demo/reports/${runId}/export?format=field-csv`);
  assert.equal(exported.status, 200);
  assert.match(exported.text, /length/);
  assert.equal((await client.get('/api/demo/reports/%2E%2E%2Fsecret')).status, 404);
});
