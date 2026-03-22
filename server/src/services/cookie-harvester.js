/**
 * Cookie Harvester — Smart per-user cron service
 *
 * Each user has their own timer based on tokenExpiresAt.
 * Two layers of protection:
 *   Layer 1: Per-user setTimeout at tokenExpiresAt + 1 min
 *   Layer 2: Before opening Chrome, check DB — skip if cookie still valid
 *
 * Flow per user:
 *   1. Check DB: if cookie not expired yet → skip (no Chrome)
 *   2. Launch Chrome with user's persistent profile
 *   3. Navigate to Google Flow → get fresh cookies
 *   4. Call session API → get access_token
 *   5. Save cookies + token to DB
 *   6. Schedule next refresh at new tokenExpiresAt + 1 min
 */

import { prisma } from '../index.js';
import { refreshCookies, loginGoogleFlow } from './google-login-agent.js';
import { notifyTelegramUser } from './telegram-bot.js';

const REFRESH_DELAY_MS = 60 * 1000; // 1 min after expiry
const USER_TIMEOUT_MS = 5 * 60 * 1000; // 5 min max per user
const FALLBACK_INTERVAL_MS = 18 * 60 * 60 * 1000; // 18h fallback if no expiry info

// Per-user timers: Map<userId, timerId>
const userTimers = new Map();
let cronStarted = false;

/**
 * Get the Telegram chat ID for a user.
 */
async function getTelegramChatId(userId) {
    const link = await prisma.telegramLink.findFirst({ where: { userId } });
    return link?.chatId || null;
}

/**
 * Create a sendTelegram function for a specific user.
 */
function createSendFn(userId) {
    return async (message) => {
        try {
            await notifyTelegramUser(userId, message);
        } catch (e) {
            console.warn(`[CookieHarvester] Failed to notify user ${userId}: ${e.message}`);
        }
    };
}

/**
 * Layer 2: Check if user's cookie is actually expired before opening Chrome.
 * Returns true if expired (needs refresh), false if still valid.
 */
async function isCookieExpired(userId) {
    const cred = await prisma.credential.findFirst({
        where: { userId, provider: 'google-flow' },
        select: { metadata: true },
    });

    if (!cred) return true; // No credential → needs setup

    try {
        const meta = JSON.parse(cred.metadata || '{}');
        if (!meta.tokenExpiresAt) return true; // No expiry info → refresh

        const expiresAt = new Date(meta.tokenExpiresAt).getTime();
        const now = Date.now();

        if (expiresAt > now) {
            const remainMin = Math.round((expiresAt - now) / 60000);
            console.log(`[CookieHarvester] User ${userId.substring(0, 8)}: cookie still valid (${remainMin}m remaining) — skipping`);
            return false;
        }

        const agoMin = Math.round((now - expiresAt) / 60000);
        console.log(`[CookieHarvester] User ${userId.substring(0, 8)}: cookie expired ${agoMin}m ago — needs refresh`);
        return true;
    } catch {
        return true; // Parse error → refresh to be safe
    }
}

/**
 * Process a single user's cookie refresh.
 */
async function harvestForUser(userId, googleAccountCredentialId) {
    const sendTelegram = createSendFn(userId);

    console.log(`[CookieHarvester] Processing user: ${userId.substring(0, 8)}`);

    // Step 1: Try simple refresh (just open Chrome with saved profile)
    const refreshResult = await Promise.race([
        refreshCookies(userId, sendTelegram),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), USER_TIMEOUT_MS)
        ),
    ]);

    if (refreshResult.success) {
        console.log(`[CookieHarvester] ✅ User ${userId.substring(0, 8)}: Cookie refreshed successfully`);
        return { userId, success: true, action: 'refresh' };
    }

    // Step 2: If needs re-login, try auto login
    if (refreshResult.needsRelogin) {
        console.log(`[CookieHarvester] ⚠️ User ${userId.substring(0, 8)}: Needs re-login, attempting auto login...`);

        const chatId = await getTelegramChatId(userId);
        if (!chatId) {
            console.warn(`[CookieHarvester] No Telegram link for user ${userId.substring(0, 8)} — cannot do 2FA, skipping`);
            await sendTelegram('⚠️ Cookie Google Flow đã hết hạn. Cần re-login nhưng không thể vì chưa liên kết Telegram.');
            return { userId, success: false, action: 'no_telegram', reason: refreshResult.message };
        }

        await sendTelegram('⚠️ Cookie Google Flow đã hết hạn, đang tự động đăng nhập lại...');

        try {
            const loginResult = await Promise.race([
                loginGoogleFlow(userId, googleAccountCredentialId, chatId, sendTelegram),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Login timeout')), USER_TIMEOUT_MS)
                ),
            ]);

            if (loginResult.success) {
                console.log(`[CookieHarvester] ✅ User ${userId.substring(0, 8)}: Re-login successful`);
                return { userId, success: true, action: 'relogin' };
            } else {
                console.log(`[CookieHarvester] ❌ User ${userId.substring(0, 8)}: Re-login failed: ${loginResult.message}`);
                return { userId, success: false, action: 'relogin_failed', reason: loginResult.message };
            }
        } catch (e) {
            console.error(`[CookieHarvester] ❌ User ${userId.substring(0, 8)}: Re-login error: ${e.message}`);
            await sendTelegram(`❌ Tự động đăng nhập thất bại: ${e.message}. Vui lòng thử lại bằng lệnh "login google flow".`);
            return { userId, success: false, action: 'relogin_error', reason: e.message };
        }
    }

    // Step 3: Other failure
    console.log(`[CookieHarvester] ❌ User ${userId.substring(0, 8)}: Refresh failed: ${refreshResult.message}`);
    return { userId, success: false, action: 'refresh_failed', reason: refreshResult.message };
}

