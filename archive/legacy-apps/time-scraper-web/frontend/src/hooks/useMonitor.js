import { useReducer, useEffect, useCallback, useRef } from 'react';
import api from '../services/api';

const initialState = {
  stats: null,
  scans: [],
  changes: { changes: [], total: 0, page: 1, totalPages: 0 },
  selectedScan: null,
  loading: false,
  error: null,
  toast: null,
  meta: {
    defaultCity: 'Singapore',
    defaultBaselineSource: '',
    autoBootstrapOnEmpty: false
  },
  selectedCity: '',
  availableCities: [],
  // Monitor task tracking
  scanTask: null, // Latest monitor-scan task { task_id, status, progress, stats, ... }
  checkpoint: null, // Best available checkpoint for resume { lastIndex, scanId, stats, ... }
  checkpoints: [] // All available checkpoints sorted by lastIndex desc
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_STATS':
      return { ...state, stats: action.payload };
    case 'SET_SCANS':
      return { ...state, scans: action.payload };
    case 'SET_CHANGES':
      return { ...state, changes: action.payload };
    case 'SET_SELECTED_SCAN':
      return { ...state, selectedScan: action.payload };
    case 'SET_LOADING':
      return { ...state, loading: action.payload };
    case 'SET_ERROR':
      return { ...state, error: action.payload, toast: action.payload ? { level: 'error', message: action.payload } : null };
    case 'SET_TOAST':
      return { ...state, toast: action.payload };
    case 'CLEAR_TOAST':
      return { ...state, toast: null };
    case 'SET_META':
      return { ...state, meta: { ...state.meta, ...action.payload } };
    case 'SET_AVAILABLE_CITIES':
      return { ...state, availableCities: action.payload || [] };
    case 'SET_SELECTED_CITY':
      return { ...state, selectedCity: action.payload || state.meta.defaultCity || 'Singapore' };
    case 'SET_SELECTED_CITY_IF_EMPTY':
      return state.selectedCity ? state : { ...state, selectedCity: action.payload || 'Singapore' };
    case 'SET_SCAN_TASK':
      return { ...state, scanTask: action.payload };
    case 'SET_CHECKPOINT':
      return { ...state, checkpoint: action.payload?.best || null, checkpoints: action.payload?.all || [] };
    default:
      return state;
  }
}

