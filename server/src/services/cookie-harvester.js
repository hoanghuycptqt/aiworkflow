/**
 * Cookie Harvester — Smart cron service
 *
 * Refreshes Google Flow cookies based on tokenExpiresAt from DB.
 * - On server start: check if expired → refresh immediately, else schedule
 * - After refresh: read new tokenExpiresAt → schedule next run
 * - Handles VPS shutdown (1:30AM-8:00AM): on restart, detects expired → refresh
 *
 * Flow per user:
 *   1. Launch Chrome with user's persistent profile
 *   2. Navigate to Google Flow → get fresh cookies
 *   3. Call session API → get access_token
 *   4. Save cookies + token to DB
 *   5. Schedule next refresh at tokenExpiresAt + 1 min
 */

import { prisma } from '../index.js';
import { refreshCookies, loginGoogleFlow } from './google-login-agent.js';
import { notifyTelegramUser } from './telegram-bot.js';

const REFRESH_DELAY_MS = 60 * 1000; // 1 min after expiry
const USER_TIMEOUT_MS = 5 * 60 * 1000; // 5 min max per user
const FALLBACK_INTERVAL_MS = 18 * 60 * 60 * 1000; // 18h fallback if no expiry info

let harvestTimer = null;
let isRunning = false;
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
 * Process a single user's cookie refresh.
 */
async function harvestForUser(userId, googleAccountCredentialId) {
    const sendTelegram = createSendFn(userId);

    console.log(`[CookieHarvester] Processing user: ${userId}`);

    // Step 1: Try simple refresh (just open Chrome with saved profile)
    const refreshResult = await Promise.race([
        refreshCookies(userId, sendTelegram),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), USER_TIMEOUT_MS)
        ),
    ]);

    if (refreshResult.success) {
        console.log(`[CookieHarvester] ✅ User ${userId}: Cookie refreshed successfully`);
        return { userId, success: true, action: 'refresh' };
    }

    // Step 2: If needs re-login, try auto login
    if (refreshResult.needsRelogin) {
        console.log(`[CookieHarvester] ⚠️ User ${userId}: Needs re-login, attempting auto login...`);

        const chatId = await getTelegramChatId(userId);
        if (!chatId) {
            console.warn(`[CookieHarvester] No Telegram link for user ${userId} — cannot do 2FA, skipping`);
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
                console.log(`[CookieHarvester] ✅ User ${userId}: Re-login successful`);
                return { userId, success: true, action: 'relogin' };
            } else {
                console.log(`[CookieHarvester] ❌ User ${userId}: Re-login failed: ${loginResult.message}`);
                return { userId, success: false, action: 'relogin_failed', reason: loginResult.message };
            }
        } catch (e) {
            console.error(`[CookieHarvester] ❌ User ${userId}: Re-login error: ${e.message}`);
            await sendTelegram(`❌ Tự động đăng nhập thất bại: ${e.message}. Vui lòng thử lại bằng lệnh "login google flow".`);
            return { userId, success: false, action: 'relogin_error', reason: e.message };
        }
    }

    // Step 3: Other failure (network error, etc.)
    console.log(`[CookieHarvester] ❌ User ${userId}: Refresh failed: ${refreshResult.message}`);
    return { userId, success: false, action: 'refresh_failed', reason: refreshResult.message };
}

/**
 * Harvest cookies for ALL users with google-account credentials.
 * Runs sequentially to avoid resource contention.
 */
