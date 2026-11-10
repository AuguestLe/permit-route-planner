import Ajv2020 from 'ajv/dist/2020.js';
import { CANDIDATE_SCHEMA, FIELD_KEYS } from './schema.js';

// Demo-local labels mirror normalize.js so validation messages stay self-contained.
const LABELS = {
  permitNumber: '证件编号',
  plateNumber: '车牌号码',
  issuingRegion: '签发地区',
  validFrom: '有效期起',
  validTo: '有效期止',
  length: '车货总长',
  width: '车货总宽',
  height: '车货总高',
  weight: '车货总重',
  axleCount: '轴数',
  passRoute: '通行路线',
};

const MEASUREMENT_KEYS = new Set(['length', 'width', 'height', 'weight']);
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

// Structural validation reuses CANDIDATE_SCHEMA; coercion stays off so types are never rewritten.
const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  validateFormats: false,
});

const validateStructure = ajv.compile(CANDIDATE_SCHEMA);

function error(path, code, message) {
  return { path, code, message };
}

// Regex shape alone accepts 2026-02-30; round-trip through UTC catches impossible calendar days.
function isRealCalendarDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function structurePath(ajvError) {
  if (ajvError.keyword === 'required' && ajvError.params?.missingProperty) {
    return `${ajvError.instancePath}/${ajvError.params.missingProperty}`;
  }
  if (ajvError.keyword === 'additionalProperties' && ajvError.params?.additionalProperty) {
    return `${ajvError.instancePath}/${ajvError.params.additionalProperty}`;
  }
  return ajvError.instancePath;
}

function structureErrors() {
  return (validateStructure.errors ?? []).map((ajvError) =>
    error(
      structurePath(ajvError),
      ajvError.keyword,
      ajvError.message || '候选字段结构不符合 Schema。',
    ),
  );
}

function businessErrors(candidates, referenceDate) {
  const errors = [];

  for (const key of FIELD_KEYS) {
    const candidate = candidates[key];
    const label = LABELS[key];

    if (candidate === null || candidate === undefined) {
      errors.push(error(`/${key}`, 'missing_field', `${label}缺失或无法规范化。`));
      continue;
    }

    if (key === 'validFrom' || key === 'validTo') {
      if (!isRealCalendarDate(candidate.value)) {
        errors.push(error(`/${key}`, 'invalid_calendar_date', `${label}不是真实存在的日历日期。`));
        continue;
      }
    }
    if (key === 'validFrom' && referenceDate < candidate.value) {
      errors.push(
        error(`/${key}`, 'not_yet_valid', `${label}晚于参考日期 ${referenceDate}，证件尚未生效。`),
      );
    }
    if (key === 'validTo' && referenceDate > candidate.value) {
      errors.push(
        error(`/${key}`, 'expired', `${label}早于参考日期 ${referenceDate}，证件已过期。`),
      );
    }
    if (MEASUREMENT_KEYS.has(key) && !(candidate.value > 0)) {
      errors.push(error(`/${key}`, 'non_positive_measurement', `${label}必须大于 0。`));
    }
    if (key === 'axleCount' && !(candidate.value >= 1 && candidate.value <= 12)) {
      errors.push(error(`/${key}`, 'axle_out_of_range', `${label}必须是 1 到 12 的整数。`));
    }
    if (key === 'passRoute' && candidate.value.trim() === '') {
      errors.push(error(`/${key}`, 'empty_route', `${label}不能为空。`));
    }
  }

  return errors;
}

/**
 * Structural check against CANDIDATE_SCHEMA, then business rules.
 * Returns { ok, errors: [{ path, code, message }] }; input is only read, never coerced.
 */
export function validateCandidates(candidates, options = {}) {
  const { referenceDate } = options;

  if (!validateStructure(candidates)) {
    return { ok: false, errors: structureErrors() };
  }

  if (!isRealCalendarDate(referenceDate)) {
    return {
      ok: false,
      errors: [error('/referenceDate', 'invalid_reference_date', '参考日期缺失或不是真实存在的 YYYY-MM-DD 日期。')],
    };
  }

  const errors = businessErrors(candidates, referenceDate);
  return { ok: errors.length === 0, errors };
}
