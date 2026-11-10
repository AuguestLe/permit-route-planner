import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRuntime } from './app.js';
import { createRecognizer } from './ocr.js';

process.umask(0o077);
const root = fileURLToPath(new URL('../', import.meta.url));
let runtime;
const server = createServer((req, res) => {
  if (runtime) return runtime.app(req, res);
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'STARTING', message: '本地服务正在启动。' } }));
});

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(4317, '127.0.0.1', resolve);
  });
  runtime = await createRuntime({ dataDir: `${root}.data`, recognize: createRecognizer(), development: process.env.NODE_ENV === 'development', distDir: `${root}dist` });
  console.log('本地 OCR 服务已启动：http://127.0.0.1:4317（仅本机，图片保留 7 天）');
} catch (error) {
  console.error(error.code === 'EADDRINUSE' ? '端口 4317 已占用，请勿重复启动本地服务。' : '服务启动失败，请检查本地依赖与数据目录权限。');
  server.close();
  process.exitCode = 1;
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  await runtime?.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
