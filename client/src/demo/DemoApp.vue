<script setup>
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import { demoApi } from './api.js'
import VerifyView from './components/VerifyView.vue'
import ReviewQueue from './components/ReviewQueue.vue'
import ReportView from './components/ReportView.vue'

const view = ref('verify')
const health = ref(null)
const samples = ref([])
const records = ref([])
const reports = ref([])
const record = ref(null)
const report = ref(null)
const busy = ref(false)
const error = ref('')
const notice = ref('')
let pollTimer = null
const theme = { token: { colorPrimary: '#0f6b62', colorText: '#273b36', borderRadius: 8, fontSize: 13, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif', controlHeight: 34 } }
const views = reactive([
  { key: 'verify', label: '单张核验' },
  { key: 'review', label: '人工复核' },
  { key: 'reports', label: '评测报告' },
])

function setError(value) { error.value = value?.message || String(value || '') }
async function refreshSamplesAndHealth() {
  const [healthResult, sampleResult] = await Promise.all([demoApi.health(), demoApi.samples()])
  health.value = healthResult
  samples.value = sampleResult.samples
}
async function refreshRecords() {
  const result = await demoApi.records()
  records.value = result.records
  if (record.value) {
    const current = result.records.find(item => item.id === record.value.id)
    if (current) record.value = current
  }
}
async function refreshReports() {
  const result = await demoApi.reports()
  reports.value = result.reports
}
async function refreshAll() {
  busy.value = true
  error.value = ''
  try { await Promise.all([refreshSamplesAndHealth(), refreshRecords(), refreshReports()]) } catch (caught) { setError(caught) } finally { busy.value = false }
}
function startPolling() {
  clearInterval(pollTimer)
  pollTimer = setInterval(async () => {
    if (!record.value || !['queued', 'running'].includes(record.value.status)) return
    try {
      record.value = await demoApi.record(record.value.id)
      await refreshRecords()
    } catch (caught) { setError(caught); clearInterval(pollTimer) }
  }, 1800)
}
async function createRecord({ sampleId, file }) {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    record.value = await demoApi.createRecord(sampleId, file)
    notice.value = '合成样例已保存，请手动开始核验。'
    await refreshRecords()
  } catch (caught) { setError(caught) } finally { busy.value = false }
}
async function runRecord({ mode, externalConfirmed }) {
  if (!record.value) return
  busy.value = true
  error.value = ''
  try {
    record.value = await demoApi.runRecord(record.value.id, { version: record.value.version, mode, externalConfirmed })
    notice.value = mode === 'local-ocr' ? '本地核验已排队，不外发图片。' : '视觉核验已排队；仅发送本次登记合成样例。'
    startPolling()
  } catch (caught) { setError(caught) } finally { busy.value = false }
}
async function submitReview({ id, body }) {
  busy.value = true
  error.value = ''
  try {
    const updated = await demoApi.reviewRecord(id, body)
    if (record.value?.id === id) record.value = updated
    notice.value = `复核已保存：${updated.review?.status || 'draft'}`
    await refreshRecords()
  } catch (caught) { setError(caught) } finally { busy.value = false }
}
async function loadReport(runId) {
  busy.value = true
  error.value = ''
  try { report.value = await demoApi.report(runId) } catch (caught) { setError(caught) } finally { busy.value = false }
}

watch(record, value => {
  if (!value || !['queued', 'running'].includes(value.status)) {
    if (value?.status === 'completed') {
      clearInterval(pollTimer)
      refreshRecords().catch(setError)
    }
  }
})

onMounted(refreshAll)
onBeforeUnmount(() => clearInterval(pollTimer))
</script>

<template>
  <a-config-provider :locale="zhCN" :theme="theme">
    <div class="demo-shell">
      <header class="demo-header">
        <div class="brand">
          <span class="seal" aria-hidden="true">核</span>
          <div>
            <p>DOCUMENT VERIFICATION AGENT</p>
            <h1>证照结构化核验 <span>Demo</span></h1>
          </div>
        </div>
        <div class="header-status">
          <span class="status-dot" :class="{ online: health?.ok }"></span>
          <span>{{ health?.ok ? '本机服务已连接' : '本机服务未连接' }}</span>
          <small>{{ health?.visionConfigured ? '视觉 API 已配置' : '仅本地 OCR' }}</small>
        </div>
      </header>

      <nav class="demo-nav" aria-label="Demo 视图">
        <button v-for="item in views" :key="item.key" type="button" :class="{ active: view === item.key }" @click="view = item.key">
          <span>{{ item.label }}</span>
          <small v-if="item.key === 'review'">{{ records.filter(item => item.status === 'completed').length }}</small>
        </button>
        <span class="nav-note">合成样例 <b>30</b> · 合成数据 · 硬门禁 · 人工兜底</span>
      </nav>

      <main class="demo-main">
        <a-alert v-if="error" class="global-alert" type="error" show-icon closable :message="error" @close="error = ''" />
        <a-alert v-if="notice" class="global-alert" type="success" show-icon closable :message="notice" @close="notice = ''" />

        <VerifyView
          v-if="view === 'verify'"
          :samples="samples"
          :health="health"
          :record="record"
          :busy="busy"
          @create="createRecord"
          @run="runRecord"
          @refresh="refreshAll"
        />
        <ReviewQueue
          v-else-if="view === 'review'"
          :records="records"
          :busy="busy"
          @review="submitReview"
          @refresh="refreshAll"
        />
        <ReportView
          v-else
          :reports="reports"
          :report="report"
          :busy="busy"
          @select="loadReport"
          @refresh="refreshReports"
        />
      </main>

      <footer class="demo-footer">
        <span>仅接收本项目登记的合成样例 · 不读取旧证件附件</span>
        <span>阈值未校准 · 非真伪鉴定 · 本地流程不外发</span>
      </footer>
    </div>
  </a-config-provider>
</template>
