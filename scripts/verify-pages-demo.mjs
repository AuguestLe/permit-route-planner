// End-to-end check of the backend-free GitHub Pages preview: serve dist-pages
// under the real Pages sub-path and drive it with a headless browser.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { access, mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist-pages')
const prefix = process.env.PAGES_BASE ?? '/permit-route-planner/'
const artifacts = path.join(root, '.data-demo/verification')
await mkdir(artifacts, { recursive: true })
// PAGES_URL 指向真实站点时直接验线上，不再起本地静态服务。
const liveURL = process.env.PAGES_URL?.trim() || ''
const shot = name => path.join(artifacts, `${liveURL ? 'live' : 'pages'}-${name}.png`)
if (!liveURL) {
  await access(path.join(dist, 'index.html')).catch(() => {
    throw new Error('dist-pages/index.html is missing; run `npm run build:pages` first')
  })
}

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain',
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/') {
    response.writeHead(302, { location: prefix })
    return response.end()
  }
  if (!url.pathname.startsWith(prefix)) {
    response.writeHead(404, { 'content-type': 'text/plain' })
    return response.end('not found')
  }
  let target = path.join(dist, decodeURIComponent(url.pathname.slice(prefix.length)))
  if (!target.startsWith(dist)) {
    response.writeHead(403, { 'content-type': 'text/plain' })
    return response.end('forbidden')
  }
  try {
    if ((await stat(target)).isDirectory()) target = path.join(target, 'index.html')
    const body = await readFile(target)
    response.writeHead(200, { 'content-type': types[path.extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    return response.end(body)
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' })
    return response.end('not found')
  }
})

const port = liveURL ? 0 : await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const baseURL = liveURL || `http://127.0.0.1:${port}${prefix}`
const allowedHosts = ['127.0.0.1', 'localhost']
if (liveURL) allowedHosts.push(new URL(liveURL).hostname)
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const step = label => console.log(`[verify] ${label}`)
page.setDefaultTimeout(20_000)
const errors = []
const external = []
let completed = false
page.on('pageerror', error => errors.push(error.message))
if (process.env.PAGES_DEBUG) {
  page.on('console', message => console.log(`[page:${message.type()}] ${message.text()}`))
  page.on('pageerror', error => console.log(`[page:error] ${error.message}`))
}
page.on('request', request => {
  const url = request.url()
  if (!url.startsWith('http')) return
  if (!allowedHosts.includes(new URL(url).hostname)) external.push(url)
})

try {
  step('load page')
  await page.goto(baseURL)
  step('page loaded')
  await page.getByText('静态回放模式', { exact: true }).waitFor()
  await page.getByText('GitHub Pages · 无后端', { exact: true }).waitFor()
  await page.getByText('合成数据演示', { exact: true }).waitFor()
  await page.getByText('阈值未校准 · 非真伪鉴定 · 静态回放，无后端', { exact: true }).waitFor()

  step('click load sample')
  await page.getByRole('button', { name: '载入登记样例' }).click()
  step('pending visible')
  await page.getByText('pending', { exact: true }).waitFor()
  await page.getByText('合成样例已载入浏览器内存，请手动开始核验回放。', { exact: true }).waitFor()
  await page.screenshot({ path: shot('pending'), fullPage: true })

  step('click run')
  await page.getByRole('button', { name: '开始核验' }).click()
  step('run clicked')
  await page.getByText('completed', { exact: true }).waitFor()
  step('record completed')
  await page.getByText('review_required', { exact: true }).waitFor()
  await page.getByText('转人工原因', { exact: true }).waitFor()
  await page.getByText('未提供（转人工）', { exact: true }).first().waitFor()
  assert.equal(await page.locator('.document-stage img').evaluate(img => img.naturalWidth > 0), true, 'sample image is bundled and decoded')
  await page.screenshot({ path: shot('verify'), fullPage: true })

  await page.getByRole('button', { name: /人工复核/ }).click()
  await page.getByText('分流原因', { exact: true }).waitFor()
  const route = page.locator('.edit-fields label').filter({ hasText: '通行路线' }).locator('input')
  await route.fill('示例入口-S01-人工复核出口')
  await page.getByRole('button', { name: '确认通过', exact: true }).click()
  await page.getByText('复核已保存：approved', { exact: true }).waitFor()
  await page.screenshot({ path: shot('review'), fullPage: true })

  await page.getByRole('button', { name: '评测报告', exact: true }).click()
  await page.getByRole('heading', { name: '字段准确率', exact: true }).waitFor()
  await page.getByText('自动通过精确率', { exact: true }).waitFor()
  assert.equal(await page.getByText('—', { exact: true }).count() > 0, true, 'zero-denominator precision renders as a dash')
  const exportHref = await page.locator('.exports a').first().getAttribute('href')
  assert.ok(exportHref?.startsWith('data:application/json'), 'JSON export is generated client-side')
  await page.getByText('样本明细', { exact: true }).waitFor()
  await page.screenshot({ path: shot('report'), fullPage: true })

  await page.getByRole('button', { name: '单张核验', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no page-level horizontal overflow at 390px')
  await page.screenshot({ path: shot('narrow'), fullPage: true })

  // Records survive a reload through localStorage, which is what a static host can offer.
  await page.reload()
  await page.getByText('静态回放模式', { exact: true }).waitFor()
  await page.getByRole('button', { name: /人工复核/ }).click()
  await page.getByText('分流原因', { exact: true }).waitFor()
  assert.equal(await page.locator('.queue-item').count(), 1, 'record restored from localStorage')

  assert.deepEqual(errors, [], 'no uncaught browser errors')
  assert.deepEqual(external, [], 'no external network requests')
  if (!liveURL) {
    const bundleSize = (await stat(path.join(dist, 'index.html'))).size
    assert.ok(bundleSize > 0)
  }
  completed = true
  console.log('Pages 静态预览验证通过：静态回放模式 → 载入合成样例 → 回放核验 → 转人工原因 → 人工确认 → 冻结评测报告与客户端导出 → localStorage 持久化；无外部请求或未捕获异常。')
  console.log(`预览地址（${liveURL ? '线上站点' : '本地静态服务'}）：${baseURL}`)
} finally {
  if (!completed) await page.screenshot({ path: shot('failure'), fullPage: true }).catch(() => {})
  await page.evaluate(() => localStorage.clear()).catch(() => {})
  await browser.close()
  if (!liveURL) await new Promise(resolve => server.close(resolve))
}
