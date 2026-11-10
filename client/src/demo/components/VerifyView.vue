<script setup>
import { computed, ref } from 'vue'
import { FIELD_LABELS, candidateText, confidenceLabel } from '../format.js'
import ToolTrace from './ToolTrace.vue'
import { demoApi } from '../api.js'

const props = defineProps({
  samples: { type: Array, default: () => [] },
  health: { type: Object, default: null },
  record: { type: Object, default: null },
  busy: { type: Boolean, default: false },
})
const emit = defineEmits(['create', 'run', 'refresh'])
const selectedSampleId = ref('SYN-001')
const mode = ref('local-ocr')
const confirmed = ref(false)
const file = ref(null)
const localError = ref('')
const fieldKeys = Object.keys(FIELD_LABELS)
const selectedSample = computed(() => props.samples.find(sample => sample.sampleId === selectedSampleId.value))

function chooseFile(event) {
  file.value = event.target.files?.[0] ?? null
  localError.value = ''
}

async function loadRegisteredSample() {
  localError.value = ''
  try {
    const response = await fetch(demoApi.sampleFileUrl(selectedSampleId.value), { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) throw new Error('合成样例读取失败。')
    const blob = await response.blob()
    const uploaded = new File([blob], selectedSample.value?.filename ?? `${selectedSampleId.value}.png`, { type: blob.type || 'image/png' })
    emit('create', { sampleId: selectedSampleId.value, file: uploaded })
  } catch (error) {
    localError.value = error.message || '合成样例读取失败。'
  }
}

function uploadLocalFile() {
  if (!file.value) return
  emit('create', { sampleId: selectedSampleId.value, file: file.value })
}

function run() {
  emit('run', { mode: mode.value, externalConfirmed: mode.value === 'local-ocr' ? false : confirmed.value })
}
</script>

<template>
  <section class="panel verify-panel">
    <header class="section-head">
      <div>
        <p class="eyebrow">Synthetic permit pipeline</p>
        <h2>单张核验</h2>
        <p class="muted">上传登记合成样例，观察质检、工具调用、硬门禁与转人工原因。</p>
      </div>
      <a-button :loading="busy" @click="emit('refresh')">刷新</a-button>
    </header>

    <div class="banner"><strong>合成数据演示</strong><span>阈值未校准 · 非真伪鉴定 · 不处理企业真实证件</span></div>

    <div class="control-grid">
      <label class="control">
        <span>合成样例</span>
        <a-select v-model:value="selectedSampleId" :disabled="busy" style="width: 100%">
          <a-select-option v-for="sample in samples" :key="sample.sampleId" :value="sample.sampleId">
            {{ sample.sampleId }} · {{ sample.scenario }} · {{ sample.filename }}
          </a-select-option>
        </a-select>
      </label>
      <div class="control">
        <span>一键加载</span>
        <a-button :disabled="busy || !selectedSample" @click="loadRegisteredSample">读取登记样例并上传</a-button>
      </div>
      <label class="control">
        <span>或选择同一合成文件</span>
        <input type="file" accept="image/png,image/jpeg" :disabled="busy" @change="chooseFile" />
      </label>
      <div class="control">
        <span>上传所选文件</span>
        <a-button :disabled="busy || !file" @click="uploadLocalFile">上传 {{ file?.name || '未选择' }}</a-button>
      </div>
      <label class="control">
        <span>核验模式</span>
        <a-select v-model:value="mode" :disabled="busy" style="width: 100%">
          <a-select-option value="local-ocr">本地 OCR（不外发）</a-select-option>
          <a-select-option value="vision" :disabled="!health?.visionConfigured">视觉 Function Calling</a-select-option>
        </a-select>
      </label>
      <div v-if="mode === 'vision'" class="control vision-confirm">
        <span>外部调用确认</span>
        <a-checkbox v-model:checked="confirmed" :disabled="busy || !health?.visionConfigured">
          仅发送本次登记的合成样例；最多一次 Schema 修正
        </a-checkbox>
        <small v-if="!health?.visionConfigured">服务端未配置视觉 API，视觉模式不可用。</small>
      </div>
      <div class="control run-control">
        <span>运行</span>
        <a-button type="primary" :loading="busy" :disabled="busy || !record || record.status === 'queued' || record.status === 'running'" @click="run">开始核验</a-button>
      </div>
    </div>
    <a-alert v-if="localError" type="error" show-icon :message="localError" />

    <template v-if="record">
      <div class="pipeline" aria-label="核验步骤">
        <span class="done">上传</span><i></i>
        <span :class="{ done: record.quality }">质检</span><i></i>
        <span :class="{ done: record.trace?.some(step => step.stage === 'vision-request' || step.stage === 'local-ocr') }">{{ record.mode === 'vision-fc' ? '多模态抽取' : '本地抽取' }}</span><i></i>
        <span :class="{ done: record.validation }">Schema</span><i></i>
        <span :class="{ done: record.decision }">分级</span>
      </div>

      <div class="record-strip">
        <div><span>状态</span><strong>{{ record.status }}</strong></div>
        <div><span>模式</span><strong>{{ record.mode }}</strong></div>
        <div><span>分级</span><strong>{{ record.decision?.level || '—' }}</strong></div>
        <div><span>结论</span><strong>{{ record.decision?.action || '—' }}</strong></div>
        <div><span>版本</span><strong>v{{ record.version }}</strong></div>
      </div>

      <a-alert v-if="record.decision?.reasons?.length" class="reason-alert" type="warning" show-icon message="转人工原因">
        <template #description><p v-for="reason in record.decision.reasons" :key="reason">{{ reason }}</p></template>
      </a-alert>
      <a-alert v-if="record.error" type="error" show-icon :message="record.error.code" :description="record.error.message" />

      <div class="verify-grid">
        <figure class="document-stage">
          <img :src="demoApi.imageUrl(record.id)" alt="合成样例原图" />
          <figcaption>{{ record.sampleId }} · 合成数据，不可用于真实通行或证件验收</figcaption>
        </figure>
        <div class="table-wrap">
          <table class="field-table">
            <thead><tr><th>字段</th><th>原文</th><th>规范化候选</th><th>置信度</th></tr></thead>
            <tbody>
              <tr v-for="key in fieldKeys" :key="key">
                <th>{{ FIELD_LABELS[key] }}</th>
                <td>{{ record.fields?.[key]?.raw ?? '—' }}</td>
                <td>{{ candidateText(record.fields?.[key]?.candidate) }}</td>
                <td>{{ confidenceLabel(record.fields?.[key]) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <ToolTrace :trace="record.trace || []" />
    </template>
  </section>
</template>

<style scoped>
.verify-panel { padding: 26px; }
.section-head { display: flex; justify-content: space-between; gap: 16px; align-items: start; }
.eyebrow { margin: 0 0 4px; color: #b45309; font-size: 11px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
h2 { margin: 0; font-size: 30px; letter-spacing: -.04em; color: #173330; }
.muted { color: #677873; margin: 6px 0 0; }
.banner { margin: 18px 0; padding: 10px 14px; border-left: 3px solid #b45309; background: #fdf4e3; display: flex; flex-wrap: wrap; gap: 10px 18px; color: #765b30; }
.banner strong { color: #8c4308; }
.control-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; align-items: end; }
.control { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: #5e706b; font-weight: 700; }
.control :deep(.ant-select), .control :deep(.ant-btn), .control input { text-align: left; }
.vision-confirm { grid-column: span 2; }
.vision-confirm small { color: #9b1c1c; }
.run-control :deep(.ant-btn) { width: 100%; }
.pipeline { margin: 24px 0 16px; display: flex; align-items: center; color: #91a09c; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
.pipeline span { white-space: nowrap; }
.pipeline span.done { color: #0f6b62; }
.pipeline i { height: 1px; flex: 1; background: currentColor; margin: 0 8px; opacity: .5; }
.record-strip { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 1px; background: #d9d4c8; border: 1px solid #d9d4c8; border-radius: 10px; overflow: hidden; }
.record-strip div { background: #fffdf7; padding: 10px 12px; display: flex; flex-direction: column; gap: 3px; }
.record-strip span { color: #78857f; font-size: 11px; }
.record-strip strong { color: #173330; font-variant-numeric: tabular-nums; }
.reason-alert { margin-top: 16px; }
.verify-grid { display: grid; grid-template-columns: minmax(360px, .95fr) minmax(0, 1.05fr); gap: 18px; margin-top: 18px; }
.document-stage { margin: 0; border: 1px solid #d8d1c2; border-radius: 12px; background: #ede8dc; padding: 10px; }
.document-stage img { width: 100%; display: block; border-radius: 8px; max-height: 560px; object-fit: contain; background: #fff; }
figcaption { padding: 9px 4px 2px; color: #6c766f; font-size: 12px; }
.table-wrap { max-height: 620px; overflow: auto; border: 1px solid #d8d1c2; border-radius: 12px; }
.field-table { border-collapse: collapse; width: 100%; font-size: 12px; }
.field-table thead th { position: sticky; top: 0; background: #173330; color: #f6f2e9; padding: 10px; text-align: left; font-weight: 700; }
.field-table th, .field-table td { padding: 9px 10px; border-bottom: 1px solid #e7e1d4; vertical-align: top; text-align: left; }
.field-table tbody th { white-space: nowrap; color: #29433e; }
.field-table td { color: #53635f; word-break: break-word; }
@media (max-width: 900px) { .control-grid, .verify-grid { grid-template-columns: 1fr; } .record-strip { grid-template-columns: 1fr 1fr; } .pipeline { overflow-x: auto; } .verify-panel { padding: 18px; } }
</style>
