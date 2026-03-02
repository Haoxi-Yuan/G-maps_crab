import { useEffect, useState, useRef, useCallback } from 'react';
import { useWebSocket } from './useWebSocket';
import api from '../services/api';

// Polling interval when WebSocket is healthy (fallback sync)
const POLL_INTERVAL_NORMAL = 10000; // 10s
// Polling interval when WebSocket is disconnected
const POLL_INTERVAL_DISCONNECTED = 3000; // 3s

export function useTask(taskId) {
  const [task, setTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const { connect, disconnect, subscribe, onConnectionChange } = useWebSocket();
  const wsConnected = useRef(false);
  const pollTimer = useRef(null);

  // Fetch latest task state from API
  const refreshTask = useCallback(async () => {
    if (!taskId) return;
    try {
      const data = await api.getTask(taskId);
      if (data.task) {
        setTask(prev => {
          // Merge: keep locally accumulated logs, update everything else
          const merged = { ...data.task };
          // Parse stats if it's a JSON string from DB
          if (typeof merged.stats === 'string') {
            try { merged.stats = JSON.parse(merged.stats); } catch (e) {}
          }
          // Build progress object from DB fields if not present
          if (!merged.progress && merged.progress_current != null) {
            merged.progress = {
              current: merged.progress_current,
              total: merged.progress_total,
              percentage: merged.progress_total > 0
                ? Math.round((merged.progress_current / merged.progress_total) * 100)
                : 0
            };
          }
          return merged;
        });
      }
    } catch (err) {
      // Silently ignore poll failures
    }
  }, [taskId]);

  // Start/restart polling with given interval
  const startPolling = useCallback((interval) => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = setInterval(refreshTask, interval);
  }, [refreshTask]);

  useEffect(() => {
    if (!taskId) {
      setLoading(false);
      return;
    }

    // Initial fetch
    refreshTask().then(() => setLoading(false));

    // Connect WebSocket
    connect(taskId);

    // Track connection state and adjust polling
    const unsubConnection = onConnectionChange((connected) => {
      wsConnected.current = connected;
      if (connected) {
        // WebSocket is up: refresh state immediately (catch up), then slow poll
        refreshTask();
        startPolling(POLL_INTERVAL_NORMAL);
      } else {
        // WebSocket is down: poll faster as fallback
        startPolling(POLL_INTERVAL_DISCONNECTED);
      }
    });

    // Start default polling
    startPolling(POLL_INTERVAL_NORMAL);

    // WebSocket event handlers (real-time updates)
    const unsubProgress = subscribe('progress', (data) => {
      setTask(prev => ({
        ...prev,
        progress: {
          ...prev?.progress,
          ...data,
          percentage: data.total > 0
            ? Math.round((data.current / data.total) * 100)
            : (prev?.progress?.percentage || 0)
        }
      }));
    });

    const unsubLog = subscribe('log', (log) => {
      setTask(prev => ({
        ...prev,
        logs: [...(prev?.logs || []).slice(-199), log]
      }));
    });

    const unsubStatus = subscribe('status', (data) => {
      setTask(prev => ({
        ...prev,
        status: data.status,
        current_place: data.current_place,
        error: data.error
      }));
      // Status change is significant — refresh full state
      refreshTask();
    });

    const unsubStats = subscribe('stats', (data) => {
      setTask(prev => ({
        ...prev,
        stats: data
      }));
    });

    return () => {
      unsubProgress();
      unsubLog();
      unsubStatus();
      unsubStats();
      unsubConnection();
      disconnect();
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [taskId]);

  const start = async () => {
    try {
      await api.startTask(taskId);
      refreshTask();
    } catch (err) {
      console.error('Failed to start task:', err);
    }
  };

  const pause = async () => {
    try {
      await api.pauseTask(taskId);
      refreshTask();
    } catch (err) {
      console.error('Failed to pause task:', err);
    }
  };

  const resume = async () => {
    try {
      await api.resumeTask(taskId);
      refreshTask();
    } catch (err) {
      console.error('Failed to resume task:', err);
    }
  };

  const stop = async () => {
    try {
      await api.stopTask(taskId);
      refreshTask();
    } catch (err) {
      console.error('Failed to stop task:', err);
    }
  };

  const deleteTask = async () => {
    try {
      await api.deleteTask(taskId);
      return true;
    } catch (err) {
      console.error('Failed to delete task:', err);
      throw err;
    }
  };

  return { task, loading, start, pause, resume, stop, deleteTask };
}
