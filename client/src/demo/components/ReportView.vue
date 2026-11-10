<script setup>
import { computed, ref, watch } from 'vue'
import { FIELD_LABELS, candidateText, fieldStatus, formatPrecision, modeLabel } from '../format.js'
import { demoApi } from '../api.js'

const props = defineProps({
  reports: { type: Array, default: () => [] },
  report: { type: Object, default: null },
  busy: { type: Boolean, default: false },
})
const emit = defineEmits(['select', 'refresh'])
const selectedRun = ref(null)
const expanded = ref(null)
const fieldKeys = Object.keys(FIELD_LABELS)
const metrics = computed(() => props.report?.metrics)
const samples = computed(() => props.report?.samples || [])
const metricCards = computed(() => metrics.value ? [
  ['字段 micro', formatPrecision(metrics.value.micro)],
  ['字段 macro', formatPrecision(metrics.value.macro)],
  ['整单全对', formatPrecision(metrics.value.wholeDocumentAccuracy)],
  ['判定准确', formatPrecision(metrics.value.decisionAccuracy)],
  ['自动通过精确率', formatPrecision(metrics.value.autoApprovePrecision)],
  ['转人工率', formatPrecision(metrics.value.reviewRate)],
  ['兜底率', formatPrecision(metrics.value.fallbackRate)],
  ['模型请求', metrics.value.modelCalls ?? '—'],
] : [])

watch(() => props.reports, value => {
  if (!value.some(item => item.runId === selectedRun.value)) selectedRun.value = value[0]?.runId ?? null
}, { immediate: true })
watch(selectedRun, runId => { if (runId) emit('select', runId) }, { immediate: true })

function choose(runId) { selectedRun.value = runId }
function fieldErrors(sample, key) {
  return sample.validation?.errors?.filter(error => error.path === `/${key}`).map(error => error.code) ?? []
}
</script>

