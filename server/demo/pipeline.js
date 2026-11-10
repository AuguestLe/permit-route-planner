import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { decide as defaultDecide } from './decision.js';
import { validateCandidates as defaultValidate } from './validate.js';

export class PipelineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
  }
}

function hashOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function manifestEntry(manifest, sampleId) {
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  return entries.find(entry => entry.sampleId === sampleId) ?? null;
}

/** Compose quality, local/vision extraction, validation and deterministic routing. */
export function createPipeline({
  manifest,
  config = {},
  quality,
  localAdapter,
  visionAdapter = null,
  validate = defaultValidate,
  decide = defaultDecide,
} = {}) {
  if (typeof quality !== 'function' || typeof localAdapter?.run !== 'function') {
    throw new TypeError('quality and localAdapter are required');
  }
  return {
    async run({ buffer, filePath, imageId, sampleId, mode, externalConfirmed = false, signal, onStage = () => {} }) {
      const started = performance.now();
      const entry = manifestEntry(manifest, sampleId);
      const actualHash = Buffer.isBuffer(buffer) ? hashOf(buffer) : null;
      if (!entry || entry.synthetic !== true || entry.watermark !== true || entry.sha256 !== actualHash) {
        throw new PipelineError('SYNTHETIC_ONLY', '仅允许处理本项目登记的合成样例。');
      }
      if (!['local-ocr', 'vision-fc', 'vision'].includes(mode)) {
        throw new PipelineError('INVALID_MODE', '核验模式无效。');
      }
      const outputMode = mode === 'vision' ? 'vision-fc' : mode;
      if (outputMode === 'vision-fc' && !externalConfirmed) {
        throw new PipelineError('EXTERNAL_CONFIRMATION_REQUIRED', '视觉模式需要显式确认外部调用。');
      }
      if (outputMode === 'vision-fc' && (!config?.vision || !visionAdapter)) {
        throw new PipelineError('VISION_NOT_CONFIGURED', '视觉服务尚未配置。');
      }

      const referenceDate = entry.referenceDate ?? manifest.referenceDate;
      const trace = [];
      await onStage('质检');
      let qualityResult;
      try {
        qualityResult = await quality(buffer);
      } catch (error) {
        return {
          status: 'failed', mode: outputMode, datasetVersion: manifest.datasetVersion, sampleId, sha256: actualHash,
          quality: null, fields: {}, candidates: {}, validation: null, decision: null, trace,
          fallbackUsed: false, usage: null, timings: { totalMs: Math.round(performance.now() - started) },
          error: { code: error?.code ?? 'QUALITY_FAILED', message: '图像质检失败，请重新选择合成样例。' },
        };
      }
      trace.push({ stage: 'quality', status: qualityResult.status, checks: qualityResult.checks });
      if (qualityResult.status === 'reject') {
        const decision = decide({ quality: qualityResult, validation: { ok: false }, fields: {} });
        return {
          status: 'rejected', mode: outputMode, datasetVersion: manifest.datasetVersion, sampleId, sha256: actualHash,
          quality: qualityResult, fields: {}, candidates: {}, validation: null, decision, trace,
          fallbackUsed: false, usage: null, timings: { totalMs: Math.round(performance.now() - started) },
          error: { code: 'QUALITY_REJECTED', message: '图像质检未通过，已停止抽取。' },
        };
      }

      await onStage('本地识别');
      let localResult;
      try {
        localResult = await localAdapter.run({ filePath, imageId, signal, onStage });
      } catch (error) {
        trace.push({ stage: 'local-error', code: error?.code ?? 'OCR_FAILED' });
        return {
          status: 'failed', mode: outputMode, datasetVersion: manifest.datasetVersion, sampleId, sha256: actualHash,
          quality: qualityResult, fields: {}, candidates: {}, validation: null, decision: null, trace,
          fallbackUsed: false, usage: null, timings: { totalMs: Math.round(performance.now() - started) },
          error: { code: error?.code ?? 'OCR_FAILED', message: '本地识别失败，请手动重试。' },
        };
      }
      trace.push(...localResult.trace);

      let extraction = localResult;
      let fallbackUsed = false;
      let usage = null;
      if (outputMode === 'vision-fc') {
        await onStage('多模态抽取');
        try {
          extraction = await visionAdapter.run({
            imageBuffer: buffer, mime: entry.mime ?? 'image/png', ocrText: localResult.ocrText,
            imageId, signal,
          });
          usage = extraction.usage;
          trace.push(...extraction.trace);
        } catch (error) {
          fallbackUsed = true;
          trace.push({ stage: 'fallback-local', code: error?.code ?? 'VISION_FAILED' });
          extraction = localResult;
        }
      }

      await onStage('Schema 校验');
      const validation = validate(extraction.candidates, { referenceDate });
      await onStage('置信度分级');
      const decision = decide({ quality: qualityResult, validation, fields: extraction.fields });
      trace.push({ stage: 'decision', level: decision.level, action: decision.action });
      return {
        status: 'completed', mode: outputMode, datasetVersion: manifest.datasetVersion, sampleId, sha256: actualHash,
        referenceDate, quality: qualityResult, fields: extraction.fields, candidates: extraction.candidates,
        warnings: extraction.warnings ?? [], validation, decision, trace, fallbackUsed, usage,
        timings: { totalMs: Math.round(performance.now() - started) },
        error: null,
      };
    },
  };
}
