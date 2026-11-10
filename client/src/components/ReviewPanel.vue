<script setup>
import { computed, ref } from 'vue'
import { FIELDS, IMAGE_STATUS, STATUS_COLOR, confidenceLabel } from '../state.js'

const props = defineProps({ image: Object, images: Array, fields: Object, busy: Boolean, recognizing: Boolean })
const emit = defineEmits(['field', 'retry'])
const tab = ref('fields')
const confidence = computed(() => confidenceLabel(props.image?.original))
const canEdit = computed(() => props.image?.status === 'succeeded' && !props.busy)
const sourceFor = (key) => props.image?.original?.fields?.[key]?.source
const sourceNumber = (source) => props.images.findIndex((image) => image.id === source.imageId) + 1
</script>

<template>
  <section class="panel review-panel" aria-label="识别结果与结构化字段校对">
    <div class="panel-heading"><strong>识别结果校对</strong><span v-if="image" class="muted">图片 {{ images.findIndex(item => item.id === image.id) + 1 }} / {{ images.length }}</span></div>
    <div v-if="image" class="recognition-status" aria-live="polite">
      <a-tag :color="STATUS_COLOR[image.status]">{{ IMAGE_STATUS[image.status] || image.status }}</a-tag>
      <span v-if="image.stage" class="stage-label">{{ image.stage }}</span>
      <span v-if="confidence !== null" class="muted confidence">OCR 置信度 {{ confidence }}</span>
    </div>
    <div v-if="image?.status === 'failed'" class="review-notice">
      <a-alert type="error" show-icon :message="image.error?.message || '本图识别失败，请重试。'">
        <template #action><a-button size="small" :disabled="busy || recognizing" @click="emit('retry', image)">重试本图</a-button></template>
      </a-alert>
    </div>
    <div v-if="image?.status === 'succeeded' && !image.original?.text?.trim()" class="review-notice">
      <a-alert type="warning" show-icon message="本图未识别到文字，请对照原图手动校对。成功图片不可重识别。" />
    </div>
    <div v-if="image?.original?.warnings?.length" class="review-notice">
      <a-alert type="warning" show-icon><template #message><div v-for="(warning, index) in image.original.warnings" :key="index">{{ warning }}</div></template></a-alert>
    </div>
    <a-tabs v-model:active-key="tab" class="review-tabs" :animated="false">
      <a-tab-pane key="fields" tab="结构化字段校对">
        <div class="field-help">空白表示未识别，请对照左侧原图录入；尺寸、重量请保留原证单位。</div>
        <div class="field-grid">
          <div v-for="field in FIELDS" :key="field.key" class="review-field" :class="{ 'full-width': field.key === 'passRoute' }">
            <label class="field-label" :for="`field-${field.key}`">{{ field.label }}</label>
            <a-textarea v-if="field.key === 'passRoute'" :id="`field-${field.key}`" :value="fields?.[field.key] ?? ''" :disabled="!canEdit" :rows="3" placeholder="未识别，请按证件原文校对通行路线" @update:value="emit('field', image.id, field.key, $event)" />
            <a-input v-else :id="`field-${field.key}`" :value="fields?.[field.key] ?? ''" :disabled="!canEdit" placeholder="未识别，请人工校对" allow-clear @update:value="emit('field', image.id, field.key, $event)" />
            <a-tooltip v-if="sourceFor(field.key)" :title="sourceFor(field.key).text" placement="topLeft">
              <div class="source-line"><span>{{ sourceNumber(sourceFor(field.key)) ? `来源图片 ${sourceNumber(sourceFor(field.key))}` : '来源原文' }}</span><span v-if="sourceFor(field.key).text" class="source-text"> · {{ sourceFor(field.key).text }}</span></div>
            </a-tooltip>
          </div>
        </div>
        <div v-if="!canEdit && !busy" class="field-help bottom-help">{{ image?.status === 'pending' ? '任务已创建。点击上方“开始识别”后生成 OCR 结果。' : image?.status === 'failed' ? '本图识别失败，请先重试本图。' : '本图正在排队或识别，结果返回后即可校对。' }}</div>
      </a-tab-pane>
      <a-tab-pane key="original" tab="识别原文">
        <div class="original-heading"><a-tag>只读</a-tag><span class="muted">保留首次成功 OCR 原文，校对不修改此记录。</span></div>
        <pre v-if="image?.original?.text" class="ocr-original">{{ image.original.text }}</pre>
        <div v-else class="ocr-empty">{{ image?.status === 'succeeded' ? 'OCR 未返回文字。可切换到结构化字段手动校对。' : '暂无识别原文。请开始识别或等待本图处理完成。' }}</div>
      </a-tab-pane>
    </a-tabs>
    <div class="review-footnote">校对结果仅供运输审核参考，不构成许可路线核验。</div>
  </section>
</template>
