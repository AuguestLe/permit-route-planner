import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import express from 'express';
import { createDemoRuntime } from './app.js';
import { loadDemoConfig } from './config.js';
import { createRecognizer } from '../ocr.js';
import { createLocalAdapter } from './adapters/local.js';
import { createVisionAdapter } from './adapters/vision.js';
import { createPipeline } from './pipeline.js';
import { inspectQuality } from './quality.js';

process.umask(0o077);

const CSP = "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";
const root = fileURLToPath(new URL('../../', import.meta.url));
const distDir = join(root, 'dist-demo');
const sampleDir = join(root, 'demo', 'samples');
const reportDir = join(root, 'demo', 'reports');

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function mountDemoStatic(app, directory) {
  app.use((_req, res, next) => {
    res.set('Content-Security-Policy', CSP);
    next();
  });
  app.get('/', (_req, res) => res.redirect(302, '/demo.html'));
  app.use(express.static(directory, { dotfiles: 'deny' }));
}

let runtime;
let server;
try {
  const config = loadDemoConfig(process.env);
  const manifest = JSON.parse(await readFile(join(sampleDir, 'manifest.json'), 'utf8'));
  const localAdapter = createLocalAdapter({ recognize: createRecognizer() });
  const visionAdapter = config.vision ? createVisionAdapter({ config: config.vision }) : null;
  const pipeline = createPipeline({ manifest, config, quality: inspectQuality, localAdapter, visionAdapter });
  runtime = await createDemoRuntime({
    dataDir: join(root, '.data-demo'), config, manifest, sampleDir, reportDir, pipeline,
  });
  if (await isDirectory(distDir)) mountDemoStatic(runtime.app, distDir);

  server = createServer(runtime.app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(4318, '127.0.0.1', resolve);
  });
  console.log('本地 Demo 服务已启动：http://127.0.0.1:4318（仅本机，合成数据）');
} catch (error) {
  console.error(error.code === 'EADDRINUSE' ? '端口 4318 已占用，请勿重复启动 Demo 服务。' : `Demo 服务启动失败：${error.message}`);
  server?.close();
  server?.closeAllConnections?.();
  await runtime?.close();
  process.exitCode = 1;
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server?.close();
  server?.closeAllConnections?.();
  await runtime?.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
