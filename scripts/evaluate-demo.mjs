import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createRecognizer } from '../server/ocr.js';
import { loadDemoConfig } from '../server/demo/config.js';
import { createLocalAdapter } from '../server/demo/adapters/local.js';
import { createVisionAdapter } from '../server/demo/adapters/vision.js';
import { createPipeline } from '../server/demo/pipeline.js';
import { runEvaluation } from '../server/demo/evaluation.js';

function usage() {
  return '用法：node scripts/evaluate-demo.mjs --mode local|vision (--all | --limit 1..30) [--confirm-external]';
}

function parseArgs(argv) {
  const options = { mode: null, limit: null, all: false, externalConfirmed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') options.all = true;
    else if (arg === '--confirm-external') options.externalConfirmed = true;
    else if (arg === '--mode') options.mode = argv[++index];
    else if (arg === '--limit') options.limit = Number(argv[++index]);
    else throw new Error(`未知参数：${arg}`);
  }
  if (!['local', 'vision'].includes(options.mode)) throw new Error(usage());
  if (options.all === Number.isInteger(options.limit)) throw new Error('--all 与 --limit 必须且只能指定一个。');
  if (!options.all && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 30)) throw new Error(usage());
  if (options.mode === 'vision' && !options.externalConfirmed) throw new Error('视觉模式必须显式传入 --confirm-external。');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const sampleDir = join(root, 'demo', 'samples');
  const manifest = JSON.parse(await readFile(join(sampleDir, 'manifest.json'), 'utf8'));
  const config = loadDemoConfig(process.env);
  if (options.mode === 'vision' && !config.vision) throw new Error('DEMO_VISION_BASE_URL/MODEL/API_KEY 未完整配置。');
  const localAdapter = createLocalAdapter({ recognize: createRecognizer() });
  const visionAdapter = config.vision ? createVisionAdapter({ config: config.vision }) : null;
  const pipeline = createPipeline({
    manifest,
    config,
    quality: async buffer => (await import('../server/demo/quality.js')).inspectQuality(buffer),
    localAdapter,
    visionAdapter,
  });
  const report = await runEvaluation({
    pipeline,
    manifest,
    sampleDir,
    reportDir: join(root, 'demo', 'reports'),
    mode: options.mode,
    all: options.all,
    limit: options.limit ?? undefined,
    externalConfirmed: options.externalConfirmed,
    model: options.mode === 'vision' ? config.vision.model : 'local-tesseract',
  });
  console.log(JSON.stringify({
    runId: report.runId,
    mode: report.metadata.mode,
    samples: report.metrics.total,
    microFieldAccuracy: report.metrics.micro,
    wholeDocumentAccuracy: report.metrics.wholeDocumentAccuracy,
    autoApprovePrecision: report.metrics.autoApprovePrecision,
    reviewRate: report.metrics.reviewRate,
    fallbackRate: report.metrics.fallbackRate,
    reportDir: join(root, 'demo', 'reports', report.runId),
  }, null, 2));
}

main().catch(error => {
  console.error(error.message || '评测失败。');
  process.exitCode = 1;
});
