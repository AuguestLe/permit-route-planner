<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { Modal } from 'ant-design-vue'
import { moveItem, validateFiles, validateName } from '../state.js'
import PreviewPanel from './PreviewPanel.vue'

const props = defineProps({ busy: Boolean, submit: { type: Function, required: true } })
const emit = defineEmits(['dirty'])
const entries = ref([])
const name = ref('')
const selectedId = ref(null)
const errors = ref([])
const submission = ref(null)
const dragging = ref(false)
const input = ref(null)
const locked = computed(() => props.busy || Boolean(submission.value))
const total = computed(() => (entries.value.reduce((sum, entry) => sum + entry.file.size, 0) / 1024 ** 2).toFixed(1))
function markDirty() { emit('dirty', entries.value.length > 0 || Boolean(name.value.trim())) }
function addFiles(files) {
  if (locked.value) return
  const incoming = Array.from(files || [])
  if (!incoming.length) return
  errors.value = validateFiles([...entries.value.map((entry) => entry.file), ...incoming])
  if (errors.value.length) return
  for (const file of incoming) entries.value.push({ id: crypto.randomUUID(), file, originalName: file.name, url: URL.createObjectURL(file) })
  if (!selectedId.value) selectedId.value = entries.value[0].id
  markDirty()
}
function choose(event) { addFiles(event.target.files); event.target.value = '' }
function drop(event) { dragging.value = false; addFiles(event.dataTransfer.files) }
function remove(index) {
  if (locked.value) return
  URL.revokeObjectURL(entries.value[index].url)
  entries.value.splice(index, 1)
  if (!entries.value.some((entry) => entry.id === selectedId.value)) selectedId.value = entries.value[0]?.id || null
  errors.value = []
  markDirty()
}
function move(index, direction) { if (!locked.value) entries.value = moveItem(entries.value, index, direction) }
async function create() {
  if (props.busy) return
  if (!submission.value) {
    const nameError = validateName(name.value)
    errors.value = [...(nameError ? [nameError] : []), ...validateFiles(entries.value.map((entry) => entry.file))]
    if (errors.value.length) return
    submission.value = { name: name.value.trim(), files: entries.value.map((entry) => entry.file), key: crypto.randomUUID() }
  }
  // Keep this exact batch and key after uncertain network failures; a retry cannot duplicate it.
  await props.submit(submission.value)
}
function unlock() {
  Modal.confirm({
    title: '放弃本次创建重试？', centered: true,
    content: '请求可能已在本机完成。建议先用“重试创建”找回同一任务；修改图片或名称后将成为新的创建请求，可能产生重复任务。',
    okText: '修改为新批次', cancelText: '继续保留重试',
    onOk() { submission.value = null },
  })
}
onBeforeUnmount(() => entries.value.forEach((entry) => URL.revokeObjectURL(entry.url)))
</script>

<template>
  <div class="work-grid upload-workspace">
    <PreviewPanel :images="entries" :selected-id="selectedId" :url-for="image => image.url" :disabled="locked" reorder @select="selectedId = $event" @move="move" />
    <section class="panel upload-panel" aria-labelledby="upload-heading">
      <div class="panel-heading"><strong id="upload-heading">新建识别任务</strong><a-tag>先选图，再识别</a-tag></div>
      <div class="upload-scroll">
        <label for="task-name" class="field-label">任务名称 <span class="required">*</span></label>
        <a-input id="task-name" v-model:value="name" :maxlength="80" :disabled="locked" placeholder="例如：设备运输 · 超限运输许可证" show-count @update:value="markDirty" />
        <input ref="input" class="visually-hidden" type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" multiple :disabled="locked" aria-label="选择许可证图片" @change="choose" />
        <div class="dropzone" :class="{ dragging, locked }" @dragover.prevent="dragging = !locked" @dragleave.prevent="dragging = false" @drop.prevent="drop">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 22V5m-6 6 6-6 6 6M5 21v6h22v-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <strong>选择或拖拽证件图片到此处</strong>
          <span>JPG / JPEG / PNG · 1–10 张</span>
          <a-button :disabled="locked" @click="input.click()">{{ entries.length ? '继续添加图片' : '选择图片' }}</a-button>
          <span class="muted">单张 ≤ 10 MiB，合计 ≤ 50 MiB</span>
        </div>
        <div v-if="errors.length" class="inline-errors" role="alert"><div v-for="(error, index) in errors" :key="index">{{ error }}</div></div>
        <div class="upload-list-heading"><strong>已选图片 <span class="muted">{{ entries.length }} / 10</span></strong><span class="muted">{{ total }} / 50 MiB</span></div>
        <div v-if="!entries.length" class="list-empty">尚未选择图片。建议使用清晰、完整、无反光的证件照片。</div>
        <div v-for="(entry, index) in entries" :key="entry.id" class="upload-row" :class="{ active: selectedId === entry.id }">
          <button type="button" class="upload-file" @click="selectedId = entry.id"><span class="sequence">{{ index + 1 }}</span><span class="ellipsis">{{ entry.file.name }}</span></button>
          <span class="file-size">{{ (entry.file.size / 1024 ** 2).toFixed(1) }} MiB</span>
          <a-button type="text" size="small" :disabled="locked || index === 0" :aria-label="`图片 ${index + 1} 上移`" @click="move(index, -1)">上移</a-button>
          <a-button type="text" size="small" :disabled="locked || index === entries.length - 1" :aria-label="`图片 ${index + 1} 下移`" @click="move(index, 1)">下移</a-button>
          <a-button type="text" danger size="small" :disabled="locked" :aria-label="`移除图片 ${index + 1}`" @click="remove(index)">移除</a-button>
        </div>
        <a-alert v-if="submission && !busy" type="warning" show-icon class="batch-alert" message="创建结果未确认，图片及名称暂时锁定" description="重试复用同一请求，不重复创建任务。" />
        <a-button v-if="submission && !busy" type="link" size="small" @click="unlock">需要修改本次上传内容</a-button>
      </div>
      <div class="panel-footer upload-footer">
        <span class="muted">按当前序号创建；创建后需手动开始识别。</span>
        <a-button type="primary" :loading="busy" :disabled="!entries.length" @click="create">{{ submission ? '重试创建' : '确认顺序并创建任务' }}</a-button>
      </div>
    </section>
  </div>
</template>
