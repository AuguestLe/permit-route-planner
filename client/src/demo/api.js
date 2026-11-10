import { ApiError } from '../api.js';

function segment(value) {
  return encodeURIComponent(value);
}

export function createDemoApi(fetcher = globalThis.fetch.bind(globalThis)) {
  const recordPath = id => `/api/demo/records/${segment(id)}`;
  async function request(path, { method = 'GET', body, headers = {}, signal } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const isForm = body instanceof FormData;
      const response = await fetcher(path, {
        method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body == null ? undefined : isForm ? body : JSON.stringify(body),
      });
      if (response.status === 204) return null;
      let data;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) throw new ApiError(data?.error?.message || `Demo 服务请求失败（${response.status}）。`, response.status, data?.error?.code || 'HTTP_ERROR');
      if (data == null) throw new ApiError('Demo 服务返回空结果。', response.status, 'EMPTY_RESPONSE');
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
      throw new ApiError('无法连接 Demo 服务或请求超时。');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  return {
    health: () => request('/api/demo/health'),
    samples: () => request('/api/demo/samples'),
    records: () => request('/api/demo/records'),
    record: id => request(recordPath(id)),
    reports: () => request('/api/demo/reports'),
    report: runId => request(`/api/demo/reports/${segment(runId)}`),
    createRecord(sampleId, file) {
      const body = new FormData();
      body.append('sampleId', sampleId);
      body.append('file', file, file.name);
      return request('/api/demo/records', { method: 'POST', body });
    },
    runRecord: (id, body) => request(`${recordPath(id)}/run`, { method: 'POST', body }),
    reviewRecord: (id, body) => request(`${recordPath(id)}/review`, { method: 'PATCH', body }),
    deleteRecord: (id, version) => request(recordPath(id), { method: 'DELETE', body: { version } }),
    sampleFileUrl: sampleId => `/api/demo/samples/${segment(sampleId)}/file`,
    imageUrl: id => `${recordPath(id)}/file`,
    reportExportUrl: (runId, format) => `/api/demo/reports/${segment(runId)}/export?format=${segment(format)}`,
  };
}

export const demoApi = createDemoApi();
