import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import { createRecognizer } from '../server/ocr.js';

const { createRuntime } = await import('../server/app.js').catch(() => ({}));
const fixture = await sharp({ create: { width: 180, height: 120, channels: 3, background: '#fff' } }).png().toBuffer();
const recognized = { text: '通行路线：甲收费站→乙收费站', confidence: 72, engine: 'Tesseract.js', languages: ['chi_sim', 'eng'] };
async function setup(t, recognize = async () => recognized) {
  assert.equal(typeof createRuntime, 'function', 'upload and OCR API must be implemented');
  const root = await mkdtemp(join(tmpdir(), 'permit-api-'));
  const dataDir = join(root, '.private');
  const runtime = await createRuntime({ dataDir, recognize });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { ...runtime, dataDir, client: request(runtime.app) };
}
async function upload(client, key = randomUUID(), count = 1) {
  let req = client.post('/api/tasks').set('Idempotency-Key', key).field('name', '测试运输');
  for (let i = 0; i < count; i++) req = req.attach('files', fixture, { filename: `permit-${i}.png`, contentType: 'image/png' });
  return req;
}

test('uploads private images, recognizes them and preserves original after a revision', async t => {
  const { client, queue, dataDir } = await setup(t);
  const created = await upload(client);
  assert.equal(created.status, 201);
  const task = created.body;
  assert.equal(task.images[0].status, 'pending');
  assert.equal(task.images[0].filename, undefined);
  assert.equal(task.images[0].token, undefined);
  const originalFile = await client.get(`/api/tasks/${task.id}/images/${task.images[0].id}/file`);
  assert.equal(originalFile.status, 200);
  assert.equal(originalFile.headers['content-type'], 'image/png');
  assert.deepEqual(originalFile.body, fixture);
  assert.equal((await client.post(`/api/tasks/${task.id}/recognize`).send({ version: 1 })).status, 202);
  await queue.whenIdle();
  const result = (await client.get(`/api/tasks/${task.id}`)).body;
  assert.equal(result.status, 'needs_correction');
  assert.equal(result.images[0].original.text, recognized.text);
  assert.equal(result.images[0].original.confidence, 72);
  assert.equal(result.images[0].revision.fields.passRoute, '甲收费站→乙收费站');
  const edit = await client.patch(`/api/tasks/${task.id}`).send({ version: 1, revisions: [{ imageId: task.images[0].id, fields: { passRoute: '人工修订路线' } }] });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.images[0].original.text, recognized.text);
  assert.equal(edit.body.images[0].revision.fields.passRoute, '人工修订路线');
  assert.equal((await client.patch(`/api/tasks/${task.id}`).send({ version: 1, name: '旧请求' })).status, 409);
  assert.equal((await client.get('/api/tasks')).body.tasks.length, 1);
  assert.equal((await client.delete(`/api/tasks/${task.id}`).send({ version: 2 })).status, 204);
  assert.equal((await client.get(`/api/tasks/${task.id}`)).status, 404);
  await assert.rejects(access(join(dataDir, 'images', task.id)));
});

