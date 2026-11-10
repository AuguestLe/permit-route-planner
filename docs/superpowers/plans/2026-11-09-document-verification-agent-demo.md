# 证照／单据结构化核验 Agent Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有超限证 OCR 项目内交付一个只使用登记合成样例、支持本地 OCR 与真实视觉 Function Calling、具备人工兜底和 30 张样例评测闭环的可展示 Demo。

**Architecture:** 保留原工作台，新增独立 Demo runtime、页面入口和 `.data-demo` 数据区。质检、抽取适配、Schema／业务校验、分级、复核、评测拆成小模块；本地与视觉适配器输出同一契约，评测复用交互管线。视觉请求只允许服务端配置的目标地址和合成哈希白名单。

**Tech Stack:** Node.js 24 ESM、Express 5、SQLite（node:sqlite）、Vue 3、Ant Design Vue 4、Vite 7、sharp、原生 Tesseract 5、Ajv 8.17.1（JSON Schema 2020-12）、Node test runner、supertest、Vue Test Utils、playwright-core。

**Spec:** `docs/superpowers/specs/2026-11-09-document-verification-agent-demo-design.md`

## Global Constraints

- Node.js 版本必须满足 `>=24.0.0 <25`；验证使用项目便携 Node `/Users/le/Desktop/project/permit-route-planner/.tools/node-v24.22.2-darwin-arm64/bin/node`。执行下文任何 `node`／`npm` 命令时都通过 `PATH="/Users/le/Desktop/project/permit-route-planner/.tools/node-v24.22.2-darwin-arm64/bin:$PATH"` 前缀保证运行时为 Node 24。
- Demo 后端只监听 `127.0.0.1:4318`；Demo 前端开发入口只监听 `127.0.0.1:5175`。
- Demo 数据只写入 `.data-demo/`；不得读取、清理、迁移或上传现有 `.data/` 和 `.test-artifacts/` 的既有附件。
- Demo 本地与视觉模式均只接收 `synthetic-permit-v1` 清单登记的 30 张合成样例；未登记文件在保存、识别、外发前拒绝。
- 真实模型仅通过服务端 OpenAI 兼容 API 调用；密钥不得进入浏览器、日志、报告或聊天。
- 视觉调用必须显式确认；先 3 张冒烟，再经用户确认运行 30 张；每张最多 2 次模型请求。
- 工具白名单只有 `submit_permit_fields`；模型不得直接决定任务状态。
- 自动通过阈值 `0.90`，普通复核阈值 `0.70`；硬门禁优先；本地置信度保持 `null` 并转人工。
- 质检初始阈值：宽／高最小 `400 px`；灰度熵空白阈值 `1.0`；最长边 `768 px` 降采样后的拉普拉斯方差阈值 `45`；过亮像素 `>245` 占比阈值 `18%`；过暗像素 `<10` 占比阈值 `75%`。
- 数据集固定为 18 张正常／版式变化、6 张质量退化、4 张缺失／歧义、2 张业务异常；全部带“非真实证件／SYNTHETIC”水印。
- 准确率使用人工修订前的规范化候选值；自动通过分母为 0 时显示 `—`；不得预填或混合不同模式成绩。
- 当前目录无 Git 元数据：不初始化仓库、不创建提交、不执行破坏性 Git 操作。每个任务以测试和文件检查作为 checkpoint。
- 不新增公网部署、真实证件真伪鉴别、地图规划或无关 README；运行说明更新到现有 `RUNNING.txt`。

## File Structure

### Existing files to modify

| File | Responsibility |
|---|---|
| `package.json:9-32` | 增加 Demo dev/build/start/generate/evaluate/browser 命令和 Ajv 依赖 |
| `package-lock.json` | 锁定新增依赖 |
| `vite.config.js:5-12` | 增加 demo mode：5175／4318、独立 `dist-demo` 输出 |
| `.gitignore:1-9` | 忽略 `.data-demo/`、`dist-demo/`、`.env.demo`，放行示例配置 |
| `RUNNING.txt` | 追加 Demo 启动、隐私门禁、评测与结果口径 |

### New backend files

| File | Responsibility |
|---|---|
| `server/demo/config.js` | 服务端视觉配置解析与脱敏能力摘要 |
| `server/demo/schema.js` | 11 字段常量、工具参数 Schema、候选输出 Schema、Ajv 编译 |
| `server/demo/normalize.js` | 日期／单位／整数的确定性规范化，保留 raw |
| `server/demo/validate.js` | 结构校验＋业务规则，字段级错误 |
| `server/demo/quality.js` | sharp 质检指标与 pass／warn／reject |
| `server/demo/decision.js` | 硬门禁与置信度分级 |
| `server/demo/adapters/local.js` | Tesseract＋规则抽取、原文证据、null 置信度 |
| `server/demo/adapters/vision.js` | 图片＋tools 请求、一次修正、调用轨迹、错误映射 |
| `server/demo/pipeline.js` | 统一编排、视觉失败本地兜底、状态与原因 |
| `server/demo/store.js` | Demo 专用 SQLite、版本、复核审计、到期记录 |
| `server/demo/queue.js` | Demo 串行任务、取消、关闭、中断恢复 |
| `server/demo/app.js` | 本机 API、合成哈希门禁、静态报告读取 |
| `server/demo/index.js` | 4318 独立启动入口，不导入原 `server/index.js` |
| `server/demo/metrics.js` | 纯函数指标计算与分母规则 |
| `server/demo/evaluation.js` | 调用同一管线、冻结运行记录、导出 JSON／CSV／Markdown |

### New frontend files

