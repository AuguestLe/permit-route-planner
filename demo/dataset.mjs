import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

export const DATASET_VERSION = 'synthetic-permit-v1';
export const REFERENCE_DATE = '2030-06-15';

const DEFAULT_LABELS = {
  permitNumber: '证件编号', plateNumber: '车牌号码', issuingRegion: '签发地区',
  validFrom: '有效期起', validTo: '有效期止', length: '车货总长', width: '车货总宽',
  height: '车货总高', weight: '车货总重', axleCount: '轴数', passRoute: '通行路线',
};

const ALIAS_LABELS = {
  permitNumber: '许可证编号', plateNumber: '车辆号牌', issuingRegion: '签发区域',
  validFrom: '有效期开始', validTo: '有效期结束', length: '车货总长度', width: '车货总宽度',
  height: '车货总高度', weight: '车货总质量', axleCount: '车轴数', passRoute: '通行线路',
};

function baseValues(index) {
  const length = 18 + ((index - 1) % 3) * 0.5;
  return {
    permitNumber: `DEMO-PERMIT-${String(index).padStart(4, '0')}`,
    plateNumber: `DEMO-A${String(index).padStart(4, '0')}`,
    issuingRegion: '示例省',
    validFrom: '2030-06-01',
    validTo: '2030-06-30',
    length,
    width: 3.2,
    height: 4,
    weight: 49,
    axleCount: 6,
    passRoute: '示例入口-S01-示例出口',
  };
}

function rawFormat(values, index) {
  const dateStyle = index % 4;
  const date = {
    validFrom: dateStyle === 1 ? '2030年06月01日' : dateStyle === 2 ? '2030/06/01' : '2030-06-01',
    validTo: dateStyle === 1 ? '2030年06月30日' : dateStyle === 2 ? '2030/06/30' : '2030-06-30',
  };
  const unitStyle = index % 4;
  return {
    permitNumber: values.permitNumber,
    plateNumber: values.plateNumber,
    issuingRegion: values.issuingRegion,
    validFrom: date.validFrom,
    validTo: date.validTo,
    length: unitStyle === 1 ? `${values.length} m` : unitStyle === 2 ? `${values.length * 1000} mm` : `${values.length}米`,
    width: unitStyle === 2 ? `${values.width * 100} 厘米` : `${values.width} m`,
    height: unitStyle === 1 ? `${values.height}米` : `${values.height} m`,
    weight: index % 2 ? `${values.weight} 吨` : `${values.weight * 1000} kg`,
    axleCount: String(values.axleCount),
    passRoute: values.passRoute,
  };
}

function candidatesFrom(values) {
  return {
    permitNumber: { value: values.permitNumber }, plateNumber: { value: values.plateNumber },
    issuingRegion: { value: values.issuingRegion },
    validFrom: { value: values.validFrom }, validTo: { value: values.validTo },
    length: { value: values.length, unit: 'm' }, width: { value: values.width, unit: 'm' },
    height: { value: values.height, unit: 'm' }, weight: { value: values.weight * 1000, unit: 'kg' },
    axleCount: { value: values.axleCount }, passRoute: { value: values.passRoute },
  };
}

