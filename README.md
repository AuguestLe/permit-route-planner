# permit-route-planner

超限运输车辆通行证（超限证）的本地 OCR 校对工作台，以及建立在同一识别链路之上的「证照／单据结构化核验 Agent Demo」。

当前仓库实现的是**证照识别与核验**部分，未接入地图服务、货车路径规划或原调度系统（仓库名沿用历史命名）。

## 项目包含两部分

| 部分 | 入口 | 端口 | 数据目录 | 说明 |
| --- | --- | --- | --- | --- |
| OCR 校对工作台 | `npm run dev` / `npm start` | 5174（开发）/ 4317（后端） | `.data/` | 上传、识别、逐字段校对、任务版本冲突保护 |
| 结构化核验 Agent Demo | `npm run dev:demo` / `npm run start:demo` | 5175（开发）/ 4318（后端） | `.data-demo/` | 合成样例、质量门禁、工具调用抽取、校验与分级、人工复核、评测报告 |

两部分共用构建配置、组件库和纯工具模块，但使用独立启动入口、接口命名空间与数据目录，互不读取对方数据。

## 技术栈

- 前端：Vue 3、Ant Design Vue 4、Vite 7
- 后端：Node.js 24、Express 5、Multer、SQLite
- 图像处理：sharp
- OCR：原生 Tesseract 5 可执行文件，通过 Node `spawn` 以参数数组调用（不经过 shell），使用 PSM 3 自动版面识别；模型来自 `@tesseract.js-data/chi_sim` 与 `@tesseract.js-data/eng`
- 校验与评测：ajv（JSON Schema）、Node 内置 `node:test`
- 浏览器验证：playwright-core 调用本机 Chrome

## 环境要求

- Node.js `>=24.0.0 <25`
- 原生 Tesseract 5（macOS：`brew install tesseract`；其他系统需自行安装并加入 `PATH`）
- 浏览器验证另需本机 Chrome，可用 `CHROME_PATH` 指定可执行文件

本机可双击 `start.command` 启动，它会优先使用项目 `.tools` 中的便携 Node 24，并检查原生 OCR 引擎是否可用。

## 快速开始

```bash
npm install

# OCR 校对工作台（开发模式，前端 5174 代理到后端 4317）
npm run dev

# 生产运行
npm run build
npm start          # 访问 http://127.0.0.1:4317

# 结构化核验 Demo（开发模式，前端 5175 代理到后端 4318）
npm run dev:demo   # 访问 http://127.0.0.1:5175/demo.html

# Demo 生产运行
npm run build:demo
npm run start:demo # 访问 http://127.0.0.1:4318/demo.html
```

同一端口只能运行一个服务（`strictPort` 已开启），重复启动会显式失败。

## 环境变量

| 变量 | 适用部分 | 说明 |
| --- | --- | --- |
| `TESSERACT_BIN` | 工作台 / Demo 本地模式 | 原生可执行文件路径；不能是带参数的 shell 命令 |
| `TESSDATA_PREFIX` | 工作台 / Demo 本地模式 | 已有模型目录绝对路径，必须同时包含可读的 `chi_sim.traineddata` 与 `eng.traineddata` |
| `CHROME_PATH` | 浏览器验证 | Chrome 可执行文件路径 |
| `TEST_BASE_URL` | 浏览器验证 | 切换验证目标，例如 `http://127.0.0.1:4317` |
| `DEMO_VISION_BASE_URL` | Demo 视觉模式 | OpenAI 兼容接口地址，必须为 HTTPS |
| `DEMO_VISION_MODEL` | Demo 视觉模式 | 模型名称 |
| `DEMO_VISION_API_KEY` | Demo 视觉模式 | 密钥，仅保存在服务端 |
| `DEMO_VISION_TIMEOUT_MS` | Demo 视觉模式 | 单次视觉调用超时，默认 60000，允许 1000～120000 |

Demo 视觉模式配置写在 `.env.demo`（从 `.env.demo.example` 复制）。引擎或模型缺失时明确报错（`OCR_ENGINE_MISSING` / `OCR_MODEL_MISSING`），不会自动回退到 JavaScript、英文单模型或云服务。

## 目录结构

```
client/
  src/                 工作台前端（Vue 3）
  src/demo/            Demo 前端（核验、复核、评测视图）
  index.html           工作台入口
  demo.html            Demo 入口
server/
  index.js             工作台服务入口
  app.js               工作台路由
  ocr.js / ocr-child.js  原生 Tesseract 调用与模型解压
  fields.js            从带标签 OCR 原文提取 11 个字段
  images.js            上传文件安全校验
  store.js             SQLite 存储与版本控制
  demo/                Demo 后端（配置、管线、质检、校验、决策、评测、报告）
scripts/
  dev.mjs / dev-demo.mjs       开发启动脚本
  verify-ocr.mjs               合成样本 + 真实 OCR 验证
  verify-browser.mjs           工作台浏览器验证
  verify-demo-browser.mjs      Demo 浏览器验证
  generate-demo-samples.mjs    生成 30 张合成样例
  evaluate-demo.mjs            本地 / 视觉模式评测
tests/                 单元与接口测试（node:test）
demo/
  samples/             30 张合成样例与冻结清单
  reports/             评测报告（JSON / CSV / Markdown）
docs/superpowers/      Demo 设计说明与实现计划
```

