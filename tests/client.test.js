import test from 'node:test'
import assert from 'node:assert/strict'

// Dynamic imports make the initial RED run explain the missing implementation.
let state, api
try { state = await import('../client/src/state.js') } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
}
try { api = await import('../client/src/api.js') } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
}
const needState = () => assert.ok(state, '待实现 client/src/state.js 状态与校验工具')
const needApi = () => assert.ok(api, '待实现 client/src/api.js 同源 API 工具')
const MiB = 1024 ** 2
const file = (name = '证件.png', size = MiB, type = 'image/png') => ({ name, size, type })
const task = (id = 'task-a', version = 1) => ({
  id, name: '运输许可', version, status: 'needs_correction', warnings: [],
  images: [{ id: 'img-a', status: 'succeeded', originalName: '证件.png',
    original: { text: '<script>原始OCR</script>', confidence: null,
      fields: { permitNumber: { value: '原始编号', source: null } }, warnings: [] },
    revision: null },
  { id: 'img-b', status: 'failed', original: null, revision: null }],
})

test('上传仅允许 1–10 张 JPG/JPEG/PNG，校验 MIME、扩展名及空文件', () => {
  needState()
  assert.equal(state.validateFiles([]).length, 1)
  assert.deepEqual(state.validateFiles([file(), file('证件.JPEG', 10 * MiB, 'image/jpeg')]), [])
  for (const invalid of [file('a.pdf'), file('a.png', MiB, 'image/gif'), file('a.jpg', 0, 'image/jpeg')]) {
    assert.ok(state.validateFiles([invalid]).length)
  }
  assert.ok(state.validateFiles(Array.from({ length: 11 }, () => file())).length)
})

test('上传严格按 MiB 限制单张 10、合计 50，边界可用', () => {
  needState()
  assert.deepEqual(state.validateFiles(Array.from({ length: 5 }, () => file('a.png', 10 * MiB))), [])
  assert.ok(state.validateFiles([file('a.png', 10 * MiB + 1)]).length)
  assert.ok(state.validateFiles([...Array.from({ length: 5 }, () => file('a.png', 10 * MiB)), file('b.png', 1)]).length)
})

test('任务名去除首尾空白并拒绝空白、超长及控制字符', () => {
  needState()
  assert.equal(state.validateName('  运输许可  '), '')
  for (const name of ['', '   ', 'a'.repeat(81), '任务\n名称']) assert.ok(state.validateName(name))
})

test('顺序调整不修改原数组，边界不移动', () => {
  needState()
  const order = ['a', 'b', 'c']
  assert.deepEqual(state.moveItem(order, 1, -1), ['b', 'a', 'c'])
  assert.deepEqual(state.moveItem(order, 0, -1), order)
  assert.deepEqual(state.moveItem(order, 2, 1), order)
  assert.deepEqual(order, ['a', 'b', 'c'])
})

test('字段固定 11 项，未识别值为空，显式校对 null 不回退 OCR', () => {
  needState()
  assert.equal(state.FIELDS.length, 11)
  const input = task()
  input.images[0].revision = { fields: { permitNumber: null, plateNumber: '校对车牌' } }
  const editor = state.createEditor(input)
  assert.equal(editor.fields['img-a'].permitNumber, null)
  assert.equal(editor.fields['img-a'].plateNumber, '校对车牌')
  assert.equal(editor.fields['img-a'].passRoute, null)
  assert.equal(state.isDirty(editor), false)
})

test('轮询合并新 OCR 不覆盖未保存字段、名称及顺序，也不修改 immutable 原文', () => {
  needState()
  const input = task()
  const original = JSON.stringify(input)
  let editor = state.createEditor(input)
  editor = state.editField(editor, 'img-a', 'permitNumber', '人工编号')
  editor = state.editName(editor, '本地任务名')
  editor = state.editOrder(editor, ['img-b', 'img-a'])
  const fresh = task('task-a', 2)
  fresh.images[0].original.fields.plateNumber = { value: '新识别车牌', source: null }
  editor = state.mergeTask(editor, fresh)
  assert.equal(editor.fields['img-a'].permitNumber, '人工编号')
  assert.equal(editor.fields['img-a'].plateNumber, '新识别车牌')
  assert.equal(editor.name, '本地任务名')
  assert.deepEqual(editor.order, ['img-b', 'img-a'])
  assert.equal(editor.baseVersion, 1)
  assert.equal(editor.task.version, 2)
  assert.equal(JSON.stringify(input), original)
})

test('无草稿时轮询推进版本，旧版本或其他任务不能覆盖当前任务', () => {
  needState()
  const editor = state.mergeTask(state.createEditor(task()), task('task-a', 3))
  assert.equal(editor.baseVersion, 3)
  assert.equal(state.mergeTask(editor, task('task-a', 2)), editor)
  assert.equal(state.mergeTask(editor, task('task-b', 5)), editor)
})

test('PATCH 仅包含校对增量，空值转 null，不包含原始 OCR', () => {
  needState()
  let editor = state.createEditor(task())
  editor = state.editField(editor, 'img-a', 'passRoute', '  ')
  editor = state.editField(editor, 'img-a', 'permitNumber', ' 新编号 ')
  editor = state.editName(editor, ' 新任务名 ')
  editor = state.editOrder(editor, ['img-b', 'img-a'])
  assert.deepEqual(state.buildPatch(editor), {
    version: 1, name: '新任务名', order: ['img-b', 'img-a'],
    revisions: [{ imageId: 'img-a', fields: { passRoute: null, permitNumber: '新编号' } }],
  })
  assert.throws(() => state.editField(editor, 'img-a', 'unknown', 'x'))
})

