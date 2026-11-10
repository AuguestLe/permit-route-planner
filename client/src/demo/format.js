export const FIELD_LABELS = Object.freeze({
  permitNumber: '证件编号', plateNumber: '车牌号码', issuingRegion: '签发地区',
  validFrom: '有效期起', validTo: '有效期止', length: '车货总长', width: '车货总宽',
  height: '车货总高', weight: '车货总重', axleCount: '轴数', passRoute: '通行路线',
});

const MODES = { 'local-ocr': '本地 OCR', 'vision-fc': '视觉 Function Calling' };

export function modeLabel(mode) {
  return MODES[mode] ?? '未知模式';
}

export function formatPrecision(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
}

export function confidenceLabel(field) {
  const confidence = field?.confidence;
  if (!Number.isFinite(confidence?.score)) return '未提供（转人工）';
  return confidence.source === 'model-self-report'
    ? `模型自报 ${(confidence.score * 100).toFixed(1)}%`
    : `未校准 ${(confidence.score * 100).toFixed(1)}%`;
}

export function candidateText(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object' && Object.hasOwn(value, 'unit')) return `${value.value} ${value.unit}`;
  if (typeof value === 'object' && Object.hasOwn(value, 'value')) return String(value.value);
  return String(value);
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

export function fieldStatus(expected, actual) {
  if (stable(expected) === stable(actual)) return 'correct';
  return actual === null || actual === undefined ? 'missing' : 'wrong';
}
