import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createRecognizer } from '../server/ocr.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const samplePath = join(projectRoot, '.test-artifacts', 'synthetic-permit.png');

/** Deliberately synthetic, visibly labelled, and never evidence of a real permit. */
export async function createSyntheticSample() {
  await mkdir(dirname(samplePath), { recursive: true });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1900" height="1560" viewBox="0 0 1900 1560">
    <rect width="1900" height="1560" fill="white"/>
    <g font-family="PingFang SC, Heiti SC, Noto Sans CJK SC, sans-serif" fill="#111">
      <text x="100" y="130" font-size="76" font-weight="600" fill="#982323">测试样本 非真实证件</text>
      <text x="100" y="245" font-size="66">LOCAL OCR TEST</text>
      <text x="100" y="350" font-size="52">以下所有号码、车辆及通行信息均为模拟数据</text>
      <g font-size="56">
        <text x="100" y="470">证件编号：TEST-2026-0001</text>
        <text x="100" y="575">车牌号码：浙A12345</text>
        <text x="100" y="680">签发地区：浙江省</text>
        <text x="100" y="785">有效期起：2026-11-01</text>
        <text x="100" y="890">有效期止：2026-11-05</text>
        <text x="100" y="995">车货总长：18米    车货总宽：3米</text>
        <text x="100" y="1100">车货总高：4米    车货总重：40吨    轴数：6</text>
        <text x="100" y="1205">通行路线：浙江省杭州市 → G25长深高速 → 江苏省南京市</text>
      </g>
      <text x="100" y="1360" font-size="48" fill="#982323">仅用于离线OCR测试，不可用于实际通行或证件验收</text>
      <text x="100" y="1460" font-size="42">SYNTHETIC SAMPLE - NOT A VALID PERMIT</text>
    </g>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(samplePath);
  return samplePath;
}

async function main() {
  try {
    const filePath = await createSyntheticSample();
    const result = await createRecognizer()(filePath, 'synthetic-permit');
    const compactText = result.text.replace(/\s/g, '');
    assert.ok(/通行路线|测试样本/.test(compactText), '本地OCR未能识别关键中文，当前识别能力不足。');
    const { extractPermitFields } = await import('../server/fields.js');
    const { fields } = extractPermitFields(result.text, 'synthetic-permit');
    console.log(JSON.stringify({
      recognizedFieldKeys: Object.entries(fields).filter(([, field]) => field.value !== null).map(([key]) => key),
      chineseRouteRecognized: /通行路线/.test(compactText) && /杭州市|长深高速|南京市/.test(compactText),
      confidence: result.confidence,
    }));
  } catch (error) {
    console.error(error?.code === 'ERR_ASSERTION'
      ? '本地OCR未能识别关键中文，当前识别能力不足；请勿将合成样本视为真实授权证件验收。'
      : '本地OCR验证未通过，请检查本地模型、图片与运行环境；未生成替代识别结果。');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
