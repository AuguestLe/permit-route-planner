import { FIELD_KEYS } from './schema.js';

// Demo-local labels mirror server/fields.js so normalization stays self-contained.
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

const TEXT_KEYS = new Set(['permitNumber', 'plateNumber', 'issuingRegion', 'passRoute']);
const DATE_KEYS = new Set(['validFrom', 'validTo']);
const LENGTH_KEYS = new Set(['length', 'width', 'height']);

// Only declared units are converted; an unknown or absent unit never becomes a candidate.
const LENGTH_UNITS = new Map([
  ['mm', (value) => value / 1000],
  ['毫米', (value) => value / 1000],
  ['cm', (value) => value / 100],
  ['厘米', (value) => value / 100],
  ['m', (value) => value],
  ['米', (value) => value],
]);

const WEIGHT_UNITS = new Map([
  ['kg', (value) => value],
  ['公斤', (value) => value],
  ['千克', (value) => value],
  ['t', (value) => value * 1000],
  ['吨', (value) => value * 1000],
]);

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLASH_DATE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const CHINESE_DATE = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/;
const NUMBER_WITH_UNIT = /^(-?(?:\d+(?:\.\d+)?|\.\d+))\s*(\p{Script=Han}+|[A-Za-z]+)?$/u;
const AXLE_COUNT = /^([+-]?)(\d+)(?:\s*轴)?$/u;

function error(fieldKey, code, message) {
  return { path: `/${fieldKey}`, code, message };
}

function readField(rawFields, key) {
  if (rawFields === null || typeof rawFields !== 'object' || Array.isArray(rawFields)) {
    return { present: false, raw: null, invalid: false };
  }
  if (!Object.hasOwn(rawFields, key)) return { present: false, raw: null, invalid: false };
  const entry = rawFields[key];
  if (entry === null || entry === undefined) return { present: false, raw: null, invalid: false };
  if (typeof entry !== 'object' || Array.isArray(entry)) {
    return { present: true, raw: null, invalid: true };
  }
  if (!Object.hasOwn(entry, 'raw')) return { present: false, raw: null, invalid: false };
  const raw = entry.raw;
  if (raw === null || raw === undefined) return { present: false, raw: null, invalid: false };
  if (typeof raw !== 'string') return { present: true, raw: null, invalid: true };
  return { present: true, raw, invalid: false };
}

function isRealDate(year, month, day) {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function parseDate(raw) {
  const text = raw.trim();
  const match = ISO_DATE.exec(text) || SLASH_DATE.exec(text) || CHINESE_DATE.exec(text);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  if (!isRealDate(year, month, day)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeNumber(value) {
  return value === 0 ? 0 : value;
}

function parseMeasurement(key, raw) {
  const match = NUMBER_WITH_UNIT.exec(raw.trim());
  if (!match) return { candidate: null, code: 'invalid_measurement' };
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return { candidate: null, code: 'invalid_measurement' };

  const unitText = match[2];
  if (!unitText) return { candidate: null, code: 'missing_unit' };
  const unit = /[A-Za-z]/.test(unitText) ? unitText.toLowerCase() : unitText;
  const units = LENGTH_KEYS.has(key) ? LENGTH_UNITS : WEIGHT_UNITS;
  const convert = units.get(unit);
  if (!convert) return { candidate: null, code: 'unknown_unit', unit };

  const converted = normalizeNumber(convert(value));
  return {
    candidate: { value: converted, unit: LENGTH_KEYS.has(key) ? 'm' : 'kg' },
    code: null,
    unit,
  };
}

function messages(fieldKey, code, unit) {
  const label = LABELS[fieldKey];
  switch (code) {
    case 'invalid_raw':
      return `${label}的原始值必须是字符串。`;
    case 'empty_value':
      return `${label}的原始值为空。`;
    case 'invalid_date':
      return `${label}不是有效日期，支持 YYYY-MM-DD、YYYY/M/D 或中文年月日。`;
    case 'invalid_measurement':
      return `${label}的数值部分格式无效。`;
    case 'missing_unit':
      return `${label}缺少明确单位。`;
    case 'unknown_unit':
      return `${label}不支持单位“${unit ?? ''}”。`;
    case 'invalid_axle_count':
      return `${label}必须是整数。`;
    default:
      return `${label}无法规范化。`;
  }
}

function normalizeField(key, rawFields) {
  const field = readField(rawFields, key);
  if (!field.present) return { candidate: null, error: null };
  if (field.invalid) {
    return { candidate: null, error: error(key, 'invalid_raw', messages(key, 'invalid_raw')) };
  }

  const raw = field.raw;
  const text = raw.trim();
  if (!text) {
    return { candidate: null, error: error(key, 'empty_value', messages(key, 'empty_value')) };
  }

  if (TEXT_KEYS.has(key)) return { candidate: { value: text.replace(/\s+/gu, '') }, error: null };

  if (DATE_KEYS.has(key)) {
    const value = parseDate(text);
    if (value) return { candidate: { value }, error: null };
    return { candidate: null, error: error(key, 'invalid_date', messages(key, 'invalid_date')) };
  }

  if (LENGTH_KEYS.has(key) || key === 'weight') {
    const parsed = parseMeasurement(key, text);
    if (parsed.candidate) return { candidate: parsed.candidate, error: null };
    return {
      candidate: null,
      error: error(key, parsed.code, messages(key, parsed.code, parsed.unit)),
    };
  }

  // axleCount: integer value; the 1..12 range is a business rule, not a normalization concern.
  const match = AXLE_COUNT.exec(text);
  if (!match) {
    return {
      candidate: null,
      error: error(key, 'invalid_axle_count', messages(key, 'invalid_axle_count')),
    };
  }
  const value = normalizeNumber(Number(`${match[1]}${match[2]}`));
  if (!Number.isSafeInteger(value)) {
    return {
      candidate: null,
      error: error(key, 'invalid_axle_count', messages(key, 'invalid_axle_count')),
    };
  }
  return { candidate: { value }, error: null };
}

/**
 * Deterministically normalize the eleven tool fields.
 * Raw text is only read; absent, empty or unparseable values become null candidates
 * and every failed parse gains a stable `{ path, code, message }` error.
 */
export function normalizeFields(rawFields) {
  const candidates = {};
  const errors = [];

  for (const key of FIELD_KEYS) {
    const { candidate, error: fieldError } = normalizeField(key, rawFields);
    candidates[key] = candidate;
    if (fieldError) errors.push(fieldError);
  }

  return { candidates, errors };
}
