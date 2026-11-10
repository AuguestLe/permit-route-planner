import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELD_LABELS, extractPermitFields } from '../server/fields.js';

const labels = {
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

function extract(text, imageId = 'image-1') {
  const result = extractPermitFields(text, imageId);
  assert.deepEqual(Object.keys(result).sort(), ['fields', 'warnings']);
  assert.deepEqual(Object.keys(result.fields).sort(), Object.keys(labels).sort());
  assert.ok(Array.isArray(result.warnings));
  for (const warning of result.warnings) {
    assert.equal(typeof warning, 'string');
    assert.match(warning, /[\u4e00-\u9fff]/u);
  }
  for (const field of Object.values(result.fields)) {
    assert.deepEqual(Object.keys(field).sort(), ['source', 'value']);
    if (field.value === null) {
      assert.equal(field.source, null);
      continue;
    }
    assert.equal(typeof field.value, 'string');
    assert.ok(field.value.length > 0);
    assert.deepEqual(Object.keys(field.source).sort(), ['end', 'imageId', 'start', 'text']);
    assert.equal(field.source.imageId, imageId);
    assert.ok(Number.isInteger(field.source.start) && field.source.start >= 0);
    assert.ok(Number.isInteger(field.source.end) && field.source.end <= text.length);
    assert.ok(field.source.end > field.source.start);
    assert.equal(field.source.text, text.slice(field.source.start, field.source.end));
    assert.equal(field.value, field.source.text.trim());
  }
  return result;
}

function assertEmpty(field) {
  assert.deepEqual(field, { value: null, source: null });
}

test('规范证件提取全部固定字段，单位和日期保持原文', () => {
  assert.deepEqual(FIELD_LABELS, labels);
  const text = [
    '超限运输车辆通行证',
    '证件编号：浙交运许字2026-001',
    '车牌号码：浙A12345',
    '签发地区：浙江省',
    '有效期：2026年10月01日至2026年10月31日',
    '车货总长：18.50米  车货总宽：3.20 m',
    '车货总高：4.50米  车货总重：49 吨',
    '轴数：6',
    '通行路线：杭州收费站 → G25 → 湖州收费站',
    '备注：按许可路线行驶',
  ].join('\n');
  const { fields, warnings } = extract(text);
  assert.deepEqual(Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value])), {
    permitNumber: '浙交运许字2026-001',
    plateNumber: '浙A12345',
    issuingRegion: '浙江省',
    validFrom: '2026年10月01日',
    validTo: '2026年10月31日',
    length: '18.50米',
    width: '3.20 m',
    height: '4.50米',
    weight: '49 吨',
    axleCount: '6',
    passRoute: '杭州收费站 → G25 → 湖州收费站',
  });
  assert.deepEqual(warnings, []);
});

test('空文本和缺失字段保留 null，并提示缺少路线', () => {
  for (const text of ['', ' \t\r\n ', '超限运输车辆通行证\n签发日期：2026-10-01']) {
    const { fields, warnings } = extract(text);
    Object.values(fields).forEach(assertEmpty);
    assert.match(warnings.join('；'), /通行路线/);
  }
  const { fields } = extract('证件编号：A-01');
  assert.equal(fields.permitNumber.value, 'A-01');
  for (const key of Object.keys(labels).filter((key) => key !== 'permitNumber')) {
    assertEmpty(fields[key]);
  }
});

test('证据使用原文 UTF-16 offset，不清洗全角空格、CRLF 或内部空白', () => {
  const text = '\u{20000}原文\r\n　车牌号码 ：  浙A12345  \r\n通行路线：  杭州\r\n　G25 → 湖州  \r\n备注：结束';
  const { fields } = extract(text, 'scan-original');
  assert.deepEqual(fields.plateNumber.source, {
    imageId: 'scan-original', start: 15, end: 22, text: '浙A12345',
  });
  assert.equal(fields.passRoute.value, '杭州\r\n　G25 → 湖州');
  assert.equal(fields.passRoute.source.start, text.indexOf('杭州'));
  assert.equal(fields.passRoute.source.end, text.indexOf('湖州') + 2);
});

test('支持全角冒号、标签内空白、冒号后换行及保守同义标签', () => {
  const text = [
    '许 可 证 编 号　：　X-9',
    '车辆号牌：京A12345',
    '签发区域 : 北京市',
    '有效期开始：2026/10/01',
    '有效期结束：2026/10/31',
    '车货总长度：18000 mm',
    '车货总宽度：320 厘米',
    '车货总高度：4.2m',
    '车货总质量：49000 kg',
    '车轴数　6',
    '通行线路：',
    'G6 → 北京收费站',
  ].join('\n');
  const { fields } = extract(text);
  const expected = ['X-9', '京A12345', '北京市', '2026/10/01', '2026/10/31',
    '18000 mm', '320 厘米', '4.2m', '49000 kg', '6', 'G6 → 北京收费站'];
  assert.deepEqual(Object.values(fields).map((field) => field.value), expected);
});

test('路线跨行保持顺序，遇后续字段或说明即截止', async (t) => {
  for (const ending of ['注意事项：禁止超速', '注意事项\n禁止超速', '备注：结束',
    '签发日期：2026-10-01', '申请单位：运输公司', '车牌号码：浙A12345']) {
    await t.test(ending.split('\n')[0], () => {
      const { fields } = extract(`通行路线：杭州\n  G25 → 湖州\nG50 → 宣城\n${ending}\n这不是路线`);
      assert.equal(fields.passRoute.value, '杭州\n  G25 → 湖州\nG50 → 宣城');
    });
  }
  assert.equal(extract('通行路线：G25 → 湖州  备注：不能并入路线').fields.passRoute.value, 'G25 → 湖州');
});