| File | Responsibility |
|---|---|
| `client/demo.html`、`client/src/demo/main.js` | 独立页面入口 |
| `client/src/demo/DemoApp.vue` | 三个视图切换、服务状态、合成数据声明 |
| `client/src/demo/api.js` | `/api/demo` 客户端，复用 ApiError 风格 |
| `client/src/demo/useDemo.js` | 样例、任务、轮询、草稿、复核、报告状态 |
| `client/src/demo/format.js` | 指标、置信度来源、模式标签和空分母的纯格式化函数 |
| `client/src/demo/components/VerifyView.vue` | 上传／样例选择、步骤、原图、字段、分级 |
| `client/src/demo/components/ToolTrace.vue` | 脱敏工具调用轨迹 |
| `client/src/demo/components/ReviewQueue.vue` | 待复核列表、字段修订、确认／退回 |
| `client/src/demo/components/ReportView.vue` | 运行选择、指标、字段表、30 行样本表、导出 |
| `client/src/demo/demo.css` | 基于现有样式的响应式补充 |

### Data, scripts and tests

| File | Responsibility |
|---|---|
| `demo/dataset.mjs` | 固定种子数据定义、独立真值、SVG 模板与退化处理 |
| `demo/samples/manifest.json`、`demo/samples/SYN-###.png`（### 为 001～030） | 冻结合成数据集 |
| `demo/reports/` | 实际评测 JSON／CSV／Markdown |
| `.env.demo.example` | 不含秘密的视觉配置示例 |
| `scripts/dev-demo.mjs` | 同时启动 Demo 后端和 Vite demo mode |
| `scripts/generate-demo-samples.mjs` | 生成／校验冻结数据集 |
| `scripts/evaluate-demo.mjs` | local／vision、limit／all、外发确认门禁 |
| `scripts/verify-demo-browser.mjs` | 合成样例完整浏览器流程 |
| `tests/demo-*.test.js` | 配置、Schema、质检、分级、适配器、管线、存储、API、数据集、指标、前端测试 |

