export const FIELD_LABELS = {
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

// 只接受明确的证件标签；“车辆长度”“货物重量”等不等同于车货总尺寸。
const ALIASES = {
  permitNumber: ['证件编号', '许可证编号', '通行证编号'],
  plateNumber: ['车牌号码', '车辆号牌', '号牌号码'],
  issuingRegion: ['签发地区', '签发区域'],
  validFrom: ['有效期起', '有效期开始', '有效期开始日期'],
  validTo: ['有效期止', '有效期结束', '有效期截止日期'],
  length: ['车货总长', '车货总长度'],
  width: ['车货总宽', '车货总宽度'],
  height: ['车货总高', '车货总高度'],
  weight: ['车货总重', '车货总质量'],
  axleCount: ['轴数', '车轴数'],
  passRoute: ['通行路线', '通行线路'],
  validity: ['有效期', '有效期限'],
};
const STOP_LABELS = ['注意事项', '备注', '签发日期', '发证日期', '签发机关', '发证机关'];
const LABEL_KEYS = new Map(Object.entries(ALIASES).flatMap(([key, names]) => names.map((name) => [name, key])));
const SPACE = String.raw`[^\S\r\n]`;
const LABEL_PATTERN = [...LABEL_KEYS.keys(), ...STOP_LABELS]
  .sort((a, b) => b.length - a.length)
  .map((label) => [...label].join(`${SPACE}*`)).join('|');
// 未知标签不跨空格匹配，避免把“湖州  备注：”整体误作标签。
const MARKER_PATTERN = String.raw`(?<![^\s|｜;；])(?:(?<label>${LABEL_PATTERN})(?:${SPACE}*[:：]${SPACE}*|${SPACE}+|(?=$))|(?<other>[\p{Script=Han}]{2,12})${SPACE}*[:：]${SPACE}*)`;
const DATE_TEXT = String.raw`(?:\d{4}${SPACE}*年${SPACE}*\d{1,2}${SPACE}*月${SPACE}*\d{1,2}${SPACE}*日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})`;
const DATE_RANGE = new RegExp(`^(${DATE_TEXT})${SPACE}*(?:至|到|—|~|～|-)${SPACE}*(${DATE_TEXT})$`, 'd');
const CHINESE_DATE = new RegExp(String.raw`^(\d{4})${SPACE}*年${SPACE}*(\d{1,2})${SPACE}*月${SPACE}*(\d{1,2})${SPACE}*日$`);
const MEASURES = {
  length: /^(\d+(?:\.\d+)?)\s*(?:毫米|厘米|米|mm|cm|m)$/i,
  width: /^(\d+(?:\.\d+)?)\s*(?:毫米|厘米|米|mm|cm|m)$/i,
  height: /^(\d+(?:\.\d+)?)\s*(?:毫米|厘米|米|mm|cm|m)$/i,
  weight: /^(\d+(?:\.\d+)?)\s*(?:吨|公斤|千克|kg|t)$/i,
};

function dateOrder(value) {
  const chinese = CHINESE_DATE.exec(value);
  const numeric = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/.exec(value);
  if (!chinese && !numeric) return null;
  const [year, month, day] = chinese
    ? chinese.slice(1).map(Number)
    : [numeric[1], numeric[3], numeric[4]].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
  return year * 10000 + month * 100 + day;
}

function evidence(text, imageId, start, end) {
  const raw = text.slice(start, end);
  const value = raw.trim();
  if (!value) return null;
  start += raw.length - raw.trimStart().length;
  end = start + value.length;
  return { value, source: { imageId, start, end, text: text.slice(start, end) } };
}

/** 从 OCR 原文提取有标签证据的值；offset 为原字符串的 UTF-16 索引，end 不包含在内。 */
export function extractPermitFields(text, imageId) {
  if (typeof text !== 'string') throw new TypeError('OCR 文本必须是字符串');
  const fields = Object.fromEntries(Object.keys(FIELD_LABELS).map((key) => [key, { value: null, source: null }]));
  const candidates = Object.fromEntries(Object.keys(FIELD_LABELS).map((key) => [key, []]));
  const invalid = new Set();
  const warnings = [];
  const markers = [...text.matchAll(new RegExp(MARKER_PATTERN, 'gmu'))].map((match) => ({
    start: match.index,
    valueStart: match.index + match[0].length,
    key: LABEL_KEYS.get((match.groups.label || '').replace(/\s/g, '')),
  }));

  function reject(key, reason) {
    invalid.add(key);
    warnings.push(`${FIELD_LABELS[key]}${reason}，无法确定，请核对原图。`);
  }

  for (let i = 0; i < markers.length; i += 1) {
    const marker = markers[i];
    const key = marker.key;
    if (!key) continue;
    let end = markers[i + 1]?.start ?? text.length;
    if (key !== 'passRoute') {
      // 普通字段只取当前行；不将无标签的下一行猜作缺失值。
      const newline = /[\r\n]/.exec(text.slice(marker.valueStart, end));
      if (newline) end = marker.valueStart + newline.index;
    }
    const candidate = evidence(text, imageId, marker.valueStart, end);
    if (!candidate) continue;

    if (key === 'validity') {
      const range = DATE_RANGE.exec(candidate.value);
      const from = range && dateOrder(range[1]);
      const to = range && dateOrder(range[2]);
      if (from === null || to === null || !range || from > to) {
        reject('validFrom', '所在有效期区间不完整、日期无效或起止倒置');
        reject('validTo', '所在有效期区间不完整、日期无效或起止倒置');
        continue;
      }
      for (const [fieldKey, group] of [['validFrom', 1], ['validTo', 2]]) {
        const [start, finish] = range.indices[group];
        candidates[fieldKey].push(evidence(text, imageId,
          candidate.source.start + start, candidate.source.start + finish));
      }
      continue;
    }

    candidates[key].push(candidate);
    if ((key === 'validFrom' || key === 'validTo') && dateOrder(candidate.value) === null) {
      reject(key, '日期格式或日历日期无效');
    } else if (MEASURES[key]) {
      const measure = MEASURES[key].exec(candidate.value);
      if (!measure || !Number.isFinite(Number(measure[1])) || Number(measure[1]) <= 0) {
        reject(key, '缺少明确单位或数值格式无效');
      }
    } else if (key === 'axleCount' && !/^[1-9]\d*(?:\s*轴)?$/.test(candidate.value)) {
      reject(key, '数值格式无效');
    }
  }

  for (const key of Object.keys(fields)) {
    const values = candidates[key];
    if (new Set(values.map(({ value }) => value)).size > 1) {
      reject(key, '存在重复标签值冲突');
    }
    if (!invalid.has(key) && values.length) fields[key] = values[0];
  }
  if (fields.validFrom.value && fields.validTo.value
      && dateOrder(fields.validFrom.value) > dateOrder(fields.validTo.value)) {
    fields.validFrom = { value: null, source: null };
    fields.validTo = { value: null, source: null };
    warnings.push('有效期起晚于有效期止，无法确定有效期，请核对原图。');
  }
  if (!fields.passRoute.value) warnings.push('缺少可确定的通行路线，请核对原图并手动补充。');
  return { fields, warnings: [...new Set(warnings)] };
}
