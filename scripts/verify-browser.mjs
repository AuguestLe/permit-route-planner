import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = `${root}.test-artifacts`;
await mkdir(artifacts, { recursive: true });
await sharp({ create: { width: 800, height: 500, channels: 3, background: '#fff' } }).png().toFile(`${artifacts}/blank.png`);
await writeFile(`${artifacts}/disguised.png`, '<svg>not a permit image</svg>');
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5174';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname), 'browser verification only targets localhost');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(15000);
const errors = [];
const external = [];
const createdIds = new Set();
page.on('pageerror', error => errors.push(error.message));
page.on('request', req => {
  if (req.url().startsWith('http') && !['127.0.0.1', 'localhost'].includes(new URL(req.url()).hostname)) external.push(req.url());
});
let completed = false;
try {
  await page.goto(baseURL);
  await page.getByText('本地识别服务已连接', { exact: true }).waitFor();
  await page.getByLabel('任务名称', { exact: false }).fill('浏览器回归 · 合成样本');
  await page.locator('input[type=file]').setInputFiles([`${artifacts}/blank.png`, `${artifacts}/synthetic-permit.png`]);
  await page.getByRole('button', { name: '图片 1 下移', exact: true }).click();
  await page.getByRole('button', { name: '确认顺序并创建任务', exact: true }).click();
  await page.getByRole('region', { name: '任务操作' }).waitFor();
  const id = await page.evaluate(() => localStorage.getItem('lastTaskId'));
  createdIds.add(id);
  const getTask = async () => (await page.request.get(`${baseURL}/api/tasks/${id}`)).json();
  const before = await getTask();
  assert.equal(before.images[0].originalName, 'synthetic-permit.png');
  await page.waitForFunction(() => { const img = document.querySelector('.permit-image'); return img?.complete && img.naturalWidth > 0; });
  await page.getByRole('button', { name: '开始识别', exact: true }).click();
  await page.waitForFunction(async taskId => {
    const task = await (await fetch(`/api/tasks/${taskId}`)).json();
    return task.images?.every(image => ['succeeded', 'failed'].includes(image.status));
  }, id, { timeout: 120000 });
  await page.waitForFunction(() => !document.getElementById('field-passRoute')?.disabled);
  await page.getByText('1/2 张', { exact: true }).waitFor({ timeout: 6000 });
  const result = await getTask();
  assert.equal(result.images[0].status, 'succeeded');
  assert.equal(result.images[1].status, 'failed');
  assert.equal(result.images[1].error.code, 'NO_TEXT');
  assert.ok(result.images[0].original.text.replace(/\s/g, '').includes('通行路线'));
  assert.ok(result.images[0].original.fields.passRoute.value.includes('G25'));
  const original = result.images[0].original.text;
  const field = page.locator('#field-passRoute');
  await field.fill('杭州收费站 → G25长深高速 → 南京收费站（人工校对）');
  await page.getByRole('button', { name: '保存校对', exact: true }).click();
  await page.getByText('服务器版本 v2', { exact: true }).waitFor();
  assert.equal((await getTask()).images[0].original.text, original);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('field-passRoute')?.value.includes('人工校对'));
  await field.fill('未保存草稿，不应被轮询覆盖');
  await page.waitForResponse(response => response.url().endsWith(`/api/tasks/${id}`) && response.request().method() === 'GET');
  assert.equal(await field.inputValue(), '未保存草稿，不应被轮询覆盖');
  await page.getByRole('button', { name: '恢复服务器已保存', exact: true }).click();
  await page.getByRole('button', { name: '丢弃草稿并刷新', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('field-passRoute')?.value.includes('人工校对'));
  await field.fill('冲突场景的未保存草稿');
  const current = await getTask();
  assert.equal((await page.request.patch(`${baseURL}/api/tasks/${id}`, { data: { version: current.version, name: '其他窗口已修改的任务' } })).status(), 200);
  await page.getByRole('button', { name: '保存校对', exact: true }).click();
  await page.getByText('版本冲突：服务器内容已变化，本地草稿已保留。', { exact: true }).waitFor();
  assert.equal(await field.inputValue(), '冲突场景的未保存草稿');
  await page.getByRole('button', { name: '刷新服务器内容', exact: true }).click();
  await page.getByRole('button', { name: '丢弃草稿并刷新', exact: true }).click();
  await page.getByRole('button', { name: '查看第 2 张：blank.png', exact: true }).click();
  const retried = page.waitForResponse(response => response.url().endsWith('/retry') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '重试本图', exact: true }).click();
  assert.equal((await retried).status(), 202);
  await page.waitForFunction(async taskId => {
    const task = await (await fetch(`/api/tasks/${taskId}`)).json();
    return task.images?.[1]?.status === 'failed';
  }, id, { timeout: 120000 });
  assert.equal((await getTask()).images[0].original.text, original);
  await page.getByRole('region', { name: '识别结果与结构化字段校对', exact: true }).getByText('识别失败', { exact: true }).waitFor();
  await page.getByRole('button', { name: '查看第 1 张：synthetic-permit.png', exact: true }).click();
  await page.getByRole('button', { name: '顺时针旋转原图 90 度', exact: true }).click();
  await page.getByRole('button', { name: '放大原图', exact: true }).click();
  await page.getByRole('button', { name: '适 应', exact: true }).click();
  const bounds = await page.locator('.savebar').boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.y + bounds.height <= 721, 'save controls remain reachable at 1280×720');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${artifacts}/browser-review.png`, fullPage: true });
  await page.getByRole('button', { name: '删除任务', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.getByText('新建识别任务', { exact: true }).waitFor();
  createdIds.delete(id);
  assert.equal((await page.request.get(`${baseURL}/api/tasks/${id}`)).status(), 404);
  await page.getByLabel('任务名称', { exact: false }).fill('伪装文件验收');
  await page.locator('input[type=file]').setInputFiles(`${artifacts}/disguised.png`);
  await page.getByRole('button', { name: '确认顺序并创建任务', exact: true }).click();
  await page.getByText('仅支持后缀、文件类型和实际内容一致的 JPG、JPEG 或 PNG 图片。', { exact: true }).waitFor();
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  assert.deepEqual(external, [], 'no external requests from the OCR page');
  completed = true;
  console.log('浏览器 1280×720 验证通过：上传排序、真实中英OCR、失败逐图重试、校对保存、刷新恢复、草稿保护、版本冲突、原图操作、删除、伪装文件拒绝；无外部请求或未捕获异常。');
} finally {
  if (!completed) await page.screenshot({ path: `${artifacts}/browser-failure.png`, fullPage: true }).catch(() => {});
  for (const id of createdIds) {
    const response = await page.request.get(`${baseURL}/api/tasks/${id}`);
    if (response.ok()) {
      const task = await response.json();
      await page.request.delete(`${baseURL}/api/tasks/${id}`, { data: { version: task.version } });
    }
  }
  await browser.close();
}