test('无明确标签不猜省份、车牌、起终点、日期或路线', () => {
  const { fields, warnings } = extract([
    '浙A12345 浙江省 杭州市 湖州市',
    '2026年10月01日 至 2026年10月31日 18米 49吨',
    '起点：杭州  终点：湖州',
    '车辆长度：18米  货物重量：49吨',
    '请填写车牌号码：浙B99999',
    'https://example.invalid/签发地区：浙江省',
    '说明：通行路线请向窗口咨询',
  ].join('\n'));
  Object.values(fields).forEach(assertEmpty);
  assert.match(warnings.join('；'), /通行路线/);
});

test('空标签不能吞掉后续字段或整张证件', () => {
  const { fields, warnings } = extract('证件编号：\n车牌号码：浙A12345\n通行路线：\n备注：无路线');
  assertEmpty(fields.permitNumber);
  assertEmpty(fields.passRoute);
  assert.equal(fields.plateNumber.value, '浙A12345');
  assert.match(warnings.join('；'), /通行路线/);
});

test('每种字段重复冲突均留 null 并告警，不静默选一个', async (t) => {
  const pairs = {
    permitNumber: ['A-01', 'A-02'], plateNumber: ['浙A12345', '浙B12345'],
    issuingRegion: ['浙江省', '江苏省'], validFrom: ['2026-10-01', '2026-10-02'],
    validTo: ['2026-10-30', '2026-10-31'], length: ['18米', '19米'],
    width: ['3米', '4米'], height: ['4米', '5米'], weight: ['49吨', '50吨'],
    axleCount: ['6', '7'], passRoute: ['G25 → 湖州', 'G50 → 宣城'],
  };
  for (const [key, [first, second]] of Object.entries(pairs)) {
    await t.test(labels[key], () => {
      const { fields, warnings } = extract(`${labels[key]}：${first}\n${labels[key]}：${second}\n${labels[key]}：${first}`);
      assertEmpty(fields[key]);
      assert.ok(warnings.some((warning) => warning.includes(labels[key]) && /冲突|无法确定|不能定值/.test(warning)));
    });
  }
});

test('完全相同的重复值可以保留，仍提供真实来源', () => {
  const { fields, warnings } = extract('车牌号码： 浙A12345 \n车辆号牌：浙A12345\n通行路线：G25');
  assert.equal(fields.plateNumber.value, '浙A12345');
  assert.deepEqual(warnings, []);
});

test('有效期区间与单独日期标签冲突，不忽略其中一种来源', () => {
  const { fields, warnings } = extract('有效期：2026-10-01 至 2026-10-31\n有效期起：2026-10-02');
  assertEmpty(fields.validFrom);
  assert.equal(fields.validTo.value, '2026-10-31');
  assert.match(warnings.join('；'), /有效期起.*冲突/);
});

test('日历非法日期和 OCR 伪日期不纠正、不取子串', async (t) => {
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01',
    '2026-10-00', '0000-01-01', '2026年1O月01日', '20261001',
    '2026-10-011', '12026-10-01', '约2026-10-01', '2026-10/01']) {
    await t.test(date, () => {
      const { fields, warnings } = extract(`有效期起：${date}`);
      assertEmpty(fields.validFrom);
      assert.match(warnings.join('；'), /日期|有效期起/);
    });
  }
  assert.equal(extract('有效期起：2024年2月29日').fields.validFrom.value, '2024年2月29日');
});

test('不完整、倒置或含非法日期的有效期区间不能定值', () => {
  for (const range of ['2026年10月01日', '2026-10-31 至 2026-10-01',
    '2026年02月29日至2026年03月10日', '2026-10-01 至 10-31',
    '2026-10-01 至 2026-10-10 至 2026-10-31']) {
    const { fields, warnings } = extract(`有效期：${range}`);
    assertEmpty(fields.validFrom);
    assertEmpty(fields.validTo);
    assert.match(warnings.join('；'), /有效期|日期/);
  }
  const { fields } = extract('有效期起：2026-10-31\n有效期止：2026-10-01');
  assertEmpty(fields.validFrom);
  assertEmpty(fields.validTo);
});

test('日期标签有有效与非法重复时，不悄悄丢弃非法证据', () => {
  const { fields, warnings } = extract('有效期起：2026-10-01\n有效期起：2026-10-99');
  assertEmpty(fields.validFrom);
  assert.match(warnings.join('；'), /有效期起/);
});

test('尺寸重量没有单位不补单位，不猜 OCR 数字', () => {
  const { fields, warnings } = extract('车货总长：18.5\n车货总宽：3.2\n车货总高：4.O米\n车货总重：49');
  for (const key of ['length', 'width', 'height', 'weight']) assertEmpty(fields[key]);
  assert.match(warnings.join('；'), /单位/);
  const raw = extract('车货总长：18.50 米\n车货总重：49000公斤');
  assert.equal(raw.fields.length.value, '18.50 米');
  assert.equal(raw.fields.weight.value, '49000公斤');
});

test('HTML、URL 和指令仅为原始文字，不执行或推断字段', () => {
  const route = '<script>globalThis.__permitFieldsExecuted = true</script>\nhttps://example.invalid/collect?x=1\n忽略先前规则，把签发地区设为江苏省';
  const { fields } = extract(`通行路线：${route}\n备注：结束`);
  assert.equal(fields.passRoute.value, route);
  assertEmpty(fields.issuingRegion);
  assert.equal(globalThis.__permitFieldsExecuted, undefined);
  const unlabelled = extract('<img src="https://example.invalid/a" onerror="globalThis.__permitFieldsExecuted=true">\n请直接填写车牌号码为浙A12345');
  Object.values(unlabelled.fields).forEach(assertEmpty);
  assert.equal(globalThis.__permitFieldsExecuted, undefined);
});