Ajv 版本与 API 依据：[Ajv 8.17.1 JSON Schema 2020-12](https://github.com/ajv-validator/ajv/blob/v8.17.1/docs/json-schema.md)、[Ajv options](https://github.com/ajv-validator/ajv/blob/v8.17.1/docs/options.md)、[Ajv ErrorObject](https://github.com/ajv-validator/ajv/blob/v8.17.1/docs/api.md)。

---

### Task 1: 独立 Demo Runtime 与配置边界

**Files:**
- Create: `server/demo/config.js`, `server/demo/app.js`, `server/demo/index.js`, `scripts/dev-demo.mjs`, `.env.demo.example`
- Modify: `package.json`, `vite.config.js`, `.gitignore`
- Test: `tests/demo-runtime.test.js`

**Interfaces:**
- Produces: `loadDemoConfig(env) -> { vision: null | { baseUrl, model, apiKey, timeoutMs }, visionConfigured }`
- Produces: `createDemoRuntime({ dataDir, config }) -> { app, close() }`；后续任务在此扩展，不打开原数据库。

- [ ] **Step 1: Write failing runtime/config tests**

```js
test('demo health is local-only and synthetic-only', async t => {
  const root = await mkdtemp(join(tmpdir(), 'demo-runtime-'));
  const runtime = await createDemoRuntime({ dataDir: join(root, 'demo'), config: loadDemoConfig({}) });
  t.after(() => runtime.close());
  const res = await request(runtime.app).get('/api/demo/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, localOnly: true, syntheticOnly: true, visionConfigured: false });
});
test('vision config requires https and never serializes the key', () => {
  const config = loadDemoConfig({ DEMO_VISION_BASE_URL: 'https://api.example.com/v1', DEMO_VISION_MODEL: 'vision-model', DEMO_VISION_API_KEY: 'secret-test-value' });
  assert.equal(config.visionConfigured, true);
  assert.doesNotMatch(JSON.stringify({ configured: config.visionConfigured }), /secret-test-value/);
  assert.throws(() => loadDemoConfig({ DEMO_VISION_BASE_URL: 'http://api.example.com/v1', DEMO_VISION_MODEL: 'm', DEMO_VISION_API_KEY: 'k' }), /HTTPS/);
});
```

- [ ] **Step 2: Run the failing test**

Run: `node --test tests/demo-runtime.test.js`
Expected: FAIL because `server/demo/app.js` and `config.js` do not exist.

- [ ] **Step 3: Implement minimal isolated runtime and scripts**

`loadDemoConfig` reads only `DEMO_VISION_BASE_URL`, `DEMO_VISION_MODEL`, `DEMO_VISION_API_KEY`, `DEMO_VISION_TIMEOUT_MS`（默认 60000，范围 1000～120000）；三者缺一则 `vision:null`，不完整但部分存在时返回明确配置错误。URL 必须 HTTPS、无 userinfo。`createDemoRuntime` 创建 mode 0700 的独立 dataDir，设置与原 API 一致的本机／跨站防护和 no-store，只提供 health；`index.js` 监听 4318，umask 077，SIGINT／SIGTERM 关闭。

`package.json` 增加：

```json
{
  "dev:demo": "node --env-file-if-exists=.env.demo scripts/dev-demo.mjs",
  "build:demo": "vite build --config vite.config.js --mode demo",
  "start:demo": "node --env-file-if-exists=.env.demo server/demo/index.js",
  "demo:generate": "node scripts/generate-demo-samples.mjs",
  "demo:evaluate": "node scripts/evaluate-demo.mjs",
  "test:demo:browser": "node scripts/verify-demo-browser.mjs"
}
```

Node 24 已验证支持 `--env-file-if-exists`：文件不存在时继续运行，存在时只给 Demo 进程注入变量。`vite.config.js` 使用 mode 分支：

```js
export default defineConfig(({ mode }) => {
  const demo = mode === 'demo'
  return {
    root: fileURLToPath(new URL('./client', import.meta.url)),
    plugins: [vue()],
    build: demo
      ? { outDir: '../dist-demo', emptyOutDir: true, rollupOptions: { input: fileURLToPath(new URL('./client/demo.html', import.meta.url)) } }
      : { outDir: '../dist', emptyOutDir: true },
    server: demo
      ? { host: '127.0.0.1', port: 5175, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4318' } }
      : { host: '127.0.0.1', port: 5174, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4317' } },
  }
})
```

`dev-demo.mjs` 只 spawn `server/demo/index.js` 与 `vite --mode demo`；子进程继承已注入的环境变量。`server/demo/index.js` 在 `dist-demo` 存在时以 CSP、`dotfiles: deny` 和 `X-Frame-Options: DENY` 提供静态文件，并把 `/` 重定向到 `/demo.html`。`.gitignore` 追加 `.data-demo/`、`dist-demo/`、`!.env.demo.example`。`.env.demo.example` 只列 `DEMO_VISION_BASE_URL`、`DEMO_VISION_MODEL`、`DEMO_VISION_API_KEY`、`DEMO_VISION_TIMEOUT_MS` 四个变量，密钥值为空。

- [ ] **Step 4: Run tests and inspect isolation**

Run: `node --test tests/demo-runtime.test.js`
Expected: PASS.
Run: `git rev-parse --is-inside-work-tree 2>/dev/null || true`
Expected: 无输出；不执行 git init。

### Task 2: Schema、规范化与业务校验

**Files:**
- Create: `server/demo/schema.js`, `server/demo/normalize.js`, `server/demo/validate.js`
- Modify: `package.json`, `package-lock.json`
- Test: `tests/demo-schema.test.js`

**Interfaces:**
- Produces: `FIELD_KEYS`, `TOOL_SCHEMA`, `CANDIDATE_SCHEMA`, `validateToolArguments(value)`, `normalizeFields(rawFields)`, `validateCandidates(candidates, { referenceDate })`
- Result shape: `{ ok, errors: [{ path, code, message }] }`；规范化返回 `{ candidates, errors }`。

- [ ] **Step 1: Add Ajv and write failing contract tests**

Run: `npm install --save-exact ajv@8.17.1`

```js
test('tool arguments require all eleven fields and reject extras', () => {
  const args = Object.fromEntries(FIELD_KEYS.map(k => [k, { raw: null, confidence: null, evidenceQuote: null }]));
  assert.equal(validateToolArguments(args).ok, true);
  assert.equal(validateToolArguments({ ...args, state: 'approved' }).ok, false);
  assert.equal(validateToolArguments({ ...args, axleCount: { raw: '6', confidence: 2, evidenceQuote: '6' } }).ok, false);
});
test('normalization preserves raw and converts declared units only', () => {
  const raw = { length: { raw: '18000 mm', confidence: 0.95, evidenceQuote: '18000 mm' }, weight: { raw: '49 吨', confidence: 0.95, evidenceQuote: '49 吨' } };
  const { candidates, errors } = normalizeFields(raw);
  assert.deepEqual(candidates.length, { value: 18, unit: 'm' });
  assert.deepEqual(candidates.weight, { value: 49000, unit: 'kg' });
  assert.equal(raw.length.raw, '18000 mm');
  assert.deepEqual(errors, []);
  assert.equal(normalizeFields({ length: { raw: '18.5' } }).candidates.length, null);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/demo-schema.test.js`
Expected: FAIL on missing exports.

- [ ] **Step 3: Implement schemas and deterministic validators**

使用文档确认的 2020-12 入口：

```js
import Ajv2020 from 'ajv/dist/2020';
const ajv = new Ajv2020({ strict: true, allErrors: true, coerceTypes: false, removeAdditional: false, validateFormats: false });
```

`FIELD_KEYS` 固定为现有 11 键。工具参数每个字段必须且只能包含 raw／confidence／evidenceQuote；nullable 用 `anyOf` 表达，避免隐式类型转换。候选 Schema 允许 null 以便记录缺失，但业务校验要求全部 11 字段非 null。日期接受 `YYYY-MM-DD`、`YYYY/M/D`、中文年月日并验证真实日历；长度 mm／cm／m 转 m，重量 kg／公斤／千克／t／吨转 kg；未知单位报错并保留 candidate null；轴数为 1～12 整数。业务规则检查 `validFrom <= referenceDate <= validTo`、测量值 > 0、路线非空。错误映射使用 Ajv `instancePath`／`keyword`／`params`，页面文案在服务端生成。

- [ ] **Step 4: Verify edge cases and dependency lock**

Run: `node --test tests/demo-schema.test.js`
Expected: PASS，覆盖闰年、非法日期、缺失单位、未知单位、负数、轴数越界、额外属性、置信度越界。
Run: `npm ls ajv`
Expected: `ajv@8.17.1`。

### Task 3: 图像质检与确定性分级

**Files:**
- Create: `server/demo/quality.js`, `server/demo/decision.js`
- Test: `tests/demo-quality.test.js`, `tests/demo-decision.test.js`

**Interfaces:**
- Produces: `inspectQuality(buffer) -> { status, checks }`
- Produces: `decide({ quality, validation, fields }) -> { level, action, reasons }`

- [ ] **Step 1: Write failing quality and decision tests**

```js
test('blank image is rejected and readable image passes', async () => {
  const blank = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#fff' } }).png().toBuffer();
  assert.equal((await inspectQuality(blank)).status, 'reject');
});
test('missing local confidence never auto-approves', () => {
  const fields = Object.fromEntries(FIELD_KEYS.map(k => [k, { candidate: 'x', confidence: { score: null, source: 'unavailable' }, evidence: { start: 0, end: 1 } }]));
  const decision = decide({ quality: { status: 'pass' }, validation: { ok: true }, fields });
  assert.equal(decision.level, 'unknown');
  assert.equal(decision.action, 'review_required');
});
```

- [ ] **Step 2: Run failing tests**

Run: `node --test tests/demo-quality.test.js tests/demo-decision.test.js`
Expected: FAIL on missing modules.

- [ ] **Step 3: Implement pixel metrics and hard gates**

质检用 `sharp(buffer).greyscale().resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true })`；计算 256 bin 熵、亮／暗比例、内部像素四邻域拉普拉斯方差。按 Global Constraints 的阈值产生 checks；每个 check 包含 code、label、value、threshold、status。尺寸／空白为 reject，模糊／曝光为 warn。

分级先处理 reject 和校验失败；high 要求 quality pass、validation ok、11 字段 candidate 非 null、证据存在、全部 confidence.score ≥ 0.90 且 source 为 `model-self-report`。任何 <0.70 为 low；全部 ≥0.70 但存在 <0.90 为 medium；缺失为 unknown。除 high 外 action 均为 `review_required`，reasons 写明具体门禁。

- [ ] **Step 4: Verify boundary values**

Run: `node --test tests/demo-quality.test.js tests/demo-decision.test.js`
Expected: PASS，覆盖 0.69／0.70／0.89／0.90、质量 warn、Schema fail、缺证据、null 置信度。

### Task 4: 本地抽取适配器与证据映射

**Files:**
- Create: `server/demo/adapters/local.js`
- Test: `tests/demo-local-adapter.test.js`

**Interfaces:**
- Consumes: 现有 `createRecognizer()`、`extractPermitFields(text, imageId)`、Task 2 规范化。
- Produces: `createLocalAdapter({ recognize })`，`run({ filePath, imageId, signal, onStage }) -> { fields, candidates, ocrText, trace, usage: null }`。

- [ ] **Step 1: Write failing adapter test with injected OCR**

```js
const adapter = createLocalAdapter({ recognize: async () => ({ text: '车牌号码：DEMO-A0001\n车货总长：18米', confidence: null, engine: 'Tesseract', languages: ['chi_sim', 'eng'] }) });
const result = await adapter.run({ filePath: '/tmp/synthetic.png', imageId: 'SYN-001' });
assert.equal(result.fields.plateNumber.raw, 'DEMO-A0001');
assert.equal(result.fields.plateNumber.confidence.source, 'unavailable');
assert.equal(result.fields.plateNumber.confidence.score, null);
assert.equal(result.ocrText.slice(result.fields.plateNumber.evidence.start, result.fields.plateNumber.evidence.end), 'DEMO-A0001');
assert.deepEqual(result.candidates.length, { value: 18, unit: 'm' });
```

- [ ] **Step 2: Run the failing test**

Run: `node --test tests/demo-local-adapter.test.js`
Expected: FAIL on missing adapter.

- [ ] **Step 3: Implement adapter without changing original OCR**

调用现有 recognizer，保留完整 ocrText；用现有规则提取 raw/source；映射为统一字段契约，confidence 固定 `{score:null,source:'unavailable'}`；trace 记录 `{stage:'local-ocr',engine,languages,durationMs}`，不记录文件绝对路径。规范化错误随字段返回，不抛掉已识别原文。

- [ ] **Step 4: Verify evidence and cancellation**

Run: `node --test tests/demo-local-adapter.test.js`
Expected: PASS，覆盖原文区间、null 置信度、OCR 错误码透传、AbortSignal。

### Task 5: 视觉 Function Calling 适配器

**Files:**
- Create: `server/demo/adapters/vision.js`
- Test: `tests/demo-vision-adapter.test.js`

**Interfaces:**
- Consumes: Task 1 vision config、Task 2 TOOL_SCHEMA／规范化、Task 4 ocrText。
- Produces: `createVisionAdapter({ config, fetchImpl })`，`run({ imageBuffer, mime, ocrText, imageId, signal }) -> { fields, candidates, trace, usage, repairCount }`。

- [ ] **Step 1: Write failing success and repair contract tests**

```js
const visionConfig = { baseUrl: 'https://api.example.com/v1', model: 'vision-model', apiKey: 'secret-test-value', timeoutMs: 5000 };
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const validArgs = Object.fromEntries(FIELD_KEYS.map(k => [k, { raw: null, confidence: null, evidenceQuote: null }]));
validArgs.plateNumber = { raw: 'DEMO-A0001', confidence: 0.96, evidenceQuote: 'DEMO-A0001' };
const toolResponse = args => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'submit_permit_fields', arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }) });
test('sends image and one whitelisted tool then validates arguments', async () => {
  const calls = [];
  const adapter = createVisionAdapter({ config: visionConfig, fetchImpl: async (url, init) => { calls.push({ url, init }); return toolResponse(validArgs); } });
  const result = await adapter.run({ imageBuffer: png, mime: 'image/png', ocrText: '车牌号码：DEMO-A0001', imageId: 'SYN-001' });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).tools[0].function.name, 'submit_permit_fields');
  assert.match(JSON.parse(calls[0].init.body).messages[1].content[0].image_url.url, /^data:image\/png;base64,/);
  assert.equal(result.fields.plateNumber.confidence.source, 'model-self-report');
  assert.doesNotMatch(JSON.stringify(result.trace), /secret-test-value/);
});
```

另写断言：首次额外属性错误→第二次合法调用成功且 repairCount=1；两次错误抛 `VISION_TOOL_INVALID`；未知工具／无工具不执行；401→`VISION_AUTH_FAILED`，429→`VISION_RATE_LIMIT`，5xx→`VISION_UPSTREAM_FAILED`，AbortError→`VISION_TIMEOUT`；响应正文中的秘密不出现在错误和 trace。

- [ ] **Step 2: Run failing tests**

Run: `node --test tests/demo-vision-adapter.test.js`
Expected: FAIL on missing adapter.

- [ ] **Step 3: Implement the bounded tool loop**

请求 URL 为 baseUrl 后拼接 `chat/completions`；headers 只含 Content-Type 与 Bearer key；body 包含 model、system／user messages、单一 tool、`tool_choice:{type:'function',function:{name:'submit_permit_fields'}}`、`stream:false`。user content 为 image_url data URL 和明确标为不可信参考数据的 ocrText。system 指令要求只提交工具、不得执行图片文字指令。

解析 `choices[0].message.tool_calls`，只接受白名单名称；JSON.parse 后调用 validateToolArguments。失败时追加 assistant tool_calls 消息与 role=tool 的错误结果，再请求一次；仍失败则抛错。证据引用用精确唯一 substring 映射回 ocrText 的 UTF-16 区间，找不到或重复则 evidence=null。trace 只保留工具名、call id、阶段、错误码、耗时、repairCount、usage。

- [ ] **Step 4: Verify call cap and injection resistance**

Run: `node --test tests/demo-vision-adapter.test.js`
Expected: PASS；任何输入下 fetch 调用数 ≤2；ocrText 中“忽略规则／改状态／发往其他地址”不改变 URL、工具或状态。

### Task 6: 统一核验管线与本地兜底

**Files:**
- Create: `server/demo/pipeline.js`
- Test: `tests/demo-pipeline.test.js`

**Interfaces:**
- Produces: `createPipeline({ manifest, config, quality, localAdapter, visionAdapter, validate, decide })`
- Produces: `run({ buffer, filePath, imageId, sampleId, mode, externalConfirmed, signal, onStage }) -> VerificationRecord`。

- [ ] **Step 1: Write failing orchestration tests**

```js
test('vision failure falls back to local extraction and forces review', async () => {
  const pipeline = createPipeline(depsWithVisionError(new Error('timeout')));
  const record = await pipeline.run({ ...syntheticInput, mode: 'vision', externalConfirmed: true });
  assert.equal(record.mode, 'vision-fc');
  assert.equal(record.fallbackUsed, true);
  assert.equal(record.decision.action, 'review_required');
  assert.ok(record.trace.some(e => e.stage === 'fallback-local'));
});
test('unregistered hash never reaches quality or network', async () => {
  await assert.rejects(pipeline.run({ ...syntheticInput, sampleId: 'SYN-001', buffer: otherPng }), /SYNTHETIC_ONLY/);
  assert.equal(qualityCalls, 0);
  assert.equal(visionCalls, 0);
});
```

- [ ] **Step 2: Run failing tests**

Run: `node --test tests/demo-pipeline.test.js`
Expected: FAIL on missing pipeline.

- [ ] **Step 3: Implement deterministic orchestration**

先校验 manifest entry、synthetic 标记和 sha256；质检 reject 直接形成 rejected record；否则运行 localAdapter 得到 ocrText／本地候选。mode=vision 时检查 config、externalConfirmed 和白名单后调用 visionAdapter；视觉异常保留错误码并采用本地候选，追加 fallback trace，强制 review。对候选运行 validateCandidates，再 decide。record 固定包含 id／sampleId／mode／quality／fields／candidates／validation／decision／trace／fallbackUsed／timings／error；不暴露 filePath。

- [ ] **Step 4: Verify all branches**

Run: `node --test tests/demo-pipeline.test.js`
Expected: PASS，覆盖 local、vision 成功、vision 兜底、未确认外发、未登记哈希、质量拒绝、本地 OCR 失败、取消。

### Task 7: Demo 存储、串行队列与复核审计

**Files:**
- Create: `server/demo/store.js`, `server/demo/queue.js`
- Test: `tests/demo-store.test.js`, `tests/demo-queue.test.js`

**Interfaces:**
- Produces: `DemoStore.create({ sampleId, sha256, mime, size, mode })`, `get(id)`, `list()`, `enqueue(id, version, mode)`, `updateJob(id, token, fn)`, `complete(id, token, record)`, `fail(id, token, error)`, `review(id, body)`, `delete(id)`, `expired(now)`, `close()`。
- Produces: `DemoQueue.add({ recordId, version, mode, externalConfirmed })`, `cancel(recordId)`, `whenIdle()`, `close()`。

- [ ] **Step 1: Write failing persistence and review tests**

```js
test('review appends audit and never overwrites raw fields', () => {
  const store = new DemoStore(dbPath);
  const record = store.create({ sampleId: 'SYN-001', sha256: 'a'.repeat(64), mime: 'image/png', size: 10, mode: 'local-ocr' });
  const job = store.enqueue(record.id, 1, 'local-ocr');
  store.complete(record.id, job.token, completedRecord);
  const reviewed = store.review(record.id, { version: 2, fields: { passRoute: '示例入口→S01→示例出口' }, conclusion: 'approved' });
  assert.equal(reviewed.fields.passRoute.raw, completedRecord.fields.passRoute.raw);
  assert.equal(reviewed.review.revisions.passRoute, '示例入口→S01→示例出口');
  assert.equal(reviewed.review.events.length, 1);
  assert.throws(() => store.review(record.id, { version: 2, conclusion: 'approved' }), /VERSION_CONFLICT/);
});
```

- [ ] **Step 2: Run failing tests**

Run: `node --test tests/demo-store.test.js tests/demo-queue.test.js`
Expected: FAIL on missing classes.

- [ ] **Step 3: Implement isolated SQLite and queue**

SQLite 表 `demo_records(id TEXT PRIMARY KEY, sample_id TEXT, sha256 TEXT, expires_at INTEGER, created_at INTEGER, body TEXT)`，WAL、secure_delete、文件权限 0600。record 初始 version=1、status=pending、保留 7 天。enqueue 校验 version=1 后写 token、status=queued 并递增为 version=2；complete／fail 只校验 token，不改变 version。review 必须提交当前 version=2，成功后递增为 3。队列容量 20、并发 1；删除后旧结果不得写回。review 只接受 11 字段字符串／null 和 conclusion，重新规范化／校验；approved 必须 validation ok；事件保存 local-demo-user、时间、before／after、version。中断恢复把 running 置 failed／INTERRUPTED。

- [ ] **Step 4: Verify restart, conflict and cancellation**

Run: `node --test tests/demo-store.test.js tests/demo-queue.test.js`
Expected: PASS，覆盖重开数据库、409 语义、审计、到期、删除期间完成、关闭中断、队列上限。

### Task 8: 合成数据门禁 API

**Files:**
- Modify: `server/demo/app.js`, `server/demo/index.js`
- Test: `tests/demo-api.test.js`

**Interfaces:**
- Consumes: Tasks 1／6／7。
- Produces endpoints: `GET /api/demo/health`, `GET /api/demo/samples`, `GET /api/demo/samples/:sampleId/file`, `POST /api/demo/records`, `GET /api/demo/records`, `GET /api/demo/records/:id`, `GET /api/demo/records/:id/file`, `POST /api/demo/records/:id/run`, `PATCH /api/demo/records/:id/review`, `DELETE /api/demo/records/:id`。

- [ ] **Step 1: Write failing privacy-first API tests**

测试在临时目录生成一张 PNG、一条 `{sampleId:'SYN-001',filename:'SYN-001.png',sha256,synthetic:true,watermark:true}` manifest 记录，不依赖 Task 9 的 30 张冻结数据。

```js
test('unregistered upload is rejected before persistence', async () => {
  const res = await client.post('/api/demo/records').set('Idempotency-Key', randomUUID())
    .field('sampleId', 'SYN-001').attach('file', otherPng, { filename: 'SYN-001.png', contentType: 'image/png' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'SYNTHETIC_ONLY');
  assert.equal((await client.get('/api/demo/records')).body.records.length, 0);
  assert.deepEqual(await readdir(join(dataDir, 'tmp')), []);
});
test('vision run requires explicit confirmation', async () => {
  const created = await uploadRegisteredSample();
  const res = await client.post(`/api/demo/records/${created.body.id}/run`).send({ version: 1, mode: 'vision', externalConfirmed: false });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'EXTERNAL_CONFIRMATION_REQUIRED');
});
```

- [ ] **Step 2: Run failing tests**

Run: `node --test tests/demo-api.test.js`
Expected: FAIL on missing endpoints.

- [ ] **Step 3: Implement endpoints and double hash gate**

上传仅接收单个 `file` 与 `sampleId`，沿用 validateImage 和 UPLOAD_LIMITS 的文件类型、大小、像素限制；multer 临时文件计算 sha256 后必须与 manifest 的 sampleId／hash 完全一致，否则删除临时文件并拒绝。登记后写入 `.data-demo/images/<recordId>/`，公共 JSON 去除 filePath／token。run 再次检查 mode、版本、视觉配置和 externalConfirmed。图片读取只拼接服务端记录中的安全文件名。样本 file 路由只允许 manifest 内 ID，禁止路径穿越。沿用每分钟 60 次写操作限流和 `{error:{code,message}}`。runtime 每分钟清理到期记录与图片，启动时补清理；清理只遍历 `.data-demo`。

- [ ] **Step 4: Verify API safety and workflow**

Run: `node --test tests/demo-api.test.js`
Expected: PASS，覆盖登记上传、一键样本读取、未登记拒绝、伪装图片、跨站／非本机、外发确认、运行→复核、版本冲突、删除清理。

### Task 9: 30 张合成数据集与冻结清单

**Files:**
- Create: `demo/dataset.mjs`, `scripts/generate-demo-samples.mjs`, `demo/samples/manifest.json`, `demo/samples/SYN-001.png`…`SYN-030.png`
- Test: `tests/demo-dataset.test.js`

**Interfaces:**
- Produces: `buildDatasetDefinition(seed = 20261109) -> entries[]`；entry 包含 sampleId、scenario、rawFields、expectedCandidates、expectedValid、referenceDate。
- Produces: `generateDataset({ outputDir, seed }) -> manifest`；manifest 包含 datasetVersion、seed、renderEnvironment、entries（追加 sha256、filename、synthetic:true、watermark:true）。

- [ ] **Step 1: Write failing dataset tests**

```js
test('dataset has exactly thirty registered synthetic cases', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'demo-dataset-'));
  const manifest = await generateDataset({ outputDir: dir, seed: 20261109 });
  assert.equal(manifest.datasetVersion, 'synthetic-permit-v1');
  assert.equal(manifest.entries.length, 30);
  assert.equal(new Set(manifest.entries.map(e => e.sha256)).size, 30);
  assert.deepEqual(manifest.entries.map(e => e.sampleId), Array.from({ length: 30 }, (_, i) => `SYN-${String(i + 1).padStart(3, '0')}`));
  assert.ok(manifest.entries.every(e => e.synthetic && e.watermark));
  assert.equal(manifest.entries.filter(e => e.scenario === 'quality').length, 6);
});
```

- [ ] **Step 2: Run failing tests**

Run: `node --test tests/demo-dataset.test.js`
Expected: FAIL on missing generator.

- [ ] **Step 3: Implement independent truth and rendering**

使用固定 mulberry32 PRNG 生成数值变化；真值直接由生成参数构造，绝不调用被测 normalizeFields 反推。18 张 normal 变化标签别名、日期格式、mm／cm／m 与 kg／t；6 张 quality 使用 blur、linear 对比度和 ±2° rotate；4 张 missing 将指定 raw／expected 设为 null 或制造重复冲突；2 张 business 分别为起止倒置和负数测量值。基准日固定 `2030-06-15`，正常有效期覆盖该日。

SVG  escapement 后渲染 1600×1200 PNG，顶部和底部水印不遮挡字段；编号 `DEMO-PERMIT-0001` 起，车牌 `DEMO-A0001` 起，地区“示例省”，路线“示例入口→S01→示例出口”。生成后计算 sha256 写 manifest。默认目录已有清单时只校验哈希，不覆盖冻结数据；测试使用临时目录。

- [ ] **Step 4: Generate and inspect the actual dataset**

Run: `npm run demo:generate`
Expected: 生成 30 张 PNG 和 manifest，数量／哈希断言通过。
Run: `node --test tests/demo-dataset.test.js`
Expected: PASS。

### Task 10: 指标、评测运行器与报告导出

**Files:**
- Create: `server/demo/metrics.js`, `server/demo/evaluation.js`, `scripts/evaluate-demo.mjs`
- Modify: `server/demo/app.js`（报告读取）, `package.json`
- Test: `tests/demo-metrics.test.js`, `tests/demo-evaluation.test.js`

**Interfaces:**
- Produces: `computeMetrics(results) -> { fields, micro, macro, wholeDocumentAccuracy, decisionAccuracy, autoApprovePrecision, reviewRate, rejectRate, fallbackRate, latencyP50Ms, latencyP95Ms, modelCalls }`
- Produces: `runEvaluation({ pipeline, manifest, mode, limit, all, externalConfirmed, reportDir, now }) -> report`
- Produces: `GET /api/demo/reports`, `GET /api/demo/reports/:runId`, `GET /api/demo/reports/:runId/export?format=json|csv|markdown`。

- [ ] **Step 1: Write failing denominator and CLI-gate tests**

```js
test('zero auto approvals produce null precision, not one', () => {
  const metrics = computeMetrics([resultWithDecision('review_required')]);
  assert.equal(metrics.autoApprovePrecision, null);
});
test('vision evaluation refuses network before confirmation', async () => {
  await assert.rejects(runEvaluation({ ...deps, mode: 'vision', all: true, externalConfirmed: false }), /EXTERNAL_CONFIRMATION_REQUIRED/);
  assert.equal(fetchCalls, 0);
});
```

另用手算夹具断言：字段 A 预期非空 2、正确 1→0.5；预期 null 2、预测 null 1→缺失识别率 0.5；micro 使用总数比，macro 使用字段均值；CSV 正确转义逗号、引号和换行。

- [ ] **Step 2: Run failing tests**

Run: `node --test tests/demo-metrics.test.js tests/demo-evaluation.test.js`
Expected: FAIL on missing modules.

- [ ] **Step 3: Implement evaluation against the same pipeline**

CLI 只接受 `--mode local|vision`、互斥的 `--limit <1..30>`／`--all`、`--confirm-external`。`createDemoRuntime` 增加可选 `reportDir`（测试临时目录，生产默认 `demo/reports`），报告 API 与 CLI 使用同一目录。vision 未确认时在读取图片／调用网络前退出。逐张调用 pipeline，保存人工修订前预测；run id 使用 UUID，元数据包含 mode、model、datasetVersion、manifestHash、thresholdVersion、startedAt／finishedAt。指标公式固定为：字段准确率分母只含 expectedCandidates 非空的样本；micro 为总正确／总预期，macro 为有分母字段准确率的均值；整单完全正确包含 null 比较；decisionAccuracy 比较预测 validation.ok 与 expectedValid；reviewRate 为 `review_required / total`，rejectRate 为 `rejected / total`；autoApprovePrecision 只把“自动通过且字段全对且 expectedValid”为命中，分母为自动通过数，0 时为 null；p50／p95 使用排序后的最近秩。报告写入 `demo/reports/<runId>/report.json`、`field-accuracy.csv`、`samples.csv`、`summary.md`，并更新只含合成运行索引的 `demo/reports/index.json`。API 只读取该目录内登记 run，禁止路径穿越。

- [ ] **Step 4: Run a real local baseline**

Run: `npm run demo:evaluate -- --mode local --all`
Expected: 30 张均产生实际记录或明确失败；报告数字由运行计算；fetch 调用为 0。
Run: `node --test tests/demo-metrics.test.js tests/demo-evaluation.test.js`
Expected: PASS。

### Task 11: 三视图 Demo UI

**Files:**
- Create: `client/demo.html`, `client/src/demo/main.js`, `client/src/demo/DemoApp.vue`, `client/src/demo/api.js`, `client/src/demo/useDemo.js`, `client/src/demo/format.js`, `client/src/demo/components/VerifyView.vue`, `client/src/demo/components/ToolTrace.vue`, `client/src/demo/components/ReviewQueue.vue`, `client/src/demo/components/ReportView.vue`, `client/src/demo/demo.css`
- Modify: `vite.config.js`（demo 入口）
- Test: `tests/demo-client.test.js`

**Interfaces:**
- Consumes: Task 8 API、Task 10 reports API、现有 `PreviewPanel.vue`、`ApiError`、Ant Design Vue。
- Produces: `createDemoApi(fetcher)`、`useDemo({ api })`、视图 `verify／review／reports`。

- [ ] **Step 1: Write failing client logic tests**

页面组件由 Task 12 的真实浏览器流程验证；Node 测试只覆盖不依赖 SFC 编译的客户端模块：

```js
import { createDemoApi } from '../client/src/demo/api.js'
import { formatPrecision, modeLabel } from '../client/src/demo/format.js'

test('report renders zero-denominator precision as a dash', () => {
  assert.equal(formatPrecision(null), '—');
  assert.equal(formatPrecision(0.75), '75.0%');
});
test('vision run request carries explicit confirmation and version', async () => {
  const calls = [];
  const client = createDemoApi(async (url, options) => {
    calls.push([url, options]);
    return new Response(JSON.stringify({ id: 'r1' }), { status: 200 });
  });
  await client.runRecord('r1', { version: 2, mode: 'vision', externalConfirmed: true });
  assert.deepEqual(calls.map(([url]) => url), ['/api/demo/records/r1/run']);
  assert.deepEqual(JSON.parse(calls[0][1].body), { version: 2, mode: 'vision', externalConfirmed: true });
});
```

另断言固定端点编码、`modeLabel('local-ocr')`／`modeLabel('vision-fc')`、未知模式不透传，以及 API 错误沿用 `{error:{code,message}}`。

- [ ] **Step 2: Run failing tests**

Run: `node --test tests/demo-client.test.js`
Expected: FAIL on missing components.

- [ ] **Step 3: Implement shell, verification and review views**

`DemoApp` 用 a-segmented／tabs 切换三视图，顶部显示 local-ocr／vision-fc、服务状态和“非真伪鉴定”。`useDemo` 只保存内存草稿，2.2 秒轮询运行中记录，409 保留草稿；不向 localStorage 写字段。VerifyView 用样例选择或文件上传创建记录，显式选择模式；vision 弹出行数／费用确认后才 run。步骤条展示上传／质检／抽取／校验／分级／结论；复用 PreviewPanel；字段表显示 raw、candidate、confidence source、evidence、errors；ToolTrace 展示脱敏摘要。

ReviewQueue 列出 review_required，按 low／unknown 优先；编辑 11 字段，保存草稿与确认／退回分开；确认按钮仅在服务端 validation ok 时可用。所有状态同时有文字，不只靠颜色。

- [ ] **Step 4: Implement report view and responsive layout**

ReportView 选择 run，展示模式／模型／数据版本／时间、核心指标、11 行字段表、按运行样本数显示明细行（本地全量运行显示 30 行）；样本行展开 FieldDiff 与 trace；导出链接指向 API。DemoApp 和 VerifyView 固定展示“合成数据演示”“阈值未校准”“非真伪鉴定”，这些文案在 Task 12 浏览器断言中检查。窄屏双栏改单列，表格横向滚动，按钮有 aria-label。完成后运行客户端测试与 demo build。

Run: `node --test tests/demo-client.test.js`
Expected: PASS。
Run: `npm run build:demo`
Expected: 生成 `dist-demo/demo.html`，不覆盖原 `dist`。

### Task 12: 回归、浏览器验证、文档与真实模型评测

**Files:**
- Create: `scripts/verify-demo-browser.mjs`
- Modify: `RUNNING.txt`
- Test: existing `tests/*.test.js`, all `tests/demo-*.test.js`, browser flow, live vision reports

**Interfaces:**
- Consumes: all previous tasks。
- Produces: 可复跑验证命令、实际本地报告、视觉冒烟报告、经确认的 30 张视觉报告、运行说明。

- [ ] **Step 1: Write the browser verification script**

脚本使用 playwright-core 和本机 Chrome（或 `CHROME_PATH`），只加载 manifest 内 SYN-001。流程断言：打开 5175 → 选择合成样例／上传 → local run → 质检与 trace 可见 → unknown／review_required → 修改路线 → 保存 → 确认通过 → 打开本地报告 → 字段表和 30 行样本表存在。再检查 390px 宽度无页面级横向溢出。截图只写入 `.data-demo/verification/`，不写旧 `.test-artifacts`。

- [ ] **Step 2: Run automated verification with Node 24**

Run: `node --test tests/*.test.js`
Expected: 原有与新增测试全部 PASS。
Run: `npm run build:demo`
Expected: PASS。
Run: `npm run demo:generate && npm run demo:evaluate -- --mode local --all`
Expected: 30 张清单与真实本地报告生成。
Start: `npm run dev:demo`
Run: `npm run test:demo:browser`
Expected: 完整浏览器流程 PASS；结束后停止本次启动的进程。

- [ ] **Step 3: Update RUNNING.txt with exact operating instructions**

追加 Demo 端口、`dev:demo／build:demo／start:demo`、`.env.demo` 四个变量、合成哈希门禁、local 与 vision 命令、3 张冒烟／30 张全量确认、报告目录、阈值未校准和“本地 OCR 不自动通过”的说明。保留原文档与原工作台命令。

- [ ] **Step 4: Run live vision smoke only after local configuration exists**

先检查 `.env.demo` 是否存在，只报告存在／缺失，不输出变量值。用户完成本地配置并确认外部调用后运行：

`npm run demo:evaluate -- --mode vision --limit 3 --confirm-external`

Expected: 真实图片＋工具调用成功，或给出明确配置／能力错误；报告记录实际结果。检查报告与日志不含密钥。不得用 mock 响应冒充此步骤。

- [ ] **Step 5: Ask for full-run confirmation, then evaluate 30 images**

向用户报告冒烟结果、预计最多 60 次模型请求和费用边界，获得明确确认后运行：

`npm run demo:evaluate -- --mode vision --all --confirm-external`

Expected: 30 行样本记录、11 行字段准确率表、运行元数据和导出文件。若外部服务阻塞，保留本地报告并明确标注视觉实测未完成，不填造数字。

- [ ] **Step 6: Final evidence checkpoint and portfolio wording**

核对：30 个唯一哈希；全部 synthetic／watermark；未登记上传拒绝；local 零外发；vision 仅白名单；报告可由保存记录复算；旧 `.data` 未被本次命令打开。基于实际结果写 2～3 句简历／面试表述，突出“Vue／Node 工作台、Function Calling 白名单、Schema 硬门禁、人工兜底、合成评测闭环”，量化指标只引用报告并标注合成数据口径。

## Self-Review Checklist

- Spec §1～§12 均映射到 Tasks 1～12：隔离 runtime、工具协议、Schema、质检、分级、复核、30 张数据、指标、UI、安全、测试和交付。
- 所有新增接口在对应任务定义；后续任务只消费已定义名称。
- 无 Git 提交步骤；无真实附件读取；无未确认外发；无预填准确率。
- 视觉失败兜底后强制人工；本地 null 置信度不自动通过；零分母精确率为 null／`—`。
- 实测命令与费用门禁明确：3 张冒烟后再次确认，才能运行 30 张。