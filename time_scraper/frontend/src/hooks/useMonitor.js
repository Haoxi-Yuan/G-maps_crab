import { useReducer, useEffect, useCallback, useRef } from 'react';
import api from '../services/api';

const initialState = {
  stats: null,
  scans: [],
  changes: { changes: [], total: 0, page: 1, totalPages: 0 },
  selectedScan: null,
  loading: false,
  error: null,
  toast: null
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
    default:
      return state;
  }
}

export function useMonitor() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const pollRef = useRef(null);

  const loadStats = useCallback(async () => {
    try {
      const res = await api.getMonitorStats();
      if (res.success) dispatch({ type: 'SET_STATS', payload: res.stats });
    } catch (err) {
      // Silently fail on stats polling
    }
  }, []);

  const loadScans = useCallback(async () => {
    try {
      const res = await api.getMonitorScans(20);
      if (res.success) dispatch({ type: 'SET_SCANS', payload: res.scans });
    } catch (err) {
      // Silently fail
    }
  }, []);

  const loadChanges = useCallback(async (page = 1) => {
    try {
      const res = await api.getMonitorChanges(page, 50);
      if (res.success) dispatch({ type: 'SET_CHANGES', payload: res });
    } catch (err) {
      dispatch({ type: 'SET_ERROR', payload: err.message });
    }
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
      const res = await api.startMonitorScan(config);
      if (res.success) {
        dispatch({ type: 'SET_TOAST', payload: { level: 'success', message: `Scan started (task: ${res.taskId})` } });
        return res.taskId;
      }
    } catch (err) {
      dispatch({ type: 'SET_ERROR', payload: err.message });
      return null;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, []);

  const startImport = useCallback(async (config) => {
    try {
      dispatch({ type: 'SET_LOADING', payload: true });
      const res = await api.startMonitorImport(config);
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
  }, []);

  const startDiscover = useCallback(async (config) => {
    try {
      dispatch({ type: 'SET_LOADING', payload: true });
      const res = await api.startMonitorDiscover(config);
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
  }, []);

  const clearToast = useCallback(() => {
    dispatch({ type: 'CLEAR_TOAST' });
  }, []);

  // Poll stats and scans
  useEffect(() => {
    loadStats();
    loadScans();
    loadChanges();

    pollRef.current = setInterval(() => {
      loadStats();
      loadScans();
    }, 10000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadStats, loadScans, loadChanges]);

  return {
    ...state,
    loadStats,
    loadScans,
    loadChanges,
    selectScan,
    startScan,
    startImport,
    startDiscover,
    clearToast
  };
}