test('真实原生 OCR 经上传接口、任务队列和字段提取后可保存校对', { timeout: 120_000 }, async t => {
  const { client, queue } = await setup(t, createRecognizer());
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="700">
    <rect width="1800" height="700" fill="white"/>
    <g font-family="PingFang SC, Noto Sans CJK SC, sans-serif" font-size="64" fill="black">
      <text x="80" y="140">测试样本 非真实证件</text>
      <text x="80" y="290">LOCAL OCR TEST</text>
      <text x="80" y="440">通行路线：杭州收费站 → G25 → 南京收费站</text>
    </g>
  </svg>`;
  const image = await sharp(Buffer.from(svg)).png().toBuffer();
  const created = await client.post('/api/tasks').set('Idempotency-Key', randomUUID())
    .field('name', '原生 OCR 接口回归').attach('files', image, { filename: 'sample.png', contentType: 'image/png' });
  assert.equal(created.status, 201);
  const task = created.body;
  assert.equal((await client.post(`/api/tasks/${task.id}/recognize`).send({ version: 1 })).status, 202);
  await queue.whenIdle();
  const result = (await client.get(`/api/tasks/${task.id}`)).body.images[0];
  assert.equal(result.status, 'succeeded');
  assert.equal(result.original.engine, 'Tesseract');
  assert.equal(result.original.confidence, null);
  assert.match(result.original.text, /LOCAL OCR TEST/);
  assert.match(result.original.fields.passRoute.value, /G25/);
  const saved = await client.patch(`/api/tasks/${task.id}`).send({
    version: 1, revisions: [{ imageId: result.id, fields: { passRoute: '人工校对路线' } }],
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.images[0].original.text, result.original.text);
  assert.equal(saved.body.images[0].revision.fields.passRoute, '人工校对路线');
});

test('health identifies the native engine used for new recognition jobs', async t => {
  const { client } = await setup(t);
  const health = await client.get('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.engine, 'Tesseract');
  assert.deepEqual(health.body.languages, ['chi_sim', 'eng']);
});

test('native engine installation failures remain actionable through the task API', async t => {
  const { client, queue } = await setup(t, async () => {
    throw Object.assign(new Error('sensitive executable path'), { code: 'OCR_ENGINE_MISSING' });
  });
  const task = (await upload(client)).body;
  await client.post(`/api/tasks/${task.id}/recognize`).send({ version: 1 });
  await queue.whenIdle();
  const result = (await client.get(`/api/tasks/${task.id}`)).body;
  assert.equal(result.images[0].status, 'failed');
  assert.equal(result.images[0].error.code, 'OCR_ENGINE_MISSING');
  assert.match(result.images[0].error.message, /Tesseract/);
  assert.doesNotMatch(JSON.stringify(result), /sensitive executable path/);
});

test('rejects disguised or damaged uploads and removes temporary files', async t => {
  const { client, dataDir } = await setup(t);
  for (const buffer of [Buffer.from('<svg><script>alert(1)</script></svg>'), fixture.subarray(0, 30)]) {
    const res = await client.post('/api/tasks').set('Idempotency-Key', randomUUID()).field('name', '坏图片').attach('files', buffer, { filename: 'image.png', contentType: 'image/png' });
    assert.ok([400, 415].includes(res.status));
  }
  assert.deepEqual(await readdir(join(dataDir, 'tmp')), []);
  assert.equal((await client.get('/api/tasks')).body.tasks.length, 0);
});

test('enforces count limits and rejects arbitrary fields without leaving files', async t => {
  const { client, dataDir } = await setup(t);
  assert.equal((await upload(client, randomUUID(), 11)).status, 413);
  assert.equal((await client.post('/api/tasks').set('Idempotency-Key', randomUUID()).field('name', '任务').field('url', 'http://internal/').attach('files', fixture, 'a.png')).status, 400);
  assert.deepEqual(await readdir(join(dataDir, 'tmp')), []);
});

test('deduplicates creation and recognition; retry only processes failed images', async t => {
  let calls = 0;
  const { client, queue } = await setup(t, async () => {
    calls++;
    if (calls === 2) throw Object.assign(new Error('private text must not escape'), { code: 'OCR_TIMEOUT' });
    return recognized;
  });
  const key = randomUUID();
  const first = await upload(client, key, 2);
  const again = await upload(client, key, 2);
  assert.equal(again.body.id, first.body.id);
  assert.equal((await client.get('/api/tasks')).body.tasks.length, 1);
  const url = `/api/tasks/${first.body.id}`;
  await client.post(`${url}/recognize`).send({ version: 1 });
  await queue.whenIdle();
  const done = (await client.get(url)).body;
  assert.equal(done.images[0].status, 'succeeded');
  assert.equal(done.images[1].status, 'failed');
  assert.doesNotMatch(JSON.stringify(done), /private text must not escape/);
  await client.post(`${url}/recognize`).send({ version: 1 });
  await queue.whenIdle();
  assert.equal(calls, 2);
  assert.equal((await client.post(`${url}/images/${done.images[1].id}/retry`).send({ version: 1 })).status, 202);
  await queue.whenIdle();
  assert.equal(calls, 3);
  assert.equal((await client.get(url)).body.images[1].status, 'succeeded');
});

test('blocks nonlocal hosts, cross-site origins and remote URLs', async t => {
  const { client } = await setup(t);
  assert.equal((await client.get('/api/tasks').set('Host', 'evil.example')).status, 403);
  assert.equal((await client.get('/api/tasks').set('Origin', 'https://evil.example')).status, 403);
  assert.equal((await client.get('/api/tasks').set('Sec-Fetch-Site', 'cross-site')).status, 403);
  assert.equal((await client.get('/api/tasks').set('Origin', 'null')).status, 403);
  const task = (await upload(client)).body;
  assert.equal((await client.patch(`/api/tasks/${task.id}`).send({ version: 1, filePath: '/etc/passwd' })).status, 400);
  assert.equal((await client.get(`/api/tasks/${task.id}/images/unknown/file`)).status, 404);
});

test('keeps recognition serial and cannot resurrect a task deleted during OCR', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let inFlight = 0;
  let maxInFlight = 0;
  const { client, queue } = await setup(t, async (_path, _id, _stage, signal) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    started();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    inFlight--;
    return recognized;
  });
  const task = (await upload(client, randomUUID(), 2)).body;
  await client.post(`/api/tasks/${task.id}/recognize`).send({ version: 1 });
  await ready;
  assert.equal((await client.delete(`/api/tasks/${task.id}`).send({ version: 1 })).status, 204);
  await queue.whenIdle();
  assert.equal(maxInFlight, 1);
  assert.equal((await client.get('/api/tasks')).body.tasks.length, 0);
});

test('cleans expired records and their private image directories', async t => {
  const { client, store, cleanup, dataDir } = await setup(t);
  const task = (await upload(client)).body;
  const expiresAt = store.get(task.id).expiresAt;
  await cleanup(expiresAt);
  assert.equal((await client.get(`/api/tasks/${task.id}`)).status, 404);
  await assert.rejects(access(join(dataDir, 'images', task.id)));
});

test('rejects oversized single files and total uploads before image decoding', async t => {
  const { client, dataDir } = await setup(t);
  const oversized = await client.post('/api/tasks').set('Idempotency-Key', randomUUID()).field('name', '过大单图')
    .attach('files', Buffer.alloc(10 * 1024 * 1024 + 1), { filename: 'large.png', contentType: 'image/png' });
  assert.equal(oversized.status, 413);
  let req = client.post('/api/tasks').set('Idempotency-Key', randomUUID()).field('name', '过大总量');
  const buffer = Buffer.alloc(9 * 1024 * 1024);
  for (let i = 0; i < 6; i++) req = req.attach('files', buffer, { filename: `large-${i}.png`, contentType: 'image/png' });
  const total = await req;
  assert.equal(total.status, 413);
  assert.equal(total.body.error.code, 'TOTAL_TOO_LARGE');
  assert.deepEqual(await readdir(join(dataDir, 'tmp')), []);
});

test('limits queue capacity without marking rejected work as queued', async t => {
  const { client } = await setup(t, async (_path, _id, _stage, signal) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return recognized;
  });
  const tasks = [];
  for (let i = 0; i < 3; i++) tasks.push((await upload(client, randomUUID(), 10)).body);
  assert.equal((await client.post(`/api/tasks/${tasks[0].id}/recognize`).send({ version: 1 })).status, 202);
  assert.equal((await client.post(`/api/tasks/${tasks[1].id}/recognize`).send({ version: 1 })).status, 202);
  const full = await client.post(`/api/tasks/${tasks[2].id}/recognize`).send({ version: 1 });
  assert.equal(full.status, 429);
  assert.equal(full.body.error.code, 'QUEUE_FULL');
  assert.ok((await client.get(`/api/tasks/${tasks[2].id}`)).body.images.every(i => i.status === 'pending'));
});

test('retains saved revisions after closing and reopening SQLite', async t => {
  assert.equal(typeof createRuntime, 'function', 'upload and OCR API must be implemented');
  const dataDir = await mkdtemp(join(tmpdir(), 'permit-restart-'));
  let runtime = await createRuntime({ dataDir, recognize: async () => recognized });
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  let client = request(runtime.app);
  const task = (await upload(client)).body;
  await client.post(`/api/tasks/${task.id}/recognize`).send({ version: 1 });
  await runtime.queue.whenIdle();
  await client.patch(`/api/tasks/${task.id}`).send({ version: 1, revisions: [{ imageId: task.images[0].id, fields: { passRoute: '重启后保留的人工路线' } }] });
  await runtime.close();
  runtime = await createRuntime({ dataDir, recognize: async () => { throw new Error('must not run automatically'); } });
  client = request(runtime.app);
  const restored = (await client.get(`/api/tasks/${task.id}`)).body;
  assert.equal(restored.version, 2);
  assert.equal(restored.images[0].revision.fields.passRoute, '重启后保留的人工路线');
  assert.equal(restored.images[0].original.text, recognized.text);
  assert.equal(restored.images[0].status, 'succeeded');
});

test('resumes interrupted deletion at startup instead of exposing a task with missing images', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'permit-delete-restart-'));
  let runtime = await createRuntime({ dataDir, recognize: async () => recognized });
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  const task = (await upload(request(runtime.app))).body;
  assert.equal(typeof runtime.store.markDeleting, 'function');
  runtime.store.markDeleting(task.id, 1);
  assert.equal((await request(runtime.app).patch(`/api/tasks/${task.id}`).send({ version: 1, name: '不能覆盖删除' })).status, 409);
  await runtime.close();
  runtime = await createRuntime({ dataDir, recognize: async () => recognized });
  assert.equal((await request(runtime.app).get(`/api/tasks/${task.id}`)).status, 404);
  await assert.rejects(access(join(dataDir, 'images', task.id)));
});
