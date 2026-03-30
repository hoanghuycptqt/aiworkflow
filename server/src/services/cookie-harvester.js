/**
 * Cookie Harvester — Smart per-Google-account cron service
 *
 * Groups users by Google account email — only 1 Chrome per account.
 * After refresh, syncs cookies/token to all sibling credentials.
 *
 * Two layers of protection:
 *   Layer 1: Per-account setTimeout at tokenExpiresAt + 1 min
 *   Layer 2: Before opening Chrome, check DB — skip if cookie still valid
 *
 * Flow per Google account:
 *   1. Check DB: if cookie not expired yet → skip (no Chrome)
 *   2. Launch Chrome with primary user's persistent profile
 *   3. Navigate to Google Flow → get fresh cookies
 *   4. Call session API → get access_token
 *   5. Save cookies + token to DB
 *   6. Sync to all sibling credentials (same Google account)
 *   7. Schedule next refresh at new tokenExpiresAt + 1 min
 */

import { prisma } from '../index.js';
import { refreshCookies, loginGoogleFlow } from './google-login-agent.js';
import { notifyTelegramUser } from './telegram-bot.js';
import { syncSiblingCredentials } from './credential-sync.js';

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
 * After success, sync to all sibling credentials sharing the same Google account.
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
        // Sync to siblings sharing the same Google account
        await _syncAfterHarvest(userId);
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
                // Sync to siblings sharing the same Google account
                await _syncAfterHarvest(userId);
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
 * After a successful harvest, read the refreshed credential and sync to siblings.
 */
async function _syncAfterHarvest(userId) {
    try {
        const cred = await prisma.credential.findFirst({
            where: { userId, provider: 'google-flow' },
        });
        if (!cred) return;
        const meta = JSON.parse(cred.metadata || '{}');
        await syncSiblingCredentials(cred.id, cred.token, meta);
    } catch (e) {
        console.warn(`[CookieHarvester] Sibling sync error (non-fatal): ${e.message}`);
    }
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
 * Start the smart per-Google-account cron.
 * Groups users by Google account email — only 1 timer per account.
 * After refresh, syncs to all sibling credentials automatically.
 */
export async function startHarvestCron() {
    if (cronStarted) {
        console.log('[CookieHarvester] Cron already started');
        return;
    }

    cronStarted = true;
    console.log('[CookieHarvester] 🕐 Smart per-Google-account cron started');

    try {
        const googleAccounts = await prisma.credential.findMany({
            where: { provider: 'google-account' },
            select: { id: true, userId: true, metadata: true },
        });

        if (googleAccounts.length === 0) {
            console.log('[CookieHarvester] No google-account credentials. Will check again in 18h.');
            setTimeout(() => {
                cronStarted = false;
                startHarvestCron();
            }, FALLBACK_INTERVAL_MS);
            return;
        }

        // Group by Google account email — 1 timer per account, not per user
        const accountGroups = new Map(); // email → { primaryUserId, credentialId, allUserIds }
        for (const account of googleAccounts) {
            let email = 'unknown';
            try {
                const meta = JSON.parse(account.metadata || '{}');
                email = meta.email?.toLowerCase() || 'unknown';
            } catch { /* use unknown */ }

            if (!accountGroups.has(email)) {
                accountGroups.set(email, {
                    primaryUserId: account.userId,
                    credentialId: account.id,
                    allUserIds: [account.userId],
                });
            } else {
                accountGroups.get(email).allUserIds.push(account.userId);
            }
        }

        console.log(`[CookieHarvester] Found ${accountGroups.size} Google account(s) across ${googleAccounts.length} user(s)`);

        for (const [email, group] of accountGroups) {
            console.log(`[CookieHarvester] 📧 ${email}: primary=${group.primaryUserId.substring(0, 8)}, ${group.allUserIds.length} user(s)`);
            // Schedule ONLY for primary user — syncSiblingCredentials handles the rest
            await scheduleForUser(group.primaryUserId, group.credentialId);
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
