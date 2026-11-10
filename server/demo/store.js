import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { AppError, check } from '../errors.js';
import { FIELD_KEYS } from './schema.js';
import { normalizeFields } from './normalize.js';
import { validateCandidates } from './validate.js';

const DAYS_7 = 7 * 86400000;
const ACTIVE = new Set(['queued', 'running']);
const FIELD_KEYS_SET = new Set(FIELD_KEYS);

function resultCode(code, message) {
  return new AppError(404, code, message);
}

export class DemoStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS demo_records (id TEXT PRIMARY KEY, sample_id TEXT NOT NULL, sha256 TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, body TEXT NOT NULL)');
  }

  create({ sampleId, sha256, mime = 'image/png', size = 0, mode = 'local-ocr', now = Date.now() }) {
    const id = randomUUID();
    const record = {
      id, version: 1, status: 'pending', stage: null, sampleId, sha256, mime, size,
      mode: mode === 'vision' ? 'vision-fc' : mode, createdAt: now, expiresAt: now + DAYS_7,
      token: null, fields: {}, candidates: {}, quality: null, validation: null, decision: null,
      trace: [], fallbackUsed: false, usage: null, error: null, review: null,
    };
    this.db.prepare('INSERT INTO demo_records VALUES (?,?,?,?,?,?)').run(id, sampleId, sha256, record.expiresAt, now, JSON.stringify(record));
    return record;
  }

  get(id) {
    const row = this.db.prepare('SELECT body FROM demo_records WHERE id=?').get(id);
    check(row, 404, 'TASK_NOT_FOUND', 'Demo 记录不存在或已清理。');
    return JSON.parse(row.body);
  }

  list() {
    return this.db.prepare('SELECT body FROM demo_records ORDER BY created_at DESC LIMIT 100').all().map(row => JSON.parse(row.body));
  }

  save(record) {
    this.db.prepare('UPDATE demo_records SET body=? WHERE id=?').run(JSON.stringify(record), record.id);
    return record;
  }

  enqueue(id, version, mode = 'local-ocr') {
    const record = this.get(id);
    check(record.status === 'pending' || record.status === 'failed', 409, 'RECORD_NOT_READY', '当前记录不可开始核验。');
    check(Number.isSafeInteger(version) && version === record.version, 409, 'VERSION_CONFLICT', '记录已更新，请刷新后重试。');
    check(['local-ocr', 'vision-fc', 'vision'].includes(mode), 400, 'INVALID_MODE', '核验模式无效。');
    const token = randomUUID();
    record.token = token;
    record.status = 'queued';
    record.stage = '等待核验';
    record.mode = mode === 'vision' ? 'vision-fc' : mode;
    record.error = null;
    record.version += 1;
    this.save(record);
    return { recordId: id, token, mode: record.mode };
  }

  updateJob(id, token, action) {
    const row = this.db.prepare('SELECT body FROM demo_records WHERE id=?').get(id);
    if (!row) return false;
    const record = JSON.parse(row.body);
    if (!ACTIVE.has(record.status) || record.token !== token) return false;
    action(record);
    this.save(record);
    return true;
  }

  stage(id, token, stage) {
    return this.updateJob(id, token, record => { record.status = 'running'; record.stage = stage; });
  }

  complete(id, token, result) {
    return this.updateJob(id, token, record => {
      Object.assign(record, result);
      record.status = result.status === 'failed' ? 'failed' : result.status === 'rejected' ? 'rejected' : 'completed';
      record.stage = record.status === 'completed' ? '核验完成，等待复核' : null;
      record.token = null;
    });
  }

  fail(id, token, error) {
    return this.updateJob(id, token, record => {
      record.status = 'failed';
      record.stage = null;
      record.token = null;
      record.error = { code: error?.code ?? 'VERIFICATION_FAILED', message: '核验失败，请手动重试。' };
    });
  }

  review(id, body) {
    const record = this.get(id);
    check(Number.isSafeInteger(body?.version) && body.version === record.version, 409, 'VERSION_CONFLICT', '记录已更新，请刷新后重新复核。');
    check(Object.keys(body).every(key => ['version', 'fields', 'conclusion'].includes(key)), 400, 'INVALID_REVIEW', '存在不支持的复核字段。');
    check(record.status === 'completed', 409, 'REVIEW_NOT_READY', '只有完成核验的记录可以复核。');
    check(body.fields == null || (typeof body.fields === 'object' && !Array.isArray(body.fields)), 400, 'INVALID_REVIEW', '复核字段格式不正确。');
    const input = body.fields ?? {};
    for (const [key, value] of Object.entries(input)) {
      check(FIELD_KEYS_SET.has(key) && (value === null || typeof value === 'string'), 400, 'INVALID_FIELD', '复核只接受 11 个字段的字符串或 null。');
    }
    const rawFields = {};
    for (const key of FIELD_KEYS) {
      const field = record.fields[key];
      rawFields[key] = {
        raw: Object.hasOwn(input, key) ? input[key] : (field?.raw ?? null),
        confidence: field?.confidence?.score ?? null,
        evidenceQuote: field?.evidence?.text ?? null,
      };
    }
    const normalized = normalizeFields(rawFields);
    const validation = validateCandidates(normalized.candidates, { referenceDate: record.referenceDate });
    const conclusion = body.conclusion ?? null;
    check(conclusion === null || ['approved', 'returned'].includes(conclusion), 400, 'INVALID_CONCLUSION', '复核结论无效。');
    if (conclusion === 'approved') check(validation.ok, 400, 'REVIEW_VALIDATION_FAILED', '复核后字段仍未通过 Schema 与业务校验。');

    record.review ??= { status: 'draft', revisions: {}, finalCandidates: {}, validation: null, events: [] };
    const events = [];
    for (const key of FIELD_KEYS) {
      if (!Object.hasOwn(input, key)) continue;
      const before = record.fields[key]?.raw ?? null;
      const after = input[key];
      if (before === after) {
        delete record.review.revisions[key];
        continue;
      }
      record.review.revisions[key] = after;
      events.push({ type: 'field', field: key, before, after, at: Date.now(), actor: 'local-demo-user' });
    }
    record.review.finalCandidates = normalized.candidates;
    record.review.validation = validation;
    record.review.status = conclusion === 'approved' ? 'approved' : conclusion === 'returned' ? 'returned' : 'draft';
    record.review.events.push(...events);
    record.review.events.push({ type: 'conclusion', before: null, after: record.review.status, at: Date.now(), actor: 'local-demo-user' });
    record.version += 1;
    return this.save(record);
  }

  delete(id, version) {
    const record = this.get(id);
    check(Number.isSafeInteger(version) && version === record.version, 409, 'VERSION_CONFLICT', '记录已更新，请刷新后删除。');
    this.db.prepare('DELETE FROM demo_records WHERE id=?').run(id);
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return true;
  }

  expired(now = Date.now()) {
    return this.db.prepare('SELECT body FROM demo_records WHERE expires_at<=?').all(now).map(row => JSON.parse(row.body));
  }

  recoverInterrupted() {
    for (const record of this.list()) {
      if (ACTIVE.has(record.status)) {
        record.status = 'failed';
        record.token = null;
        record.stage = null;
        record.error = { code: 'INTERRUPTED', message: '服务上次运行中断，请手动重试。' };
        this.save(record);
      }
    }
  }

  close() { this.db.close(); }
}

export { resultCode };
