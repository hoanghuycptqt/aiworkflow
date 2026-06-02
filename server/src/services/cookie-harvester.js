/**
 * Cookie Harvester — on-demand Google Flow cookie/token refresh + re-login helpers.
 *
 * The periodic CRON was REMOVED (2026-06): the Google Flow connector self-heals expiry
 * inline (fast /session → slow Firefox-at-profile reload + mid-run 401 recovery), so a
 * scheduled refresh is redundant. What remains here is the on-demand path used by the
 * Telegram bot (telegram-ai.js → harvestForSpecificUser) plus the slow/profile-recovery +
 * Telegram-2FA re-login orchestration (harvestForUser → loginGoogleFlow) for the ~2-month
 * case when the persistent-profile JWT itself dies and a full re-login is required.
 *
 * harvestForUser escalation: fast /session → broker reload-via-firefox → profile-recovery
 * → Telegram-2FA number-relay login. Syncs to all sibling credentials after success.
 */

import { prisma } from '../index.js';
import { loginGoogleFlow, getAccessToken, saveCredentialsToDB } from './google-login-agent.js';
import { notifyTelegramUser } from './telegram-bot.js';
import { syncSiblingCredentials } from './credential-sync.js';
import { flowBroker, BrokerError } from '../connectors/google-flow/broker-client.js';
import { getAccountInstanceId } from '../connectors/google-flow/connector.js';

const USER_TIMEOUT_MS = 5 * 60 * 1000; // 5 min max per on-demand refresh / re-login

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
 * Fast token refresh — pure Node `/fx/api/auth/session` call with current DB
 * cookies. Covers the normal ~1h access_token expiry without touching the
 * broker (no Firefox launch, no /session rotation risk). Saves only the
 * fresh `access_token` + `tokenExpiresAt`; cookies in DB stay unchanged.
 *
 * Falls back to the slower broker path (refreshCookiesViaBroker) when:
 *   - DB has no cookies (fresh user, first-time setup)
 *   - getAccessToken throws ACCESS_TOKEN_REFRESH_NEEDED (session past
 *     NextAuth maxAge ≈ 20h, NextAuth refusing to refresh further)
 *   - any other /session failure (HTTP error, network blip, ...)
 *
 * Mirrors the Mac MCP two-tier strategy in mcp-server/lib/token-refresh.js
 * (commit f4b7560) — cheap /session for the hourly case, expensive broker
 * Firefox refresh only at the maxAge boundary.
 *
 * Returns { success: bool, reason: string }.
 */
async function tryFastRefresh(userId) {
    const cred = await prisma.credential.findFirst({
        where: { userId, provider: 'google-flow' },
    });
    if (!cred) return { success: false, reason: 'no google-flow credential' };

    let meta = {};
    try { meta = JSON.parse(cred.metadata || '{}'); } catch { /* ok */ }
    const oldCookies = meta.sessionCookies;
    if (!oldCookies) return { success: false, reason: 'no sessionCookies in metadata' };

    let tokenData;
    try {
        tokenData = await getAccessToken(oldCookies);
    } catch (e) {
        // ACCESS_TOKEN_REFRESH_NEEDED is the explicit "go to slow path" signal —
        // see google-login-agent.getAccessToken which throws on this. Any other
        // error is a transient /session failure; in both cases we fall through
        // to the broker path which can re-navigate Flow and rotate the JWT.
        return { success: false, reason: e.message };
    }
    if (!tokenData.expiresAt) {
        return { success: false, reason: '/session returned no expiresAt' };
    }
    if (meta.userEmail && tokenData.userEmail && tokenData.userEmail.toLowerCase() !== meta.userEmail.toLowerCase()) {
        // Defensive: shouldn't happen on a fast refresh (cookies in DB are
        // already pinned to this user) but if it does, escalate so the
        // slow path's account-match logic can re-verify.
        return {
            success: false,
            reason: `account mismatch: got ${tokenData.userEmail}, expected ${meta.userEmail}`,
        };
    }

    // Save just the fresh token + expiresAt. saveCredentialsToDB writes both
    // cookies and token in the same row, but since we pass the EXISTING
    // cookies the sessionCookies field stays unchanged byte-for-byte.
    await saveCredentialsToDB(userId, oldCookies, tokenData);
    const successMsg = `✅ Fast token refresh (${tokenData.userEmail || 'unknown'}). Token expires: ${tokenData.expiresAt}`;
    console.log(`[CookieRefresh:fast] ${successMsg}`);
    return { success: true, reason: successMsg };
}

