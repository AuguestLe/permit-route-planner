import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { Modal, message } from 'ant-design-vue'
import { api } from './api.js'
import {
  buildPatch, canRetry, createEditor, createRequestGate, editField, editName, editOrder,
  isDirty, markConflict, mergeTask, moveItem, recallTask, rememberTask, validateName,
} from './state.js'

function confirmAction(title, content, okText = '确认') {
  return new Promise((resolve) => Modal.confirm({
    title, content, okText, cancelText: '取消', centered: true,
    onOk: () => resolve(true), onCancel: () => resolve(false),
  }))
}

export function useWorkbench() {
  const editor = shallowRef(null)
  const tasks = ref([])
  const selectedId = ref(null)
  const activeId = ref(null)
  const busy = ref(false)
  const loading = ref(false)
  const listLoading = ref(false)
  const error = ref('')
  const listError = ref('')
  const health = ref(null)
  const healthError = ref('')
  const uploadDirty = ref(false)
  const uploadKey = ref(0)
  const loadFailedId = ref(null)
  const gate = createRequestGate()
  let controller = null
  let timer = null
  let stopped = false
  let listGeneration = 0
  const dirty = computed(() => isDirty(editor.value))
  const task = computed(() => editor.value?.task || null)
  const orderedImages = computed(() => editor.value?.order.map((id) => task.value.images.find((image) => image.id === id)).filter(Boolean) || [])
  const selectedImage = computed(() => orderedImages.value.find((image) => image.id === selectedId.value) || orderedImages.value[0] || null)
  const recognizing = computed(() => task.value?.status === 'recognizing' || task.value?.images.some((image) => ['queued', 'recognizing'].includes(image.status)))
  const canStart = computed(() => task.value?.images.some((image) => image.status === 'pending') && !recognizing.value)

  function storage() {
    try { return window.localStorage } catch { return null }
  }
  function remember(id) { rememberTask(storage(), id) }
  function cancelRead() { controller?.abort(); controller = null; gate.invalidate() }
  function syncSelection() {
    if (!orderedImages.value.some((image) => image.id === selectedId.value)) selectedId.value = orderedImages.value[0]?.id || null
  }
  function acceptSnapshot(snapshot, replace = false) {
    if (!snapshot || !Array.isArray(snapshot.images) || !snapshot.id) throw new Error('任务数据为空或格式不完整，请重试。')
    editor.value = replace || !editor.value ? createEditor(snapshot) : mergeTask(editor.value, snapshot)
    activeId.value = snapshot.id
    loadFailedId.value = null
    syncSelection()
    remember(snapshot.id)
  }
  async function checkHealth() {
    healthError.value = ''
    try { health.value = await api.health() } catch (failure) { healthError.value = failure.message; health.value = null }
  }
  async function refreshList() {
    const generation = ++listGeneration
    listLoading.value = true
    try {
      const data = await api.listTasks()
      if (generation !== listGeneration || stopped) return
      if (!Array.isArray(data.tasks)) throw new Error('最近任务列表为空或格式不完整，请重试。')
      tasks.value = data.tasks
      listError.value = ''
    } catch (failure) {
      if (generation === listGeneration && !stopped) listError.value = failure.message
    } finally { if (generation === listGeneration) listLoading.value = false }
  }
  async function mayLeave() {
    if (!dirty.value && !uploadDirty.value) return true
    return confirmAction('放弃未保存的内容？', '切换后将丢弃当前未保存校对或待上传图片，服务器已保存内容不受影响。', '放弃并切换')
  }
  async function openTask(id, skipConfirm = false) {
    if (busy.value || (id === activeId.value && editor.value)) return
    if (!skipConfirm && !await mayLeave()) return
    cancelRead()
    const token = gate.begin(id)
    controller = new AbortController()
    activeId.value = id
    editor.value = null
    uploadDirty.value = false
    loading.value = true
    error.value = ''
    loadFailedId.value = null
    try {
      const snapshot = await api.getTask(id, controller.signal)
      if (!gate.accepts(token, id) || stopped) return
      acceptSnapshot(snapshot, true)
    } catch (failure) {
      if (!gate.accepts(token, id) || stopped || failure.name === 'AbortError') return
      error.value = failure.message
      loadFailedId.value = id
      if ([404, 410].includes(failure.status)) remember(null)
    } finally { if (gate.accepts(token, id)) loading.value = false }
  }
  async function newTask() {
    if (busy.value || !await mayLeave()) return
    cancelRead()
    editor.value = null
    activeId.value = null
    selectedId.value = null
    loadFailedId.value = null
    loading.value = false
    error.value = ''
    uploadDirty.value = false
    uploadKey.value++
    remember(null)
  }
  async function createTask(payload) {
    if (busy.value) return false
    busy.value = true
    error.value = ''
    cancelRead()
    try {
      const snapshot = await api.createTask(payload.name, payload.files, payload.key)
      if (stopped) return false
      acceptSnapshot(snapshot, true)
      uploadDirty.value = false
      message.success('任务已创建，请点击“开始识别”。')
      refreshList()
      return true
    } catch (failure) {
      if (!stopped) error.value = failure.message
      return false
    } finally { busy.value = false }
  }
  function setError(failure) {
    error.value = failure.message
    if (failure.status === 409 && editor.value) editor.value = markConflict(editor.value)
  }
  async function mutate(operation, replace = false, successMessage = '') {
    if (!task.value || busy.value) return
    busy.value = true
    error.value = ''
    cancelRead()
    const id = task.value.id
    const token = gate.begin(id)
    try {
      const snapshot = await operation()
      if (!gate.accepts(token, id) || stopped) return
      acceptSnapshot(snapshot, replace)
      if (successMessage) message.success(successMessage)
      refreshList()
    } catch (failure) {
      if (gate.accepts(token, id) && !stopped) setError(failure)
    } finally { busy.value = false }
  }
  async function save() {
    if (!dirty.value || recognizing.value || editor.value?.conflict) return
    const nameError = validateName(editor.value.name)
    if (nameError) { error.value = nameError; return }
    const patch = buildPatch(editor.value)
    await mutate(() => api.patchTask(task.value.id, patch), true, '校对已保存；原始 OCR 保持不变。')
  }
  async function start() {
    if (!canStart.value) return
    await mutate(() => api.recognize(task.value.id, task.value.version))
  }
  async function retry(image) {
    if (!canRetry(image) || recognizing.value) return
    await mutate(() => api.retryImage(task.value.id, image.id, task.value.version))
  }
  async function restore() {
    if (!task.value || busy.value) return
    if ((dirty.value || editor.value.conflict) && !await confirmAction('丢弃草稿并刷新？', '当前未保存的名称、图片顺序和字段校对将被丢弃，恢复服务器最新已保存内容。此操作无法撤销。', '丢弃草稿并刷新')) return
    await mutate(() => api.getTask(task.value.id), true, '已恢复服务器保存的内容。')
  }
  async function removeTask() {
    if (!task.value || busy.value) return
    const id = task.value.id
    if (!await confirmAction('删除此任务及全部图片？', `删除“${task.value.name}”后无法恢复。${dirty.value ? '未保存的校对也将丢失。' : ''}`, '确认删除')) return
    if (id !== task.value?.id) return
    busy.value = true
    error.value = ''
    cancelRead()
    try {
      await api.deleteTask(id, task.value.version)
      editor.value = null
      activeId.value = null
      remember(null)
      uploadKey.value++
      message.success('任务已删除。')
      refreshList()
    } catch (failure) { setError(failure) } finally { busy.value = false }
  }
  async function poll() {
    if (stopped) return
    if (task.value && !busy.value && !loading.value) {
      const id = task.value.id
      const token = gate.begin(id)
      controller = new AbortController()
      try {
        const snapshot = await api.getTask(id, controller.signal)
        if (gate.accepts(token, id) && !stopped) {
          const summaryChanged = snapshot.version !== task.value?.version
            || snapshot.status !== task.value?.status
            || snapshot.images.some(image => image.status !== task.value?.images.find(previous => previous.id === image.id)?.status)
          acceptSnapshot(snapshot)
          if (error.value.startsWith('状态更新失败')) error.value = ''
          if (summaryChanged) refreshList()
        }
      } catch (failure) {
        if (gate.accepts(token, id) && !stopped && failure.name !== 'AbortError') error.value = `状态更新失败：${failure.message} 未保存校对已保留。`
      }
    }
    if (!stopped) timer = setTimeout(poll, 2200)
  }
  function beforeUnload(event) {
    if (dirty.value || uploadDirty.value || busy.value) { event.preventDefault(); event.returnValue = '' }
  }
  onMounted(() => {
    checkHealth()
    refreshList()
    const lastId = recallTask(storage())
    if (lastId) openTask(lastId, true)
    timer = setTimeout(poll, 2200)
    window.addEventListener('beforeunload', beforeUnload)
  })
  onBeforeUnmount(() => {
    stopped = true
    cancelRead()
    clearTimeout(timer)
    window.removeEventListener('beforeunload', beforeUnload)
  })
  return {
    editor, task, tasks, selectedId, selectedImage, orderedImages, activeId, busy, loading, listLoading,
    error, listError, health, healthError, uploadDirty, uploadKey, loadFailedId, dirty, recognizing, canStart,
    checkHealth, refreshList, openTask, newTask, createTask, save, start, retry, restore, removeTask,
    setName: (name) => { if (!busy.value) editor.value = editName(editor.value, name) },
    setField: (imageId, key, value) => { if (!busy.value) editor.value = editField(editor.value, imageId, key, value) },
    moveImage: (index, direction) => { if (!busy.value) editor.value = editOrder(editor.value, moveItem(editor.value.order, index, direction)) },
  }
}
