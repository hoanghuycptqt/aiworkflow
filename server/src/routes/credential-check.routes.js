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
//  Opens a VISIBLE Chrome window to labs.google/fx
//  Intercepts network requests to capture Bearer token + projectId
// ─────────────────────────────────────────────────────────

import { acquireBrowser, releaseBrowser } from '../services/browser-manager.js';

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

    const browserKey = `gflow_refresh_${req.user.id}`;

    console.log('[GoogleFlow Auth] Opening visible Chrome for login...');

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

        // Hide webdriver detection
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

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
        await page.goto('https://labs.google/fx/vi/tools/flow/', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });

        console.log('[GoogleFlow Auth] Chrome opened. Navigate to Flow and interact to trigger API calls...');

        // Poll for captured token
        const MAX_WAIT = 300000; // 5 minutes
        const POLL_INTERVAL = 2000;
        const startTime = Date.now();

        while (Date.now() - startTime < MAX_WAIT) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL));

            // Check if browser was closed
            try {
                if (!browser.isConnected()) {
                    return res.status(400).json({ error: 'Browser was closed before token was captured' });
                }
            } catch (e) {
                return res.status(400).json({ error: 'Browser connection lost' });
            }

            const elapsed = Math.round((Date.now() - startTime) / 1000);
            if (elapsed % 10 === 0) {
                console.log(`[GoogleFlow Auth] Waiting for token... ${elapsed}s elapsed`);
            }

            if (capturedToken) {
                console.log('[GoogleFlow Auth] Token captured! Saving...');

                // Try to extract projectId from page if not captured from request
                if (!capturedProjectId) {
                    try {
                        const pageUrl = page.url();
                        const urlMatch = pageUrl.match(/projects\/([^/]+)/);
                        if (urlMatch) capturedProjectId = urlMatch[1];
                    } catch (e) { /* ignore */ }
                }

                // Parse existing metadata
                const existingMeta = credential.metadata ? JSON.parse(credential.metadata) : {};

                // Capture session cookies from labs.google for video download
                let sessionCookies = '';
                try {
                    const cookies = await page.cookies('https://labs.google');
                    sessionCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                    console.log(`[GoogleFlow Auth] ✅ Captured ${cookies.length} cookies from labs.google`);
                } catch (e) {
                    console.warn('[GoogleFlow Auth] Could not capture cookies:', e.message);
                }

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

                // Show success message in browser before closing
                try {
                    await page.evaluate(() => {
                        document.title = '✅ Token captured! Closing in 3s...';
                    });
                } catch (e) { /* ignore */ }
                await new Promise(r => setTimeout(r, 3000));

                // Close browser
                await releaseBrowser(browserKey);

                console.log('[GoogleFlow Auth] ✅ Credentials saved successfully!');

                return res.json({
                    success: true,
                    expiresAt,
                    projectId: capturedProjectId || existingMeta.projectId || '',
                });
            }
        }

        // Timeout
        await releaseBrowser(browserKey);

        return res.status(408).json({ error: 'Timeout — no token captured. Make sure to interact with Google Flow to trigger API calls.' });

    } catch (e) {
        console.error('[GoogleFlow Auth] Error:', e.message);
        await releaseBrowser(browserKey);
        return res.status(500).json({ error: e.message });
    }
});

export default router;
