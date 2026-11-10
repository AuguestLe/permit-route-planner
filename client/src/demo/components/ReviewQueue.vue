<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { FIELD_LABELS } from '../format.js'

const props = defineProps({
  records: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
})
const emit = defineEmits(['select', 'review', 'refresh'])
const selectedId = ref(null)
const draft = reactive({})
const fieldKeys = Object.keys(FIELD_LABELS)
const queue = computed(() => props.records.filter(record => record.status === 'completed'))
const selected = computed(() => queue.value.find(record => record.id === selectedId.value) ?? null)

watch(queue, value => {
  if (!value.some(record => record.id === selectedId.value)) selectedId.value = value[0]?.id ?? null
}, { immediate: true })

watch(selected, record => {
  for (const key of fieldKeys) {
    draft[key] = record?.review?.revisions?.[key] ?? record?.fields?.[key]?.raw ?? ''
  }
}, { immediate: true })

function select(id) {
  selectedId.value = id
  emit('select', id)
}

function submit(conclusion) {
  if (!selected.value) return
  const fields = {}
  for (const key of fieldKeys) fields[key] = draft[key] === '' ? null : draft[key]
  emit('review', { id: selected.value.id, body: { version: selected.value.version, fields, conclusion } })
}
</script>

<template>
  <section class="panel review-panel">
    <header class="section-head">
      <div>
        <p class="eyebrow">Human fallback</p>
        <h2>人工复核</h2>
        <p class="muted">硬门禁失败、本地无置信度或视觉兜底的记录都在这里人工确认。</p>
      </div>
      <a-button :loading="busy" @click="emit('refresh')">刷新队列</a-button>
    </header>

    <div class="queue-list">
      <button v-for="record in queue" :key="record.id" type="button" class="queue-item" :class="{ active: record.id === selectedId }" @click="select(record.id)">
        <span><strong>{{ record.sampleId }}</strong><small>{{ record.mode }}</small></span>
        <span class="queue-meta">{{ record.decision?.level || '—' }} · {{ record.review?.status || '待复核' }} · v{{ record.version }}</span>
        <span v-if="record.fallbackUsed" class="fallback">本地兜底</span>
      </button>
      <div v-if="!queue.length" class="empty-queue">暂无已完成记录。请先在“单张核验”运行合成样例。</div>
    </div>

    <div v-if="selected" class="review-grid">
      <figure>
        <img :src="`/api/demo/records/${selected.id}/file`" alt="待复核合成样例" />
        <figcaption>{{ selected.sampleId }} · 合成数据</figcaption>
      </figure>
      <div>
        <div class="reason-box">
          <strong>分流原因</strong>
          <p v-for="reason in selected.decision?.reasons || ['无']" :key="reason">{{ reason }}</p>
          <p v-if="selected.validation?.errors?.length">校验：{{ selected.validation.errors.map(error => error.code).join('、') }}</p>
        </div>
        <div class="edit-fields">
          <label v-for="key in fieldKeys" :key="key">
            <span>{{ FIELD_LABELS[key] }}<small v-if="selected.review?.revisions?.[key] !== undefined">已修订</small></span>
            <a-input v-model:value="draft[key]" :maxlength="key === 'passRoute' ? 20000 : 500" :disabled="busy || selected.review?.status === 'approved'">
              <template #suffix><span class="raw-hint">原 {{ selected.fields?.[key]?.raw ?? '—' }}</span></template>
            </a-input>
          </label>
        </div>
        <div class="review-actions">
          <a-button :disabled="busy || selected.review?.status === 'approved'" @click="submit(null)">保存草稿</a-button>
          <a-button :disabled="busy || selected.review?.status === 'approved'" @click="submit('returned')">退回补充</a-button>
          <a-button type="primary" :disabled="busy || selected.review?.status === 'approved'" @click="submit('approved')">确认通过</a-button>
        </div>
        <p class="audit">人工操作仅保存修订与审计事件，不覆盖原始抽取；确认通过会重新执行 Schema 与业务校验。</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.review-panel { padding: 26px; }
.section-head { display: flex; justify-content: space-between; gap: 16px; align-items: start; }
.eyebrow { margin: 0 0 4px; color: #b45309; font-size: 11px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
h2 { margin: 0; font-size: 30px; letter-spacing: -.04em; color: #173330; }
.muted { color: #677873; margin: 6px 0 0; }
.queue-list { margin: 20px 0 18px; display: grid; gap: 7px; max-height: 260px; overflow: auto; }
.queue-item { border: 1px solid #d8d1c2; background: #fffdf7; border-radius: 9px; padding: 10px 12px; display: grid; grid-template-columns: 1fr auto auto; gap: 12px; text-align: left; cursor: pointer; color: #405450; }
.queue-item.active { border-color: #0f6b62; box-shadow: inset 3px 0 #0f6b62; }
.queue-item span:first-child { display: flex; gap: 8px; align-items: baseline; }
.queue-item strong { color: #173330; }
.queue-item small, .queue-meta { color: #7b8580; font-size: 11px; }
.fallback { color: #9b1c1c; font-weight: 700; }
.empty-queue { color: #75827d; padding: 18px; border: 1px dashed #d5cfc3; border-radius: 9px; }
.review-grid { display: grid; grid-template-columns: minmax(300px, .85fr) minmax(0, 1.15fr); gap: 18px; }
figure { margin: 0; padding: 10px; background: #ede8dc; border: 1px solid #d8d1c2; border-radius: 12px; }
figure img { width: 100%; max-height: 520px; object-fit: contain; background: #fff; border-radius: 8px; }
figcaption { margin-top: 8px; color: #6c766f; font-size: 12px; }
.reason-box { background: #fdf4e3; border-left: 3px solid #b45309; padding: 10px 12px; font-size: 12px; color: #765b30; }
.reason-box p { margin: 5px 0 0; }
.edit-fields { display: grid; gap: 8px; margin: 14px 0; max-height: 520px; overflow: auto; padding-right: 4px; }
.edit-fields label { display: grid; grid-template-columns: 90px 1fr; gap: 8px; align-items: center; font-size: 12px; color: #52645f; }
.edit-fields label span { font-weight: 700; }
.edit-fields small { display: block; color: #b45309; }
.raw-hint { color: #8d9894; font-size: 10px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.review-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.audit { color: #78857f; font-size: 11px; margin-top: 12px; }
@media (max-width: 900px) { .review-grid { grid-template-columns: 1fr; } .review-panel { padding: 18px; } .edit-fields label { grid-template-columns: 1fr; } }
</style>
