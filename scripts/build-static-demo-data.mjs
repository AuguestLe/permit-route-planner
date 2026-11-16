import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifestPath = join(root, 'demo/samples/manifest.json');
const reportsPath = join(root, 'demo/reports');
const outputPath = join(root, 'client/src/demo/static/generated/demo-data.json');

const MANIFEST_ENTRY_KEYS = [
  'sampleId', 'filename', 'scenario', 'mime', 'sha256', 'synthetic', 'watermark', 'referenceDate',
];
const EXPORT_FILES = {
  json: 'report.json',
  'field-csv': 'field-accuracy.csv',
  'samples-csv': 'samples.csv',
  markdown: 'summary.md',
};

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function pick(entry) {
  return Object.fromEntries(MANIFEST_ENTRY_KEYS.map(key => [key, entry[key] ?? null]));
}

const manifest = await readJson(manifestPath);
const index = (await readJson(join(reportsPath, 'index.json'))) ?? [];
const runs = [];

for (const item of index) {
  if (!item?.runId) continue;
  const report = await readJson(join(reportsPath, item.runId, 'report.json'));
  const exports = {};
  for (const [format, file] of Object.entries(EXPORT_FILES)) {
    const content = await readOptional(join(reportsPath, item.runId, file));
    if (content !== null) exports[format] = content;
  }
  runs.push({ summary: item, report, exports });
}

const payload = {
  generatedFrom: 'demo/samples/manifest.json + demo/reports',
  datasetVersion: manifest.datasetVersion,
  referenceDate: manifest.referenceDate,
  entries: (manifest.entries ?? []).map(pick),
  runs,
};

await mkdir(join(outputPath, '..'), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload)}\n`, 'utf8');
console.log(`静态预览数据已生成：${outputPath}`);
console.log(`样例 ${payload.entries.length} 张，评测报告 ${runs.length} 份，${(JSON.stringify(payload).length / 1024).toFixed(1)} KB`);
