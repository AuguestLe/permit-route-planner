import { ApiError } from '../../api.js'
import { FIELD_KEYS } from '../../../../server/demo/schema.js'
import { normalizeFields } from '../../../../server/demo/normalize.js'
import { validateCandidates } from '../../../../server/demo/validate.js'
import { decide } from '../../../../server/demo/decision.js'
import data from './generated/demo-data.json'
import { sampleImageUrl } from './image-assets.js'

const STORAGE_KEY = 'permit-route-planner.static-demo.v1'
const RECORD_LIMIT = 100
const DAYS_7 = 7 * 86_400_000
const FIELD_KEYS_SET = new Set(FIELD_KEYS)
const STAGE_STEP_MS = 260

function demoError(code, message, status = 400) {
  return new ApiError(message, status, code)
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
}

function readStorage() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function writeStorage(records) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, RECORD_LIMIT)))
  } catch { /* storage may be full or blocked; the demo keeps working in memory */ }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

// Replayed extraction results come from the frozen local-OCR evaluation report; scenario/expected fields stay out of the record.
function replayedResult(sample) {
  const result = clone(sample)
  delete result.scenario
  delete result.expectedCandidates
  return result
}

const entries = data.entries ?? []
const entryById = new Map(entries.map(entry => [entry.sampleId, entry]))
const resultsBySample = new Map()
let reports = []
for (const run of data.runs ?? []) {
  reports.push(run.summary)
  for (const sample of run.report?.samples ?? []) {
    if (!resultsBySample.has(sample.sampleId) && sample.status === 'completed') {
      resultsBySample.set(sample.sampleId, replayedResult(sample))
    }
  }
}

