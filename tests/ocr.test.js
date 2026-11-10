import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import englishModel from '@tesseract.js-data/eng';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { before, test } from 'node:test';
import sharp from 'sharp';
import { AppError } from '../server/errors.js';
import { createRecognizer } from '../server/ocr.js';
import { createSyntheticSample } from '../scripts/verify-ocr.mjs';

const exec = promisify(execFile);
let samplePath;
before(async () => { samplePath = await createSyntheticSample(); });

function errorCode(code) {
  return (error) => error instanceof AppError && error.code === code && !error.message.includes(samplePath);
}

async function assertNoOcrChild() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'ppid=,command=']);
  const ownChildren = stdout.split('\n').filter((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    return match && Number(match[1]) === process.pid && !match[2].startsWith('/bin/ps ');
  });
  assert.equal(ownChildren.length, 0, 'recognition must reap its child before settling');
}

test('recognizes hand-expected Chinese and English with the real local engine', { timeout: 120_000 }, async () => {
  const stages = [];
  const result = await createRecognizer()(samplePath, 'synthetic-test', (stage) => stages.push(stage));
  assert.match(result.text, /LOCAL OCR TEST/i);
  assert.match(result.text.replace(/\s/g, ''), /通行路线|测试样本/);
  assert.equal(result.engine, 'Tesseract');
  assert.deepEqual(result.languages, ['chi_sim', 'eng']);
  // 原生纯文本输出没有置信度，不生成替代数值。
  assert.equal(result.confidence, null);
  assert.ok(stages.includes('识别文字'));
  assert.ok(stages.every((stage) => typeof stage === 'string' && !stage.includes('LOCAL OCR TEST')));
  await assertNoOcrChild();
});

test('本地路径包含空格和 shell 字符仍可识别', async t => {
  const path = join(dirname(samplePath), "证件 ' ; $(echo test).png");
  await copyFile(samplePath, path);
  t.after(() => rm(path, { force: true }));
  const result = await createRecognizer()(path, 'special-path');
  assert.match(result.text, /LOCAL OCR TEST/i);
  await assertNoOcrChild();
});

test('原生引擎非零退出及超量输出均受控失败，不残留进程', async () => {
  for (const tesseractPath of ['/usr/bin/false', '/usr/bin/yes']) {
    await assert.rejects(createRecognizer({ tesseractPath })(samplePath, 'failed-engine'), errorCode('OCR_FAILED'));
    await assertNoOcrChild();
  }
});

test('进度回调抛错或拒绝会结束当前原生识别', async () => {
  for (const asynchronous of [false, true]) {
    await assert.rejects(createRecognizer()(samplePath, 'failed-progress', stage => {
      if (stage !== '识别文字') return;
      if (asynchronous) return Promise.reject(new Error('sensitive stage failure'));
      throw new Error('sensitive stage failure');
    }), errorCode('OCR_FAILED'));
    await assertNoOcrChild();
  }
});

test('超时会杀死已启动的原生进程', async t => {
  const path = join(dirname(samplePath), 'slow tesseract');
  // 受控外部进程只用于验证超时，不模拟 OCR 成功结果。
  await writeFile(path, '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o700 });
  t.after(() => rm(path, { force: true }));
  let started = false;
  await assert.rejects(createRecognizer({ timeoutMs: 2000, tesseractPath: path })(samplePath, 'slow-engine', stage => {
    if (stage === '识别文字') started = true;
  }), errorCode('OCR_TIMEOUT'));
  assert.equal(started, true);
  await assertNoOcrChild();
});

test('中文模型损坏时不能仅使用英文模型并宣告成功', async t => {
  const dir = await mkdtemp(join(dirname(samplePath), 'broken-tessdata-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const english = gunzipSync(await readFile(join(englishModel.langPath, 'eng.traineddata.gz')));
  await writeFile(join(dir, 'eng.traineddata'), english);
  await writeFile(join(dir, 'chi_sim.traineddata'), 'invalid model');
  await assert.rejects(createRecognizer({ tessdataDir: dir })(samplePath, 'broken-model'), errorCode('OCR_MODEL_MISSING'));
  await assertNoOcrChild();
});

test('missing native executable returns an actionable error instead of falling back to JavaScript', async () => {
  await assert.rejects(
    createRecognizer({ tesseractPath: join(dirname(samplePath), 'missing-tesseract') })(samplePath, 'missing-engine'),
    errorCode('OCR_ENGINE_MISSING'),
  );
  await assertNoOcrChild();
});

test('explicit model directory must contain both Chinese and English models', async () => {
  await assert.rejects(
    createRecognizer({ tessdataDir: dirname(samplePath) })(samplePath, 'missing-models'),
    errorCode('OCR_MODEL_MISSING'),
  );
  await assertNoOcrChild();
});

test('cancelling an active native process reaps it before rejecting', async () => {
  const controller = new AbortController();
  let started = false;
  await assert.rejects(createRecognizer()(samplePath, 'cancel-native', stage => {
    if (stage === '识别文字') {
      started = true;
      controller.abort();
    }
  }, controller.signal), errorCode('ABORTED'));
  assert.equal(started, true);
  await assertNoOcrChild();
});

test('a 1ms timeout includes engine initialization and reaps its child', async () => {
  const started = performance.now();
  await assert.rejects(createRecognizer({ timeoutMs: 1 })(samplePath, 'timeout'), errorCode('OCR_TIMEOUT'));
  assert.ok(performance.now() - started < 5000);
  await assertNoOcrChild();
});

test('pre-aborted recognition starts no child or progress notifications', async () => {
  const controller = new AbortController();
  controller.abort();
  let stageCount = 0;
  await assert.rejects(
    createRecognizer()(samplePath, 'aborted', () => { stageCount += 1; }, controller.signal),
    errorCode('ABORTED'),
  );
  assert.equal(stageCount, 0);
  await assertNoOcrChild();
});

test('cancellation during real engine startup kills that job without residual work', async () => {
  const controller = new AbortController();
  let sawEngine = false;
  await assert.rejects(createRecognizer()(samplePath, 'cancel-startup', (stage) => {
    if (stage === '加载识别引擎') {
      sawEngine = true;
      controller.abort();
    }
  }, controller.signal), errorCode('ABORTED'));
  assert.equal(sawEngine, true);
  await assertNoOcrChild();
});

test('rejects URL, relative, directory and missing paths with sanitized application errors', async () => {
  const recognize = createRecognizer();
  for (const path of ['https://example.invalid/private.png', 'file:///tmp/private.png', '//host/private.png', 'private.png', null]) {
    await assert.rejects(recognize(path, 'invalid'), errorCode('INVALID_OCR_PATH'));
  }
  await assert.rejects(recognize(dirname(samplePath), 'directory'), errorCode('INVALID_OCR_PATH'));
  await assert.rejects(recognize(join(dirname(samplePath), 'does-not-exist.png'), 'missing'), errorCode('OCR_FILE_MISSING'));
  await assertNoOcrChild();
});

test('real blank-image output is NO_TEXT, not invented text or confidence', { timeout: 120_000 }, async () => {
  const blankPath = join(dirname(samplePath), 'ocr-blank.png');
  try {
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#fff' } }).png().toFile(blankPath);
    await assert.rejects(createRecognizer()(blankPath, 'blank'), errorCode('NO_TEXT'));
    await assertNoOcrChild();
  } finally {
    await rm(blankPath, { force: true });
  }
});
