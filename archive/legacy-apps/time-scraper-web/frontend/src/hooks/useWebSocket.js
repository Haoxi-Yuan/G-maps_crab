import { useRef, useCallback } from 'react';
import { io } from 'socket.io-client';

const WS_URL = import.meta.env.VITE_WS_URL || 'http://localhost:3000';

export function useWebSocket() {
  const socket = useRef(null);
  const listeners = useRef({});
  const currentTaskId = useRef(null);
  const connectionCallbacks = useRef([]);

  const notifyConnectionChange = useCallback((connected) => {
    connectionCallbacks.current.forEach(cb => cb(connected));
  }, []);

  const connect = useCallback((taskId) => {
    if (socket.current?.connected && currentTaskId.current === taskId) {
      return;
    }

    if (socket.current) {
      socket.current.disconnect();
    }

    currentTaskId.current = taskId;

    socket.current = io(WS_URL, {
      query: { taskId },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity
    });

    socket.current.on('connect', () => {
      console.log('[WebSocket] Connected to task:', taskId);
      socket.current.emit('subscribe', { taskId });
      notifyConnectionChange(true);
    });

    socket.current.on('disconnect', () => {
      console.log('[WebSocket] Disconnected');
      notifyConnectionChange(false);
    });

    socket.current.on('reconnect', () => {
      console.log('[WebSocket] Reconnected');
      socket.current.emit('subscribe', { taskId: currentTaskId.current });
      notifyConnectionChange(true);
    });

    socket.current.onAny((event, data) => {
      const callbacks = listeners.current[event] || [];
      callbacks.forEach(callback => callback(data));
    });
  }, [notifyConnectionChange]);

  const disconnect = useCallback(() => {
    if (socket.current) {
      socket.current.emit('unsubscribe', { taskId: currentTaskId.current });
      socket.current.disconnect();
      socket.current = null;
    }
    listeners.current = {};
    currentTaskId.current = null;
  }, []);

  const subscribe = useCallback((event, callback) => {
    if (!listeners.current[event]) {
      listeners.current[event] = [];
    }
    listeners.current[event].push(callback);

    return () => {
      listeners.current[event] = listeners.current[event].filter(
        cb => cb !== callback
      );
    };
  }, []);

  const emit = useCallback((event, data) => {
    if (socket.current?.connected) {
      socket.current.emit(event, data);
    }
  }, []);

  const onConnectionChange = useCallback((callback) => {
    connectionCallbacks.current.push(callback);
    return () => {
      connectionCallbacks.current = connectionCallbacks.current.filter(
        cb => cb !== callback
      );
    };
  }, []);

  return { connect, disconnect, subscribe, emit, onConnectionChange };
}
