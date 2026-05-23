/**
 * reCAPTCHA Token Manager — Broker-backed (Plan v4.3 / v5.0).
 *
 * Public API preserved from the legacy Chrome-based implementation so callers
 * in `tools/*.js` and `lib/google-flow-api.js` don't need to change. Internals
 * now delegate to `lib/broker-client.js` which talks to the Python broker
 * (Docker Desktop container running invisible_playwright Firefox patched).
 *
 * Pure-Node helpers that don't need a browser are kept as-is here:
 *   - getAccountInstanceId(credentials) — derive accountId from email
 *   - buildHeaders(token) — standard auth headers
 *   - clearRecaptchaToken(usedToken) — Node fetch to recaptcha CLR endpoint
 *
 * Chrome-dependent functions become broker shims:
 *   - fetchRecaptchaToken → broker.ensureSession + recaptchaToken
 *   - browserFetch → broker.flowFetch
 *   - reloadRecaptchaPage → broker.reload
 *   - closeRecaptchaBrowser → broker.close
 *   - getChromePoolInstance / deleteChromePoolEntry → no-op stubs (return null)
 *
 * See MIGRATION-MAC-MCP.md for migration details. The old Chrome implementation
 * has been removed; if you need to revert, `git restore lib/recaptcha.js` at
 * commit before this change.
 */

import fetch from 'node-fetch';
import { broker, BrokerError } from './broker-client.js';

// ─── Pure helpers (unchanged from legacy) ────────────────────────────────

/**
 * Derive a stable instance ID from Google account email. Used as the broker
 * session key (the broker pools one Firefox session per accountId).
 */
export function getAccountInstanceId(credentials) {
    let meta = credentials?.metadata;
    if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { meta = {}; }
    }
    const email = meta?.userEmail;
    if (email) {
        return email.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    }
    console.error('[reCAPTCHA] ⚠️ No userEmail in credentials.metadata — using default profile');
    return 'default';
}

/**
 * Standard auth headers for Google Flow API requests. Used both browser-side
 * (via broker.flowFetch) and Node-side (e.g. for /api/auth/session in token-refresh).
 */
export function buildHeaders(token) {
    return {
        'Content-Type': 'text/plain;charset=UTF-8',
        'Authorization': `Bearer ${token}`,
        'Origin': 'https://labs.google',
        'Referer': 'https://labs.google/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    };
}

/**
 * Tell Google's reCAPTCHA Enterprise to clear a used token. Pure Node fetch,
 * no browser involved. Best-effort — failures are logged but don't throw.
 */
export async function clearRecaptchaToken(usedToken) {
    if (!usedToken) return;
    try {
        const res = await fetch('https://www.google.com/recaptcha/enterprise/clr', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-protobuf',
                'Origin': 'https://labs.google',
                'Referer': 'https://labs.google/',
            },
            body: usedToken,
        });
        console.error(`[reCAPTCHA] CLR sent (status=${res.status})`);
    } catch (e) {
        console.error('[reCAPTCHA] CLR call failed:', e.message);
    }
}

// ─── Broker-backed shims (same signatures, new implementation) ────────────

/**
 * Mint a fresh reCAPTCHA Enterprise token for the given account. The broker
 * ensures a Firefox session with the provided cookies is initialized, then
 * runs grecaptcha.enterprise.execute() in-browser.
 */
export async function fetchRecaptchaToken(sessionCookies, action = 'IMAGE_GENERATION', instanceId = 'default') {
    await broker.ensureSession(instanceId, sessionCookies);
    const res = await broker.recaptchaToken(instanceId, action);
    return res.token;
}

/**
 * Browser-side fetch — Google Flow APIs only accept calls originating from a
 * page session with valid cookies + recent reCAPTCHA. Broker runs the fetch
 * inside its Firefox page context.
 */
export async function browserFetch(url, token, body, instanceId = 'default') {
    return broker.flowFetch(instanceId, url, token, body);
}

/**
 * Reload the Flow page to recover from sticky SDK failures (e.g. transient
 * grecaptcha errors). Doesn't rotate context — for full rotation, the broker
 * does that internally @ 15 requests.
 */
export async function reloadRecaptchaPage(instanceId = 'default') {
    return broker.reload(instanceId);
}

/**
 * Close the broker session for this account (DELETE /sessions/{id}). Broker
 * tears down Firefox and removes the session from the pool. Idempotent.
 */
export async function closeRecaptchaBrowser(instanceId = 'default') {
    try {
        await broker.close(instanceId);
    } catch (e) {
        if (e instanceof BrokerError && e.status === 404) return; // already gone
        console.error(`[reCAPTCHA] close failed for ${instanceId}:`, e.message);
    }
}

/**
 * Legacy callers (token-refresh.js before refactor) used this to access the
 * Chrome pool entry directly. After migration, broker manages all browser
 * state — no in-process pool exists. Return null so callers can detect and
 * fall back to broker API.
 */
export function getChromePoolInstance(_instanceId) {
    return null;
}

/**
 * No-op — broker manages its own pool lifecycle via close(). Kept for API
 * compatibility with legacy callers.
 */
export function deleteChromePoolEntry(_instanceId) {
    // intentionally empty
}
