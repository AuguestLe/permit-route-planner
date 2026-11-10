import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const baseURL = process.env.DEMO_BASE_URL || 'http://127.0.0.1:4318';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname), 'browser verification only targets localhost');
const artifacts = fileURLToPath(new URL('../.data-demo/verification/', import.meta.url));
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(20_000);
const errors = [];
const external = [];
let recordId = null;
let completed = false;
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  if (request.url().startsWith('http') && !['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url());
});

try {
  await page.goto(`${baseURL}/demo.html`);
  await page.getByText('本机服务已连接', { exact: true }).waitFor();
  await page.getByText('合成数据演示', { exact: true }).waitFor();
  await page.getByText('阈值未校准 · 非真伪鉴定 · 不处理企业真实证件', { exact: true }).waitFor();
  await page.getByRole('button', { name: '读取登记样例并上传' }).click();
  await page.getByText('pending', { exact: true }).waitFor();
  const records = (await (await page.request.get(`${baseURL}/api/demo/records`)).json()).records;
  recordId = records[0].id;
  assert.equal(records[0].sampleId, 'SYN-001');
  await page.getByRole('button', { name: '开始核验' }).click();
  await page.waitForFunction(async id => {
    const record = await (await fetch(`/api/demo/records/${id}`)).json();
    return record.status === 'completed';
  }, recordId, { timeout: 120_000 });
  await page.getByText('review_required', { exact: true }).waitFor();
  await page.getByText('转人工原因', { exact: true }).waitFor();
  await page.getByText('未提供（转人工）', { exact: true }).first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${artifacts}/demo-verify.png`, fullPage: true });

  await page.getByRole('button', { name: /人工复核/ }).click();
  await page.getByText('分流原因', { exact: true }).waitFor();
  const route = page.locator('.edit-fields label').filter({ hasText: '通行路线' }).locator('input');
  await route.fill('示例入口-S01-人工复核出口');
  await page.getByRole('button', { name: '确认通过', exact: true }).click();
  await page.getByText('复核已保存：approved', { exact: true }).waitFor();
  await page.screenshot({ path: `${artifacts}/demo-review.png`, fullPage: true });

  await page.getByRole('button', { name: '评测报告', exact: true }).click();
  await page.getByRole('heading', { name: '字段准确率', exact: true }).waitFor();
  await page.getByText('自动通过精确率', { exact: true }).waitFor();
  assert.equal(await page.getByText('—', { exact: true }).count() > 0, true);
  await page.getByText('样本明细', { exact: true }).waitFor();
  await page.screenshot({ path: `${artifacts}/demo-report.png`, fullPage: true });

  await page.getByRole('button', { name: '单张核验', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no page-level horizontal overflow at 390px');
  await page.screenshot({ path: `${artifacts}/demo-narrow.png`, fullPage: true });

  assert.deepEqual(errors, [], 'no uncaught browser errors');
  assert.deepEqual(external, [], 'no external browser requests');
  completed = true;
  console.log('Demo 浏览器验证通过：登记样例上传→本地核验→转人工原因→人工修订与确认→真实 bash 报告；无外部请求或未捕获异常。');
} finally {
  if (!completed) await page.screenshot({ path: `${artifacts}/demo-failure.png`, fullPage: true }).catch(() => {});
  if (recordId) {
    const response = await page.request.get(`${baseURL}/api/demo/records/${recordId}`);
    if (response.ok()) {
      const record = await response.json();
      await page.request.delete(`${baseURL}/api/demo/records/${recordId}`, { data: { version: record.version } });
    }
  }
  await browser.close();
}
