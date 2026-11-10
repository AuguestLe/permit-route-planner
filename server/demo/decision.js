import { FIELD_KEYS } from './schema.js';

const HIGH = 0.9;
const MEDIUM = 0.7;

function hasConfidence(field) {
  return field?.confidence && Number.isFinite(field.confidence.score);
}

function hasEvidence(field) {
  return field?.evidence && Number.isInteger(field.evidence.start) && Number.isInteger(field.evidence.end)
    && field.evidence.end > field.evidence.start;
}

function confidenceTier(fields) {
  const scores = FIELD_KEYS.map(key => fields[key]?.confidence?.score);
  if (scores.some(score => !Number.isFinite(score))) return 'unknown';
  if (scores.some(score => score < MEDIUM)) return 'low';
  if (scores.some(score => score < HIGH)) return 'medium';
  return 'high';
}

/** Deterministic routing: hard gates override model confidence. */
export function decide({ quality, validation, fields }) {
  const reasons = [];
  if (quality?.status === 'reject') {
    reasons.push('质检未通过，停止自动处理');
    return { level: 'unknown', action: 'rejected', reasons };
  }
  if (quality?.status === 'warn') reasons.push('质检存在警告，需人工确认');
  if (!validation?.ok) {
    const codes = validation?.errors?.map(error => error.code).filter(Boolean) ?? [];
    reasons.push(`字段校验未通过${codes.length ? `（${[...new Set(codes)].join('、')}）` : ''}`);
  }

  const missing = FIELD_KEYS.filter(key => fields[key]?.candidate == null);
  if (missing.length) reasons.push(`缺少字段：${missing.join('、')}`);
  const noEvidence = FIELD_KEYS.filter(key => !hasEvidence(fields[key]));
  if (noEvidence.length) reasons.push(`缺少可追溯证据：${noEvidence.join('、')}`);
  const noConfidence = FIELD_KEYS.filter(key => !hasConfidence(fields[key]));
  if (noConfidence.length) reasons.push('置信度缺失或来源不可用');

  let level = confidenceTier(fields);
  if (missing.length || noEvidence.length || noConfidence.length) level = 'unknown';
  else if (level === 'high' && (quality?.status !== 'pass' || !validation?.ok)) level = 'unknown';

  const autoApproved = level === 'high' && quality?.status === 'pass' && validation?.ok
    && !missing.length && !noEvidence.length && !noConfidence.length;
  return { level, action: autoApproved ? 'auto_approved' : 'review_required', reasons: [...new Set(reasons)] };
}
