<script setup>
import { computed } from 'vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import { api } from './api.js'
import { STATUS_COLOR, TASK_STATUS } from './state.js'
import { useWorkbench } from './useWorkbench.js'
import PreviewPanel from './components/PreviewPanel.vue'
import UploadPanel from './components/UploadPanel.vue'
import ReviewPanel from './components/ReviewPanel.vue'

const {
  editor, task, tasks, selectedId, selectedImage, orderedImages, activeId, busy, loading, listLoading,
  error, listError, health, healthError, uploadDirty, uploadKey, loadFailedId, dirty, recognizing, canStart,
  checkHealth, refreshList, openTask, newTask, createTask, save, start, retry, restore, removeTask,
  setName, setField, moveImage,
} = useWorkbench()
const localReady = computed(() => health.value?.ok && health.value?.localOnly === true)
const succeededCount = computed(() => task.value?.images.filter(image => image.status === 'succeeded').length || 0)
const failedCount = computed(() => task.value?.images.filter(image => image.status === 'failed').length || 0)
const theme = { token: { colorPrimary: '#1677ff', colorText: '#27292f', borderRadius: 4, fontSize: 13, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif', controlHeight: 32 } }
function dateLabel(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}
</script>

<template>
  <a-config-provider :locale="zhCN" :theme="theme">
    <div class="workbench">
      <header class="topbar">
        <div class="brand-mark" aria-hidden="true"><svg width="24" height="26" viewBox="0 0 24 26" fill="none"><path d="M5 2h10l5 5v17H5V2Z" stroke="currentColor" stroke-width="1.6"/><path d="M15 2v6h5M9 12h7M9 16h7M9 20h4" stroke="currentColor" stroke-width="1.6"/></svg></div>
        <div class="brand-copy"><h1>超限证识别校对</h1><span>运输审核工作台 <span class="topbar-divider">/</span> 本机 OCR · 人工校对</span></div>
        <div class="service-indicator">
          <a-badge :status="localReady ? 'success' : healthError ? 'error' : 'default'" :text="localReady ? '本地识别服务已连接' : healthError ? '本机服务未连接' : '正在检查本机服务'" />
          <a-button v-if="!localReady" type="link" size="small" @click="checkHealth">重新检查</a-button>
          <span class="engine-label">{{ health?.engine || '原生 Tesseract' }}</span>
        </div>
      </header>
      <div class="workspace-body">
        <aside class="task-sidebar" aria-label="最近任务">
          <div class="sidebar-title"><strong>最近任务</strong><a-button type="text" size="small" :loading="listLoading" aria-label="刷新最近任务" @click="refreshList">刷新</a-button></div>
          <a-button type="primary" block :disabled="busy" @click="newTask">+ 新建识别任务</a-button>
          <div class="sidebar-hint">本机保存，7 天后到期</div>
          <div v-if="listError" class="sidebar-error" role="alert">{{ listError }}<a-button type="link" size="small" @click="refreshList">重试</a-button></div>
          <div class="task-list">
            <div v-if="!tasks.length && !listLoading && !listError" class="tasks-empty"><strong>暂无任务</strong><span>新建任务后，可在这里继续校对。</span></div>
            <button v-for="item in tasks" :key="item.id" type="button" class="task-item" :class="{ active: item.id === activeId }" :disabled="busy" :aria-current="item.id === activeId ? 'true' : undefined" @click="openTask(item.id)">
              <span class="task-item-name" :title="item.name">{{ item.name }}</span>
              <span class="task-item-meta"><a-tag :color="STATUS_COLOR[item.status]">{{ TASK_STATUS[item.status] || item.status }}</a-tag><span>{{ item.recognizedCount ?? 0 }}/{{ item.imageCount }} 张</span></span>
              <span class="task-item-time">创建于 {{ dateLabel(item.createdAt) }}</span>
            </button>
          </div>
          <div class="sidebar-note"><strong>仅在本机处理</strong><span>图片不发送至外部 OCR 服务。刷新仅记住最近任务编号，不在浏览器存储证件字段。</span></div>
        </aside>
        <main class="main-workspace">
          <div class="boundary-banner"><span class="warning-dot" aria-hidden="true">!</span><span><strong>本地 OCR 需要人工校对，不代表许可路线核验；地图规划尚未接入。</strong> 图片仅传本机，7 天后到期。</span></div>
          <div v-if="error" class="request-error" role="alert"><a-alert type="error" show-icon :message="error" /><a-button v-if="loadFailedId" size="small" @click="openTask(loadFailedId, true)">重新加载任务</a-button></div>
          <div v-if="loading" class="loading-task panel"><a-spin tip="正在读取本机任务…" /></div>
          <div v-else-if="loadFailedId && !task" class="loading-task panel"><a-empty description="任务暂时无法读取；请重试，或新建识别任务。" /><a-button @click="newTask">新建任务</a-button></div>
          <template v-else-if="task">
            <section class="task-toolbar panel" aria-label="任务操作">
              <div class="task-title-group"><label for="saved-task-name" class="field-label">任务名称</label><a-input id="saved-task-name" :value="editor.name" :maxlength="80" :disabled="busy" @update:value="setName" /><a-tag :color="STATUS_COLOR[task.status]">{{ TASK_STATUS[task.status] || task.status }}</a-tag></div>
              <div class="task-actions"><a-button danger :disabled="busy" @click="removeTask">删除任务</a-button><a-button type="primary" :disabled="busy || !canStart" :loading="busy && canStart" @click="start">{{ recognizing ? '正在本机识别' : '开始识别' }}</a-button></div>
              <div class="task-summary"><span>{{ task.images.length }} 张图片 · 已识别 {{ succeededCount }} 张<span v-if="failedCount" class="failure-count"> · 失败 {{ failedCount }} 张</span></span><span>到期时间 {{ dateLabel(task.expiresAt) }}</span><span>服务器版本 v{{ task.version }}</span><span v-if="recognizing">处理状态自动更新，未保存校对不被覆盖</span><span v-else-if="task.status === 'draft'">图片已就绪，请手动开始识别</span></div>
            </section>
            <a-alert v-if="editor.conflict" class="task-warning" type="warning" show-icon message="版本冲突：服务器内容已变化，本地草稿已保留。">
              <template #description>请先复制需保留的校对，再刷新服务器内容。刷新将二次确认丢弃草稿。</template>
              <template #action><a-button size="small" :disabled="busy" @click="restore">刷新服务器内容</a-button></template>
            </a-alert>
            <a-alert v-if="task.warnings?.length" class="task-warning" type="warning" show-icon><template #message><div v-for="(warning, index) in task.warnings" :key="index">{{ warning }}</div></template></a-alert>
            <div class="work-grid review-workspace">
              <PreviewPanel :images="orderedImages" :selected-id="selectedId" :url-for="image => api.imageUrl(task.id, image.id)" :disabled="busy" reorder @select="selectedId = $event" @move="moveImage" />
              <ReviewPanel :image="selectedImage" :images="orderedImages" :fields="editor.fields[selectedImage?.id]" :busy="busy" :recognizing="recognizing" @field="setField" @retry="retry" />
            </div>
            <footer class="savebar panel">
              <div class="save-status"><span class="save-dot" :class="{ dirty }"></span><strong>{{ dirty ? '有未保存的校对' : '已与服务器保存内容同步' }}</strong><span class="muted">{{ dirty ? '刷新页面会丢失本地草稿' : '原始 OCR 记录保持不变' }}</span></div>
              <a-space><a-button :disabled="busy" @click="restore">恢复服务器已保存</a-button><a-button type="primary" :loading="busy" :disabled="!dirty || recognizing || editor.conflict" @click="save">保存校对</a-button></a-space>
            </footer>
          </template>
          <UploadPanel v-else :key="uploadKey" :busy="busy" :submit="createTask" @dirty="uploadDirty = $event" />
        </main>
      </div>
    </div>
  </a-config-provider>
</template>
