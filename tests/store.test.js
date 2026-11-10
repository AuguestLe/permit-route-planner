import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const module = await import('../server/store.js').catch(() => ({}));
const { TaskStore } = module;
const image = id => ({ id, filename: `${id}.png`, mime: 'image/png', size: 100, width: 100, height: 80, originalName: '证件.png' });
function setup(t) {
  assert.equal(typeof TaskStore, 'function', 'persistent TaskStore must be implemented');
  const root = mkdtempSync(join(tmpdir(), 'permit-store-'));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return store;
}

test('preserves OCR original while edits use optimistic versions', t => {
  const store = setup(t);
  const task = store.create({ name: '运输', images: [image('a')], requestKey: 'request-a' });
  const token = store.enqueue(task.id, ['a'], task.version)[0].token;
  store.complete(task.id, 'a', token, { text: '通行路线：甲→乙', confidence: 75, fields: { passRoute: { value: '甲→乙', source: { imageId: 'a', start: 5, end: 8, text: '甲→乙' } } }, warnings: [] });
  const updated = store.edit(task.id, { version: 1, revisions: [{ imageId: 'a', fields: { passRoute: '甲→丙→乙' } }] });
  assert.equal(updated.version, 2);
  assert.equal(updated.images[0].original.text, '通行路线：甲→乙');
  assert.equal(updated.images[0].revision.fields.passRoute, '甲→丙→乙');
  assert.throws(() => store.edit(task.id, { version: 1, name: '旧请求' }), e => e.status === 409);
  assert.equal(store.get(task.id).name, '运输');
});

test('deduplicates queued work and never repeats successful OCR', t => {
  const store = setup(t);
  const task = store.create({ name: '任务', images: [image('a'), image('b')], requestKey: 'request-b' });
  const jobs = store.enqueue(task.id, ['a', 'b'], 1);
  assert.equal(jobs.length, 2);
  assert.equal(store.enqueue(task.id, ['a', 'b'], 1).length, 0);
  store.complete(task.id, 'a', jobs[0].token, { text: '原文', confidence: null, fields: {}, warnings: [] });
  store.fail(task.id, 'b', jobs[1].token, 'OCR_TIMEOUT', '识别超时');
  const retry = store.enqueue(task.id, ['a', 'b'], 1);
  assert.deepEqual(retry.map(job => job.imageId), ['b']);
  assert.equal(store.get(task.id).images[0].original.text, '原文');
});

test('rejects stale OCR completion and keeps edits made during another image recognition', t => {
  const store = setup(t);
  const task = store.create({ name: '任务', images: [image('a'), image('b')], requestKey: 'request-c' });
  const jobs = store.enqueue(task.id, ['a', 'b'], 1);
  store.complete(task.id, 'a', jobs[0].token, { text: '原文', fields: { passRoute: { value: '甲乙', source: null } }, confidence: 80, warnings: [] });
  store.edit(task.id, { version: 1, revisions: [{ imageId: 'a', fields: { passRoute: '修订路线' } }] });
  assert.equal(store.complete(task.id, 'b', 'old-token', { text: '错误结果' }), false);
  store.complete(task.id, 'b', jobs[1].token, { text: '第二张', fields: {}, confidence: null, warnings: [] });
  assert.equal(store.get(task.id).images[0].revision.fields.passRoute, '修订路线');
});

test('validates image order instead of accepting missing or repeated images', t => {
  const store = setup(t);
  const task = store.create({ name: '任务', images: [image('a'), image('b')], requestKey: 'request-d' });
  assert.throws(() => store.edit(task.id, { version: 1, order: ['a', 'a'] }), e => e.status === 400);
  assert.deepEqual(store.edit(task.id, { version: 1, order: ['b', 'a'] }).images.map(x => x.id), ['b', 'a']);
});

test('interrupted jobs become retryable without automatic re-execution', t => {
  const store = setup(t);
  const task = store.create({ name: '任务', images: [image('a')], requestKey: 'request-e' });
  store.enqueue(task.id, ['a'], 1);
  store.recoverInterrupted();
  const current = store.get(task.id);
  assert.equal(current.images[0].status, 'failed');
  assert.equal(current.images[0].error.code, 'INTERRUPTED');
  assert.equal(store.enqueue(task.id, ['a'], 1).length, 1);
});

test('expires records seven days after creation and forgets deleted tasks', t => {
  const store = setup(t);
  const task = store.create({ name: '任务', images: [image('a')], requestKey: 'request-f', now: 1000 });
  assert.equal(task.expiresAt, 1000 + 7 * 86400000);
  assert.deepEqual(store.expired(1000 + 7 * 86400000).map(x => x.id), [task.id]);
  store.delete(task.id);
  assert.throws(() => store.get(task.id), e => e.status === 404);
  assert.equal(store.complete(task.id, 'a', 'old', {}), false);
});

test('a durable deletion marker blocks edits, new jobs and late OCR results', t => {
  const store = setup(t);
  const task = store.create({ name: '待删除', images: [image('a')], requestKey: 'delete-race' });
  const [job] = store.enqueue(task.id, ['a'], 1);
  assert.equal(typeof store.markDeleting, 'function', 'deletion must be persisted before asynchronous file removal');
  assert.throws(() => store.markDeleting(task.id, 0), e => e.status === 409);
  store.markDeleting(task.id, 1);
  assert.throws(() => store.edit(task.id, { version: 1, name: '不应保存' }), e => e.status === 409);
  assert.throws(() => store.enqueue(task.id, ['a'], 1), e => e.status === 409);
  assert.equal(store.complete(task.id, 'a', job.token, { text: '旧结果', fields: {} }), false);
  assert.deepEqual(store.pendingDeletion().map(t => t.id), [task.id]);
});
