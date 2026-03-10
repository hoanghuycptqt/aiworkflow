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
        // Non-JWT token (ya29.*) — validate via API call or trust recent refresh
        const meta = credential.metadata ? JSON.parse(credential.metadata) : {};

        // If we have tokenExpiresAt from session API, use that
        if (meta.tokenExpiresAt) {
            const expiry = new Date(meta.tokenExpiresAt).getTime();
            expiresIn = Math.floor((expiry - Date.now()) / 1000);
            tokenValid = expiresIn > 0;
        }
        // If refreshed recently (within 5 min), trust the token
        else if (meta.lastRefreshed) {
            const refreshedAt = new Date(meta.lastRefreshed).getTime();
            if (Date.now() - refreshedAt < 5 * 60 * 1000) {
                tokenValid = true;
            }
        }

        if (!tokenValid && !meta.tokenExpiresAt) {
            try {
                const headers = {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${credential.token}`,
                    'Origin': 'https://labs.google',
                    'Referer': 'https://labs.google/',
                };
                if (meta.sessionCookies) {
                    headers['Cookie'] = meta.sessionCookies;
                }
                const testRes = await fetch('https://aisandbox-pa.googleapis.com/v1/flow/uploadImage', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({}),
                });
                tokenValid = testRes.status !== 401 && testRes.status !== 403;
                console.log(`[CredCheck] Google Flow API test: status=${testRes.status}, valid=${tokenValid}`);
            } catch (e) {
                console.log(`[CredCheck] Google Flow API test failed: ${e.message}`);
                tokenValid = false;
            }
        }
    }

    // For google-flow: also check if session cookies exist
    let hasSession = true;
    if (credential.provider === 'google-flow') {
        const gfMeta = credential.metadata ? JSON.parse(credential.metadata) : {};
        hasSession = !!(gfMeta.sessionCookies && gfMeta.sessionCookies.length > 10);
        if (!hasSession) {
            console.log(`[CredCheck] Google Flow: ⚠️ No session cookies found — need refresh`);
        }
    }

    const overallValid = tokenValid && hasSession;

    // For google-flow ya29.* tokens: estimate expiry from tokenExpiresAt or lastRefreshed + 1 hour
    if (credential.provider === 'google-flow' && tokenValid && expiresIn === 0) {
        const gfMeta2 = credential.metadata ? JSON.parse(credential.metadata) : {};
        if (gfMeta2.lastRefreshed) {
            const refreshedAt = new Date(gfMeta2.lastRefreshed).getTime();
            const estimatedExpiry = refreshedAt + 3600 * 1000; // 1 hour
            expiresIn = Math.floor((estimatedExpiry - Date.now()) / 1000);
            if (expiresIn < 0) expiresIn = 0;
        }
    }

    const hours = Math.floor(Math.max(0, expiresIn) / 3600);
    const mins = Math.floor((Math.max(0, expiresIn) % 3600) / 60);

    console.log(`[CredCheck] ${credential.provider} token: ${tokenValid ? '✅' : '❌'} (${hours}h ${mins}m), session: ${hasSession ? '✅' : '❌'}`);

    res.json({
        valid: overallValid,
        tokenValid,
        hasSession,
        reason: !tokenValid ? 'token_expired' : (!hasSession ? 'no_session' : null),
        expiresAt: payload?.exp ? new Date(payload.exp * 1000).toISOString() : (expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null),
        expiresIn,
        expiresInHuman: overallValid ? (expiresIn > 0 ? `${hours}h ${mins}m` : 'Active') : (!tokenValid ? 'EXPIRED' : 'No Session'),
    });
});

// ─────────────────────────────────────────────────────────
//  POST /api/credential-check/google-flow-refresh
// ─────────────────────────────────────────────────────────
//  Calls labs.google/fx/api/auth/session with saved cookies
//  to get a fresh access_token. No browser needed!
// ─────────────────────────────────────────────────────────

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

    const existingMeta = credential.metadata ? JSON.parse(credential.metadata) : {};
    if (!existingMeta.sessionCookies) {
        return res.status(400).json({
            error: 'No session cookies saved. Please add session cookies via the Edit form first.',
        });
    }

    console.log('[GoogleFlow Auth] Refreshing token via session API...');

    try {
        const sessionRes = await fetch('https://labs.google/fx/api/auth/session', {
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'Content-Type': 'application/json',
                'Cookie': existingMeta.sessionCookies,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                'Referer': 'https://labs.google/fx/vi/tools/flow/',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
            },
        });

        if (!sessionRes.ok) {
            console.log(`[GoogleFlow Auth] ❌ Session API returned ${sessionRes.status}`);
            return res.status(400).json({
                error: `Session API returned ${sessionRes.status} — session cookies may be expired. Please update cookies via the Edit form.`,
            });
        }

        const sessionData = await sessionRes.json();

        if (!sessionData.access_token) {
            console.log('[GoogleFlow Auth] ❌ No access_token in session response');
            return res.status(400).json({
                error: 'No access_token in session response — session cookies may be expired.',
            });
        }

        const capturedToken = sessionData.access_token;
        const expiresAt = sessionData.expires || null;

        console.log('[GoogleFlow Auth] ✅ Got fresh token!', capturedToken.substring(0, 30) + '...');
        console.log('[GoogleFlow Auth] Expires:', expiresAt);

        // Update credential in database
        await prisma.credential.update({
            where: { id: credentialId },
            data: {
                token: capturedToken,
                metadata: JSON.stringify({
                    ...existingMeta,
                    projectId: existingMeta.projectId || '',
                    lastRefreshed: new Date().toISOString(),
                    tokenExpiresAt: expiresAt,
                    userName: sessionData.user?.name || existingMeta.userName,
                    userEmail: sessionData.user?.email || existingMeta.userEmail,
                }),
            },
        });

        console.log('[GoogleFlow Auth] ✅ Credentials saved successfully!');

        return res.json({
            success: true,
            expiresAt,
            projectId: existingMeta.projectId || '',
        });

    } catch (e) {
        console.error('[GoogleFlow Auth] Error:', e.message);
        return res.status(500).json({ error: e.message });
    }
});

export default router;
