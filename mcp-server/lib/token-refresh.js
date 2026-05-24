/**
 * Token Auto-Refresh — Broker-backed (Plan v4.3 / v5.0).
 *
 * Triggered by handleTokenRefresh() in google-flow-api.js when an API call
 * returns 401. Flow:
 *   1. Call broker /refresh-cookies — broker re-navigates Flow page with
 *      existing session, returns fresh cookies (or needs_relogin if session
 *      truly expired).
 *   2. Call /api/auth/session via pure Node fetch with fresh cookies — returns
 *      new access_token + expires timestamp.
 *   3. Write both to mcp-server/.env (cache for subsequent MCP server startup).
 *      Also updates process.env for the running process.
 *
 * No Chrome page interception (legacy approach) — broker's Firefox session
 * handles the heavy lifting via its persistent state. Simpler + more reliable.
 *
 * Concurrency: `_refreshing` flag prevents two parallel refreshes from
 * stomping on .env or hammering Google's session API.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fetch from 'node-fetch';
import { broker, BrokerError } from './broker-client.js';

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
        // 1. Fresh cookies from broker (re-nav Flow page with current session).
        let cookies;
        try {
            const res = await broker.refreshCookies(accountId);
            if (res.status === 'needs_relogin') {
                console.error('[TokenRefresh] ❌ Session truly expired — needs full re-login. '
                    + 'Cookies in .env are past NextAuth maxAge ceiling (~60 days). '
                    + 'Extract fresh cookies from a logged-in browser and update mcp-server/.env.');
                return null;
            }
            if (res.status !== 'ok' || !res.cookies) {
                console.error(`[TokenRefresh] Unexpected broker response: ${JSON.stringify(res).substring(0, 200)}`);
                return null;
            }
            cookies = res.cookies;
        } catch (e) {
            const msg = e instanceof BrokerError ? `${e.status || ''}: ${e.message}` : e.message;
            console.error(`[TokenRefresh] Broker refresh failed: ${msg}`);
            return null;
        }

        // 2. Fresh bearer token via Node fetch to /api/auth/session. Same pattern
        //    as VPS server's ensureFreshToken — broker not needed for this step.
        const sessionRes = await fetch('https://labs.google/fx/api/auth/session', {
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'Content-Type': 'application/json',
                'Cookie': cookies,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                'Referer': 'https://labs.google/fx/vi/tools/flow/',
            },
        });
        if (!sessionRes.ok) {
            console.error(`[TokenRefresh] Session API returned ${sessionRes.status}`);
            return null;
        }
        const data = await sessionRes.json();
        // Ground-truth dead-session signal — NextAuth still returns an access_token
        // alongside this error, but the token is dead and `expires` freezes at the
        // last valid timestamp. The cookies broker just harvested are the
        // post-rotation JWT that triggered this; writing them back to .env would
        // perpetuate the loop. Skip the .env write, escalate to profile recovery.
        // See commit c1d0314 (server-side analogue) and incident 2026-05-24.
        if (data.error === 'ACCESS_TOKEN_REFRESH_NEEDED') {
            console.error('[TokenRefresh] ⚠️ Dead session from broker refresh — '
                + 'attempting recovery from Firefox profile…');
            const recovered = await recoverFromProfile(accountId);
            if (recovered) return recovered;
            console.error('[TokenRefresh] ❌ Profile recovery failed — manual re-login '
                + 'required (python-broker/scripts/manual-login.sh)');
            return null;
        }
        if (!data.access_token) {
            console.error('[TokenRefresh] No access_token in session response');
            return null;
        }

        // 3. Persist to .env (subsequent MCP server startups read this) +
        //    process.env (this running process picks it up immediately).
        updateEnvKey('GOOGLE_FLOW_SESSION_COOKIES', cookies);
        updateEnvKey('GOOGLE_FLOW_TOKEN', data.access_token);
        console.error('[TokenRefresh] ✅ .env updated with fresh cookies + token');

        return data.access_token;
    } catch (e) {
        console.error(`[TokenRefresh] Failed: ${e.message}`);
        return null;
    } finally {
        _refreshing = false;
    }
}

/**
 * Recovery path when broker's normal refresh produced a dead session.
 *
 * Pulls cookies straight from the broker's standalone Firefox profile
 * (/app/firefox-profile inside the container, populated by manual-login.sh).
 * The profile is NEVER touched by broker's ephemeral mode, so its
 * `__Secure-next-auth.session-token` survives whatever rotation incident
 * killed the .env cookies. We:
 *   1. Ask broker for the profile's cookies.
 *   2. Validate by calling /fx/api/auth/session — if THIS too returns
 *      ACCESS_TOKEN_REFRESH_NEEDED, profile JWT is also dead (Google
 *      actually revoked it, or it's past the ~60-day NextAuth maxAge),
 *      and only a fresh interactive login can recover.
 *   3. Persist fresh cookies + access_token to .env + process.env.
 *   4. Close the broker session — its in-memory Session.cookies still hold
 *      the dead-JWT seed from step "before recovery", and its Firefox page
 *      is on a redirected-to-signin URL with grecaptcha unloaded. Closing
 *      forces a clean re-init on the next caller request, picking up the
 *      fresh process.env cookies via recaptcha.js's process.env preference.
 *
 * Returns the fresh access_token on success, or null on any failure.
 *
 * Caller (refreshToken) holds the `_refreshing` flag, so this is single-flight.
 */
