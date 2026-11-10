import express from 'express';
import multer from 'multer';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateImage, UPLOAD_LIMITS } from '../images.js';
import { DemoStore } from './store.js';
import { DemoQueue } from './queue.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const VALID_MODES = new Set(['local-ocr', 'vision', 'vision-fc']);

class DemoError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function check(condition, status, code, message) {
  if (!condition) throw new DemoError(status, code, message);
}

function protectLocalRequest(req, res, next) {
  try {
    const host = new URL(`http://${req.headers.host}`);
    check(LOCAL_HOSTS.has(host.hostname) && !host.username && !host.password, 403, 'LOCAL_ONLY', '仅允许本机同源访问。');
    check(req.headers['sec-fetch-site'] !== 'cross-site', 403, 'CROSS_SITE', '不允许跨站访问。');
    const origin = req.headers.origin;
    if (origin) check(origin === `http://${host.host}`, 403, 'CROSS_ORIGIN', '不允许跨域访问。');
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    next();
  } catch (error) {
    next(error instanceof DemoError ? error : new DemoError(403, 'LOCAL_ONLY', '仅允许本机访问。'));
  }
}

function publicRecord({ token, imageFile, ...record }) {
  return record;
}

function entryMap(manifest) {
  return new Map((Array.isArray(manifest?.entries) ? manifest.entries : []).map(entry => [entry.sampleId, entry]));
}

function imagePath(imageRoot, record) {
  return join(imageRoot, record.id, `${record.id}.${record.mime === 'image/png' ? 'png' : 'jpg'}`);
}

