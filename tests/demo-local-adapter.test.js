import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalAdapter } from '../server/demo/adapters/local.js';

const text = [
  '证件编号：DEMO-PERMIT-0001',
  '车牌号码：DEMO-A0001',
  '签发地区：示 例 省',
  '车货总宽：320 厘 米',
  '车货总长：18米',
  '通行路线：示例入口-S01-示例出口',
  '备注：全部编号均为虚构合成数据，不可用于验收',
].join('\n');

test('local adapter maps raw evidence and never invents confidence', async () => {
  const adapter = createLocalAdapter({ recognize: async () => ({ text, confidence: null, engine: 'Tesseract', languages: ['chi_sim', 'eng'] }) });
  const result = await adapter.run({ filePath: '/tmp/SYN-001.png', imageId: 'SYN-001' });
  assert.equal(result.fields.plateNumber.raw, 'DEMO-A0001');
  assert.equal(result.fields.issuingRegion.raw, '示例省');
  assert.equal(result.fields.passRoute.raw, '示例入口-S01-示例出口');
  assert.equal(result.fields.passRoute.raw.includes('备注'), false);
  assert.equal(result.fields.plateNumber.confidence.score, null);
  assert.equal(result.fields.plateNumber.confidence.source, 'unavailable');
  const evidence = result.fields.plateNumber.evidence;
  assert.equal(result.ocrText.slice(evidence.start, evidence.end), 'DEMO-A0001');
  assert.deepEqual(result.candidates.length, { value: 18, unit: 'm' });
  assert.deepEqual(result.candidates.width, { value: 3.2, unit: 'm' });
  assert.deepEqual(result.candidates.plateNumber, { value: 'DEMO-A0001' });
  assert.equal(result.candidates.weight, null);
  assert.equal(result.trace[0].stage, 'local-ocr');
  assert.equal(result.trace[0].engine, 'Tesseract');
});

test('local adapter passes recognition failures with their stable code', async () => {
  const failure = Object.assign(new Error('engine missing'), { code: 'OCR_ENGINE_MISSING' });
  const adapter = createLocalAdapter({ recognize: async () => { throw failure; } });
  await assert.rejects(adapter.run({ filePath: '/tmp/SYN-001.png', imageId: 'SYN-001' }), error => error.code === 'OCR_ENGINE_MISSING');
});

test('local adapter propagates cancellation before mapping', async () => {
  const controller = new AbortController();
  controller.abort();
  const adapter = createLocalAdapter({ recognize: async (_path, _id, _stage, signal) => {
    assert.equal(signal.aborted, true);
    throw Object.assign(new Error('git directory changed'), { code: 'ABORTED' });
  } });
  await assert.rejects(adapter.run({ filePath: '/tmp/SYN-001.png', imageId: 'SYN-001', signal: controller.signal }), error => error.code === 'ABORTED');
});
