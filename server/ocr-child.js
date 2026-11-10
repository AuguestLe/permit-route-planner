import { access, readFile, stat, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { UPLOAD_LIMITS } from './images.js';

const require = createRequire(import.meta.url);
const decompress = promisify(gunzip);

function send(message, done) {
  if (!process.connected) return process.exit(1);
  try {
    process.send(message, (error) => {
      if (error) process.exit(1);
      done?.();
    });
  } catch {
    process.exit(1);
  }
}

async function prepareModels(tessdataDir) {
  const modelDirectory = tessdataDir ?? fileURLToPath(new URL('../.data/ocr-models/native/', import.meta.url));
  if (!tessdataDir) await mkdir(modelDirectory, { recursive: true, mode: 0o700 });
  for (const code of ['chi_sim', 'eng']) {
    const destination = join(modelDirectory, `${code}.traineddata`);
    try {
      await access(destination, constants.R_OK);
    } catch (error) {
      // 显式指定的目录严格使用其内容，不联网下载或回退到其他模型。
      if (tessdataDir || error.code !== 'ENOENT') throw error;
      const archive = await readFile(join(require(`@tesseract.js-data/${code}`).langPath, `${code}.traineddata.gz`));
      const data = await decompress(archive, { maxOutputLength: 64 * 1024 ** 2 });
      const temporary = join(modelDirectory, `${code}.${process.pid}.tmp`);
      try {
        await writeFile(temporary, data, { mode: 0o600 });
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    const details = await stat(destination);
    if (!details.isFile() || details.size === 0 || details.size > 64 * 1024 ** 2) throw new Error();
  }
  return modelDirectory;
}

async function prepare({ filePath, tessdataDir } = {}) {
  let response;
  let failureCode = 'INVALID_OCR_PATH';
  try {
    if (typeof filePath !== 'string' || !isAbsolute(filePath) || filePath.startsWith('//') || filePath.includes('\0')) throw new Error();
    failureCode = 'OCR_FILE_MISSING';
    const details = await stat(filePath);
    failureCode = 'INVALID_OCR_PATH';
    if (!details.isFile()) throw new Error();
    failureCode = 'INVALID_IMAGE';
    if (details.size === 0 || details.size > UPLOAD_LIMITS.maxFileBytes) throw new Error();
    send({ type: 'stage', stage: '预处理图片' });
    const source = sharp(filePath, { failOn: 'warning', limitInputPixels: UPLOAD_LIMITS.maxPixels });
    const metadata = await source.metadata();
    if (!['png', 'jpeg'].includes(metadata.format) || (metadata.pages ?? 1) !== 1) throw new Error();
    const image = await source.rotate()
      .resize({ width: 3500, height: 3500, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#fff' }).grayscale().png().toBuffer();

    failureCode = 'OCR_MODEL_MISSING';
    send({ type: 'stage', stage: '读取本地模型' });
    const modelDirectory = await prepareModels(tessdataDir);
    response = { type: 'prepared', image, modelDirectory };
  } catch {
    response = { type: 'error', code: failureCode };
  }
  // 图片仅在内存和本地 IPC 中流转，不额外落盘，不启动原生引擎孙进程。
  send(response, () => process.exit(0));
}

if (typeof process.send !== 'function') {
  process.exitCode = 1;
} else {
  process.once('disconnect', () => process.exit(0));
  process.once('message', (message) => {
    prepare(message).catch(() => send({ type: 'error', code: 'OCR_FAILED' }, () => process.exit(1)));
  });
}