/**
 * Slow-path refresh — broker spawns standalone Firefox at the per-account
 * persistent profile dir (`BROKER_PROFILE_BASE/<account_id>`), lets it
 * navigate Google Flow so NextAuth's page-level OAuth silent-refresh runs
 * inside a full-state browser, then returns the rotated cookies read off
 * cookies.sqlite. ~25-30s per call.
 *
 * Replaces the old `flowBroker.refreshCookies()` ephemeral path (broker's
 * shared session pool injecting DB cookies into a fresh BrowserContext)
 * because the ephemeral context lacks the Google account cookies (SID,
 * SAPISID, ...) and other browser state that OAuth silent-refresh needs
 * once the NextAuth session-token is past `session.maxAge` (~20h on
 * labs.google). At that point the ephemeral broker would fail and the
 * harvester would escalate to Telegram-2FA loginGoogleFlow — surprising
 * the user even though the underlying Google session is still alive in
 * the persistent profile dir.
 *
 * Returns { success: bool, needsRelogin: bool, message: string }.
 */
async function refreshCookiesViaBroker(userId, sendTelegram = null) {
    const cred = await prisma.credential.findFirst({
        where: { userId, provider: 'google-flow' },
    });
    if (!cred) {
        return { success: false, needsRelogin: false, message: 'No google-flow credential' };
    }

    let meta = {};
    try { meta = JSON.parse(cred.metadata || '{}'); } catch { /* ok */ }

    const accountId = getAccountInstanceId({ metadata: meta });

    let res;
    try {
        res = await flowBroker.reloadViaFirefox(accountId);
    } catch (e) {
        const msg = e instanceof BrokerError ? `broker ${e.status || ''}: ${e.message}` : e.message;
        console.error(`[CookieRefresh:broker] reload-via-firefox: ${msg}`);
        return { success: false, needsRelogin: true, message: `Firefox reload failed: ${msg}` };
    }

    if (res.status === 'no_profile_base' || res.status === 'no_profile') {
        // Broker not configured for per-account profiles, or this user has
        // no profile yet (first-time setup pre-rollout) — fall through to
        // Telegram-2FA login which will populate the profile via the
        // login-time snapshot in google-login-agent.loginGoogleFlow.
        return {
            success: false,
            needsRelogin: true,
            message: `broker has no usable profile for ${accountId}: ${res.status}`,
        };
    }

    if (res.status !== 'ok' || !res.cookies) {
        return { success: false, needsRelogin: false, message: `Unexpected broker response: ${JSON.stringify(res).substring(0, 200)}` };
    }

    // Got fresh cookies — pull the new bearer token from the session API and save to DB.
    let tokenData;
    try {
        tokenData = await getAccessToken(res.cookies);
    } catch (e) {
        return { success: false, needsRelogin: true, message: `Session API failed: ${e.message}` };
    }

    // Verify correct account (defensive — broker session should already be the right user).
    const expectedEmail = (meta.userEmail || '').toLowerCase();
    if (expectedEmail && tokenData.userEmail && tokenData.userEmail.toLowerCase() !== expectedEmail) {
        const msg = `Wrong account: got ${tokenData.userEmail}, expected ${expectedEmail}`;
        console.warn(`[CookieRefresh:broker] ${msg}`);
        if (sendTelegram) await sendTelegram(`⚠️ ${msg}. Cần re-login.`);
        return { success: false, needsRelogin: true, message: msg };
    }

    // Ground-truth liveness signal: if the session API does not return an
    // `expires` field, the upstream NextAuth session is gone — refreshing
    // cookies further can't recover it, escalate to full re-login. A healthy
    // refresh typically returns expires ~20h in the future.
    if (!tokenData.expiresAt) {
        const msg = 'Session API returned no expires field — needs re-login';
        console.warn(`[CookieRefresh:broker] ${msg}`);
        return { success: false, needsRelogin: true, message: msg };
    }

    await saveCredentialsToDB(userId, res.cookies, tokenData);

    // No explicit profile snapshot here — Firefox itself wrote the rotated
    // cookies to `BROKER_PROFILE_BASE/<account_id>/cookies.sqlite` during
    // the reload-via-firefox dance above. Overwriting with our manual
    // minimal-schema sqlite would just downgrade Firefox's full write.

    const successMsg = `✅ Cookie refreshed via Firefox-at-profile (${tokenData.userEmail || 'unknown'}). Token expires: ${tokenData.expiresAt}`;
    console.log(`[CookieRefresh:broker] ${successMsg}`);
    if (sendTelegram) await sendTelegram(successMsg);

    return { success: true, needsRelogin: false, message: successMsg };
}

