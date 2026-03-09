/**
 * ChatGPT Auth Routes
 * 
 * POST /api/chatgpt-auth/check    — Check if credentials are valid (JWT exp)
 * POST /api/chatgpt-auth/refresh  — Launch visible Chrome for re-auth
 */

import { Router } from 'express';
import { prisma } from '../index.js';
import { acquireBrowser, releaseBrowser } from '../services/browser-manager.js';

const router = Router();
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/**
 * Decode JWT payload without verification (just to read exp).
 */
function decodeJWT(token) {
    try {
        const cleanToken = token.replace(/^Bearer\s+/i, '').trim();
        const parts = cleanToken.split('.');
        if (parts.length !== 3) return null;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        return payload;
    } catch (e) {
        return null;
    }
}

/**
 * Parse cookie string into Puppeteer cookie objects.
 */
function parseCookieString(cookieStr) {
    if (!cookieStr) return [];
    return cookieStr.split(';').map(c => {
        const trimmed = c.trim();
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) return null;
        const name = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim();
        if (!name) return null;
        const cookie = { name, value, domain: 'chatgpt.com', path: '/' };
        if (name.startsWith('__Secure-') || name.startsWith('__Host-')) cookie.secure = true;
        return cookie;
    }).filter(Boolean);
}

/**
 * Quick headless check if session cookies are still valid.
 * Launches Chrome, injects cookies, tries /api/auth/session inside browser.
 */
