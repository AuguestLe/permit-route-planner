import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { generateDataset } from '../demo/dataset.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputDir = process.argv[2] ? fileURLToPath(new URL(process.argv[2], `file://${process.cwd()}/`)) : join(root, 'demo', 'samples');
const manifest = await generateDataset({ outputDir, seed: 20261109 });
console.log(JSON.stringify({
  datasetVersion: manifest.datasetVersion,
  outputDir,
  samples: manifest.entries.length,
  categories: manifest.entries.reduce((counts, entry) => ({ ...counts, [entry.scenario]: (counts[entry.scenario] ?? 0) + 1 }), {}),
  referenceDate: manifest.referenceDate,
}, null, 2));