async function recoverFromProfile(accountId) {
    let cookies;
    try {
        const res = await broker.cookiesFromProfile(accountId);
        if (res.status === 'no_profile') {
            console.error('[TokenRefresh][recover] Broker has no Firefox profile available '
                + '(VPS deployment, or manual-login never ran).');
            return null;
        }
        if (res.status === 'no_session_token') {
            console.error('[TokenRefresh][recover] Profile present but no session-token — '
                + 'manual-login likely incomplete.');
            return null;
        }
        if (res.status !== 'ok' || !res.cookies) {
            console.error(`[TokenRefresh][recover] Unexpected broker response: ${JSON.stringify(res).substring(0, 200)}`);
            return null;
        }
        cookies = res.cookies;
    } catch (e) {
        const msg = e instanceof BrokerError ? `${e.status || ''}: ${e.message}` : e.message;
        console.error(`[TokenRefresh][recover] cookies-from-profile call failed: ${msg}`);
        return null;
    }

    // Validate the profile cookies by calling /session — must return a real
    // access_token with no error. If error === ACCESS_TOKEN_REFRESH_NEEDED,
    // the profile JWT itself is dead and only manual re-login can recover.
    let sessionData;
    try {
        const sessionRes = await fetch('https://labs.google/fx/api/auth/session', {
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'Content-Type': 'application/json',
                'Cookie': cookies,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                'Referer': 'https://labs.google/fx/vi/tools/flow/',
            },
        });
        if (!sessionRes.ok) {
            console.error(`[TokenRefresh][recover] /session returned ${sessionRes.status} for profile cookies`);
            return null;
        }
        sessionData = await sessionRes.json();
    } catch (e) {
        console.error(`[TokenRefresh][recover] /session call failed: ${e.message}`);
        return null;
    }
    if (sessionData.error === 'ACCESS_TOKEN_REFRESH_NEEDED') {
        console.error('[TokenRefresh][recover] Profile JWT also dead — Google revoked '
            + 'refresh_token, manual re-login required.');
        return null;
    }
    if (!sessionData.access_token) {
        console.error('[TokenRefresh][recover] Profile /session has no access_token');
        return null;
    }

    // Profile cookies validate. Commit them to disk + process.env so the next
    // call (and next MCP server startup) sees fresh state.
    updateEnvKey('GOOGLE_FLOW_SESSION_COOKIES', cookies);
    updateEnvKey('GOOGLE_FLOW_TOKEN', sessionData.access_token);

    // Reset + re-prime the broker session: the existing one is stuck on the
    // post-rotation dead state (in-memory cookies stale, Firefox page on
    // signin redirect with grecaptcha unloaded). Close it, then immediately
    // re-init with the fresh profile cookies so the next caller hit
    // (flow-fetch or recaptcha-token) lands on an already-warm session with
    // fresh auth — no anonymous-Firefox detour, no second cold launch.
    try {
        await broker.close(accountId);
    } catch (e) {
        const msg = e instanceof BrokerError ? `${e.status || ''}: ${e.message}` : e.message;
        console.error(`[TokenRefresh][recover] broker.close non-fatal error: ${msg}`);
    }
    try {
        await broker.ensureSession(accountId, cookies);
    } catch (e) {
        // .env is already fresh; immediate retry may need to cold-launch on
        // the next call, but it'll still succeed there. Log + proceed.
        const msg = e instanceof BrokerError ? `${e.status || ''}: ${e.message}` : e.message;
        console.error(`[TokenRefresh][recover] broker re-prime failed (next call will cold-launch): ${msg}`);
    }

    console.error('[TokenRefresh][recover] ✅ Recovered from Firefox profile '
        + '(broker re-primed, .env + process.env updated)');
    return sessionData.access_token;
}