## 可用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动工作台开发环境 |
| `npm start` | 以生产模式启动工作台后端 |
| `npm run build` | 构建工作台前端到 `dist/` |
| `npm test` | 运行全部单元与接口测试 |
| `npm run test:ocr` | 生成合成中文样本并调用真实 OCR |
| `npm run test:browser` | 工作台浏览器流程验证（需先 `npm run dev`） |
| `npm run dev:demo` | 启动 Demo 开发环境 |
| `npm run start:demo` | 以生产模式启动 Demo 后端 |
| `npm run build:demo` | 构建 Demo 前端到 `dist-demo/` |
| `npm run demo:generate` | 生成 `synthetic-permit-v1` 合成样例 |
| `npm run demo:evaluate` | 运行评测并导出报告 |
| `npm run test:demo:browser` | Demo 浏览器流程验证（需先启动 Demo） |

## 接口概览

工作台接口（同源调用，无原系统登录）：

```
GET    /api/health
GET    /api/tasks
POST   /api/tasks                          multipart：name、重复 files；Idempotency-Key 为 UUID
GET    /api/tasks/:id
GET    /api/tasks/:id/images/:imageId/file
POST   /api/tasks/:id/recognize             JSON：{version}
POST   /api/tasks/:id/images/:imageId/retry JSON：{version}
PATCH  /api/tasks/:id                       JSON：{version,name?,order?,revisions?:[{imageId,fields}]}
DELETE /api/tasks/:id                       JSON：{version}
```

Demo 接口（命名空间 `/api/demo`）：健康检查、样例清单与样例文件、记录创建／查询／运行／复核／删除、评测报告查询与导出。

响应约定：任务 JSON 直接返回，不包装 `data`；错误格式为 `{error:{code,message}}`；版本过旧返回 `409`；前端只提交修订字段，不覆盖 `original`。

## 字段契约

识别的 11 个字段：

`permitNumber`、`plateNumber`、`issuingRegion`、`validFrom`、`validTo`、`length`、`width`、`height`、`weight`、`axleCount`、`passRoute`

- `original.text` 为不可修改的 OCR 原文；`original.fields` 的每个值包含 `value` 与 `source`
- `source` 为 `{imageId,start,end,text}`，索引是原始文字的 UTF-16 区间 `[start,end)`
- 缺失值为 `null`；尺寸与重量保留原单位文本，不自动换算或补单位
- 规则提取只接受可追溯的标签证据；路线末尾可能混入无标签备注，需逐字核对原图
- 保存校对仅保存 OCR 字段修订，不代表路线复核

## Demo 核验链路

```
合成哈希门禁 → 可解释图像质检 → 本地 OCR 或视觉工具抽取
→ JSON Schema 与业务校验 → 硬门禁分级 → 自动通过或人工复核 → 评测报告
```

- 视觉抽取只允许一个白名单工具 `submit_permit_fields`，参数错误最多修正一次；无工具调用、超时、限流或服务异常时降级到本地规则提取并转人工
- 模型返回的证据必须能唯一映射到本地 OCR 原文区间，找不到或存在歧义时保留空证据并转人工，不伪造坐标
- 最终状态由服务端确定性产生，模型无权直接决定任务状态
- 质检与置信度阈值属于合成数据演示策略，未做真实概率校准；本地 Tesseract 置信度为 `null`，不参与自动通过

## 验证与评测

```bash
npm test                              # 单元与接口测试
npm run test:ocr                      # 合成样本 + 真实 OCR
npm run build:demo && npm run test:demo:browser
npm run demo:evaluate -- --mode local --all
```

本地基线（30 张合成样例，`synthetic-permit-v1`）：字段 micro 准确率 90.8%，整单字段完全正确 73.3%，Schema／业务判定准确率 83.3%，转人工比例 96.7%，p50／p95 耗时 589／659 ms，模型请求数 0；自动通过精确率因分母为 0 显示「—」。报告见 `demo/reports/1263823d-21b0-4595-9ad9-09e920fbb3e3/`。

视觉模式评测：先在 `.env.demo` 填写视觉服务配置，运行 `npm run demo:evaluate -- --mode vision --limit 3 --confirm-external` 检查结果并确认费用后，再运行 `--mode vision --all --confirm-external`。未完成真实调用时报告必须显示待实测，不得用本地或夹具成绩替代。

## 隐私与运行限制

- 服务仅监听 `127.0.0.1`，没有多人认证，不应通过代理或端口转发开放至公网或局域网
- 图片与 SQLite 位于非公开的 `.data` / `.data-demo` 目录，从创建起保留 7 天，运行期间每分钟清理，启动时补清理；停机期间无法定时清理
- 识别并发为 1，等待队列最多 20 张，单张最多执行 120 秒；失败只允许手动重试
- 支持静态 JPG/JPEG/PNG，1～10 张，单张 10 MiB，总计 50 MiB，单张最多 4000 万像素
- 识别阶段只读取本地模型，不请求外部 OCR 服务；Demo 视觉模式是唯一的外发路径，需要显式配置、显式确认且仅限登记过的合成样例
- Demo 只处理 `demo/samples` 中登记的 30 张合成样例，不读取 `.data`、`.test-artifacts` 或任何真实证件；未登记文件在保存和识别前即被拒绝
- 所有合成样例均为虚构内容并带「非真实证件 / SYNTHETIC」水印，不能据此承诺真实证件的识别准确率

## 已知限制

- 未接入地图、货车路径规划与调度系统
- Tesseract 存在错字、空格与版式识别误差；本轮使用原生 txt 输出，`confidence` 为 `null`，页面不展示虚构置信度
- Demo 的编号、地区与路线为虚构格式，Schema 不代表真实行政机关的验证规则
- 尚需授权真实证件样本才能评估生产可用性

## 文档

- 设计说明：`docs/superpowers/specs/2026-11-09-document-verification-agent-demo-design.md`
- 实现计划：`docs/superpowers/plans/2026-11-09-document-verification-agent-demo.md`
- 运行手册：`RUNNING.txt`