test('409 标记冲突保留草稿；显式恢复服务器快照才丢弃草稿', () => {
  needState()
  let editor = state.editField(state.createEditor(task()), 'img-a', 'permitNumber', '未保存')
  editor = state.markConflict(editor)
  assert.equal(editor.conflict, true)
  assert.equal(editor.fields['img-a'].permitNumber, '未保存')
  assert.equal(state.isDirty(editor), true)
  const restored = state.createEditor(task('task-a', 5))
  assert.equal(restored.fields['img-a'].permitNumber, '原始编号')
  assert.equal(restored.conflict, false)
  assert.equal(state.isDirty(restored), false)
})

test('请求门禁防止切换任务和同任务乱序响应覆盖当前结果', () => {
  needState()
  const gate = state.createRequestGate()
  const first = gate.begin('a')
  const second = gate.begin('b')
  assert.equal(gate.accepts(first, 'a'), false)
  assert.equal(gate.accepts(second, 'b'), true)
  const third = gate.begin('b')
  assert.equal(gate.accepts(second, 'b'), false)
  assert.equal(gate.accepts(third, 'b'), true)
  gate.invalidate()
  assert.equal(gate.accepts(third, 'b'), false)
})

test('成功图片不可重识别，仅失败图片可重试；可信度仅取真实有限数字', () => {
  needState()
  assert.equal(state.canRetry({ status: 'failed' }), true)
  for (const status of ['pending', 'queued', 'recognizing', 'succeeded']) assert.equal(state.canRetry({ status }), false)
  assert.equal(state.confidenceLabel({ confidence: null }), null)
  assert.equal(state.confidenceLabel({ confidence: '96' }), null)
  assert.equal(state.confidenceLabel({ confidence: NaN }), null)
  assert.equal(state.confidenceLabel({ confidence: 0 }), '0%')
  assert.equal(state.confidenceLabel({ confidence: 96.23 }), '96.2%')
})

test('浏览器存储仅写 lastTaskId，不序列化任何证件字段', () => {
  needState()
  const writes = []
  const storage = { setItem: (...args) => writes.push(args), removeItem: (key) => writes.push([key]), getItem: () => 'task-a' }
  state.rememberTask(storage, 'task-a')
  assert.deepEqual(writes, [['lastTaskId', 'task-a']])
  assert.equal(state.recallTask(storage), 'task-a')
  state.rememberTask(storage, null)
  assert.deepEqual(writes[1], ['lastTaskId'])
  assert.doesNotThrow(() => state.rememberTask({ setItem() { throw new Error('blocked') } }, 'task-a'))
})

test('创建请求按确认顺序使用 multipart，失败后复用同一个 UUID 幂等键', async () => {
  needApi()
  const calls = []
  const client = api.createApi(async (url, options) => {
    calls.push([url, options])
    if (calls.length === 1) throw new TypeError('offline')
    return new Response(JSON.stringify(task()), { status: 201 })
  })
  const files = [new File(['a'], '第二页.png', { type: 'image/png' }), new File(['b'], '第一页.jpg', { type: 'image/jpeg' })]
  const key = '369524c7-3029-4162-aa31-0a783a312e4d'
  await assert.rejects(client.createTask('任务', files, key), /本机服务/)
  const result = await client.createTask('任务', files, key)
  assert.equal(result.id, 'task-a')
  for (const [url, options] of calls) {
    assert.equal(url, '/api/tasks')
    assert.equal(options.headers['Idempotency-Key'], key)
    assert.equal(options.headers['Content-Type'], undefined)
    assert.deepEqual(options.body.getAll('files').map((item) => item.name), ['第二页.png', '第一页.jpg'])
    assert.equal(options.body.get('name'), '任务')
    assert.equal(options.credentials, 'same-origin')
  }
})

test('API 严格使用固定端点及版本 JSON，删除 204 不解析 JSON', async () => {
  needApi()
  const calls = []
  const client = api.createApi(async (url, options) => {
    calls.push([url, options])
    return options.method === 'DELETE' ? new Response(null, { status: 204 }) : new Response(JSON.stringify(task()))
  })
  await client.health()
  await client.listTasks()
  await client.getTask('a/b')
  await client.recognize('a', 3)
  await client.retryImage('a', 'i/b', 4)
  await client.patchTask('a', { version: 5, name: '校对' })
  assert.equal(await client.deleteTask('a', 6), null)
  assert.deepEqual(calls.map(([url]) => url), ['/api/health', '/api/tasks', '/api/tasks/a%2Fb', '/api/tasks/a/recognize', '/api/tasks/a/images/i%2Fb/retry', '/api/tasks/a', '/api/tasks/a'])
  assert.deepEqual(JSON.parse(calls[3][1].body), { version: 3 })
  assert.deepEqual(JSON.parse(calls[4][1].body), { version: 4 })
  assert.deepEqual(JSON.parse(calls[6][1].body), { version: 6 })
  assert.equal(client.imageUrl('a/b', 'i/b'), '/api/tasks/a%2Fb/images/i%2Fb/file')
})

test('API 保留 409 状态及错误码，拒绝空结果并处理非 JSON 错误', async () => {
  needApi()
  const conflict = api.createApi(async () => new Response(JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: '版本已更新' } }), { status: 409 }))
  await assert.rejects(conflict.patchTask('a', { version: 1 }), (error) => error.status === 409 && error.code === 'VERSION_CONFLICT' && error.message === '版本已更新')
  const empty = api.createApi(async () => new Response('null'))
  await assert.rejects(empty.getTask('a'), /空/)
  const failure = api.createApi(async () => new Response('<html>bad gateway</html>', { status: 502 }))
  await assert.rejects(failure.getTask('a'), (error) => error.status === 502 && !error.message.includes('<html>'))
})
