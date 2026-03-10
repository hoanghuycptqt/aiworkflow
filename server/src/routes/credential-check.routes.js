/**
 * Generic Credential Check Routes
 * 
 * POST /api/credential-check/check — Check if a credential's token is valid (JWT exp)
 * Works for any provider that uses JWT tokens (google-flow, chatgpt, etc.)
 */

import { Router } from 'express';
import { prisma } from '../index.js';
import fetch from 'node-fetch';

const router = Router();

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

// ─────────────────────────────────────────────────────────
//  POST /api/credential-check/token
// ─────────────────────────────────────────────────────────
router.post('/token', async (req, res) => {
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

    // Try JWT decode first
    const payload = decodeJWT(credential.token);
    let tokenValid = false;
    let expiresIn = 0;

    if (payload?.exp) {
        // JWT token — check exp
        const now = Math.floor(Date.now() / 1000);
        expiresIn = payload.exp - now;
        tokenValid = expiresIn > 0;
    } else if (credential.provider === 'google-flow') {
        // Non-JWT token (ya29.*) — validate via API call
        try {
            const testRes = await fetch('https://aisandbox-pa.googleapis.com/v1/flow/uploadImage', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${credential.token}`,
                    'Origin': 'https://labs.google',
                },
                body: JSON.stringify({}), // empty body — will get 400 if auth is valid, 401 if not
            });
            // 401/403 = token expired, anything else (400, 200) = token is valid
            tokenValid = testRes.status !== 401 && testRes.status !== 403;
            console.log(`[CredCheck] Google Flow API test: status=${testRes.status}, valid=${tokenValid}`);
        } catch (e) {
            console.log(`[CredCheck] Google Flow API test failed: ${e.message}`);
            tokenValid = false;
        }
    }

    // For google-flow: also check if session cookies exist (needed for video download)
    let hasSession = true;
    if (credential.provider === 'google-flow') {
        const meta = credential.metadata ? JSON.parse(credential.metadata) : {};
        hasSession = !!(meta.sessionCookies && meta.sessionCookies.length > 10);
        if (!hasSession) {
            console.log(`[CredCheck] Google Flow: ⚠️ No session cookies found — need refresh`);
        }
    }

    const overallValid = tokenValid && hasSession;

    const hours = Math.floor(Math.max(0, expiresIn) / 3600);
    const mins = Math.floor((Math.max(0, expiresIn) % 3600) / 60);

    console.log(`[CredCheck] ${credential.provider} token: ${tokenValid ? '✅' : '❌'} (${hours}h ${mins}m), session: ${hasSession ? '✅' : '❌'}`);

    res.json({
        valid: overallValid,
        tokenValid,
        hasSession,
        reason: !tokenValid ? 'token_expired' : (!hasSession ? 'no_session' : null),
        expiresAt: payload?.exp ? new Date(payload.exp * 1000).toISOString() : null,
        expiresIn,
        expiresInHuman: overallValid ? (expiresIn > 0 ? `${hours}h ${mins}m` : 'Active') : (!tokenValid ? 'EXPIRED' : 'No Session'),
    });
});

// ─────────────────────────────────────────────────────────
//  POST /api/credential-check/google-flow-refresh
// ─────────────────────────────────────────────────────────
//  Headless auto-refresh: injects saved session cookies into
//  invisible Chrome, navigates to Google Flow, intercepts
//  the fresh Bearer token automatically. No user interaction.
// ─────────────────────────────────────────────────────────

import { acquireBrowser, releaseBrowser } from '../services/browser-manager.js';

/**
 * Parse a cookie string ("name1=val1; name2=val2") into Puppeteer cookie objects.
 */
function parseGoogleCookies(cookieStr) {
    if (!cookieStr) return [];
    return cookieStr.split(';').map(c => {
        const trimmed = c.trim();
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) return null;
        return {
            name: trimmed.substring(0, eqIdx).trim(),
            value: trimmed.substring(eqIdx + 1).trim(),
            domain: '.google',
            path: '/',
        };
    }).filter(Boolean);
}

router.post('/google-flow-refresh', async (req, res) => {
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

    // Check if we have session cookies to inject
    const existingMeta = credential.metadata ? JSON.parse(credential.metadata) : {};
    if (!existingMeta.sessionCookies) {
        return res.status(400).json({
            error: 'No session cookies saved. Please manually update your Google Flow credential with a fresh Bearer token and cookies via the Edit form.',
        });
    }

    const browserKey = `gflow_refresh_${req.user.id}`;

    console.log('[GoogleFlow Auth] Starting headless auto-refresh with saved session cookies...');

    let browser;
    try {
        const result = await acquireBrowser(browserKey, {
            headless: 'new',
            args: ['--disable-gpu'],
        });
        browser = result.browser;

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36');

        // Hide webdriver detection
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        // Inject saved session cookies BEFORE navigation
        const cookieObjs = parseGoogleCookies(existingMeta.sessionCookies);
        if (cookieObjs.length > 0) {
            await page.setCookie(...cookieObjs);
            console.log(`[GoogleFlow Auth] Injected ${cookieObjs.length} session cookies`);
        }

        // Enable request interception to capture Bearer token
        let capturedToken = '';
        let capturedProjectId = '';

        await page.setRequestInterception(true);
        page.on('request', request => {
            const url = request.url();
            const headers = request.headers();

            // Look for requests to Google Flow API with Bearer token
            if (url.includes('aisandbox-pa.googleapis.com') && headers.authorization) {
                const auth = headers.authorization;
                if (auth.startsWith('Bearer ') && auth.length > 50) {
                    capturedToken = auth.replace('Bearer ', '');
                    console.log('[GoogleFlow Auth] ✅ Captured Bearer token!', capturedToken.substring(0, 30) + '...');

                    // Try to extract projectId from URL
                    const projectMatch = url.match(/projects\/([^/]+)/);
                    if (projectMatch) {
                        capturedProjectId = projectMatch[1];
                        console.log('[GoogleFlow Auth] ✅ Captured projectId:', capturedProjectId);
                    }
                }
            }

            request.continue();
        });

        // Navigate to Google Flow
        console.log('[GoogleFlow Auth] Navigating to Google Flow...');
        await page.goto('https://labs.google/fx/vi/tools/flow/', {
            waitUntil: 'networkidle2',
            timeout: 60000,
        });

        // Wait for page to settle and trigger API calls
        await new Promise(r => setTimeout(r, 5000));

        // If no token captured yet, try clicking around to trigger API calls
        if (!capturedToken) {
            console.log('[GoogleFlow Auth] No token from initial load, waiting more...');
            await new Promise(r => setTimeout(r, 10000));
        }

        // Poll for captured token (shorter timeout since it should be automatic)
        const MAX_WAIT = 60000; // 1 minute
        const POLL_INTERVAL = 2000;
        const startTime = Date.now();

        while (!capturedToken && Date.now() - startTime < MAX_WAIT) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL));
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            if (elapsed % 10 === 0) {
                console.log(`[GoogleFlow Auth] Waiting for token... ${elapsed}s elapsed`);
            }
        }

        if (!capturedToken) {
            await releaseBrowser(browserKey);
            console.log('[GoogleFlow Auth] ❌ Could not capture token — session cookies may be expired');
            return res.status(408).json({
                error: 'Could not auto-refresh — session cookies may be expired. Please manually update credentials via the Edit form.',
            });
        }

        console.log('[GoogleFlow Auth] Token captured! Saving...');

        // Try to extract projectId from page URL
        if (!capturedProjectId) {
            try {
                const pageUrl = page.url();
                const urlMatch = pageUrl.match(/projects\/([^/]+)/);
                if (urlMatch) capturedProjectId = urlMatch[1];
            } catch (e) { /* ignore */ }
        }

        // Capture updated session cookies
        let sessionCookies = existingMeta.sessionCookies;
        try {
            const cookies = await page.cookies('https://labs.google');
            if (cookies.length > 0) {
                sessionCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                console.log(`[GoogleFlow Auth] ✅ Updated ${cookies.length} session cookies`);
            }
        } catch (e) {
            console.warn('[GoogleFlow Auth] Could not capture cookies:', e.message);
        }

        // Close browser
        await releaseBrowser(browserKey);

        // Update credential in database
        await prisma.credential.update({
            where: { id: credentialId },
            data: {
                token: capturedToken,
                metadata: JSON.stringify({
                    ...existingMeta,
                    projectId: capturedProjectId || existingMeta.projectId || '',
                    sessionCookies,
                    lastRefreshed: new Date().toISOString(),
                }),
            },
        });

        // Decode JWT to get expiry
        const payload = decodeJWT(capturedToken);
        const expiresAt = payload?.exp ? new Date(payload.exp * 1000).toISOString() : null;

        console.log('[GoogleFlow Auth] ✅ Credentials saved successfully!');

        return res.json({
            success: true,
            expiresAt,
            projectId: capturedProjectId || existingMeta.projectId || '',
        });

    } catch (e) {
        console.error('[GoogleFlow Auth] Error:', e.message);
        await releaseBrowser(browserKey);
        return res.status(500).json({ error: e.message });
    }
});

export default router;