/**
 * Profile-recovery: pull cookies from the broker's per-account persistent
 * profile dir (populated at last login via save-cookies-to-profile) and
 * promote them into DB.
 *
 * Bypasses a Telegram 2FA full re-login when the underlying Google session
 * is still alive — the only thing that broke was the DB cookieString
 * getting rotated to a dead JWT by an unlucky NextAuth refresh.
 *
 * Returns { success: bool, reason: string }.
 */
async function tryProfileRecovery(userId, sendTelegram) {
    const cred = await prisma.credential.findFirst({
        where: { userId, provider: 'google-flow' },
    });
    if (!cred) {
        return { success: false, reason: 'no google-flow credential' };
    }
    let meta = {};
    try { meta = JSON.parse(cred.metadata || '{}'); } catch { /* ok */ }
    const accountId = getAccountInstanceId({ metadata: meta });
    const expectedEmail = (meta.userEmail || '').toLowerCase();

    // 1. Pull cookies from per-account profile dir
    let res;
    try {
        res = await flowBroker.cookiesFromProfile(accountId);
    } catch (e) {
        const m = e instanceof BrokerError ? `${e.status || ''}: ${e.message}` : e.message;
        return { success: false, reason: `broker cookies-from-profile: ${m}` };
    }
    if (res.status === 'no_profile') {
        return { success: false, reason: 'broker has no persistent profile for this account (BROKER_PROFILE_BASE unset or login pre-dates rollout)' };
    }
    if (res.status === 'no_session_token') {
        return { success: false, reason: 'profile lacks session-token (incomplete login snapshot)' };
    }
    if (res.status !== 'ok' || !res.cookies) {
        return { success: false, reason: `unexpected broker response: ${JSON.stringify(res).substring(0, 200)}` };
    }

    // 2. Validate via /fx/api/auth/session — getAccessToken throws when the
    //    response carries ACCESS_TOKEN_REFRESH_NEEDED (profile JWT also dead;
    //    likely past NextAuth's ~60-day maxAge → real re-login needed).
    let tokenData;
    try {
        tokenData = await getAccessToken(res.cookies);
    } catch (e) {
        return { success: false, reason: `profile cookies failed /session validation: ${e.message}` };
    }

    // 3. Verify account match (broker profile_snapshot trusts the caller-supplied
    //    account_id, so defend against a swapped/mislabeled profile dir).
    if (expectedEmail && tokenData.userEmail && tokenData.userEmail.toLowerCase() !== expectedEmail) {
        return { success: false, reason: `profile holds different account: ${tokenData.userEmail} (expected ${expectedEmail})` };
    }
    if (!tokenData.expiresAt) {
        return { success: false, reason: 'profile cookies returned no expires field' };
    }

    // 4. Commit fresh cookies + token to DB. Sibling sync happens in caller.
    await saveCredentialsToDB(userId, res.cookies, tokenData);

    // NO re-snapshot to the profile dir. The dir holds a REAL Firefox login
    // (written by the persistent-context Telegram login) and reload-via-firefox
    // keeps it fresh by re-granting in-place. Writing a synthetic cookie snapshot
    // here would DOWNGRADE it (wrong host/httpOnly/sameSite → Firefox renders
    // logged-out → reload can never rotate) — the bug we just fixed. The static
    // cookies-from-profile read above already returned the dir's real cookies.

    const msg = `✅ Cookie recovered from broker persistent profile (${tokenData.userEmail || 'unknown'}). Token expires: ${tokenData.expiresAt}`;
    console.log(`[CookieRefresh:profile-recovery] ${msg}`);
    if (sendTelegram) await sendTelegram(msg);
    return { success: true, reason: msg };
}

