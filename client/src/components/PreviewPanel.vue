<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { IMAGE_STATUS, STATUS_COLOR } from '../state.js'

const props = defineProps({
  images: { type: Array, default: () => [] }, selectedId: String,
  urlFor: { type: Function, required: true }, disabled: Boolean, reorder: Boolean,
})
const emit = defineEmits(['select', 'move'])
const active = computed(() => props.images.find((image) => image.id === props.selectedId) || props.images[0])
const viewport = ref(null)
const zoom = ref(1)
const rotation = ref(0)
const dimensions = ref({ width: 800, height: 1100 })
const box = ref({ width: 440, height: 390 })
const failed = ref(false)
const loaded = ref(false)
const reloadKey = ref(0)
let observer
const imageStyle = computed(() => {
  const rotated = Math.abs(rotation.value % 180) === 90
  const { width, height } = dimensions.value
  const fit = Math.min((box.value.width - 40) / (rotated ? height : width), (box.value.height - 40) / (rotated ? width : height))
  const scale = Math.max(0.01, fit) * zoom.value
  return { width: `${width * scale}px`, height: `${height * scale}px`, transform: `translate(-50%, -50%) rotate(${rotation.value}deg)` }
})
const canvasStyle = computed(() => {
  const rotated = Math.abs(rotation.value % 180) === 90
  const width = parseFloat(imageStyle.value.width)
  const height = parseFloat(imageStyle.value.height)
  return { width: `${Math.max(box.value.width, (rotated ? height : width) + 40)}px`, height: `${Math.max(box.value.height, (rotated ? width : height) + 40)}px` }
})
function reset() { zoom.value = 1; rotation.value = 0 }
function changeZoom(delta) { zoom.value = Math.min(3, Math.max(0.5, Math.round((zoom.value + delta) * 100) / 100)) }
function imageLoaded(event) {
  dimensions.value = { width: event.target.naturalWidth || 800, height: event.target.naturalHeight || 1100 }
  loaded.value = true
  failed.value = false
}
function reload() { failed.value = false; loaded.value = false; reloadKey.value++ }
watch(() => active.value?.id, () => { reset(); reload() })
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    if (entry.contentRect.width && entry.contentRect.height) box.value = { width: entry.contentRect.width, height: entry.contentRect.height }
  })
  if (viewport.value) observer.observe(viewport.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <section class="panel preview-panel" aria-label="原图预览">
    <div class="panel-heading">
      <div><strong>原图预览</strong><span v-if="active" class="muted heading-detail">{{ images.findIndex(image => image.id === active.id) + 1 }} / {{ images.length }}</span></div>
      <a-space :size="4" class="preview-tools">
        <a-button size="small" :disabled="!active || zoom <= 0.5" aria-label="缩小原图" title="缩小" @click="changeZoom(-0.25)">−</a-button>
        <span class="zoom-label">{{ Math.round(zoom * 100) }}%</span>
        <a-button size="small" :disabled="!active || zoom >= 3" aria-label="放大原图" title="放大" @click="changeZoom(0.25)">+</a-button>
        <a-button size="small" :disabled="!active" aria-label="顺时针旋转原图 90 度" @click="rotation += 90">旋转</a-button>
        <a-button size="small" :disabled="!active" @click="reset">适应</a-button>
      </a-space>
    </div>
    <div ref="viewport" class="image-viewport">
      <div v-if="!active" class="preview-empty">
        <svg width="64" height="78" viewBox="0 0 64 78" fill="none" aria-hidden="true"><path d="M9 2h31l15 15v58H9V2Z" fill="white" stroke="currentColor" stroke-width="2"/><path d="M39 2v17h16M19 33h27M19 42h27M19 51h18M19 60h23" stroke="currentColor" stroke-width="2"/></svg>
        <strong>暂无证件图片</strong>
        <span>选择图片后，在此检查清晰度和页序</span>
      </div>
      <div v-else-if="failed" class="preview-empty" role="alert">
        <strong>原图加载失败</strong><span>请检查本机服务或图片是否已到期。</span>
        <a-button @click="reload">重新加载原图</a-button>
      </div>
      <div v-else class="image-canvas" :style="canvasStyle">
        <span v-if="!loaded" class="image-loading">正在加载原图…</span>
        <img :key="`${active.id}-${reloadKey}`" class="permit-image" :style="imageStyle" :src="urlFor(active)" :alt="`第 ${images.findIndex(image => image.id === active.id) + 1} 张：${active.originalName || active.name}`" draggable="false" @load="imageLoaded" @error="failed = true" />
      </div>
    </div>
    <div class="image-caption"><span class="ellipsis">{{ active?.originalName || active?.name || '支持 JPG / JPEG / PNG 原始图片' }}</span><span v-if="active" class="muted">仅预览 · 不改原文件</span></div>
    <div class="thumbnail-strip" aria-label="图片序号切换">
      <div v-for="(image, index) in images" :key="image.id" class="thumbnail-item" :class="{ selected: active?.id === image.id }">
        <button type="button" class="thumbnail-button" :aria-label="`查看第 ${index + 1} 张：${image.originalName || image.name}`" :aria-pressed="active?.id === image.id" @click="emit('select', image.id)">
          <img :src="urlFor(image)" alt="" /><span class="thumbnail-index">{{ index + 1 }}</span>
          <span v-if="image.status" class="thumbnail-status"><a-badge :status="image.status === 'failed' ? 'error' : image.status === 'succeeded' ? 'success' : 'default'" />{{ IMAGE_STATUS[image.status] }}</span>
        </button>
        <div v-if="reorder" class="thumbnail-order">
          <a-button type="text" size="small" :disabled="disabled || index === 0" :aria-label="`第 ${index + 1} 张上移`" @click="emit('move', index, -1)">上移</a-button>
          <a-button type="text" size="small" :disabled="disabled || index === images.length - 1" :aria-label="`第 ${index + 1} 张下移`" @click="emit('move', index, 1)">下移</a-button>
        </div>
      </div>
      <span v-if="!images.length" class="muted thumbnail-empty">上传后显示图片缩略图，按序核对</span>
    </div>
  </section>
</template>
