export const FIELDS = Object.freeze([
  ['permitNumber', '证件编号'], ['plateNumber', '车牌号码'], ['issuingRegion', '签发地区'],
  ['validFrom', '有效期起'], ['validTo', '有效期止'], ['length', '车货总长'],
  ['width', '车货总宽'], ['height', '车货总高'], ['weight', '车货总重'],
  ['axleCount', '轴数'], ['passRoute', '通行路线'],
].map(([key, label]) => Object.freeze({ key, label })))

export const IMAGE_STATUS = { pending: '待识别', queued: '排队中', recognizing: '识别中', succeeded: '已识别', failed: '识别失败' }
export const TASK_STATUS = { draft: '待识别', recognizing: '识别中', needs_correction: '待人工校对', failed: '识别失败' }
export const STATUS_COLOR = { draft: 'default', pending: 'default', queued: 'processing', recognizing: 'processing', succeeded: 'blue', needs_correction: 'gold', failed: 'error' }

export function validateFiles(files) {
  const errors = []
  if (!files.length || files.length > 10) errors.push('请选择 1–10 张图片。')
  let total = 0
  for (const file of files) {
    total += Number(file.size) || 0
    const extension = /\.(jpe?g|png)$/i.exec(file.name || '')?.[1]?.toLowerCase()
    const expected = extension === 'png' ? 'image/png' : 'image/jpeg'
    if (!extension || file.type !== expected) errors.push(`${file.name}：仅支持 JPG、JPEG、PNG 图片。`)
    if (!Number.isFinite(file.size) || file.size <= 0) errors.push(`${file.name}：图片为空或不可读取。`)
    if (file.size > 10 * 1024 ** 2) errors.push(`${file.name}：单张不得超过 10 MiB。`)
  }
  if (total > 50 * 1024 ** 2) errors.push('图片合计不得超过 50 MiB。')
  return errors
}

export function validateName(name) {
  if (typeof name !== 'string' || !name.trim()) return '请输入任务名称。'
  if (name.trim().length > 80) return '任务名称最多 80 个字符。'
  if (/[\u0000-\u001f\u007f]/.test(name)) return '任务名称不能包含换行或控制字符。'
  return ''
}

export function moveItem(items, index, direction) {
  const result = [...items]
  const target = index + direction
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return result
  ;[result[index], result[target]] = [result[target], result[index]]
  return result
}

function savedFields(image) {
  return Object.fromEntries(FIELDS.map(({ key }) => [key,
    Object.hasOwn(image.revision?.fields || {}, key)
      ? image.revision.fields[key] : (image.original?.fields?.[key]?.value ?? null),
  ]))
}

export function createEditor(task) {
  return {
    task, baseVersion: task.version, name: task.name, order: task.images.map((image) => image.id),
    fields: Object.fromEntries(task.images.map((image) => [image.id, savedFields(image)])),
    dirty: { name: false, order: false, fields: {} }, conflict: false,
  }
}

export function isDirty(editor) {
  return Boolean(editor && (editor.dirty.name || editor.dirty.order || Object.keys(editor.dirty.fields).length))
}

export function editField(editor, imageId, key, value) {
  if (!FIELDS.some((field) => field.key === key) || !editor.fields[imageId]) throw new Error('未知校对字段')
  return {
    ...editor,
    fields: { ...editor.fields, [imageId]: { ...editor.fields[imageId], [key]: value } },
    dirty: { ...editor.dirty, fields: { ...editor.dirty.fields, [imageId]: { ...editor.dirty.fields[imageId], [key]: true } } },
  }
}

export function editName(editor, name) {
  return { ...editor, name, dirty: { ...editor.dirty, name: true } }
}

export function editOrder(editor, order) {
  if (order.length !== editor.order.length || new Set(order).size !== order.length || order.some((id) => !editor.order.includes(id))) {
    throw new Error('图片顺序必须包含全部图片且不重复')
  }
  return { ...editor, order: [...order], dirty: { ...editor.dirty, order: true } }
}

// Server snapshots and local drafts are separate: polling only fills untouched fields.
export function mergeTask(editor, task) {
  if (task.id !== editor.task.id || task.version < editor.task.version) return editor
  const fresh = createEditor(task)
  if (!isDirty(editor)) return { ...fresh, conflict: editor.conflict }
  const fields = { ...fresh.fields }
  for (const [imageId, keys] of Object.entries(editor.dirty.fields)) {
    for (const key of Object.keys(keys)) fields[imageId] = { ...fields[imageId], [key]: editor.fields[imageId][key] }
  }
  return {
    ...editor, task, fields,
    name: editor.dirty.name ? editor.name : fresh.name,
    order: editor.dirty.order ? editor.order : fresh.order,
  }
}

export function buildPatch(editor) {
  const patch = { version: editor.baseVersion }
  if (editor.dirty.name) patch.name = editor.name.trim()
  if (editor.dirty.order) patch.order = [...editor.order]
  const revisions = Object.entries(editor.dirty.fields).map(([imageId, keys]) => ({
    imageId, fields: Object.fromEntries(Object.keys(keys).map((key) => [key, editor.fields[imageId][key]?.trim() || null])),
  }))
  if (revisions.length) patch.revisions = revisions
  return patch
}

export const markConflict = (editor) => ({ ...editor, conflict: true })
export const canRetry = (image) => image?.status === 'failed'
export function confidenceLabel(original) {
  return typeof original?.confidence === 'number' && Number.isFinite(original.confidence)
    ? `${Math.round(original.confidence * 10) / 10}%` : null
}

export function createRequestGate() {
  let generation = 0
  let activeId = null
  return {
    begin(id) { activeId = id; return ++generation },
    accepts(token, id) { return token === generation && id === activeId },
    invalidate() { generation++; activeId = null },
  }
}

export function rememberTask(storage, id) {
  try {
    if (id) storage.setItem('lastTaskId', id)
    else storage.removeItem('lastTaskId')
  } catch { /* Storage can be disabled; certificate data stays in memory regardless. */ }
}

export function recallTask(storage) {
  try { return storage.getItem('lastTaskId') || null } catch { return null }
}
