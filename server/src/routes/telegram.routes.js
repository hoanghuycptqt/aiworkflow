/**
 * Telegram Routes — Deep link auth, account management
 * 
 * POST /api/telegram/generate-link  → Generate deep link token
 * GET  /api/telegram/linked-accounts → List linked Telegram accounts
 * DELETE /api/telegram/unlink/:linkId → Unlink a Telegram account
 */

import { Router } from 'express';
import { prisma } from '../index.js';
import crypto from 'crypto';

const router = Router();

/**
 * Generate a deep link token for linking Telegram account.
 * Returns a t.me deep link URL.
 */
router.post('/generate-link', async (req, res, next) => {
    try {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (!botToken) {
            return res.status(400).json({ error: 'Telegram bot not configured' });
        }

        // Get bot username from Telegram API
        const botInfo = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
        const botData = await botInfo.json();
        if (!botData.ok) {
            return res.status(500).json({ error: 'Failed to get bot info' });
        }
        const botUsername = botData.result.username;

        // Generate 6-char token
        const token = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 chars
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

        // Clean up old expired tokens for this user
        await prisma.telegramLinkToken.deleteMany({
            where: {
                userId: req.user.id,
                expiresAt: { lt: new Date() },
            },
        });

        // Create new token
        await prisma.telegramLinkToken.create({
            data: {
                userId: req.user.id,
                token,
                expiresAt,
            },
        });

        const deepLink = `https://t.me/${botUsername}?start=${token}`;

        res.json({
            deepLink,
            token,
            expiresAt: expiresAt.toISOString(),
            botUsername,
        });
    } catch (err) {
        next(err);
    }
});

/**
 * List all linked Telegram accounts for the current user.
 */
router.get('/linked-accounts', async (req, res, next) => {
    try {
        const links = await prisma.telegramLink.findMany({
            where: { userId: req.user.id },
            select: {
                id: true,
                chatId: true,
                label: true,
                createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
        });

        res.json({ accounts: links });
    } catch (err) {
        next(err);
    }
});

/**
 * Unlink a Telegram account.
 */
router.delete('/unlink/:linkId', async (req, res, next) => {
    try {
        const link = await prisma.telegramLink.findUnique({
            where: { id: req.params.linkId },
        });

        if (!link || link.userId !== req.user.id) {
            return res.status(404).json({ error: 'Link not found' });
        }

        await prisma.telegramLink.delete({ where: { id: req.params.linkId } });

        res.json({ message: 'Telegram account unlinked' });
    } catch (err) {
        next(err);
    }
});

/**
 * Telegram Webhook endpoint (production mode).
 * This route is PUBLIC — no auth middleware.
 * Telegram sends POST requests here with updates.
 */
router.post('/webhook', async (req, res) => {
    try {
        const { bot } = await import('../services/telegram-bot.js');
        if (bot) {
            await bot.handleUpdate(req.body);
        } else {
            console.warn('[Telegram] ⚠️ Webhook received but bot is null — update dropped');
        }
        res.sendStatus(200);
    } catch (err) {
        console.error('[Telegram] Webhook error:', err.message);
        res.sendStatus(200); // Always 200 to avoid Telegram retries
    }
});

export default router;
