const { Server } = require('socket.io');

class WebSocketManager {
  constructor() {
    this.io = null;
    this.taskSubscriptions = new Map();
  }

  initialize(httpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST']
      },
      transports: ['websocket', 'polling']
    });

    this.io.on('connection', (socket) => {
      console.log('[WebSocket] Client connected:', socket.id);

      socket.on('subscribe', ({ taskId }) => {
        if (!taskId) return;

        socket.join(taskId);

        if (!this.taskSubscriptions.has(taskId)) {
          this.taskSubscriptions.set(taskId, new Set());
        }
        this.taskSubscriptions.get(taskId).add(socket.id);

        console.log(`[WebSocket] Client ${socket.id} subscribed to task ${taskId}`);
      });

      socket.on('unsubscribe', ({ taskId }) => {
        if (!taskId) return;

        socket.leave(taskId);

        if (this.taskSubscriptions.has(taskId)) {
          this.taskSubscriptions.get(taskId).delete(socket.id);
          if (this.taskSubscriptions.get(taskId).size === 0) {
            this.taskSubscriptions.delete(taskId);
          }
        }

        console.log(`[WebSocket] Client ${socket.id} unsubscribed from task ${taskId}`);
      });

      socket.on('disconnect', () => {
        this.taskSubscriptions.forEach((subscribers, taskId) => {
          if (subscribers.has(socket.id)) {
            subscribers.delete(socket.id);
            if (subscribers.size === 0) {
              this.taskSubscriptions.delete(taskId);
            }
          }
        });
        console.log('[WebSocket] Client disconnected:', socket.id);
      });
    });

    console.log('[WebSocket] Server initialized');
  }

  emit(taskId, event, data) {
    if (!this.io) {
      console.warn('[WebSocket] Socket.io not initialized');
      return;
    }

    this.io.to(taskId).emit(event, {
      ...data,
      timestamp: data.timestamp || Date.now()
    });
  }

  broadcast(event, data) {
    if (!this.io) {
      console.warn('[WebSocket] Socket.io not initialized');
      return;
    }

    this.io.emit(event, {
      ...data,
      timestamp: data.timestamp || Date.now()
    });
  }

  getSubscriberCount(taskId) {
    return this.taskSubscriptions.get(taskId)?.size || 0;
  }

  getAllSubscriptions() {
    const result = {};
    this.taskSubscriptions.forEach((subscribers, taskId) => {
      result[taskId] = subscribers.size;
    });
    return result;
  }
}

module.exports = new WebSocketManager();