export function buildDatasetDefinition() {
  return Array.from({ length: 30 }, (_, offset) => {
    const index = offset + 1;
    const sampleId = `SYN-${String(index).padStart(3, '0')}`;
    const scenario = index <= 18 ? 'normal' : index <= 24 ? 'quality' : index <= 28 ? 'missing' : 'business';
    const values = baseValues(index);
    const rawValues = rawFormat(values, index);
    const expectedCandidates = candidatesFrom(values);
    let renderLines = Object.entries(rawValues).map(([key, value]) => ({ label: (index % 3 === 2 ? ALIAS_LABELS : DEFAULT_LABELS)[key], value }));
    let expectedValid = true;
    let quality = null;

    if (scenario === 'quality') {
      const transforms = ['blur:6', 'blur:11', 'contrast:0.55', 'rotate:1.5', 'rotate:-2', 'brightness:0.72'];
      quality = transforms[index - 19];
    }
    if (index === 25) {
      expectedCandidates.width = null;
      renderLines = renderLines.filter(line => line.label !== '车货总宽' && line.label !== '车货总宽度');
      expectedValid = false;
    }
    if (index === 26) {
      expectedCandidates.validTo = null;
      renderLines = renderLines.filter(line => line.label !== '有效期止' && line.label !== '有效期结束');
      expectedValid = false;
    }
    if (index === 27) {
      expectedCandidates.plateNumber = null;
      renderLines = renderLines.flatMap(line => line.value === rawValues.plateNumber
        ? [{ ...line, value: 'DEMO-A9001' }, { label: '车辆号牌', value: 'DEMO-A9002' }]
        : [line]);
      expectedValid = false;
    }
    if (index === 28) {
      expectedCandidates.passRoute = null;
      renderLines = renderLines.filter(line => line.label !== '通行路线' && line.label !== '通行线路');
      expectedValid = false;
    }
    if (index === 29) {
      Object.assign(rawValues, { validFrom: '2030-06-30', validTo: '2030-06-01' });
      expectedCandidates.validFrom = { value: '2030-06-30' };
      expectedCandidates.validTo = { value: '2030-06-01' };
      renderLines = renderLines.map(line => {
        if (line.label.includes('有效期起') || line.label.includes('有效期开始')) return { ...line, value: rawValues.validFrom };
        if (line.label.includes('有效期止') || line.label.includes('有效期结束')) return { ...line, value: rawValues.validTo };
        return line;
      });
      expectedValid = false;
    }
    if (index === 30) {
      Object.assign(rawValues, { length: '-1米' });
      expectedCandidates.length = { value: -1, unit: 'm' };
      renderLines = renderLines.map(line => line.label.includes('总长') || line.label.includes('总长度') ? { ...line, value: '-1米' } : line);
      expectedValid = false;
    }

    return { sampleId, scenario, quality, referenceDate: REFERENCE_DATE, rawValues, renderLines, expectedCandidates, expectedValid };
  });
}

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function svgFor(entry) {
  const lines = entry.renderLines.map((line, index) =>
    `<text x="${120 + (index % 2) * 24}" y="${260 + index * 72}" font-size="46">${escapeXml(line.label)}：${escapeXml(line.value)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200">
    <rect width="1600" height="1200" fill="#fffdf7"/>
    <text x="80" y="95" font-size="52" font-weight="700" fill="#9b1c1c">非真实证件 / SYNTHETIC</text>
    <text x="80" y="155" font-size="34" fill="#444">${entry.sampleId} · 仅用于结构化核验演示</text>
    <g font-family="PingFang SC, Heiti SC, Noto Sans CJK SC, sans-serif" fill="#111">${lines}</g>
    <text x="80" y="1130" font-size="32" fill="#9b1c1c">备注：全部编号、车辆、路线均为虚构合成数据，不可用于通行或验收</text>
  </svg>`;
}

async function render(entry) {
  let image = sharp(Buffer.from(svgFor(entry)));
  if (entry.quality?.startsWith('blur:')) image = image.blur(Number(entry.quality.split(':')[1]));
  else if (entry.quality?.startsWith('contrast:')) image = image.linear(Number(entry.quality.split(':')[1]), 18);
  else if (entry.quality?.startsWith('brightness:')) image = image.modulate({ brightness: Number(entry.quality.split(':')[1]) });
  else if (entry.quality?.startsWith('rotate:')) image = image.rotate(Number(entry.quality.split(':')[1]), { background: '#fffdf7' });
  return image.png().toBuffer();
}

async function verifyExisting(manifestPath, outputDir) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.datasetVersion !== DATASET_VERSION || manifest.entries?.length !== 30) throw new Error('已存在的合成数据集版本或数量不匹配，请使用新目录。');
  for (const entry of manifest.entries) {
    const bytes = await readFile(join(outputDir, entry.filename));
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('冻结合成样例哈希不匹配，拒绝覆盖。');
  }
  return manifest;
}

export async function generateDataset({ outputDir, seed = 20261109 } = {}) {
  if (!outputDir) throw new TypeError('outputDir is required');
  await mkdir(outputDir, { recursive: true });
  const manifestPath = join(outputDir, 'manifest.json');
  try { return await verifyExisting(manifestPath, outputDir); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const definitions = buildDatasetDefinition(seed);
  const entries = [];
  for (const definition of definitions) {
    const bytes = await render(definition);
    const filename = `${definition.sampleId}.png`;
    await writeFile(join(outputDir, filename), bytes, { mode: 0o600 });
    entries.push({
      ...definition, filename, sha256: createHash('sha256').update(bytes).digest('hex'),
      synthetic: true, watermark: true, mime: 'image/png',
    });
  }
  const manifest = {
    datasetVersion: DATASET_VERSION, seed, referenceDate: REFERENCE_DATE,
    renderEnvironment: { node: process.version, platform: process.platform, arch: process.arch, vips: sharp.versions?.vips ?? 'unknown' },
    entries,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}
