import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { mkdir } from 'fs/promises';

import authRoutes from './routes/auth.routes.js';
import workflowRoutes from './routes/workflow.routes.js';
import credentialRoutes from './routes/credential.routes.js';
import executionRoutes from './routes/execution.routes.js';
import uploadRoutes from './routes/upload.routes.js';
import chatgptAuthRoutes from './routes/chatgpt-auth.routes.js';
import credentialCheckRoutes from './routes/credential-check.routes.js';
import jobRoutes from './routes/job.routes.js';
import telegramRoutes from './routes/telegram.routes.js';
import adminRoutes from './routes/admin.routes.js';
import { authMiddleware } from './middleware/auth.middleware.js';
import { requireAdmin } from './middleware/role.middleware.js';
import { errorHandler } from './middleware/error.middleware.js';

const app = express();
const httpServer = createServer(app);

// Prisma client
export const prisma = new PrismaClient();

// Socket.IO
export const io = new SocketIOServer(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    credentials: true,
  },
});

// Middleware
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests from: localhost client, Chrome extensions, and no-origin (server-to-server)
    if (!origin || origin.startsWith('http://localhost') || origin.startsWith('chrome-extension://')) {
      callback(null, true);
    } else {
      callback(null, true); // Allow all for now (dev mode)
    }
  },
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());

// Ensure upload directory exists
const uploadDir = process.env.UPLOAD_DIR || './uploads';
await mkdir(uploadDir, { recursive: true });

// Serve uploaded files
app.use('/uploads', express.static(uploadDir));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Public routes
app.use('/api/auth', authRoutes);
// Telegram webhook — must be public (Telegram POSTs here, no auth)
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const { bot } = await import('./services/telegram-bot.js');
    if (bot) await bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error('[Telegram] Webhook error:', err.message);
    res.sendStatus(200);
  }
});

// Protected routes
app.use('/api/workflows', authMiddleware, workflowRoutes);
app.use('/api/credentials', authMiddleware, credentialRoutes);
app.use('/api/executions', authMiddleware, executionRoutes);
app.use('/api/upload', authMiddleware, uploadRoutes);
app.use('/api/chatgpt-auth', authMiddleware, chatgptAuthRoutes);
app.use('/api/credential-check', authMiddleware, credentialCheckRoutes);
app.use('/api/jobs', authMiddleware, jobRoutes);
app.use('/api/telegram', authMiddleware, telegramRoutes);
app.use('/api/admin', authMiddleware, requireAdmin, adminRoutes);

// Error handler
app.use(errorHandler);

// Socket.IO auth & events
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));

  import('./services/auth.service.js').then(({ verifyToken }) => {
    try {
      const payload = verifyToken(token);
      socket.userId = payload.userId;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });
});

io.on('connection', (socket) => {
  // Join user-specific room for targeted updates
  socket.join(`user:${socket.userId}`);

  socket.on('join:execution', (executionId) => {
    socket.join(`execution:${executionId}`);
  });

  socket.on('leave:execution', (executionId) => {
    socket.leave(`execution:${executionId}`);
  });

  socket.on('join:batch', (batchId) => {
    socket.join(`batch:${batchId}`);
  });

  socket.on('leave:batch', (batchId) => {
    socket.leave(`batch:${batchId}`);
  });
});

// Start server
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 Socket.IO ready`);

  // Start Telegram bot (if configured)
  try {
    const { startBot } = await import('./services/telegram-bot.js');
    await startBot();
  } catch (err) {
    console.error('[Telegram] Failed to start bot:', err.message);
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  httpServer.close();
  process.exit(0);
});
