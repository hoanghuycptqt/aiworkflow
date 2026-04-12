/**
 * Telegram Bot Service — Main bot entry point
 * 
 * Handles: deep link auth, message routing to AI, media delivery on job completion.
 * Supports dual mode: polling (local dev) and webhook (production).
 */

import { Telegraf } from 'telegraf';
import { prisma, io } from '../index.js';
import { handleMessage, handlePhoto } from './telegram-ai.js';
import { pendingInputRequests } from './google-login-agent.js';
import { mkdir } from 'fs/promises';
import { join, extname } from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const uploadDir = process.env.UPLOAD_DIR || './uploads';

/**
 * Get video dimensions (width, height) using ffprobe.
 * Returns { width, height } or null if ffprobe fails.
 */
export async function getVideoDimensions(filePath) {
    try {
        const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height',
            '-of', 'json',
            filePath,
        ], { timeout: 10000 });
        const info = JSON.parse(stdout);
        const stream = info.streams?.[0];
        if (stream?.width && stream?.height) {
            return { width: stream.width, height: stream.height };
        }
    } catch (e) {
        console.warn(`[Telegram] ffprobe failed for ${filePath}: ${e.message}`);
    }
    return null;
}
let bot = null;

/**
 * Start the Telegram bot.
 * Call this after the Express server is running.
 */
export async function startBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.log('[Telegram] No TELEGRAM_BOT_TOKEN set, bot disabled');
        return;
    }

    bot = new Telegraf(token);

    // ─── Private-only guard ───────────────────────────────────
    bot.use(async (ctx, next) => {
        if (ctx.chat?.type !== 'private') return;
        return next();
    });

    // ─── Auth middleware ──────────────────────────────────────
    bot.use(async (ctx, next) => {
        // Allow /start command without auth (for deep link)
        const text = ctx.message?.text || '';
        if (text.startsWith('/start')) return next();

        const chatId = String(ctx.chat.id);
        const link = await prisma.telegramLink.findUnique({ where: { chatId } });
        if (!link) {
            return ctx.reply(
                '🔗 Tài khoản chưa được liên kết.\n\n' +
                'Vui lòng mở Web UI → Settings → "Link Telegram" để lấy link kết nối.',
                { parse_mode: 'Markdown' }
            );
        }
        ctx.userId = link.userId;
        ctx.telegramLink = link;
        return next();
    });

    // ─── /start — Deep Link Handler ──────────────────────────
    bot.start(async (ctx) => {
        const payload = ctx.startPayload; // token from deep link
        if (!payload) {
            return ctx.reply(
                '👋 Chào mừng đến với Video Creator Workflow Bot!\n\n' +
                'Để kết nối tài khoản, vui lòng mở Web UI → Settings → "Link Telegram".'
            );
        }

        // Verify token
        const linkToken = await prisma.telegramLinkToken.findUnique({
            where: { token: payload },
        });

        if (!linkToken || linkToken.expiresAt < new Date()) {
            // Clean up expired token
            if (linkToken) {
                await prisma.telegramLinkToken.delete({ where: { id: linkToken.id } }).catch(() => { });
            }
            return ctx.reply('❌ Link đã hết hạn. Vui lòng tạo link mới từ Web UI.');
        }

        const chatId = String(ctx.chat.id);

        // Check if this chat is already linked
        const existing = await prisma.telegramLink.findUnique({ where: { chatId } });
        if (existing) {
            // Already linked — update userId if different
            if (existing.userId !== linkToken.userId) {
                await prisma.telegramLink.update({
                    where: { chatId },
                    data: { userId: linkToken.userId },
                });
            }
        } else {
            // Create new link
            await prisma.telegramLink.create({
                data: {
                    userId: linkToken.userId,
                    chatId,
                    label: ctx.from?.first_name || 'Telegram',
                },
            });
        }

        // Delete used token
        await prisma.telegramLinkToken.delete({ where: { id: linkToken.id } }).catch(() => { });

        const user = await prisma.user.findUnique({
            where: { id: linkToken.userId },
            select: { name: true, email: true },
        });

        return ctx.reply(
            `✅ Liên kết thành công!\n\n` +
            `👤 Tài khoản: ${user?.name || user?.email}\n` +
            `💬 Bạn có thể bắt đầu trò chuyện, tạo job, hoặc xem trạng thái workflows.\n\n` +
            `Gõ "help" để xem hướng dẫn.`
        );
    });

    // ─── /help command ───────────────────────────────────────
    bot.command('help', (ctx) => {
        return ctx.reply(
            '📖 *Hướng dẫn sử dụng*\n\n' +
            '• Gửi tin nhắn để trò chuyện với AI assistant\n' +
            '• Gửi ảnh để tạo job mới\n' +
            '• Nói "xem workflows" để xem danh sách\n' +
            '• Nói "chạy job" để trigger execution\n' +
            '• Nói "xem status" để theo dõi tiến trình\n' +
            '• Nói "dừng" để stop batch đang chạy\n' +
            '• Nói "lịch sử" để xem history\n\n' +
            '🤖 Bot hiểu ngôn ngữ tự nhiên (tiếng Việt & English)',
            { parse_mode: 'Markdown' }
        );
    });

    // ─── /unlink command ─────────────────────────────────────
    bot.command('unlink', async (ctx) => {
        const chatId = String(ctx.chat.id);
        const link = await prisma.telegramLink.findUnique({ where: { chatId } });
        if (!link) {
            return ctx.reply('Tài khoản chưa được liên kết.');
        }
        await prisma.telegramLink.delete({ where: { chatId } });
        return ctx.reply('✅ Đã huỷ liên kết tài khoản.');
    });

    // ─── Photo handler ───────────────────────────────────────
    bot.on('photo', async (ctx) => {
        if (!ctx.userId) return;
        try {
            await handlePhoto(ctx);
        } catch (err) {
            console.error('[Telegram] Photo handler error:', err);
            ctx.reply('❌ Lỗi xử lý ảnh: ' + err.message);
        }
    });

    // ─── Text message handler ────────────────────────────────
    bot.on('text', async (ctx) => {
        if (!ctx.userId) return;

        // Check if login agent is waiting for this user's input (2FA)
        const chatId = String(ctx.chat.id);
        const pendingReq = pendingInputRequests.get(chatId);
        if (pendingReq) {
            pendingReq.resolve(ctx.message.text.trim());
            return; // Don't pass to AI handler
        }

        try {
            await handleMessage(ctx);
        } catch (err) {
            console.error('[Telegram] Message handler error:', err);
            ctx.reply('❌ Lỗi: ' + err.message);
        }
    });

    // ─── Unsupported media handlers (respond fast to avoid webhook timeout) ───
    bot.on(['video', 'video_note', 'voice', 'audio', 'document', 'sticker', 'animation'], (ctx) => {
        return ctx.reply('⚠️ Bot hiện chưa hỗ trợ loại nội dung này. Vui lòng gửi tin nhắn văn bản hoặc ảnh.');
    });

    // ─── Error handler ───────────────────────────────────────
    bot.catch((err, ctx) => {
        console.error('[Telegram] Bot error:', err);
    });

    // ─── Start bot ───────────────────────────────────────────
    // Catch polling/webhook errors gracefully (don't crash server)
    bot.catch((err) => {
        if (err.response?.error_code === 409) {
            console.warn('[Telegram] ⚠️ Another bot instance is polling — stopping this one. Check your .env tokens.');
        } else {
            console.error('[Telegram] Bot error:', err.message);
        }
    });

    const mode = process.env.TELEGRAM_MODE || 'polling';
    try {
        if (mode === 'webhook') {
            const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
            if (webhookUrl) {
                await bot.telegram.setWebhook(webhookUrl);
                console.log(`[Telegram] 🤖 Bot started (webhook: ${webhookUrl})`);
            } else {
                console.error('[Telegram] TELEGRAM_WEBHOOK_URL not set for webhook mode');
            }
        } else {
            bot.launch({ dropPendingUpdates: true });
            console.log('[Telegram] 🤖 Bot started (polling mode)');
        }
    } catch (err) {
        console.error('[Telegram] Failed to start bot:', err.message);
    }

    // Graceful shutdown
    const shutdown = () => bot.stop('SIGTERM');
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}