export function useMonitor() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const pollRef = useRef(null);
  const autoBootstrapRef = useRef(false);

  const loadMeta = useCallback(async () => {
    try {
      const res = await api.getMonitorMeta();
      if (!res.success) return;
      dispatch({
        type: 'SET_META',
        payload: {
          defaultCity: res.defaultCity || 'Singapore',
          defaultBaselineSource: res.defaultBaselineSource || '',
          autoBootstrapOnEmpty: !!res.autoBootstrapOnEmpty
        }
      });
      dispatch({ type: 'SET_AVAILABLE_CITIES', payload: res.availableCities || [] });
      dispatch({ type: 'SET_SELECTED_CITY_IF_EMPTY', payload: res.defaultCity || 'Singapore' });
    } catch (err) {
      // Silently fail
    }
  }, []);

  const loadStats = useCallback(async (city = state.selectedCity) => {
    try {
      const res = await api.getMonitorStats(city);
      if (res.success) dispatch({ type: 'SET_STATS', payload: res.stats });
    } catch (err) {
      // Silently fail on stats polling
    }
  }, [state.selectedCity]);

  const loadScans = useCallback(async (city = state.selectedCity) => {
    try {
      const res = await api.getMonitorScans(20, city);
      if (res.success) dispatch({ type: 'SET_SCANS', payload: res.scans });
    } catch (err) {
      // Silently fail
    }
  }, [state.selectedCity]);

  const loadChanges = useCallback(async (page = 1, city = state.selectedCity) => {
    try {
      const res = await api.getMonitorChanges(page, 50, city);
      if (res.success) dispatch({ type: 'SET_CHANGES', payload: res });
    } catch (err) {
      dispatch({ type: 'SET_ERROR', payload: err.message });
    }
  }, [state.selectedCity]);

  // Load latest monitor-scan task (any status)
  const loadScanTask = useCallback(async () => {
    try {
      const res = await api.getMonitorTasks();
      if (!res.success) return;
      // Find latest monitor-scan task (first in list, already sorted by created_at desc)
      const scanTask = (res.tasks || []).find(t => {
        const config = typeof t.config === 'string' ? JSON.parse(t.config) : t.config;
        return config?.taskType === 'monitor-scan';
      });
      dispatch({ type: 'SET_SCAN_TASK', payload: scanTask || null });
    } catch {
      // Silently fail
    }
  }, []);

  // Load available checkpoints from output directory
  const loadCheckpoint = useCallback(async () => {
    try {
      const res = await api.getMonitorCheckpoint();
      if (res.success) {
        dispatch({ type: 'SET_CHECKPOINT', payload: { best: res.checkpoint, all: res.checkpoints || [] } });
      }
    } catch {
      // Silently fail
    }
  }, []);

  const setSelectedCity = useCallback((city) => {
    dispatch({ type: 'SET_SELECTED_CITY', payload: city });
    dispatch({ type: 'SET_SELECTED_SCAN', payload: null });
  }, []);

  const selectScan = useCallback(async (scanId) => {
    if (!scanId) {
      dispatch({ type: 'SET_SELECTED_SCAN', payload: null });
      return;
    }
    try {
      dispatch({ type: 'SET_LOADING', payload: true });
      const res = await api.getMonitorScanDetail(scanId);
      if (res.success) dispatch({ type: 'SET_SELECTED_SCAN', payload: res.scan });
    } catch (err) {
      dispatch({ type: 'SET_ERROR', payload: err.message });
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, []);

  const startScan = useCallback(async (config) => {
    try {
      dispatch({ type: 'SET_LOADING', payload: true });
      const payload = { ...(config || {}), city: config?.city || state.selectedCity };
      const res = await api.startMonitorScan(payload);
      if (res.success) {
        dispatch({ type: 'SET_TOAST', payload: { level: 'success', message: `Scan started (task: ${res.taskId})` } });
        loadScanTask();
        loadCheckpoint();
        return res.taskId;
      }
    } catch (err) {
      dispatch({ type: 'SET_ERROR', payload: err.message });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
    return null;
  }, [state.selectedCity, loadScanTask, loadCheckpoint]);

  const resumeScanTask = useCallback(async () => {
    if (!state.scanTask) return null;
    try {
      dispatch({ type: 'SET_LOADING', payload: true });
      const res = await api.resumeMonitorTask(state.scanTask.task_id);
      if (res.success) {
        dispatch({ type: 'SET_TOAST', payload: { level: 'success', message: `Scan resumed (task: ${state.scanTask.task_id})` } });
        loadScanTask();
        return state.scanTask.task_id;
      }
    } catch (err) {
      dispatch({ type: 'SET_ERROR', payload: err.message });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
    return null;
  }, [state.scanTask, loadScanTask]);

  // Resume from existing checkpoint (creates new task with resume=true)
  const resumeFromCheckpoint = useCallback(async () => {
    try {
      dispatch({ type: 'SET_LOADING', payload: true });
      const payload = { resume: true, city: state.selectedCity };
      const res = await api.startMonitorScan(payload);
      if (res.success) {
        dispatch({ type: 'SET_TOAST', payload: { level: 'success', message: `Scan resumed from checkpoint (task: ${res.taskId})` } });
        loadScanTask();
        loadCheckpoint();
        return res.taskId;
      }
    } catch (err) {
      dispatch({ type: 'SET_ERROR', payload: err.message });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
    return null;
  }, [state.selectedCity, loadScanTask, loadCheckpoint]);

  const stopScanTask = useCallback(async () => {
    if (!state.scanTask) return;
    try {
      dispatch({ type: 'SET_LOADING', payload: true });
      await api.stopMonitorTask(state.scanTask.task_id);
      dispatch({ type: 'SET_TOAST', payload: { level: 'success', message: 'Scan stopped' } });
      loadScanTask();
      loadCheckpoint();
    } catch (err) {
      dispatch({ type: 'SET_ERROR', payload: err.message });
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [state.scanTask, loadScanTask, loadCheckpoint]);

  const startImport = useCallback(async (config) => {
    try {
      dispatch({ type: 'SET_LOADING', payload: true });
      const payload = { ...(config || {}), city: config?.city || state.selectedCity };
      const res = await api.startMonitorImport(payload);
      if (res.success) {
        dispatch({ type: 'SET_TOAST', payload: { level: 'success', message: `Import started (task: ${res.taskId})` } });
        return res.taskId;
      }
    } catch (err) {
      dispatch({ type: 'SET_ERROR', payload: err.message });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
    return null;
  }, [state.selectedCity]);

  const startDiscover = useCallback(async (config) => {
    try {
      dispatch({ type: 'SET_LOADING', payload: true });
      const payload = { ...(config || {}), city: config?.city || state.selectedCity };
      const res = await api.startMonitorDiscover(payload);
      if (res.success) {
        dispatch({ type: 'SET_TOAST', payload: { level: 'success', message: `Discovery started (task: ${res.taskId})` } });
        return res.taskId;
      }
    } catch (err) {
      dispatch({ type: 'SET_ERROR', payload: err.message });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
    return null;
  }, [state.selectedCity]);

  const clearToast = useCallback(() => {
    dispatch({ type: 'CLEAR_TOAST' });
  }, []);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    loadStats(state.selectedCity);
    loadScans(state.selectedCity);
    loadChanges(1, state.selectedCity);
    loadScanTask();
    loadCheckpoint();

    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      loadStats(state.selectedCity);
      loadScans(state.selectedCity);
      loadScanTask();
    }, 10000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [state.selectedCity, loadStats, loadScans, loadChanges, loadScanTask, loadCheckpoint]);

  useEffect(() => {
    if (autoBootstrapRef.current) return;
    if (!state.meta.autoBootstrapOnEmpty) return;
    if (!state.meta.defaultBaselineSource) return;
    if (state.loading) return;
    if (state.stats && state.stats.totalPois > 0) return;

    autoBootstrapRef.current = true;
    startImport({
      source: state.meta.defaultBaselineSource,
      format: 'auto',
      city: state.selectedCity
    });
  }, [state.meta, state.stats, state.loading, state.selectedCity, startImport]);

  return {
    ...state,
    loadMeta,
    loadStats,
    loadScans,
    loadChanges,
    loadScanTask,
    loadCheckpoint,
    setSelectedCity,
    selectScan,
    startScan,
    resumeScanTask,
    resumeFromCheckpoint,
    stopScanTask,
    startImport,
    startDiscover,
    clearToast
  };
}
