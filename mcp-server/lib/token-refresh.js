/**
 * Token Auto-Refresh — Extracts fresh Bearer token from Chrome page
 * and updates .env file. No changes to existing code flow.
 *
 * How it works:
 * 1. Chrome page is already on Google Flow (from reCAPTCHA init)
 * 2. Reload the page → triggers auth flow → page JS gets fresh token
 * 3. Intercept outgoing API request → capture Authorization header
 * 4. Write new token to .env + update process.env
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getChromePoolInstance } from './recaptcha.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');

let _refreshing = false;

/**
 * Extract a fresh Bearer token from the Chrome page.
 * The page is already on Google Flow with valid session cookies.
 * We reload → page's JS gets a fresh OAuth token → we intercept it.
 */
export async function extractTokenFromBrowser(instanceId = 'default') {
    const inst = getChromePoolInstance(instanceId);
    if (!inst?.page || !inst?.browser?.isConnected() || !inst?.ready) {
        throw new Error('Chrome page not available for token extraction');
    }

    const page = inst.page;

    // Strategy 1: Intercept outgoing API requests during page reload
    const interceptPromise = new Promise((resolve) => {
        const timeout = setTimeout(() => { cleanup(); resolve(null); }, 20000);

        function onRequest(request) {
            const authHeader = request.headers()['authorization'];
            if (authHeader && authHeader.startsWith('Bearer ')) {
                cleanup();
                resolve(authHeader.replace('Bearer ', ''));
            }
        }

        function cleanup() {
            clearTimeout(timeout);
            try { page.off('request', onRequest); } catch { /* ok */ }
        }

        page.on('request', onRequest);
        page.reload({ waitUntil: 'networkidle2', timeout: 18000 }).catch(() => {});
    });

    const interceptedToken = await interceptPromise;
    if (interceptedToken && interceptedToken.length > 50) {
        console.error(`[TokenRefresh] ✅ Captured token via request interception (${interceptedToken.length} chars)`);
        return interceptedToken;
    }

    // Strategy 2: Use page's auth cookies to call Google's token endpoint directly
    console.error('[TokenRefresh] Interception failed — trying direct token extraction...');
    const directToken = await page.evaluate(async () => {
        try {
            // Google Flow uses Next.js auth → session endpoint returns access token
            const sessionRes = await fetch('/api/credentials', { credentials: 'include' });
            if (sessionRes.ok) {
                const data = await sessionRes.json();
                if (data.accessToken) return data.accessToken;
                if (data.token) return data.token;
            }
        } catch {}

        try {
            // Alternative: check if the app exposes token via __NEXT_DATA__
            const nextData = window.__NEXT_DATA__;
            const token = nextData?.props?.pageProps?.session?.accessToken
                || nextData?.props?.pageProps?.accessToken;
            if (token) return token;
        } catch {}

        try {
            // Alternative: trigger a lightweight API call and intercept via XHR
            // The page's fetch wrapper likely adds Authorization automatically
            const res = await fetch('https://aisandbox-pa.googleapis.com/v1/flow/credits', {
                credentials: 'include',
            });
            // Won't directly give us the token, but may trigger auth refresh
        } catch {}

        return null;
    });

    if (directToken && directToken.length > 50) {
        console.error(`[TokenRefresh] ✅ Extracted token via page context (${directToken.length} chars)`);
        return directToken;
    }

    // Strategy 3: Monkey-patch fetch to capture the next Authorization header
    console.error('[TokenRefresh] Trying fetch monkey-patch strategy...');
    const patchedToken = await page.evaluate(() => {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(null), 15000);
            const originalFetch = window.fetch;
            window.fetch = function(...args) {
                const [url, opts] = args;
                const authHeader = opts?.headers?.['Authorization'] || opts?.headers?.['authorization'];
                if (authHeader && authHeader.startsWith('Bearer ')) {
                    clearTimeout(timeout);
                    window.fetch = originalFetch; // restore
                    resolve(authHeader.replace('Bearer ', ''));
                }
                return originalFetch.apply(this, args);
            };
            // Trigger something that causes the app to make an API call
            window.dispatchEvent(new Event('focus'));
            document.querySelectorAll('button').forEach(b => {
                if (b.textContent.includes('Create') || b.textContent.includes('Generate')) {
                    // Don't click, just trigger hover to wake up the app
                }
            });
        });
    });

    if (patchedToken && patchedToken.length > 50) {
        console.error(`[TokenRefresh] ✅ Captured token via fetch patch (${patchedToken.length} chars)`);
        return patchedToken;
    }

    throw new Error('All token extraction strategies failed');
}

/**
 * Update a single key in the .env file.
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
 * Extract session cookies from Chrome page.
 */
async function extractSessionCookies(instanceId = 'default') {
    const inst = getChromePoolInstance(instanceId);
    if (!inst?.page) return null;

    try {
        const cookies = await inst.page.cookies('https://labs.google', 'https://www.google.com');
        if (cookies.length === 0) return null;
        const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        console.error(`[TokenRefresh] ✅ Extracted ${cookies.length} session cookies`);
        return cookieString;
    } catch (e) {
        console.error(`[TokenRefresh] Failed to extract cookies: ${e.message}`);
        return null;
    }
}

/**
 * Auto-refresh: extract token + cookies from Chrome and update .env.
 * Returns the new token, or null on failure.
 * Prevents concurrent refresh attempts.
 */
export async function refreshToken(instanceId = 'default') {
    if (_refreshing) {
        console.error('[TokenRefresh] Already refreshing, skipping...');
        return null;
    }

    _refreshing = true;
    try {
        console.error('[TokenRefresh] Extracting fresh token from Chrome...');
        const newToken = await extractTokenFromBrowser(instanceId);

        if (newToken && newToken.length > 50) {
            updateEnvKey('GOOGLE_FLOW_TOKEN', newToken);
            console.error('[TokenRefresh] ✅ .env updated with fresh token');

            // Also refresh session cookies
            const cookies = await extractSessionCookies(instanceId);
            if (cookies) {
                updateEnvKey('GOOGLE_FLOW_SESSION_COOKIES', cookies);
                console.error('[TokenRefresh] ✅ .env updated with fresh cookies');
            }

            return newToken;
        }

        console.error('[TokenRefresh] Token too short or empty');
        return null;
    } catch (e) {
        console.error(`[TokenRefresh] Failed: ${e.message}`);
        return null;
    } finally {
        _refreshing = false;
    }
}
