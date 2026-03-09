import { io } from 'socket.io-client';
import { api } from './api.js';

const SOCKET_URL = window.location.hostname === 'localhost'
    ? 'http://localhost:3001'
    : window.location.origin;

let socket = null;
const listeners = new Map();

export function connectSocket() {
    const token = api.getToken();
    if (!token || socket?.connected) return;

    socket = io(SOCKET_URL, {
        auth: { token },
        transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => {
        console.log('🔌 Socket connected');
    });

    socket.on('disconnect', () => {
        console.log('🔌 Socket disconnected');
    });

    socket.on('execution:update', (data) => {
        const callbacks = listeners.get('execution:update') || [];
        callbacks.forEach((cb) => cb(data));
    });

    socket.on('job:update', (data) => {
        const callbacks = listeners.get('job:update') || [];
        callbacks.forEach((cb) => cb(data));
    });
}

export function disconnectSocket() {
    socket?.disconnect();
    socket = null;
}

export function joinExecution(executionId) {
    socket?.emit('join:execution', executionId);
}

export function leaveExecution(executionId) {
    socket?.emit('leave:execution', executionId);
}

export function joinBatch(batchId) {
    socket?.emit('join:batch', batchId);
}

export function leaveBatch(batchId) {
    socket?.emit('leave:batch', batchId);
}

export function onExecutionUpdate(callback) {
    const key = 'execution:update';
    const callbacks = listeners.get(key) || [];
    callbacks.push(callback);
    listeners.set(key, callbacks);

    return () => {
        const cbs = listeners.get(key) || [];
        listeners.set(key, cbs.filter((cb) => cb !== callback));
    };
}

export function onJobUpdate(callback) {
    const key = 'job:update';
    const callbacks = listeners.get(key) || [];
    callbacks.push(callback);
    listeners.set(key, callbacks);

    return () => {
        const cbs = listeners.get(key) || [];
        listeners.set(key, cbs.filter((cb) => cb !== callback));
    };
}

