import { performance } from 'node:perf_hooks';
import { extractPermitFields } from '../../fields.js';
import { FIELD_KEYS } from '../schema.js';
import { normalizeFields } from '../normalize.js';

/** Tesseract native output inserts spaces between CJK glyphs; collapse only those. */
function tidyOcrText(text) {
  return text
    .replace(/\p{Script=Han}(?:[^\S\r\n]+\p{Script=Han})+/gu, sequence => sequence.replace(/[^\S\r\n]+/gu, ''))
    .replace(/[^\S\r\n]+([：:，,。；;])/gu, '$1');
}

/** Convert legacy Tesseract fields into the shared extraction contract. */
export function createLocalAdapter({ recognize }) {
  if (typeof recognize !== 'function') throw new TypeError('recognize must be a function');
  return {
    async run({ filePath, imageId, signal, onStage = () => {} }) {
      const started = performance.now();
      const result = await recognize(filePath, imageId, onStage, signal);
      const ocrText = tidyOcrText(result.text);
      const extracted = extractPermitFields(ocrText, imageId);
      const rawFields = {};
      const fields = {};
      for (const key of FIELD_KEYS) {
        const legacy = extracted.fields[key];
        const evidence = legacy.source
          ? { start: legacy.source.start, end: legacy.source.end, text: legacy.source.text }
          : null;
        rawFields[key] = {
          raw: legacy.value,
          confidence: null,
          evidenceQuote: evidence?.text ?? null,
        };
        fields[key] = {
          raw: legacy.value,
          candidate: null,
          confidence: { score: null, source: 'unavailable' },
          evidence,
        };
      }
      const normalized = normalizeFields(rawFields);
      for (const key of FIELD_KEYS) fields[key].candidate = normalized.candidates[key];
      const trace = [{
        stage: 'local-ocr',
        engine: result.engine ?? 'Tesseract',
        languages: result.languages ?? [],
        durationMs: Math.round(performance.now() - started),
        warningCount: extracted.warnings.length,
      }];
      return {
        fields,
        candidates: normalized.candidates,
        normalizationErrors: normalized.errors,
        warnings: extracted.warnings,
        ocrText,
        trace,
        usage: null,
      };
    },
  };
}