function publicRecord(record) {
  const { token, ...rest } = record
  return rest
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function createStaticDemoApi({ storage = true } = {}) {
  const persisted = storage ? readStorage() : []
  const records = new Map()
  const jobs = new Map()
  const exportUrls = new Map()

  for (const record of persisted) {
    if (!record?.id || !entryById.has(record.sampleId)) continue
    if (record.expiresAt <= Date.now()) continue
    if (record.status === 'queued' || record.status === 'running') {
      record.status = 'failed'
      record.stage = null
      record.error = { code: 'INTERRUPTED', message: '页面已刷新，请重新开始核验。' }
    }
    records.set(record.id, record)
  }

  function save() {
    if (!storage) return
    writeStorage([...records.values()].sort((a, b) => b.createdAt - a.createdAt))
  }

  function list() {
    return [...records.values()]
      .filter(record => record.expiresAt > Date.now())
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  function get(id) {
    const record = records.get(id)
    if (!record) throw demoError('TASK_NOT_FOUND', 'Demo 记录不存在或已清理（静态预览仅保留本机浏览器内的记录）。', 404)
    return record
  }

  function update(id, token, action) {
    const record = records.get(id)
    if (!record || !['queued', 'running'].includes(record.status) || record.token !== token) return false
    action(record)
    save()
    return true
  }

  async function hashFile(file) {
    const subtle = globalThis.crypto?.subtle
    if (!subtle || typeof file?.arrayBuffer !== 'function') return null
    const digest = await subtle.digest('SHA-256', await file.arrayBuffer())
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  }

  function stopJob(id) {
    const job = jobs.get(id)
    if (job) job.cancelled = true
    jobs.delete(id)
  }

  async function replay(id, token, sampleId) {
    const stages = ['质检', '本地识别', 'Schema 校验', '置信度分级']
    for (const stage of stages) {
      await sleep(STAGE_STEP_MS)
      if (!update(id, token, record => { record.status = 'running'; record.stage = stage })) return
    }
    await sleep(STAGE_STEP_MS)
    const sample = resultsBySample.get(sampleId)
    if (!sample) {
      update(id, token, record => {
        record.status = 'failed'
        record.stage = null
        record.error = { code: 'REPLAY_UNAVAILABLE', message: '该样例没有可回放的核验结果。' }
      })
      return
    }
    update(id, token, record => {
      Object.assign(record, clone(sample))
      record.status = 'completed'
      record.stage = '核验完成，等待复核'
      record.mode = 'local-ocr'
      record.token = null
    })
    if (records.get(id)?.status === 'completed') {
      const trace = records.get(id).trace ?? []
      if (!trace.some(step => step.stage === 'replay')) {
        trace.push({ stage: 'replay', note: '结果来自冻结的本地 OCR 评测回放，未重新识别图片' })
      }
      records.get(id).trace = trace
    }
    save()
    jobs.delete(id)
  }

  return {
    staticMode: true,

    async health() {
      return { ok: true, staticDemo: true, syntheticOnly: true, visionConfigured: false, datasetVersion: data.datasetVersion }
    },

    async samples() {
      return {
        samples: entries.map(entry => ({
          sampleId: entry.sampleId,
          filename: entry.filename,
          scenario: entry.scenario,
          synthetic: entry.synthetic === true,
          watermark: entry.watermark === true,
          mime: entry.mime ?? 'image/png',
        })),
      }
    },

    async records() {
      return { records: list().map(publicRecord) }
    },

    async record(id) {
      return publicRecord(get(id))
    },

    async reports() {
      return { reports }
    },

    async report(runId) {
      const run = (data.runs ?? []).find(item => item.summary?.runId === runId)
      if (!run) throw demoError('REPORT_NOT_FOUND', '评测报告不存在。', 404)
      return run.report
    },

    async createRecord(sampleId, file) {
      const entry = entryById.get(sampleId)
      if (!entry) throw demoError('SYNTHETIC_ONLY', '仅允许本项目登记的合成样例。')
      if (!file) throw demoError('NO_FILE', '请选择一张合成样例图片。')
      if (file.size > 10 * 1024 * 1024) throw demoError('LIMIT_FILE_SIZE', '上传超过限制：仅一张 10 MB 内合成图片。', 413)
      const hash = await hashFile(file)
      if (hash && entry.sha256 && hash !== entry.sha256) {
        throw demoError('SYNTHETIC_ONLY', '文件与登记的合成样例哈希不一致。')
      }
      if (!sampleImageUrl(entry.filename)) throw demoError('SAMPLE_NOT_FOUND', '合成样例资源未打包进静态预览。', 404)
      const now = Date.now()
      const record = {
        id: randomId(), version: 1, status: 'pending', stage: null, sampleId,
        sha256: entry.sha256 ?? hash ?? '', mime: entry.mime ?? 'image/png', size: file.size ?? 0,
        mode: 'local-ocr', createdAt: now, expiresAt: now + DAYS_7,
        fields: {}, candidates: {}, quality: null, validation: null, decision: null,
        trace: [], fallbackUsed: false, usage: null, error: null, review: null,
      }
      records.set(record.id, record)
      save()
      return publicRecord(record)
    },

    async runRecord(id, body) {
      const record = get(id)
      if (!['pending', 'failed'].includes(record.status)) {
        throw demoError('RECORD_NOT_READY', '当前记录不可重新核验。', 409)
      }
      if (!Number.isSafeInteger(body?.version) || body.version !== record.version) {
        throw demoError('VERSION_CONFLICT', '记录已更新，请刷新后重试。', 409)
      }
      if (!['local-ocr', 'vision-fc', 'vision'].includes(body?.mode)) {
        throw demoError('INVALID_MODE', '核验模式无效。')
      }
      if (body.mode !== 'local-ocr') {
        throw demoError('VISION_NOT_CONFIGURED', '静态预览不连接视觉服务，仅提供本地 OCR 回放。', 503)
      }
      if (record.expiresAt <= Date.now()) throw demoError('TASK_EXPIRED', 'Demo 记录已到期。', 410)
      const token = randomId()
      record.token = token
      record.status = 'queued'
      record.stage = '等待核验'
      record.mode = 'local-ocr'
      record.error = null
      record.version += 1
      save()
      stopJob(id)
      jobs.set(id, { token })
      replay(id, token, record.sampleId)
      return publicRecord(record)
    },

    async reviewRecord(id, body) {
      const record = get(id)
      if (!Number.isSafeInteger(body?.version) || body.version !== record.version) {
        throw demoError('VERSION_CONFLICT', '记录已更新，请刷新后重新复核。', 409)
      }
      if (!Object.keys(body ?? {}).every(key => ['version', 'fields', 'conclusion'].includes(key))) {
        throw demoError('INVALID_REVIEW', '存在不支持的复核字段。')
      }
      if (record.status !== 'completed') throw demoError('REVIEW_NOT_READY', '只有完成核验的记录可以复核。', 409)
      if (body.fields != null && (typeof body.fields !== 'object' || Array.isArray(body.fields))) {
        throw demoError('INVALID_REVIEW', '复核字段格式不正确。')
      }
      const input = body.fields ?? {}
      for (const [key, value] of Object.entries(input)) {
        if (!FIELD_KEYS_SET.has(key) || (value !== null && typeof value !== 'string')) {
          throw demoError('INVALID_FIELD', '复核只接受 11 个字段的字符串或 null。')
        }
      }
      const rawFields = {}
      for (const key of FIELD_KEYS) {
        const field = record.fields[key]
        rawFields[key] = {
          raw: Object.hasOwn(input, key) ? input[key] : (field?.raw ?? null),
          confidence: field?.confidence?.score ?? null,
          evidenceQuote: field?.evidence?.text ?? null,
        }
      }
      const normalized = normalizeFields(rawFields)
      const validation = validateCandidates(normalized.candidates, { referenceDate: record.referenceDate })
      const conclusion = body.conclusion ?? null
      if (conclusion !== null && !['approved', 'returned'].includes(conclusion)) {
        throw demoError('INVALID_CONCLUSION', '复核结论无效。')
      }
      if (conclusion === 'approved' && !validation.ok) {
        throw demoError('REVIEW_VALIDATION_FAILED', '复核后字段仍未通过 Schema 与业务校验。')
      }
      record.review ??= { status: 'draft', revisions: {}, finalCandidates: {}, validation: null, events: [] }
      const events = []
      for (const key of FIELD_KEYS) {
        if (!Object.hasOwn(input, key)) continue
        const before = record.fields[key]?.raw ?? null
        const after = input[key]
        if (before === after) { delete record.review.revisions[key]; continue }
        record.review.revisions[key] = after
        events.push({ type: 'field', field: key, before, after, at: Date.now(), actor: 'static-demo-user' })
      }
      record.review.finalCandidates = normalized.candidates
      record.review.validation = validation
      record.review.status = conclusion === 'approved' ? 'approved' : conclusion === 'returned' ? 'returned' : 'draft'
      record.review.decision = decide({ quality: record.quality, validation, fields: record.fields })
      record.review.events.push(...events)
      record.review.events.push({ type: 'conclusion', before: null, after: record.review.status, at: Date.now(), actor: 'static-demo-user' })
      record.version += 1
      save()
      return publicRecord(record)
    },

    async deleteRecord(id, version) {
      const record = get(id)
      if (Number.isSafeInteger(version) && version !== record.version) {
        throw demoError('VERSION_CONFLICT', '记录已更新，请刷新后删除。', 409)
      }
      stopJob(id)
      records.delete(id)
      save()
      return null
    },

    sampleFileUrl(sampleId) {
      const entry = entryById.get(sampleId)
      return entry ? sampleImageUrl(entry.filename) : null
    },

    imageUrl(id) {
      const record = records.get(id)
      const entry = record ? entryById.get(record.sampleId) : null
      return entry ? sampleImageUrl(entry.filename) : null
    },

    exportName(runId, format) {
      const names = { json: 'report.json', 'field-csv': 'field-accuracy.csv', 'samples-csv': 'samples.csv', markdown: 'summary.md' }
      return `demo-${runId.slice(0, 8)}-${names[format] ?? 'export.txt'}`
    },

    reportExportUrl(runId, format) {
      const key = `${runId}:${format}`
      if (exportUrls.has(key)) return exportUrls.get(key)
      const run = (data.runs ?? []).find(item => item.summary?.runId === runId)
      if (!run) return '#'
      const content = format === 'json'
        ? JSON.stringify(run.report, null, 2)
        : run.exports?.[format]
      if (content == null) return '#'
      const mime = {
        json: 'application/json', 'field-csv': 'text/csv', 'samples-csv': 'text/csv', markdown: 'text/markdown',
      }[format] ?? 'text/plain'
      const url = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`
      exportUrls.set(key, url)
      return url
    },
  }
}

export const demoApi = createStaticDemoApi()
export { STORAGE_KEY }