<template>
  <section class="panel report-panel">
    <header class="section-head">
      <div>
        <p class="eyebrow">Evaluation loop</p>
        <h2>评测报告</h2>
        <p class="muted">30 张冻结合成样例，预测与真值逐字段对照；自动通过分母为零时显示「—」。</p>
      </div>
      <a-button :loading="busy" @click="emit('refresh')">刷新报告</a-button>
    </header>

    <div class="run-picker">
      <label>运行</label>
      <a-select :value="selectedRun" style="min-width: 360px" @change="choose">
        <a-select-option v-for="run in reports" :key="run.runId" :value="run.runId">
          {{ run.mode }} · {{ run.model }} · {{ run.total }} 张 · {{ run.startedAt }}
        </a-select-option>
      </a-select>
      <span v-if="!reports.length" class="muted">尚无评测报告，先运行 demo:evaluate。</span>
    </div>

    <template v-if="report">
      <div class="meta-strip">
        <span>{{ modeLabel(report.metadata.mode) }}</span>
        <span>模型 {{ report.metadata.model }}</span>
        <span>数据 {{ report.metadata.datasetVersion }}</span>
        <span>阈值 {{ report.metadata.thresholdVersion }}</span>
        <span>run {{ report.runId }}</span>
      </div>

      <div class="metric-grid">
        <article v-for="[label, value] in metricCards" :key="label">
          <span>{{ label }}</span><strong>{{ value }}</strong>
        </article>
      </div>

      <div class="report-columns">
        <div>
          <h3>字段准确率</h3>
          <table class="compact-table">
            <thead><tr><th>字段</th><th>预期非空</th><th>正确</th><th>缺失</th><th>错误</th><th>准确率</th></tr></thead>
            <tbody>
              <tr v-for="key in fieldKeys" :key="key">
                <th>{{ FIELD_LABELS[key] }}</th>
                <td>{{ metrics.fields[key].applicable }}</td>
                <td>{{ metrics.fields[key].correct }}</td>
                <td>{{ metrics.fields[key].predictedMissing }}</td>
                <td>{{ metrics.fields[key].wrong }}</td>
                <td>{{ formatPrecision(metrics.fields[key].accuracy) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <aside>
          <h3>导出</h3>
          <div class="exports">
            <a :href="demoApi.reportExportUrl(report.runId, 'json')">JSON</a>
            <a :href="demoApi.reportExportUrl(report.runId, 'field-csv')">字段 CSV</a>
            <a :href="demoApi.reportExportUrl(report.runId, 'samples-csv')">样本 CSV</a>
            <a :href="demoApi.reportExportUrl(report.runId, 'markdown')">Markdown</a>
          </div>
          <p class="method">指标使用人工修订前预测；整单完全正确包含 null；自动通过必须字段正确且业务预期有效。阈值未校准，不构成真实证件验收。</p>
        </aside>
      </div>

      <h3>样本明细</h3>
      <div class="sample-list">
        <article v-for="sample in samples" :key="sample.sampleId" class="sample-row">
          <button type="button" @click="expanded = expanded === sample.sampleId ? null : sample.sampleId">
            <strong>{{ sample.sampleId }}</strong>
            <span>{{ sample.scenario }}</span>
            <span>{{ sample.decision?.action || sample.error?.code || sample.status }}</span>
            <span>{{ sample.fallbackUsed ? '本地兜底' : '正常路径' }}</span>
            <span>{{ expanded === sample.sampleId ? '收起' : '查看差异' }}</span>
          </button>
          <div v-if="expanded === sample.sampleId" class="sample-diff">
            <div v-for="key in fieldKeys" :key="key" :class="['diff-row', fieldStatus(sample.expectedCandidates?.[key], sample.fields?.[key]?.candidate)]">
              <strong>{{ FIELD_LABELS[key] }}</strong>
              <span>预期 {{ candidateText(sample.expectedCandidates?.[key]) }}</span>
              <span>实际 {{ candidateText(sample.fields?.[key]?.candidate) }}</span>
              <span>{{ fieldStatus(sample.expectedCandidates?.[key], sample.fields?.[key]?.candidate) }}</span>
              <small v-if="fieldErrors(sample, key).length">{{ fieldErrors(sample, key).join('、') }}</small>
            </div>
          </div>
        </article>
      </div>
    </template>
    <div v-else class="empty-report">
      <strong>暂无报告</strong>
      <span>执行 <code>npm run demo:evaluate -- --mode local --all</code> 后刷新。</span>
    </div>
  </section>
</template>

<style scoped>
.report-panel { padding: 26px; }
.section-head { display: flex; justify-content: space-between; gap: 16px; align-items: start; }
.eyebrow { margin: 0 0 4px; color: #b45309; font-size: 11px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
h2 { margin: 0; font-size: 30px; letter-spacing: -.04em; color: #173330; }
h3 { margin: 22px 0 10px; color: #29433e; font-size: 16px; }
.muted { color: #677873; }
.run-picker { display: flex; align-items: center; gap: 10px; margin: 20px 0; flex-wrap: wrap; font-size: 12px; color: #63736e; }
.meta-strip { display: flex; gap: 8px 18px; flex-wrap: wrap; padding: 10px 12px; background: #173330; color: #d8e7e2; border-radius: 8px; font-size: 11px; }
.metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
.metric-grid article { background: #fffdf7; border: 1px solid #d8d1c2; border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; }
.metric-grid span { color: #74827d; font-size: 11px; }
.metric-grid strong { color: #0f6b62; font-size: 23px; font-variant-numeric: tabular-nums; }
.report-columns { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(240px, .45fr); gap: 20px; }
.compact-table { width: 100%; border-collapse: collapse; font-size: 12px; background: #fffdf7; }
.compact-table th, .compact-table td { padding: 8px 9px; border-bottom: 1px solid #e5dfd2; text-align: left; }
.compact-table thead th { background: #ede8dc; color: #52645f; }
.exports { display: flex; flex-direction: column; gap: 7px; }
.exports a { color: #0f6b62; font-weight: 700; }
.method { color: #78857f; font-size: 11px; line-height: 1.65; }
.sample-list { border: 1px solid #d8d1c2; border-radius: 10px; overflow: hidden; }
.sample-row + .sample-row { border-top: 1px solid #e4ded1; }
.sample-row > button { width: 100%; display: grid; grid-template-columns: 100px 90px 1fr 1fr auto; gap: 10px; border: 0; padding: 10px 12px; background: #fffdf7; text-align: left; color: #53635f; font-size: 12px; cursor: pointer; }
.sample-row > button:hover { background: #f4efe4; }
.sample-row strong { color: #173330; }
.sample-diff { padding: 10px 14px; background: #faf7ef; }
.diff-row { display: grid; grid-template-columns: 90px 1fr 1fr 60px; gap: 8px; font-size: 11px; padding: 5px 0; border-bottom: 1px dashed #e3ddd0; }
.diff-row.correct { color: #276b45; }
.diff-row.missing, .diff-row.wrong { color: #9b1c1c; }
.diff-row small { grid-column: 2 / -1; }
.empty-report { padding: 30px; border: 1px dashed #d5cfc3; border-radius: 10px; display: flex; flex-direction: column; gap: 6px; color: #77847f; }
.empty-report code { color: #173330; }
@media (max-width: 900px) { .report-panel { padding: 18px; } .metric-grid { grid-template-columns: 1fr 1fr; } .report-columns { grid-template-columns: 1fr; } .sample-row > button { grid-template-columns: 80px 1fr; } .diff-row { grid-template-columns: 75px 1fr; } }
</style>