async function validateSession(cookies) {
    const browserKey = `validate_${Date.now()}`;
    let browser;
    try {
        const result = await acquireBrowser(browserKey, {
            headless: 'new',
            args: ['--disable-gpu'],
        });
        browser = result.browser;
        const page = await browser.newPage();
        await page.setUserAgent(USER_AGENT);
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        const cookieObjs = parseCookieString(cookies);
        if (cookieObjs.length > 0) {
            await page.setCookie(...cookieObjs);
        }

        // Navigate to chatgpt.com
        await page.goto('https://chatgpt.com/', { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait for page to fully render (including session expired overlays)
        await new Promise(r => setTimeout(r, 3000));

        // Check if redirected to login
        const url = page.url();
        if (url.includes('auth0') || url.includes('auth.openai') || url.includes('login')) {
            return { sessionValid: false, reason: 'Redirected to login page' };
        }

        // Check page state for session expired or logged out
        const pageState = await page.evaluate(() => {
            const bodyText = document.body.innerText || '';

            // Check for session expired overlay
            if (bodyText.includes('session has expired') && bodyText.includes('log in again')) {
                return 'session_expired';
            }

            // Check for fully logged-out state
            if (bodyText.includes('Sign up for free') ||
                (bodyText.includes('Log in') && bodyText.includes('Sign up') && !bodyText.includes('New chat'))) {
                return 'logged_out';
            }

            // Positive check: is the chat textarea present?
            const textarea = document.querySelector('#prompt-textarea');
            if (!textarea) {
                return 'no_textarea';
            }

            return 'ok';
        });

        console.log(`[ChatGPT Auth] Page state: ${pageState}`);

        if (pageState === 'session_expired') {
            return { sessionValid: false, reason: 'Session expired overlay detected' };
        }
        if (pageState === 'logged_out') {
            return { sessionValid: false, reason: 'Not logged in (logged out state detected)' };
        }
        if (pageState === 'no_textarea') {
            return { sessionValid: false, reason: 'Chat UI not found — possibly not logged in' };
        }

        return { sessionValid: true };
    } catch (e) {
        return { sessionValid: false, reason: e.message };
    } finally {
        await releaseBrowser(browserKey);
    }
}

// ─────────────────────────────────────────────────────────
//  POST /api/chatgpt-auth/check
// ─────────────────────────────────────────────────────────
router.post('/check', async (req, res) => {
    const { credentialId } = req.body;

    if (!credentialId) {
        return res.status(400).json({ error: 'credentialId required' });
    }

    const credential = await prisma.credential.findFirst({
        where: { id: credentialId, userId: req.user.id },
    });

    if (!credential) {
        return res.status(404).json({ error: 'Credential not found' });
    }

    // 1. Check JWT token expiry
    const payload = decodeJWT(credential.token);
    let tokenValid = false;
    let expiresIn = 0;

    if (payload?.exp) {
        const now = Math.floor(Date.now() / 1000);
        expiresIn = payload.exp - now;
        tokenValid = expiresIn > 0;
    }

    // 2. Check session validity (cookies) via quick Puppeteer
    const meta = credential.metadata ? JSON.parse(credential.metadata) : {};
    const cookies = meta.cookies || '';

    console.log('[ChatGPT Auth] Checking session validity...');
    const sessionResult = cookies
        ? await validateSession(cookies)
        : { sessionValid: false, reason: 'No cookies stored' };

    const valid = tokenValid && sessionResult.sessionValid;

    console.log(`[ChatGPT Auth] Token: ${tokenValid ? '✅' : '❌'} | Session: ${sessionResult.sessionValid ? '✅' : '❌'}`);

    res.json({
        valid,
        tokenValid,
        sessionValid: sessionResult.sessionValid,
        expiresAt: payload?.exp ? new Date(payload.exp * 1000).toISOString() : null,
        expiresIn,
        expiresInHuman: tokenValid
            ? `${Math.floor(expiresIn / 3600)}h ${Math.floor((expiresIn % 3600) / 60)}m`
            : 'EXPIRED',
        sessionReason: sessionResult.reason || null,
    });
});


// ─────────────────────────────────────────────────────────
//  POST /api/chatgpt-auth/refresh
// ─────────────────────────────────────────────────────────
//  Opens a VISIBLE Chrome window for the user to log in.
//  After login, captures token + cookies + deviceId.
// ─────────────────────────────────────────────────────────


router.post('/refresh', async (req, res) => {
    const { credentialId } = req.body;

    if (!credentialId) {
        return res.status(400).json({ error: 'credentialId required' });
    }

    const credential = await prisma.credential.findFirst({
        where: { id: credentialId, userId: req.user.id },
    });

    if (!credential) {
        return res.status(404).json({ error: 'Credential not found' });
    }

    const browserKey = `chatgpt_refresh_${req.user.id}`;

    console.log('[ChatGPT Auth] Opening visible Chrome for login...');

    let browser;
    try {
        const result = await acquireBrowser(browserKey, {
            headless: false,
            args: [
                '--window-size=1200,800',
                '--window-position=200,100',
            ],
            defaultViewport: null,
        });
        browser = result.browser;

        const page = await browser.newPage();
        await page.setUserAgent(USER_AGENT);

        // Hide webdriver detection
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        // DON'T inject old cookies — start fresh so user must actually log in
        const existingMeta = credential.metadata ? JSON.parse(credential.metadata) : {};
        const oldToken = credential.token || '';

        // Navigate to ChatGPT login
        await page.goto('https://chatgpt.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });

        console.log('[ChatGPT Auth] Chrome opened. Waiting for user to log in...');

        const MAX_WAIT = 300000; // 5 minutes
        const POLL_INTERVAL = 3000;
        const startTime = Date.now();

        let accessToken = '';
        let deviceId = '';
        let cookies = '';

        while (Date.now() - startTime < MAX_WAIT) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL));

            // Check if browser was closed by user
            try {
                if (!browser.isConnected()) {
                    return res.status(400).json({ error: 'Browser was closed before login completed' });
                }
            } catch (e) {
                return res.status(400).json({ error: 'Browser connection lost' });
            }

            try {
                const currentUrl = page.url();
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                console.log(`[ChatGPT Auth] Poll ${elapsed}s: URL=${currentUrl.substring(0, 60)}`);

                // Skip if still on login/auth page
                if (currentUrl.includes('auth0') || currentUrl.includes('auth.openai') ||
                    currentUrl.includes('/login')) {
                    continue;
                }

                // Check for session expired overlay
                const hasExpiredOverlay = await page.evaluate(() => {
                    const bodyText = document.body.innerText || '';
                    return bodyText.includes('session has expired') && bodyText.includes('log in again');
                });
                if (hasExpiredOverlay) {
                    console.log('[ChatGPT Auth] Session expired overlay still showing, waiting...');
                    continue;
                }

                // Check for logged-out state (Sign up for free button)
                const isLoggedOut = await page.evaluate(() => {
                    const bodyText = document.body.innerText || '';
                    return bodyText.includes('Sign up for free') || bodyText.includes('Log in\nSign up');
                });
                if (isLoggedOut) {
                    continue;
                }

                // Try to get a FRESH session token
                const sessionData = await page.evaluate(async () => {
                    try {
                        const res = await fetch('/api/auth/session', { credentials: 'include' });
                        if (!res.ok) return null;
                        const data = await res.json();
                        return data;
                    } catch (e) {
                        return null;
                    }
                });

                if (sessionData?.accessToken && sessionData.accessToken !== oldToken) {
                    accessToken = sessionData.accessToken;
                    console.log('[ChatGPT Auth] ✅ Got FRESH access token!');

                    // Get all cookies
                    const allCookies = await page.cookies();
                    cookies = allCookies
                        .filter(c => c.domain.includes('chatgpt.com') || c.domain.includes('.chatgpt.com'))
                        .map(c => `${c.name}=${c.value}`)
                        .join('; ');

                    // Get device ID
                    const deviceIdCookie = allCookies.find(c => c.name === 'oai-did');
                    deviceId = deviceIdCookie?.value || existingMeta.deviceId || '';

                    console.log('[ChatGPT Auth] Cookies captured:', cookies.length, 'chars');
                    console.log('[ChatGPT Auth] Device ID:', deviceId);
                    break;
                } else if (sessionData?.accessToken === oldToken) {
                    console.log('[ChatGPT Auth] Got stale token, waiting for fresh one...');
                }
            } catch (e) {
                // Page might be navigating, continue polling
            }
        }

        // Close browser
        await releaseBrowser(browserKey);

        if (!accessToken) {
            return res.status(408).json({ error: 'Login timed out. Please try again.' });
        }

        // Update credential in database
        const newMetadata = {
            ...existingMeta,
            deviceId,
            cookies,
            lastRefreshed: new Date().toISOString(),
        };

        await prisma.credential.update({
            where: { id: credentialId },
            data: {
                token: accessToken,
                metadata: JSON.stringify(newMetadata),
            },
        });

        // Decode new token to get expiry
        const newPayload = decodeJWT(accessToken);
        const expiresAt = newPayload?.exp
            ? new Date(newPayload.exp * 1000).toISOString()
            : null;

        console.log('[ChatGPT Auth] ✅ Credential updated successfully!');

        res.json({
            success: true,
            expiresAt,
            cookiesLength: cookies.length,
            deviceId,
        });

    } catch (err) {
        console.error('[ChatGPT Auth] Error:', err.message);
        await releaseBrowser(browserKey);
        res.status(500).json({ error: err.message });
    }
});

export default router;
