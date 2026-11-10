import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIELD_KEYS } from './schema.js';
import { computeMetrics } from './metrics.js';

export class EvaluationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sampleFieldStatus(sample, key) {
  const actual = sample.fields?.[key]?.candidate ?? null;
  const expected = sample.expectedCandidates?.[key] ?? null;
  if (JSON.stringify(actual) === JSON.stringify(expected)) return 'correct';
  if (actual === null) return 'missing';
  return 'wrong';
}

function fieldCsv(report) {
  const header = ['field', 'applicable', 'correct', 'accuracy', 'predicted_missing', 'wrong', 'null_expected', 'null_correct'];
  const rows = FIELD_KEYS.map(key => {
    const field = report.metrics.fields[key];
    return [key, field.applicable, field.correct, field.accuracy, field.predictedMissing, field.wrong, field.nullExpected, field.nullCorrect];
  });
  return [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n');
}

function samplesCsv(report) {
  const header = ['sample_id', 'scenario', 'expected_valid', 'validation_ok', 'decision_action', 'level', 'fallback_used', ...FIELD_KEYS.map(key => `${key}_status`)];
  const rows = report.samples.map(sample => [
    sample.sampleId, sample.scenario, sample.expectedValid, sample.validation?.ok, sample.decision?.action, sample.decision?.level,
    sample.fallbackUsed, ...FIELD_KEYS.map(key => sampleFieldStatus(sample, key)),
  ]);
  return [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n');
}

function summaryMarkdown(report) {
  const pct = value => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
  const number = value => value === null ? '—' : String(value);
  const lines = [
    '# 证照核验评测报告', '',
    `- Run: ${report.runId}`, `- 模式: ${report.metadata.mode}`, `- 模型: ${report.metadata.model}`,
    `- 数据版本: ${report.metadata.datasetVersion}`, `- 清单哈希: ${report.metadata.manifestHash}`,
    `- 时间: ${report.startedAt} → ${report.finishedAt}`, `- 样本数: ${report.metrics.total}`, '',
    '| 指标 | 值 |', '|---|---|',
    `| 字段 micro 准确率 | ${pct(report.metrics.micro)} |`,
    `| 字段 macro 准确率 | ${pct(report.metrics.macro)} |`,
    `| 整单字段完全正确率 | ${pct(report.metrics.wholeDocumentAccuracy)} |`,
    `| Schema/业务判定准确率 | ${pct(report.metrics.decisionAccuracy)} |`,
    `| 自动通过精确率 | ${pct(report.metrics.autoApprovePrecision)} |`,
    `| 转人工率 | ${pct(report.metrics.reviewRate)} |`,
    `| 兜底率 | ${pct(report.metrics.fallbackRate)} |`,
    `| 模型请求数 | ${number(report.metrics.modelCalls)} |`,
    `| p50 / p95 ms | ${number(report.metrics.latencyP50Ms)} / ${number(report.metrics.latencyP95Ms)} |`, '',
    '## 字段准确率', '', '| 字段 | 预期非空 | 正确 | 准确率 |', '|---|---:|---:|---:|',
    ...FIELD_KEYS.map(key => `| ${key} | ${report.metrics.fields[key].applicable} | ${report.metrics.fields[key].correct} | ${pct(report.metrics.fields[key].accuracy)} |`),
    '', '> 合成数据演示；阈值未校准；不构成真实证件验收或真伪鉴定。', '',
  ];
  return lines.join('\n');
}

function manifestHash(manifest) {
  return createHash('sha256').update(JSON.stringify(manifest.entries)).digest('hex');
}

export async function runEvaluation({
  pipeline, manifest, sampleDir, reportDir, mode = 'local', limit, all = false,
  externalConfirmed = false, model = 'local-tesseract', runId = randomUUID(), now = () => new Date(),
}) {
  if (!pipeline?.run) throw new TypeError('pipeline.run is required');
  if (!manifest?.entries?.length) throw new TypeError('manifest entries are required');
  if (!['local', 'local-ocr', 'vision'].includes(mode)) throw new EvaluationError('INVALID_MODE', '评测模式无效。');
  const vision = mode === 'vision';
  if (vision && !externalConfirmed) throw new EvaluationError('EXTERNAL_CONFIRMATION_REQUIRED', '视觉评测需要显式外发确认。');
  if (all === Boolean(limit)) throw new EvaluationError('INVALID_LIMIT', 'limit 与 all 必须且只能指定一个。');
  if (!all && (!Number.isInteger(limit) || limit < 1 || limit > 30)) throw new EvaluationError('INVALID_LIMIT', 'limit 必须是 1～30 的整数。');

  const selected = all ? manifest.entries : manifest.entries.slice(0, limit);
  const started = now();
  const samples = [];
  for (const entry of selected) {
    const buffer = await readFile(join(sampleDir, entry.filename));
    try {
      const result = await pipeline.run({
        buffer, filePath: join(sampleDir, entry.filename), imageId: entry.sampleId, sampleId: entry.sampleId,
        mode: vision ? 'vision' : 'local-ocr', externalConfirmed,
      });
      samples.push({
        ...result, sampleId: entry.sampleId, scenario: entry.scenario,
        expectedCandidates: entry.expectedCandidates, expectedValid: entry.expectedValid,
      });
    } catch (error) {
      samples.push({
        status: 'failed', sampleId: entry.sampleId, scenario: entry.scenario,
        expectedCandidates: entry.expectedCandidates, expectedValid: entry.expectedValid,
        fields: {}, validation: null, decision: null, fallbackUsed: false, trace: [],
        timings: { totalMs: 0 }, error: { code: error?.code ?? 'EVALUATION_FAILED' },
      });
    }
  }
  const report = {
    runId, startedAt: started.toISOString(), finishedAt: now().toISOString(),
    metadata: {
      mode: vision ? 'vision-fc' : 'local-ocr', model, datasetVersion: manifest.datasetVersion,
      manifestHash: manifestHash(manifest), thresholdVersion: 'demo-confidence-v1',
      externalConfirmed: vision ? externalConfirmed : false,
    },
    metrics: computeMetrics(samples), samples,
  };
  const directory = join(reportDir, runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(directory, 'field-accuracy.csv'), `${fieldCsv(report)}\n`);
  await writeFile(join(directory, 'samples.csv'), `${samplesCsv(report)}\n`);
  await writeFile(join(directory, 'summary.md'), summaryMarkdown(report));
  let index = [];
  try { index = JSON.parse(await readFile(join(reportDir, 'index.json'), 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const summary = { runId, startedAt: report.startedAt, mode: report.metadata.mode, model, datasetVersion: manifest.datasetVersion, total: report.metrics.total };
  await writeFile(join(reportDir, 'index.json'), `${JSON.stringify([summary, ...index.filter(item => item.runId !== runId)], null, 2)}\n`);
  return report;
}