export async function harvestAllUsers() {
    if (isRunning) {
        console.log('[CookieHarvester] Already running, skipping...');
        return [];
    }

    isRunning = true;
    console.log('[CookieHarvester] ═══════════════════════════════════');
    console.log('[CookieHarvester] Starting cookie harvest for all users...');

    try {
        // Find all users with google-account credentials
        const googleAccounts = await prisma.credential.findMany({
            where: { provider: 'google-account' },
            select: { id: true, userId: true, label: true },
        });

        if (googleAccounts.length === 0) {
            console.log('[CookieHarvester] No google-account credentials found. Nothing to do.');
            return [];
        }

        console.log(`[CookieHarvester] Found ${googleAccounts.length} user(s) with Google Account credentials`);

        const results = [];
        for (const account of googleAccounts) {
            try {
                const result = await harvestForUser(account.userId, account.id);
                results.push(result);
            } catch (e) {
                console.error(`[CookieHarvester] Unhandled error for user ${account.userId}: ${e.message}`);
                results.push({ userId: account.userId, success: false, action: 'error', reason: e.message });
            }
        }

        // Summary
        const successCount = results.filter(r => r.success).length;
        console.log(`[CookieHarvester] ═══════════════════════════════════`);
        console.log(`[CookieHarvester] Done! ${successCount}/${results.length} users refreshed successfully.`);

        return results;

    } finally {
        isRunning = false;
    }
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
 * Get the earliest tokenExpiresAt from all google-flow credentials.
 */
async function getEarliestExpiry() {
    const credentials = await prisma.credential.findMany({
        where: { provider: 'google-flow' },
        select: { metadata: true },
    });

    let earliest = null;
    for (const cred of credentials) {
        try {
            const meta = JSON.parse(cred.metadata || '{}');
            if (meta.tokenExpiresAt) {
                const expiry = new Date(meta.tokenExpiresAt);
                if (!earliest || expiry < earliest) {
                    earliest = expiry;
                }
            }
        } catch { /* skip invalid metadata */ }
    }

    return earliest;
}

/**
 * Schedule the next harvest based on tokenExpiresAt.
 * - If already expired → run immediately
 * - If not expired → schedule for expiresAt + 1 min
 * - If no expiry info → fallback to 18h interval
 */
async function scheduleNextHarvest() {
    // Clear any existing timer
    if (harvestTimer) {
        clearTimeout(harvestTimer);
        harvestTimer = null;
    }

    const earliest = await getEarliestExpiry();
    const now = Date.now();

    let delayMs;
    let reason;

    if (!earliest) {
        // No google-flow credentials yet — use fallback interval
        delayMs = FALLBACK_INTERVAL_MS;
        reason = `no expiry info, fallback ${FALLBACK_INTERVAL_MS / 3600000}h`;
    } else if (earliest.getTime() <= now) {
        // Already expired — run in 10 seconds (give server time to stabilize)
        delayMs = 10 * 1000;
        reason = `expired ${Math.round((now - earliest.getTime()) / 60000)}m ago → refreshing soon`;
    } else {
        // Not expired — schedule for expiresAt + 1 min
        delayMs = earliest.getTime() - now + REFRESH_DELAY_MS;
        reason = `expires at ${earliest.toISOString()} → refresh in ${Math.round(delayMs / 60000)}m`;
    }

    const nextRun = new Date(now + delayMs);
    console.log(`[CookieHarvester] ⏰ Next harvest: ${nextRun.toISOString()} (${reason})`);

    harvestTimer = setTimeout(async () => {
        try {
            await harvestAllUsers();
        } catch (e) {
            console.error('[CookieHarvester] Harvest error:', e.message);
        }
        // After harvest, schedule the next one
        await scheduleNextHarvest();
    }, delayMs);
}

/**
 * Start the smart cron.
 * Reads tokenExpiresAt from DB and schedules accordingly.
 */
export async function startHarvestCron() {
    if (cronStarted) {
        console.log('[CookieHarvester] Cron already started');
        return;
    }

    cronStarted = true;
    console.log('[CookieHarvester] 🕐 Smart cron started — scheduling based on tokenExpiresAt');

    await scheduleNextHarvest();
}

/**
 * Stop the cron timer.
 */
export function stopHarvestCron() {
    if (harvestTimer) {
        clearTimeout(harvestTimer);
        harvestTimer = null;
        cronStarted = false;
        console.log('[CookieHarvester] Cron stopped');
    }
}