/**
 * Harvest for ALL users (used by manual trigger).
 */
export async function harvestAllUsers() {
    const googleAccounts = await prisma.credential.findMany({
        where: { provider: 'google-account' },
        select: { id: true, userId: true },
    });

    if (googleAccounts.length === 0) {
        console.log('[CookieHarvester] No google-account credentials found.');
        return [];
    }

    const results = [];
    for (const account of googleAccounts) {
        try {
            const expired = await isCookieExpired(account.userId);
            if (!expired) {
                results.push({ userId: account.userId, success: true, action: 'skipped_valid' });
                continue;
            }
            const result = await harvestForUser(account.userId, account.id);
            results.push(result);
        } catch (e) {
            console.error(`[CookieHarvester] Error for user ${account.userId.substring(0, 8)}: ${e.message}`);
            results.push({ userId: account.userId, success: false, action: 'error', reason: e.message });
        }
    }
    return results;
}

/**
 * Manual trigger: refresh cookies for a specific user.
 */
export async function harvestForSpecificUser(userId) {
    const googleAccount = await prisma.credential.findFirst({
        where: { userId, provider: 'google-account' },
        select: { id: true },
    });

    if (!googleAccount) {
        return { success: false, message: 'No Google Account credential found. Add one via Web UI → Credentials.' };
    }

    return harvestForUser(userId, googleAccount.id);
}

/**
 * Get tokenExpiresAt for a specific user.
 */
async function getUserExpiry(userId) {
    const cred = await prisma.credential.findFirst({
        where: { userId, provider: 'google-flow' },
        select: { metadata: true },
    });
    if (!cred) return null;
    try {
        const meta = JSON.parse(cred.metadata || '{}');
        return meta.tokenExpiresAt ? new Date(meta.tokenExpiresAt) : null;
    } catch { return null; }
}

/**
 * Schedule refresh for a single user.
 * Layer 1: setTimeout at tokenExpiresAt + 1 min
 * Layer 2: before refresh, isCookieExpired() check
 */
async function scheduleForUser(userId, googleAccountCredentialId) {
    // Clear existing timer for this user
    if (userTimers.has(userId)) {
        clearTimeout(userTimers.get(userId));
        userTimers.delete(userId);
    }

    const expiry = await getUserExpiry(userId);
    const now = Date.now();

    let delayMs;
    let reason;

    if (!expiry) {
        delayMs = FALLBACK_INTERVAL_MS;
        reason = `no expiry info → fallback ${FALLBACK_INTERVAL_MS / 3600000}h`;
    } else if (expiry.getTime() <= now) {
        delayMs = 10 * 1000; // 10s for startup stabilization
        const agoMin = Math.round((now - expiry.getTime()) / 60000);
        reason = `expired ${agoMin}m ago → refreshing soon`;
    } else {
        delayMs = expiry.getTime() - now + REFRESH_DELAY_MS;
        const inMin = Math.round(delayMs / 60000);
        reason = `expires ${expiry.toISOString()} → refresh in ${inMin}m`;
    }

    const nextRun = new Date(now + delayMs);
    console.log(`[CookieHarvester] ⏰ User ${userId.substring(0, 8)}: next refresh at ${nextRun.toISOString()} (${reason})`);

    const timerId = setTimeout(async () => {
        userTimers.delete(userId);
        try {
            // Layer 2: double-check if actually expired
            const expired = await isCookieExpired(userId);
            if (!expired) {
                console.log(`[CookieHarvester] User ${userId.substring(0, 8)}: cookie renewed externally — rescheduling`);
                await scheduleForUser(userId, googleAccountCredentialId);
                return;
            }

            // Actually refresh
            console.log(`[CookieHarvester] ═══ Harvesting user ${userId.substring(0, 8)} ═══`);
            await harvestForUser(userId, googleAccountCredentialId);
        } catch (e) {
            console.error(`[CookieHarvester] Harvest error for ${userId.substring(0, 8)}: ${e.message}`);
        }

        // Reschedule for next expiry
        await scheduleForUser(userId, googleAccountCredentialId);
    }, delayMs);

    userTimers.set(userId, timerId);
}

/**
 * Start the smart per-user cron.
 * Reads all users with google-account credentials and schedules each independently.
 */
export async function startHarvestCron() {
    if (cronStarted) {
        console.log('[CookieHarvester] Cron already started');
        return;
    }

    cronStarted = true;
    console.log('[CookieHarvester] 🕐 Smart per-user cron started');

    try {
        const googleAccounts = await prisma.credential.findMany({
            where: { provider: 'google-account' },
            select: { id: true, userId: true },
        });

        if (googleAccounts.length === 0) {
            console.log('[CookieHarvester] No google-account credentials. Will check again in 18h.');
            setTimeout(() => {
                cronStarted = false;
                startHarvestCron();
            }, FALLBACK_INTERVAL_MS);
            return;
        }

        console.log(`[CookieHarvester] Scheduling ${googleAccounts.length} user(s)...`);

        for (const account of googleAccounts) {
            await scheduleForUser(account.userId, account.id);
        }
    } catch (e) {
        console.error('[CookieHarvester] Startup error:', e.message);
    }
}

/**
 * Stop all user timers.
 */
export function stopHarvestCron() {
    for (const [userId, timerId] of userTimers) {
        clearTimeout(timerId);
    }
    userTimers.clear();
    cronStarted = false;
    console.log('[CookieHarvester] All user timers stopped');
}
