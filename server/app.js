import express from 'express';
import multer from 'multer';
import { mkdir, readdir, readFile, rename, rm, chmod } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TaskStore } from './store.js';
import { OcrQueue } from './queue.js';
import { OCR_INFO } from './ocr.js';
import { validateImage, UPLOAD_LIMITS } from './images.js';
import { AppError, check } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const publicTask = task => ({ ...task, images: task.images.map(({ filename, token, ...image }) => image) });

function protectLocalRequest(req, res, next) {
  try {
    const host = new URL(`http://${req.headers.host}`);
    check(LOCAL_HOSTS.has(host.hostname) && !host.username && !host.password, 403, 'LOCAL_ONLY', '仅允许本机同源访问。');
    check(req.headers['sec-fetch-site'] !== 'cross-site', 403, 'CROSS_SITE', '不允许跨站访问。');
    const origin = req.headers.origin;
    if (origin) {
      check(origin === `http://${host.host}` || req.app.locals.allowedOrigins.includes(origin), 403, 'CROSS_ORIGIN', '不允许跨域访问。');
    }
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    next();
  } catch (error) {
    next(error instanceof AppError ? error : new AppError(403, 'LOCAL_ONLY', '仅允许本机访问。'));
  }
}

export async function createRuntime({ dataDir, recognize, development = false, distDir } = {}) {
  const root = resolve(dataDir);
  const tempRoot = join(root, 'tmp');
  const imageRoot = join(root, 'images');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  await mkdir(imageRoot, { recursive: true, mode: 0o700 });
  for (const file of await readdir(tempRoot)) await rm(join(tempRoot, file), { recursive: true, force: true });
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  await chmod(join(root, 'tasks.sqlite'), 0o600);
  store.recoverInterrupted();
  for (const directory of await readdir(imageRoot)) {
    if (!UUID.test(directory)) continue;
    try { store.get(directory); } catch (error) {
      if (error.status !== 404) throw error;
      await rm(join(imageRoot, directory), { recursive: true, force: true });
    }
  }
  const queue = new OcrQueue(store, imageRoot, recognize);
  const app = express();
  app.disable('x-powered-by');
  app.locals.allowedOrigins = development ? ['http://127.0.0.1:5174', 'http://localhost:5174'] : [];
  app.use(protectLocalRequest);
  app.use(express.json({ limit: '256kb', strict: true }));
  let mutationWindow = Date.now();
  let mutationCount = 0;
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (Date.now() - mutationWindow >= 60000) { mutationWindow = Date.now(); mutationCount = 0; }
      if (++mutationCount > 60) return next(new AppError(429, 'RATE_LIMIT', '操作过于频繁，请一分钟后重试。'));
      if (req.is('application/json') && (!req.body || Array.isArray(req.body))) return next(new AppError(400, 'INVALID_BODY', '请求必须是 JSON 对象。'));
    }
    next();
  });

  function activeTask(id) {
    check(UUID.test(id), 404, 'TASK_NOT_FOUND', '任务不存在。');
    const task = store.get(id);
    check(!task.deleting, 409, 'TASK_DELETING', '任务正在删除，无法再修改或识别。');
    check(task.expiresAt > Date.now(), 410, 'TASK_EXPIRED', '任务已到期，请新建任务。');
    return task;
  }

  async function removeTask(task) {
    if (!task.deleting) store.markDeleting(task.id, task.version);
    queue.cancel(task.id);
    await rm(join(imageRoot, task.id), { recursive: true, force: true });
    store.delete(task.id);
  }
  async function cleanup(now = Date.now()) {
    const pending = new Map([...store.expired(now), ...store.pendingDeletion()].map(task => [task.id, task]));
    for (const task of pending.values()) await removeTask(task);
  }
  await cleanup();
  const cleanupTimer = setInterval(() => { cleanup().catch(() => console.error('任务清理失败，将在下一周期重试。')); }, 60000);
  cleanupTimer.unref();

  app.get('/api/health', (_req, res) => res.json({ ok: true, ...OCR_INFO, localOnly: true, retentionDays: 7 }));
  app.get('/api/tasks', (_req, res) => res.json({ tasks: store.list().filter(t => !t.deleting && t.expiresAt > Date.now()).map(t => ({ id: t.id, name: t.name, version: t.version, status: t.status, createdAt: t.createdAt, expiresAt: t.expiresAt, imageCount: t.images.length, recognizedCount: t.images.filter(i => i.status === 'succeeded').length })) }));

  const upload = multer({
    storage: multer.diskStorage({ destination: tempRoot, filename: (_req, _file, done) => done(null, randomUUID()) }),
    limits: { fileSize: UPLOAD_LIMITS.maxFileBytes, files: UPLOAD_LIMITS.maxFiles, fields: 2, fieldSize: 1024, parts: 13 },
  }).array('files', UPLOAD_LIMITS.maxFiles);
  let receiving = false;
  app.post('/api/tasks', async (req, res) => {
    check(!receiving, 429, 'UPLOAD_BUSY', '已有图片正在上传，请稍后重试。');
    const key = req.get('Idempotency-Key');
    check(typeof key === 'string' && UUID.test(key), 400, 'INVALID_REQUEST_KEY', '上传请求缺少有效的防重复标识。');
    check(req.is('multipart/form-data'), 415, 'MULTIPART_REQUIRED', '请以图片文件表单上传。');
    receiving = true;
    let finalDirectory;
    let saved = false;
    try {
      await new Promise((resolve, reject) => upload(req, res, error => error ? reject(error) : resolve()));
      check(Object.keys(req.body).every(key => key === 'name'), 400, 'INVALID_FIELD', '上传仅接收任务名称和图片文件，不接收远程链接。');
      check(typeof req.body.name === 'string' && req.body.name.trim() && req.body.name.length <= 100, 400, 'INVALID_NAME', '请输入 1～100 个字符的任务名称。');
      check(req.files?.length >= 1, 400, 'NO_IMAGES', '请选择至少一张图片。');
      check(req.files.reduce((sum, f) => sum + f.size, 0) <= UPLOAD_LIMITS.maxTotalBytes, 413, 'TOTAL_TOO_LARGE', '每个任务图片总量不得超过 50 MB。');
      const images = [];
      const hashes = [];
      for (const file of req.files) {
        const buffer = await readFile(file.path);
        const details = await validateImage(buffer, { name: file.originalname, mime: file.mimetype });
        const id = randomUUID();
        let originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        if (originalName.includes('\ufffd')) originalName = file.originalname;
        originalName = basename(originalName).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
        images.push({ id, filename: `${id}.${details.extension}`, originalName, mime: details.mime, width: details.width, height: details.height, size: details.size });
        hashes.push(createHash('sha256').update(buffer).digest('hex'));
      }
      const fingerprint = createHash('sha256').update(JSON.stringify([req.body.name.trim(), hashes])).digest('hex');
      const existing = store.findRequest(key);
      if (existing) {
        check(existing.fingerprint === fingerprint, 409, 'REQUEST_KEY_REUSED', '同一上传标识不可用于不同的图片，请新建上传请求。');
        activeTask(existing.task.id);
        return res.status(200).json(publicTask(existing.task));
      }
      const id = randomUUID();
      finalDirectory = join(imageRoot, id);
      await mkdir(finalDirectory, { mode: 0o700 });
      for (let i = 0; i < images.length; i++) {
        const target = join(finalDirectory, images[i].filename);
        await rename(req.files[i].path, target);
        await chmod(target, 0o600);
      }
      const task = store.create({ id, name: req.body.name.trim(), images, requestKey: key, fingerprint });
      saved = true;
      res.status(201).json(publicTask(task));
    } finally {
      try {
        await Promise.all((req.files || []).map(file => rm(file.path, { force: true })));
        if (finalDirectory && !saved) await rm(finalDirectory, { recursive: true, force: true });
      } finally { receiving = false; }
    }
  });

  app.get('/api/tasks/:id', (req, res) => res.json(publicTask(activeTask(req.params.id))));
  app.get('/api/tasks/:id/images/:imageId/file', (req, res) => {
    const task = activeTask(req.params.id);
    const image = task.images.find(i => i.id === req.params.imageId);
    check(image, 404, 'IMAGE_NOT_FOUND', '图片不存在。');
    res.type(image.mime).set('Content-Disposition', `inline; filename="${image.filename}"`).sendFile(join(imageRoot, task.id, image.filename), { dotfiles: 'allow' });
  });
  app.patch('/api/tasks/:id', (req, res) => {
    activeTask(req.params.id);
    check(req.body && typeof req.body === 'object', 400, 'INVALID_BODY', '缺少校对内容。');
    res.json(publicTask(store.edit(req.params.id, req.body)));
  });
  app.post('/api/tasks/:id/recognize', (req, res) => {
    const task = activeTask(req.params.id);
    queue.add(task.id, task.images.filter(i => i.status === 'pending').map(i => i.id), req.body?.version);
    res.status(202).json(publicTask(store.get(task.id)));
  });
  app.post('/api/tasks/:id/images/:imageId/retry', (req, res) => {
    const task = activeTask(req.params.id);
    const image = task.images.find(i => i.id === req.params.imageId);
    check(image, 404, 'IMAGE_NOT_FOUND', '图片不存在。');
    check(image.status !== 'succeeded', 409, 'ALREADY_RECOGNIZED', '此图片已识别成功，请直接校对，不重复识别。');
    queue.add(task.id, [image.id], req.body?.version);
    res.status(202).json(publicTask(store.get(task.id)));
  });
  app.delete('/api/tasks/:id', async (req, res) => {
    const task = activeTask(req.params.id);
    store.checkVersion(task, req.body?.version);
    await removeTask(task);
    res.status(204).end();
  });
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'NOT_FOUND', '接口不存在。')));
  if (distDir) {
    app.use((_req, res, next) => { res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"); next(); });
    app.use(express.static(resolve(distDir), { dotfiles: 'deny' }));
  }
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    res.type('application/json');
    if (error instanceof multer.MulterError) {
      const tooLarge = ['LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT', 'LIMIT_PART_COUNT', 'LIMIT_UNEXPECTED_FILE'].includes(error.code);
      return res.status(tooLarge ? 413 : 400).json({ error: { code: error.code, message: tooLarge ? '上传超过限制：最多 10 张、单张 10 MB、总量 50 MB。' : '上传表单格式不正确。' } });
    }
    if (error.type === 'entity.too.large') return res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message: '请求内容过大。' } });
    if (error instanceof SyntaxError) return res.status(400).json({ error: { code: 'INVALID_JSON', message: '请求格式不正确。' } });
    const status = error instanceof AppError ? error.status : 500;
    res.status(status).json({ error: { code: error instanceof AppError ? error.code : 'INTERNAL_ERROR', message: error instanceof AppError ? error.message : '本地服务处理失败，请稍后重试。' } });
  });
  return { app, store, queue, cleanup, async close() { clearInterval(cleanupTimer); await queue.close(); store.close(); } };
}
