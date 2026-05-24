/**
 * Token Auto-Refresh — two-tier strategy.
 *
 * Triggered by handleTokenRefresh() in google-flow-api.js on 401. Two paths
 * depending on whether the underlying NextAuth session is still alive:
 *
 *   FAST (~1s, normal case, runs every ~1h on access_token expiry):
 *     /fx/api/auth/session with the cookies already in process.env →
 *     NextAuth refreshes Google access_token via the refresh_token inside
 *     the session-token JWT → returns a new access_token. We save only
 *     the new access_token to .env; cookies stay the same (NextAuth may
 *     have rotated session-token internally, but the existing one is
 *     still accepted during its grace window).
 *
 *   SLOW (~20s, only when fast path returns ACCESS_TOKEN_REFRESH_NEEDED,
 *   runs ~once per NextAuth session.maxAge — labs.google ≈ 20h):
 *     /session is rejecting the JWT (past maxAge or session-token grace
 *     window expired). Launch standalone Firefox at /app/firefox-profile
 *     via docker exec — Firefox itself drives the page-level NextAuth
 *     refresh inside its full persistent context, rotates session-token
 *     to a brand-new JWT, writes it to cookies.sqlite. We re-extract via
 *     broker.cookiesFromProfile and save BOTH cookies and access_token.
 *
 *   If the slow path ALSO returns ACCESS_TOKEN_REFRESH_NEEDED, Google has
 *   genuinely revoked the refresh_token (security event, password change,
 *   real account suspension) or the profile is past NextAuth's ~60d
 *   absolute maxAge ceiling. Only scripts/manual-login.sh can recover.
 *
 * Concurrency: `_refreshing` flag prevents two parallel refreshes from
 * stomping on .env or hammering Google's session API.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fetch from 'node-fetch';
import { refreshViaFirefox } from './firefox-refresh.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');

let _refreshing = false;

/**
 * Update a single key in mcp-server/.env. Replaces in place if present, else
 * appends. Also propagates to process.env so the running process picks it up
 * without restart.
 */
function updateEnvKey(key, value) {
    try {
        let content = readFileSync(ENV_PATH, 'utf-8');
        const regex = new RegExp(`^${key}=.*`, 'm');
        if (regex.test(content)) {
            content = content.replace(regex, `${key}=${value}`);
        } else {
            content += `\n${key}=${value}\n`;
        }
        writeFileSync(ENV_PATH, content);
        process.env[key] = value;
    } catch (e) {
        console.error(`[TokenRefresh] Failed to update ${key} in .env: ${e.message}`);
    }
}

/**
 * Refresh token + cookies via broker. Returns the new bearer token on success,
 * or null on failure / needs_relogin.
 *
 * Caller passes accountId derived from credentials.metadata.userEmail (see
 * getAccountInstanceId in recaptcha.js).
 */
export async function refreshToken(accountId) {
    if (_refreshing) {
        console.error('[TokenRefresh] Already refreshing, skipping concurrent call');
        return null;
    }
    _refreshing = true;
    try {
        // FAST PATH (1h boundary): just call /session with the cookies we
        // already have. NextAuth uses the JWT's stored refresh_token to fetch
        // a new Google access_token, returns it. No Firefox launch. ~1s.
        const currentCookies = process.env.GOOGLE_FLOW_SESSION_COOKIES || '';
        if (currentCookies) {
            const fast = await callSessionApi(currentCookies);
            if (fast.alive) {
                updateEnvKey('GOOGLE_FLOW_TOKEN', fast.access_token);
                console.error('[TokenRefresh] ✅ fast path: token refreshed (~1s, cookies unchanged)');
                return fast.access_token;
            }
            // fast.dead — session past maxAge or refresh_token rejected.
            // Fall through to slow path.
            console.error('[TokenRefresh] ⚠️ fast path returned ACCESS_TOKEN_REFRESH_NEEDED — '
                + 'session past NextAuth maxAge (~20h), triggering Firefox reload…');
        } else {
            console.error('[TokenRefresh] no cookies in process.env yet — going straight to Firefox reload');
        }

        // SLOW PATH (20h boundary): NextAuth session is past maxAge, so
        // /session won't refresh anymore. Launch standalone Firefox at
        // /app/firefox-profile — Firefox itself drives the page-level
        // NextAuth refresh inside its full persistent context, rotates
        // session-token to a fresh JWT, writes it to cookies.sqlite. We
        // re-extract and save BOTH cookies + token. ~20s.
        const reloadedCookies = await refreshViaFirefox(accountId);
        if (!reloadedCookies) {
            console.error('[TokenRefresh] ❌ Firefox reload produced no cookies — '
                + 'manual re-login required (python-broker/scripts/manual-login.sh)');
            return null;
        }
        const slow = await callSessionApi(reloadedCookies);
        if (!slow.alive) {
            console.error('[TokenRefresh] ❌ /app/firefox-profile session is also dead '
                + '(Google revoked refresh_token, or profile past NextAuth ~60d maxAge). '
                + 'Re-login via python-broker/scripts/manual-login.sh');
            return null;
        }
        updateEnvKey('GOOGLE_FLOW_SESSION_COOKIES', reloadedCookies);
        updateEnvKey('GOOGLE_FLOW_TOKEN', slow.access_token);
        console.error('[TokenRefresh] ✅ slow path: Firefox-reloaded cookies + token saved');
        return slow.access_token;
    } catch (e) {
        console.error(`[TokenRefresh] Failed: ${e.message}`);
        return null;
    } finally {
        _refreshing = false;
    }
}

/**
 * GET /fx/api/auth/session and classify the response.
 *
 * Returns:
 *   { alive: true, access_token }    — fresh token from NextAuth's JWT refresh.
 *   { alive: false, reason }         — dead session (ACCESS_TOKEN_REFRESH_NEEDED,
 *                                       missing access_token, or HTTP error).
 *                                       Caller should escalate to slow path.
 */
async function callSessionApi(cookies) {
    let res;
    try {
        res = await fetch('https://labs.google/fx/api/auth/session', {
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'Content-Type': 'application/json',
                'Cookie': cookies,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                'Referer': 'https://labs.google/fx/vi/tools/flow/',
            },
        });
    } catch (e) {
        return { alive: false, reason: `fetch error: ${e.message}` };
    }
    if (!res.ok) {
        return { alive: false, reason: `HTTP ${res.status}` };
    }
    let data;
    try {
        data = await res.json();
    } catch (e) {
        return { alive: false, reason: `JSON parse: ${e.message}` };
    }
    // Dead-session ground truth — NextAuth still returns an access_token
    // alongside this error but it's stale and `expires` is frozen in the
    // past. Saving it would just retrigger the refresh loop.
    if (data.error === 'ACCESS_TOKEN_REFRESH_NEEDED') {
        return { alive: false, reason: 'ACCESS_TOKEN_REFRESH_NEEDED' };
    }
    if (!data.access_token) {
        return { alive: false, reason: 'no access_token in response' };
    }
    return { alive: true, access_token: data.access_token };
}