export async function createDemoRuntime({ dataDir, config, manifest = { entries: [] }, sampleDir, pipeline = null, reportDir } = {}) {
  if (!dataDir) throw new TypeError('Demo runtime 需要独立的 dataDir。');
  if (!config || typeof config !== 'object') throw new TypeError('Demo runtime 需要 loadDemoConfig 产生的 config。');

  const root = resolve(dataDir);
  const imageRoot = join(root, 'images');
  const tempRoot = join(root, 'tmp');
  const entries = entryMap(manifest);
  const reportsDir = resolve(reportDir ?? join(root, 'reports'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(imageRoot, { recursive: true, mode: 0o700 });
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  await mkdir(reportsDir, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  for (const file of await readdir(tempRoot)) await rm(join(tempRoot, file), { force: true, recursive: true });
  const store = new DemoStore(join(root, 'records.sqlite'));
  await chmod(join(root, 'records.sqlite'), 0o600);
  store.recoverInterrupted();

  const app = express();
  app.disable('x-powered-by');
  app.locals.allowedOrigins = [];
  app.locals.reportDir = reportsDir;
  app.use(protectLocalRequest);
  app.use(express.json({ limit: '256kb', strict: true }));

  let mutationWindow = Date.now();
  let mutationCount = 0;
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (Date.now() - mutationWindow >= 60000) { mutationWindow = Date.now(); mutationCount = 0; }
      if (++mutationCount > 60) return next(new DemoError(429, 'RATE_LIMIT', '操作过于频繁，请稍后重试。'));
    }
    next();
  });

  const queue = new DemoQueue({
    store,
    onRun: async (job, signal, onStage) => {
      check(pipeline?.run, 503, 'VERIFICATION_UNAVAILABLE', '核验管线尚未配置。');
      const record = store.get(job.recordId);
      const buffer = await readFile(imagePath(imageRoot, record));
      return pipeline.run({
        buffer, filePath: imagePath(imageRoot, record), imageId: record.id, sampleId: record.sampleId,
        mode: job.mode, externalConfirmed: job.externalConfirmed, signal, onStage,
      });
    },
  });

  async function cleanup(now = Date.now()) {
    for (const record of store.expired(now)) {
      queue.cancel(record.id);
      await rm(join(imageRoot, record.id), { recursive: true, force: true });
      store.delete(record.id, record.version);
    }
  }
  await cleanup();
  const cleanupTimer = setInterval(() => { cleanup().catch(() => console.error('Demo 记录清理失败，将在下一周期重试。')); }, 60000);
  cleanupTimer.unref();

  app.get('/api/demo/health', (_req, res) => {
    res.json({ ok: true, localOnly: true, syntheticOnly: true, visionConfigured: config.visionConfigured === true });
  });

  app.get('/api/demo/samples', (_req, res) => {
    res.json({ samples: [...entries.values()].map(entry => ({
      sampleId: entry.sampleId, filename: entry.filename, scenario: entry.scenario,
      synthetic: entry.synthetic === true, watermark: entry.watermark === true, mime: entry.mime ?? 'image/png',
    })) });
  });

  app.get('/api/demo/samples/:sampleId/file', (req, res) => {
    const entry = entries.get(req.params.sampleId);
    check(entry && basename(entry.filename) === entry.filename, 404, 'SAMPLE_NOT_FOUND', '合成样例不存在。');
    res.type(entry.mime ?? 'image/png').sendFile(join(sampleDir, entry.filename), { dotfiles: 'deny' });
  });

  const upload = multer({
    storage: multer.diskStorage({ destination: tempRoot, filename: (_req, _file, done) => done(null, randomUUID()) }),
    limits: { fileSize: UPLOAD_LIMITS.maxFileBytes, files: 1, fields: 2, fieldSize: 1024, parts: 4 },
  }).single('file');
  let receiving = false;
  app.post('/api/demo/records', async (req, res) => {
    check(!receiving, 429, 'UPLOAD_BUSY', '已有文件正在上传，请稍后重试。');
    check(req.is('multipart/form-data'), 415, 'MULTIPART_REQUIRED', '请以合成图片文件上传。');
    receiving = true;
    let record;
    try {
      await new Promise((resolveUpload, reject) => upload(req, res, error => error ? reject(error) : resolveUpload()));
      check(req.file, 400, 'NO_FILE', '请选择一张合成样例图片。');
      check(Object.keys(req.body).every(key => key === 'sampleId'), 400, 'INVALID_FIELD', '上传仅接收 sampleId。');
      check(typeof req.body.sampleId === 'string' && entries.has(req.body.sampleId), 400, 'SYNTHETIC_ONLY', '仅允许本项目登记的合成样例。');
      const buffer = await readFile(req.file.path);
      const details = await validateImage(buffer, { name: req.file.originalname, mime: req.file.mimetype });
      const hash = createHash('sha256').update(buffer).digest('hex');
      const entry = entries.get(req.body.sampleId);
      check(hash === entry.sha256 && entry.synthetic === true && entry.watermark === true, 400, 'SYNTHETIC_ONLY', '文件与登记的合成样例哈希不一致。');
      record = store.create({ sampleId: req.body.sampleId, sha256: hash, mime: details.mime, size: details.size, mode: 'local-ocr' });
      const finalDirectory = join(imageRoot, record.id);
      await mkdir(finalDirectory, { mode: 0o700 });
      const finalPath = imagePath(imageRoot, record);
      await rename(req.file.path, finalPath);
      await chmod(finalPath, 0o600);
      record.imageFile = basename(finalPath);
      store.save(record);
      res.status(201).json(publicRecord(record));
    } catch (error) {
      if (record) {
        store.delete(record.id, record.version);
        await rm(join(imageRoot, record.id), { recursive: true, force: true });
      }
      throw error;
    } finally {
      if (req.file?.path) await rm(req.file.path, { force: true });
      receiving = false;
    }
  });

  app.get('/api/demo/records', (_req, res) => {
    res.json({ records: store.list().filter(record => record.expiresAt > Date.now()).map(publicRecord) });
  });

  app.get('/api/demo/records/:id', (req, res) => {
    res.json(publicRecord(store.get(req.params.id)));
  });

  app.get('/api/demo/records/:id/file', (req, res) => {
    const record = store.get(req.params.id);
    res.type(record.mime).sendFile(imagePath(imageRoot, record), { dotfiles: 'allow' });
  });

  app.post('/api/demo/records/:id/run', (req, res) => {
    const record = store.get(req.params.id);
    check(record.expiresAt > Date.now(), 410, 'TASK_EXPIRED', 'Demo 记录已到期。');
    check(VALID_MODES.has(req.body?.mode), 400, 'INVALID_MODE', '核验模式无效。');
    const vision = req.body.mode !== 'local-ocr';
    if (vision) {
      check(req.body.externalConfirmed === true, 400, 'EXTERNAL_CONFIRMATION_REQUIRED', '视觉模式必须显式确认外部调用。');
      check(config.vision, 503, 'VISION_NOT_CONFIGURED', '视觉服务尚未配置。');
    }
    queue.add({ recordId: record.id, version: req.body.version, mode: req.body.mode, externalConfirmed: req.body.externalConfirmed === true });
    res.status(202).json(publicRecord(store.get(record.id)));
  });

  app.patch('/api/demo/records/:id/review', (req, res) => {
    res.json(publicRecord(store.review(req.params.id, req.body)));
  });

  app.delete('/api/demo/records/:id', async (req, res) => {
    const record = store.get(req.params.id);
    queue.cancel(record.id);
    store.delete(record.id, req.body?.version);
    await rm(join(imageRoot, record.id), { recursive: true, force: true });
    res.status(204).end();
  });

  const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  app.get('/api/demo/reports', async (_req, res) => {
    try {
      res.json({ reports: JSON.parse(await readFile(join(reportsDir, 'index.json'), 'utf8')) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      res.json({ reports: [] });
    }
  });

  app.get('/api/demo/reports/:runId', async (req, res) => {
    check(RUN_ID.test(req.params.runId), 404, 'REPORT_NOT_FOUND', '评测报告不存在。');
    try {
      res.json(JSON.parse(await readFile(join(reportsDir, req.params.runId, 'report.json'), 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new DemoError(404, 'REPORT_NOT_FOUND', '评测报告不存在。');
    }
  });

  app.get('/api/demo/reports/:runId/export', async (req, res) => {
    check(RUN_ID.test(req.params.runId), 404, 'REPORT_NOT_FOUND', '评测报告不存在。');
    const files = {
      json: ['report.json', 'application/json'],
      'field-csv': ['field-accuracy.csv', 'text/csv; charset=utf-8'],
      'samples-csv': ['samples.csv', 'text/csv; charset=utf-8'],
      markdown: ['summary.md', 'text/markdown; charset=utf-8'],
    };
    const selected = files[req.query.format];
    check(selected, 400, 'INVALID_FORMAT', '导出格式无效。');
    res.type(selected[1]).sendFile(join(reportsDir, req.params.runId, selected[0]), { dotfiles: 'deny' });
  });

  app.use('/api', (_req, _res, next) => next(new DemoError(404, 'NOT_FOUND', '接口不存在。')));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    res.type('application/json');
    if (error instanceof multer.MulterError) {
      const tooLarge = ['LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT', 'LIMIT_PART_COUNT', 'LIMIT_UNEXPECTED_FILE'].includes(error.code);
      return res.status(tooLarge ? 413 : 400).json({ error: { code: error.code, message: tooLarge ? '上传超过限制：仅一张 10 MB 内合成图片。' : '上传表单格式不正确。' } });
    }
    if (error instanceof SyntaxError) return res.status(400).json({ error: { code: 'INVALID_JSON', message: '请求格式不正确。' } });
    const status = error instanceof DemoError ? error.status
      : Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    const code = error instanceof DemoError || typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR';
    return res.status(status).json({
      error: {
        code,
        message: status < 500 ? error.message : 'Demo 服务处理失败，请稍后重试。',
      },
    });
  });

  return {
    app, store, queue, dataDir: root, cleanup,
    async close() { clearInterval(cleanupTimer); await queue.close(); store.close(); },
  };
}
