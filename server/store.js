import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { check } from './errors.js';
import { FIELD_LABELS } from './fields.js';

const FIELD_KEYS = new Set(Object.keys(FIELD_LABELS));
const ACTIVE = new Set(['queued', 'recognizing']);
const DAYS_7 = 7 * 86400000;

function summarize(task) {
  const images = task.images;
  task.status = images.some(i => ACTIVE.has(i.status)) ? 'recognizing'
    : images.every(i => i.status === 'failed') ? 'failed'
      : images.some(i => i.status === 'succeeded') ? 'needs_correction' : 'draft';
  task.warnings = [];
  for (const key of ['plateNumber', 'validFrom', 'validTo']) {
    const values = new Set(images.map(i => i.revision?.fields[key]).filter(Boolean).map(v => v.replace(/\s/g, '').toUpperCase()));
    if (values.size > 1) task.warnings.push(key === 'plateNumber' ? '多张图片的车牌存在冲突，请核对是否属于同一趟运输。' : '多张图片的有效期存在差异，请人工确认有效期与跨省衔接。');
  }
  images.forEach((image, index) => {
    if (image.status === 'succeeded' && !image.revision?.fields.passRoute?.trim()) task.warnings.push(`第 ${index + 1} 张图片缺少通行路线，请对照原图补充。`);
  });
  if (images.length > 1) task.warnings.push('图片按当前顺序排列；多证路线连接关系需人工核对，不自动合并车辆或补齐路线。');
  return task;
}