/**
 * Download a photo from Telegram and save to uploads.
 * Returns { filePath, fileUrl }
 */
export async function downloadTelegramPhoto(ctx, fileId) {
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    const dir = join(uploadDir, 'user-uploads');
    await mkdir(dir, { recursive: true });

    const ext = extname(file.file_path || '.jpg') || '.jpg';
    const fileName = `tg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`;
    const localPath = join(dir, fileName);

    // Download file
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error(`Failed to download: ${res.status}`);

    const fileStream = createWriteStream(localPath);
    await pipeline(res.body, fileStream);

    return {
        filePath: localPath,
        fileUrl: `/uploads/user-uploads/${fileName}`,
        fileName,
    };
}

/**
 * Send media (images/videos) to all linked Telegram accounts for a user.
 * Called from job-runner when a job completes.
 */
export async function notifyTelegramUser(userId, message, mediaFiles = []) {
    if (!bot) return;

    const links = await prisma.telegramLink.findMany({ where: { userId } });
    if (links.length === 0) return;

    for (const link of links) {
        try {
            // Send text message first
            await bot.telegram.sendMessage(link.chatId, message, { parse_mode: 'Markdown' });
            console.log(`[Telegram] ✅ Text sent to chat ${link.chatId}`);

            // Send media files: photos inline, videos as native video
            for (const media of mediaFiles.slice(0, 50)) { // max 50 files per batch
                try {
                    if (media.type === 'video') {
                        const dims = await getVideoDimensions(media.path);
                        await bot.telegram.sendVideo(link.chatId, { source: media.path }, {
                            supports_streaming: true,
                            ...(dims && { width: dims.width, height: dims.height }),
                        });
                        console.log(`[Telegram] ✅ Video sent: ${media.path}`);
                    } else {
                        await bot.telegram.sendPhoto(link.chatId, { source: media.path });
                        console.log(`[Telegram] ✅ Photo sent: ${media.path}`);
                    }
                } catch (mediaErr) {
                    console.warn(`[Telegram] ⚠️ Media send failed (${media.path}): ${mediaErr.message}`);
                    // If file too large, send URL instead
                    if (media.url) {
                        await bot.telegram.sendMessage(
                            link.chatId,
                            `📎 File quá lớn, tải tại: ${media.url}`
                        );
                    }
                }
            }
        } catch (err) {
            console.error(`[Telegram] Failed to notify chat ${link.chatId}:`, err.message);
        }
    }
}

export { bot };
