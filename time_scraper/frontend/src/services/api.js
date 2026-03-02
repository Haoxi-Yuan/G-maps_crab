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
  })
};