/**
 * Process a single user's cookie refresh.
 * After success, sync to all sibling credentials sharing the same Google account.
 */
async function harvestForUser(userId, googleAccountCredentialId) {
    const sendTelegram = createSendFn(userId);

    console.log(`[CookieHarvester] Processing user: ${userId.substring(0, 8)}`);

    // Step 0: Fast token refresh — pure /session call, no broker. Covers the
    // common ~1h access_token expiry (~95% of refreshes). Cookies in DB stay
    // unchanged; only the bearer token + tokenExpiresAt are updated. Slow
    // broker path runs only when fast fails (session past NextAuth maxAge or
    // any other /session failure).
    const fastResult = await tryFastRefresh(userId);
    if (fastResult.success) {
        console.log(`[CookieHarvester] ✅ User ${userId.substring(0, 8)}: fast token refresh (no broker)`);
        await _syncAfterHarvest(userId);
        return { userId, success: true, action: 'fast_refresh' };
    }
    console.log(`[CookieHarvester] Fast path skipped (${fastResult.reason}) — falling through to broker refresh`);

    // Step 1: Try simple refresh via broker (Firefox). Legacy Chrome refreshCookies
    // is kept in google-login-agent.js as a fallback until Phase 3 is fully verified.
    const refreshResult = await Promise.race([
        refreshCookiesViaBroker(userId, sendTelegram),
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

    // Step 1.5: Profile recovery — broker.refresh said needs-relogin, but the
    // broker is ephemeral so what it sees as "dead" is often a NextAuth
    // session-token rotation that produced an unrefreshable JWT in DB. The
    // per-account profile dir at BROKER_PROFILE_BASE/<accountId>, populated
    // at last successful login by save-cookies-to-profile, is NEVER touched
    // by broker ops — its JWT-A stays alive until the next login overwrites
    // it. Read it and try to recover before paying the cost of a full
    // Telegram-2FA re-login.
    //
    // If BROKER_PROFILE_BASE is not set (e.g. fresh VPS that hasn't been
    // upgraded yet, or Mac docker), broker returns no_profile and this
    // step is a fast no-op — Step 2 still runs.
    if (refreshResult.needsRelogin) {
        const recovery = await tryProfileRecovery(userId, sendTelegram);
        if (recovery.success) {
            console.log(`[CookieHarvester] ✅ User ${userId.substring(0, 8)}: Recovered from broker persistent profile`);
            await _syncAfterHarvest(userId);
            return { userId, success: true, action: 'profile_recovery' };
        }
        // Recovery didn't work — keep needsRelogin path and fall through.
        console.log(`[CookieHarvester] Profile recovery skipped/failed (${recovery.reason}); escalating to full re-login`);
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