export class TaskStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, body TEXT NOT NULL)');
  }

  create({ name, images, requestKey, fingerprint = '', now = Date.now(), id = randomUUID() }) {
    const task = summarize({ id, name, version: 1, createdAt: now, updatedAt: now, expiresAt: now + DAYS_7, images: images.map(image => ({ ...image, status: 'pending', stage: null, error: null, original: null, revision: null, token: null })) });
    this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?)').run(id, requestKey, fingerprint, task.expiresAt, now, JSON.stringify(task));
    return task;
  }

  findRequest(key) {
    const row = this.db.prepare('SELECT body,fingerprint FROM tasks WHERE request_key=?').get(key);
    return row ? { task: JSON.parse(row.body), fingerprint: row.fingerprint } : null;
  }

  get(id) {
    const row = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(id);
    check(row, 404, 'TASK_NOT_FOUND', '任务不存在或已清理。');
    return JSON.parse(row.body);
  }

  list() {
    return this.db.prepare('SELECT body FROM tasks ORDER BY created_at DESC LIMIT 100').all().map(row => JSON.parse(row.body));
  }

  save(task) {
    task.updatedAt = Date.now();
    summarize(task);
    this.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(task), task.id);
    return task;
  }

  checkVersion(task, version) {
    check(!task.deleting, 409, 'TASK_DELETING', '任务正在删除，无法再修改或识别。');
    check(Number.isSafeInteger(version) && version === task.version, 409, 'VERSION_CONFLICT', '任务已更新，请刷新后重新校对；当前未保存内容不会自动覆盖。');
  }

  markDeleting(id, version) {
    const task = this.get(id);
    this.checkVersion(task, version);
    task.deleting = true;
    this.save(task);
  }

  pendingDeletion() {
    return this.db.prepare("SELECT body FROM tasks WHERE json_extract(body, '$.deleting')=1").all().map(row => JSON.parse(row.body));
  }

  edit(id, body) {
    const task = this.get(id);
    this.checkVersion(task, body.version);
    check(Object.keys(body).every(key => ['version', 'name', 'order', 'revisions'].includes(key)), 400, 'INVALID_EDIT', '存在不支持的修改字段。');
    if (body.name !== undefined) {
      check(typeof body.name === 'string' && body.name.trim().length > 0 && body.name.length <= 100, 400, 'INVALID_NAME', '任务名称须为 1～100 个字符。');
      task.name = body.name.trim();
    }
    if (body.order !== undefined) {
      const order = body.order;
      check(Array.isArray(order) && order.length === task.images.length && new Set(order).size === order.length && order.every(id => task.images.some(i => i.id === id)), 400, 'INVALID_ORDER', '图片排序必须包含全部图片且不可重复。');
      task.images = order.map(id => task.images.find(i => i.id === id));
    }
    if (body.revisions !== undefined) {
      check(Array.isArray(body.revisions) && body.revisions.length <= 10 && new Set(body.revisions.map(i => i?.imageId)).size === body.revisions.length, 400, 'INVALID_REVISION', '校对数据格式不正确。');
      for (const revision of body.revisions) {
        const image = task.images.find(i => i.id === revision?.imageId);
        check(image?.original && revision.fields && typeof revision.fields === 'object' && !Array.isArray(revision.fields), 400, 'INVALID_REVISION', '请先识别图片，再保存校对字段。');
        for (const [key, value] of Object.entries(revision.fields)) {
          check(FIELD_KEYS.has(key) && (value === null || (typeof value === 'string' && value.length <= (key === 'passRoute' ? 20000 : 500))), 400, 'INVALID_FIELD', '校对字段不支持或文本过长。');
          image.revision.fields[key] = typeof value === 'string' ? value.trim() || null : null;
        }
      }
    }
    task.version++;
    return this.save(task);
  }

  enqueue(id, imageIds, version) {
    const task = this.get(id);
    this.checkVersion(task, version);
    check(imageIds.every(id => task.images.some(i => i.id === id)), 404, 'IMAGE_NOT_FOUND', '图片不存在。');
    const jobs = [];
    for (const image of task.images) {
      if (!imageIds.includes(image.id) || ACTIVE.has(image.status) || image.status === 'succeeded') continue;
      image.token = randomUUID();
      image.status = 'queued';
      image.stage = '等待本地识别';
      image.error = null;
      jobs.push({ taskId: id, imageId: image.id, token: image.token, filename: image.filename });
    }
    this.save(task);
    return jobs;
  }

  updateJob(id, imageId, token, action) {
    const row = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(id);
    if (!row) return false;
    const task = JSON.parse(row.body);
    const image = task.images.find(i => i.id === imageId);
    if (task.deleting || !image || image.token !== token || !ACTIVE.has(image.status)) return false;
    action(image);
    this.save(task);
    return true;
  }

  stage(id, imageId, token, stage) {
    return this.updateJob(id, imageId, token, image => { image.status = 'recognizing'; image.stage = stage; });
  }

  complete(id, imageId, token, result) {
    return this.updateJob(id, imageId, token, image => {
      image.original = result;
      image.revision ??= { fields: Object.fromEntries(Object.entries(result.fields).map(([key, field]) => [key, field.value])) };
      image.status = 'succeeded';
      image.stage = '识别完成，等待人工校对';
      image.error = null;
      image.token = null;
    });
  }

  fail(id, imageId, token, code, message) {
    return this.updateJob(id, imageId, token, image => { image.status = 'failed'; image.stage = null; image.error = { code, message }; image.token = null; });
  }

  recoverInterrupted() {
    const rows = this.db.prepare('SELECT body FROM tasks').all();
    for (const row of rows) {
      const task = JSON.parse(row.body);
      let changed = false;
      for (const image of task.images) {
        if (ACTIVE.has(image.status)) {
          Object.assign(image, { status: 'failed', stage: null, token: null, error: { code: 'INTERRUPTED', message: '服务上次运行中断，请手动重试此图片。' } });
          changed = true;
        }
      }
      if (changed) this.save(task);
    }
  }

  expired(now = Date.now()) {
    return this.db.prepare('SELECT body FROM tasks WHERE expires_at<=?').all(now).map(row => JSON.parse(row.body));
  }

  delete(id) {
    this.db.prepare('DELETE FROM tasks WHERE id=?').run(id);
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close() { this.db.close(); }
}
