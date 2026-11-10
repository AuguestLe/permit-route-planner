export class ApiError extends Error {
  constructor(message, status = 0, code = 'NETWORK_ERROR') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export function createApi(fetcher = globalThis.fetch.bind(globalThis)) {
  const segment = (value) => encodeURIComponent(value)
  const taskPath = (id) => `/api/tasks/${segment(id)}`
  async function request(path, { method = 'GET', body, headers = {}, signal } = {}) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 60_000)
    const abort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const isForm = body instanceof FormData
      const response = await fetcher(path, {
        method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body == null ? undefined : isForm ? body : JSON.stringify(body),
      })
      if (response.status === 204) return null
      let data
      try { data = await response.json() } catch { data = null }
      if (!response.ok) throw new ApiError(data?.error?.message || `本机服务请求失败（${response.status}），请重试。`, response.status, data?.error?.code || 'HTTP_ERROR')
      if (data == null) throw new ApiError('本机服务返回空结果，请刷新重试。', response.status, 'EMPTY_RESPONSE')
      return data
    } catch (error) {
      if (error instanceof ApiError) throw error
      if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError')
      throw new ApiError('无法连接本机服务或请求超时，请检查服务后重试。')
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  }
  return {
    health: () => request('/api/health'),
    listTasks: () => request('/api/tasks'),
    getTask: (id, signal) => request(taskPath(id), { signal }),
    createTask(name, files, key) {
      const body = new FormData()
      body.append('name', name.trim())
      files.forEach((file) => body.append('files', file, file.name))
      return request('/api/tasks', { method: 'POST', body, headers: { 'Idempotency-Key': key } })
    },
    recognize: (id, version) => request(`${taskPath(id)}/recognize`, { method: 'POST', body: { version } }),
    retryImage: (id, imageId, version) => request(`${taskPath(id)}/images/${segment(imageId)}/retry`, { method: 'POST', body: { version } }),
    patchTask: (id, patch) => request(taskPath(id), { method: 'PATCH', body: patch }),
    deleteTask: (id, version) => request(taskPath(id), { method: 'DELETE', body: { version } }),
    imageUrl: (id, imageId) => `${taskPath(id)}/images/${segment(imageId)}/file`,
  }
}

export const api = createApi()
