const API_BASE = import.meta.env.VITE_API_URL || '/api';

async function request(endpoint, options = {}) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || 'Request failed');
  }

  return response.json();
}

export default {
  getTasks: () => request('/tasks'),

  getTask: (taskId) => request(`/tasks/${taskId}`),

  createTask: (config) => request('/tasks', {
    method: 'POST',
    body: JSON.stringify({ config })
  }),

  startTask: (taskId) => request(`/tasks/${taskId}/start`, {
    method: 'POST'
  }),

  pauseTask: (taskId) => request(`/tasks/${taskId}/pause`, {
    method: 'POST'
  }),

  resumeTask: (taskId) => request(`/tasks/${taskId}/resume`, {
    method: 'POST'
  }),

  stopTask: (taskId) => request(`/tasks/${taskId}/stop`, {
    method: 'POST'
  }),

  deleteTask: (taskId) => request(`/tasks/${taskId}`, {
    method: 'DELETE'
  }),

  convertToJSON: (taskId) => request(`/tasks/${taskId}/convert-to-json`, {
    method: 'POST'
  }),

  resumeFromCheckpoint: (taskId) => request(`/tasks/${taskId}/resume-from-checkpoint`, {
    method: 'POST'
  }),

  getRunningTasks: () => request('/tasks?status=running,paused'),

  browseFiles: (path) => request(`/files/browse?path=${encodeURIComponent(path || '')}`),

  getSharedFiles: () => request('/files/shared'),

  previewFile: (path) => request(`/files/preview?path=${encodeURIComponent(path)}`),

  getCategories: () => request('/files/categories'),

  // Parallel splitting APIs
  countItems: (filePath, mode) => request('/files/count-items', {
    method: 'POST',
    body: JSON.stringify({ filePath, mode })
  }),

  createParallelTasks: (config, splitCount) => request('/tasks/create-parallel', {
    method: 'POST',
    body: JSON.stringify({ config, splitCount })
  }),

  startParallelTasks: (taskIds) => request('/tasks/start-parallel', {
    method: 'POST',
    body: JSON.stringify({ taskIds })
  }),

  getTaskGroup: (groupId) => request(`/tasks/group/${groupId}`),

  stopTaskGroup: (groupId) => request(`/tasks/group/${groupId}/stop`, {
    method: 'POST'
  }),

  deleteTaskGroup: (groupId) => request(`/tasks/group/${groupId}`, {
    method: 'DELETE'
  }),

  // City generator APIs (SSE streaming)
  generateCity: (params, onProgress) => {
    const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';
    return new Promise((resolve, reject) => {
      fetch(`${API_BASE_URL}/generator/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      }).then(response => {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        function read() {
          reader.read().then(({ done, value }) => {
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              try {
                const evt = JSON.parse(line.slice(6));
                if (evt.type === 'progress' && onProgress) {
                  onProgress(evt);
                } else if (evt.type === 'complete') {
                  resolve(evt);
                } else if (evt.type === 'error') {
                  reject(new Error(evt.message));
                }
              } catch {}
            }
            read();
          }).catch(reject);
        }
        read();
      }).catch(reject);
    });
  },

  getGeneratorData: (cityDir) => request(`/generator/data/${encodeURIComponent(cityDir)}`),

  getGeneratorCities: () => request('/generator/cities'),

  // Search → Scrape bridging
  createScrapeFromSearch: (searchTaskId, scrapeConfig) => request('/tasks/create-from-search', {
    method: 'POST',
    body: JSON.stringify({ searchTaskId, scrapeConfig })
  }),

  // Monitor APIs
  getMonitorCheckpoint: () => request('/monitor/checkpoint'),
  getMonitorMeta: () => request('/monitor/meta'),
  getMonitorStats: (city) => request(`/monitor/stats${city ? `?city=${encodeURIComponent(city)}` : ''}`),
  getMonitorScans: (limit, city) => {
    const query = [
      limit ? `limit=${encodeURIComponent(limit)}` : '',
      city ? `city=${encodeURIComponent(city)}` : ''
    ].filter(Boolean).join('&');
    return request(`/monitor/scans${query ? `?${query}` : ''}`);
  },
  getMonitorScanDetail: (scanId) => request(`/monitor/scans/${scanId}`),
  getMonitorChanges: (page, limit, city) => request(`/monitor/changes?${[
    `page=${page || 1}`,
    `limit=${limit || 50}`,
    city ? `city=${encodeURIComponent(city)}` : ''
  ].filter(Boolean).join('&')}`),
  startMonitorScan: (config) => request('/monitor/scan', { method: 'POST', body: JSON.stringify(config || {}) }),
  startMonitorImport: (config) => request('/monitor/import', { method: 'POST', body: JSON.stringify(config) }),
  startMonitorDiscover: (config) => request('/monitor/discover', { method: 'POST', body: JSON.stringify(config) }),
  getMonitorReport: (scanId) => request(`/monitor/report/${scanId}`),
  getMonitorReportDownloadUrl: (scanId) => `${API_BASE}/monitor/report/${scanId}/download`,
  getMonitorPlaceIdsDownloadUrl: (scanId) => `${API_BASE}/monitor/report/${scanId}/placeids`,

  // Monitor task management
  getMonitorTasks: (status) => request(`/monitor/tasks${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  resumeMonitorTask: (taskId) => request(`/monitor/tasks/${taskId}/resume`, { method: 'POST' }),
  stopMonitorTask: (taskId) => request(`/monitor/tasks/${taskId}/stop`, { method: 'POST' })
};
