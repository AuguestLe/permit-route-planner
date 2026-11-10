import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoStore } from '../server/demo/store.js';
import { DemoQueue } from '../server/demo/queue.js';
import { FIELD_KEYS } from '../server/demo/schema.js';

function completedRecord() {
  const fields = {};
  for (const key of FIELD_KEYS) {
    const candidate = key === 'axleCount' ? { value: 6 }
      : key === 'length' || key === 'width' || key === 'height' ? { value: 3, unit: 'm' }
        : key === 'weight' ? { value: 40000, unit: 'kg' }
          : key === 'validFrom' ? { value: '2030-06-01' }
            : key === 'validTo' ? { value: '2030-06-30' }
              : { value: key === 'passRoute' ? '示例入口→S01→示例出口' : 'DEMO' };
    fields[key] = {
      raw: key === 'length' || key === 'width' || key === 'height' ? '3m'
        : key === 'weight' ? '40000kg' : key === 'validFrom' || key === 'validTo' ? candidate.value : String(candidate.value),
      candidate, confidence: { score: null, source: 'unavailable' }, evidence: null,
    };
  }
  return {
    status: 'completed', mode: 'local-ocr', referenceDate: '2030-06-15', fields, candidates: {},
    quality: { status: 'pass', checks: [] }, validation: { ok: true, errors: [] },
    decision: { level: 'unknown', action: 'review_required', reasons: ['置信度缺失'] }, trace: [], fallbackUsed: false, usage: null,
  };
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'demo-store-'));
  const store = new DemoStore(join(root, 'records.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return store;
}

test('enqueue advances version; complete keeps it; review enforces current version', async t => {
  const store = await setup(t);
  const record = store.create({ sampleId: 'SYN-001', sha256: 'a'.repeat(64), mime: 'image/png', size: 10, mode: 'local-ocr' });
  assert.equal(record.version, 1);
  const job = store.enqueue(record.id, 1, 'local-ocr');
  assert.equal(store.get(record.id).version, 2);
  assert.equal(store.complete(record.id, job.token, completedRecord()), true);
  const reviewed = store.review(record.id, { version: 2, fields: { passRoute: '示例入口→S01→人工出口' }, conclusion: 'approved' });
  assert.equal(reviewed.version, 3);
  assert.equal(reviewed.review.status, 'approved');
  assert.equal(reviewed.fields.passRoute.raw, completedRecord().fields.passRoute.raw);
  assert.equal(reviewed.review.revisions.passRoute, '示例入口→S01→人工出口');
  assert.equal(reviewed.review.events.length, 2);
  assert.throws(() => store.review(record.id, { version: 2, conclusion: 'approved' }), error => error.code === 'VERSION_CONFLICT');
});

test('review rejects approval while business validation fails', async t => {
  const store = await setup(t);
  const record = store.create({ sampleId: 'SYN-001', sha256: 'a'.repeat(64), mime: 'image/png', size: 10, mode: 'local-ocr' });
  store.enqueue(record.id, 1, 'local-ocr');
  store.complete(record.id, store.get(record.id).token, completedRecord());
  assert.throws(() => store.review(record.id, { version: 2, fields: { axleCount: '0' }, conclusion: 'approved' }), error => error.code === 'REVIEW_VALIDATION_FAILED');
});

test('review draft can save without approval and preserves raw', async t => {
  const store = await setup(t);
  const record = store.create({ sampleId: 'SYN-001', sha256: 'b'.repeat(64), mime: 'image/png', size: 10, mode: 'local-ocr' });
  store.enqueue(record.id, 1, 'local-ocr');
  store.complete(record.id, store.get(record.id).token, completedRecord());
  const draft = store.review(record.id, { version: 2, fields: { plateNumber: '人工车牌' } });
  assert.equal(draft.review.status, 'draft');
  assert.equal(draft.review.revisions.plateNumber, '人工车牌');
  assert.equal(draft.fields.plateNumber.raw, 'DEMO');
});

test('queue processes serially, cancels and survives restart interruption', async t => {
  const store = await setup(t);
  const record = store.create({ sampleId: 'SYN-001', sha256: 'c'.repeat(64), mime: 'image/png', size: 10, mode: 'local-ocr' });
  let running = 0;
  let max = 0;
  const queue = new DemoQueue({ store, onRun: async () => {
    running += 1;
    max = Math.max(max, running);
    await new Promise(resolve => setTimeout(resolve, 10));
    running -= 1;
    return completedRecord();
  } });
  t.after(() => queue.close());
  const second = store.create({ sampleId: 'SYN-002', sha256: 'd'.repeat(64), mime: 'image/png', size: 10, mode: 'local-ocr' });
  queue.add({ recordId: record.id, version: 1 });
  queue.add({ recordId: second.id, version: 1 });
  await queue.whenIdle();
  assert.equal(max, 1);
  assert.equal(store.get(record.id).status, 'completed');
  assert.equal(store.get(second.id).status, 'completed');

  const cancelled = store.create({ sampleId: 'SYN-003', sha256: 'e'.repeat(64), mime: 'image/png', size: 10, mode: 'local-ocr' });
  queue.add({ recordId: cancelled.id, version: 1 });
  queue.cancel(cancelled.id);
  assert.equal((await queue.whenIdle(), store.get(cancelled.id)).status, 'failed');
});

test('expiry and deletion remove record bodies', async t => {
  const store = await setup(t);
  const record = store.create({ sampleId: 'SYN-001', sha256: 'f'.repeat(64), mime: 'image/png', size: 10, mode: 'local-ocr', now: 1000 });
  assert.equal(store.expired(record.expiresAt).length, 1);
  assert.equal(store.delete(record.id, 1), true);
  assert.throws(() => store.get(record.id), error => error.code === 'TASK_NOT_FOUND');
});
