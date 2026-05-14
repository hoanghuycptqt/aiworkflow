/**
 * reCAPTCHA Token Manager — Extracted from Google Flow connector
 *
 * Manages persistent Chrome instances per Google account to fetch
 * fresh reCAPTCHA Enterprise tokens required by all Google Flow APIs.
 *
 * Key design:
 *  - 1 Chrome profile per Google account (keyed by email)
 *  - Profile directories persist on disk for trust score improvement
 *  - Idle timeout auto-closes Chrome after 10 minutes of inactivity
 */

import puppeteer from 'puppeteer-core';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import fetch from 'node-fetch';

const RECAPTCHA_SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
// On macOS: no idle timeout (Chrome stays open for better reCAPTCHA trust + token refresh)
// On Linux/server: 10 min idle → close browser to save RAM
const RECAPTCHA_PAGE_IDLE_TIMEOUT = process.platform === 'darwin' ? 0 : 10 * 60 * 1000;
const RECAPTCHA_BASE_PORT = 9439;  // Different base port from main server (9339)

// Chrome instance pool — 1 persistent profile per Google account (keyed by email)
const _chromePool = new Map();
let _nextPortOffset = 0;

/**
 * Default Chrome path for macOS.
 */
const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * Derive a stable Chrome instance ID from Google account email.
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
 * Get or create a Chrome instance entry in the pool.
 */
function _getOrCreateInstance(instanceId = 'default') {
    if (!_chromePool.has(instanceId)) {
        const uploadDir = process.env.UPLOAD_DIR || './uploads';
        const profileDir = join(uploadDir, `.recaptcha-profile-${instanceId}`);
        console.error(`[reCAPTCHA] 📁 Creating pool entry: account=${instanceId}, profileDir=${profileDir}`);
        _chromePool.set(instanceId, {
            page: null,
            browser: null,
            chromeProcess: null,
            ready: false,
            idleTimer: null,
            initPromise: null,
            port: RECAPTCHA_BASE_PORT + (_nextPortOffset++),
            profileDir,
        });
    } else {
        console.error(`[reCAPTCHA] ♻️ Reusing existing pool entry: account=${instanceId}`);
    }
    return _chromePool.get(instanceId);
}

/**
 * Initialize (or reuse) the reCAPTCHA browser page for a specific instance.
 */
async function _ensureRecaptchaPage(sessionCookies, instanceId = 'default') {
    const inst = _getOrCreateInstance(instanceId);

    // Already initialized and alive
    if (inst.page && inst.browser?.isConnected() && inst.ready) {
        return inst.page;
    }

    // Prevent concurrent initializations for the same instance
    if (inst.initPromise) {
        await inst.initPromise;
        if (inst.page && inst.browser?.isConnected() && inst.ready) {
            return inst.page;
        }
    }

    inst.initPromise = (async () => {
        // Clean up any stale browser connection (but Chrome process may stay alive)
        await closeRecaptchaBrowser(instanceId);

        console.error(`[reCAPTCHA:${instanceId.substring(0, 8)}] Launching Chrome (port: ${inst.port})...`);

        const chromePath = process.env.CHROME_PATH || DEFAULT_CHROME_PATH;
        await mkdir(inst.profileDir, { recursive: true });

        // Launch Chrome natively — NO automation flags
        const args = [
            `--user-data-dir=${inst.profileDir}`,
            `--remote-debugging-port=${inst.port}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--window-size=1280,900',
            '--disable-blink-features=AutomationControlled',
        ];

        if (process.platform === 'linux') {
            args.push(
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--lang=en-US,en',
                '--start-maximized',
            );
            if (!process.env.DISPLAY) {
                process.env.DISPLAY = ':99';
            }
        }

        // Check if Chrome is already running on this port
        let browser = null;
        try {
            const res = await fetch(`http://127.0.0.1:${inst.port}/json/version`);
            if (res.ok) {
                const data = await res.json();
                browser = await puppeteer.connect({
                    browserWSEndpoint: data.webSocketDebuggerUrl,
                    defaultViewport: null,
                });
                console.error(`[reCAPTCHA:${instanceId.substring(0, 8)}] Reusing existing Chrome`);

                // Close all existing pages (stale tabs from previous session)
                const existingPages = await browser.pages();
                console.error(`[reCAPTCHA:${instanceId.substring(0, 8)}] Closing ${existingPages.length} stale page(s)`);
                for (const p of existingPages) {
                    try { await p.close(); } catch { /* ok */ }
                }
            }
        } catch { /* not running, will launch */ }

        if (!browser) {
            const { spawn } = await import('child_process');
            inst.chromeProcess = spawn(chromePath, args, {
                stdio: 'ignore',
                detached: true,
                env: { ...process.env },
            });
            inst.chromeProcess.unref();

            // Wait for Chrome to be ready
            for (let attempt = 0; attempt < 30; attempt++) {
                await new Promise(r => setTimeout(r, 500));
                try {
                    const res = await fetch(`http://127.0.0.1:${inst.port}/json/version`);
                    if (res.ok) {
                        const data = await res.json();
                        browser = await puppeteer.connect({
                            browserWSEndpoint: data.webSocketDebuggerUrl,
                            defaultViewport: null,
                        });
                        break;
                    }
                } catch { /* not ready yet */ }
            }

            if (!browser) {
                if (inst.chromeProcess) inst.chromeProcess.kill();
                throw new Error('Chrome failed to start for reCAPTCHA');
            }

            console.error(`[reCAPTCHA:${instanceId.substring(0, 8)}] ✅ Chrome launched (port: ${inst.port})`);
        }

        inst.browser = browser;

        // Auto-cleanup on unexpected disconnect
        inst.browser.on('disconnected', () => {
            console.error(`[reCAPTCHA:${instanceId.substring(0, 8)}] Browser disconnected`);
            inst.page = null;
            inst.browser = null;
            inst.ready = false;
        });

        const page = await inst.browser.newPage();

        // Parse and set session cookies (optional — profile may already be logged in)
        const cookieParts = sessionCookies ? sessionCookies.split(';').map(c => c.trim()).filter(Boolean) : [];
        const validCookies = [];
        for (const part of cookieParts) {
            const eqIdx = part.indexOf('=');
            if (eqIdx <= 0) continue;
            const name = part.substring(0, eqIdx).trim();
            const value = part.substring(eqIdx + 1).trim();
            if (!name) continue;
            validCookies.push({ name, value });
        }

        if (validCookies.length > 0) {
            const cookiesForPuppeteer = validCookies.flatMap(c => [
                { name: c.name, value: c.value, url: 'https://labs.google' },
                { name: c.name, value: c.value, url: 'https://www.google.com' },
            ]);
            await page.setCookie(...cookiesForPuppeteer);
            console.error(`[reCAPTCHA:${instanceId.substring(0, 8)}] Set ${validCookies.length} cookies`);
        } else {
            console.error(`[reCAPTCHA:${instanceId.substring(0, 8)}] No cookies provided — relying on Chrome profile`);
        }

        // Navigate to Flow page (loads reCAPTCHA Enterprise SDK)
        console.error(`[reCAPTCHA:${instanceId.substring(0, 8)}] Navigating to Google Flow...`);
        await page.goto('https://labs.google/fx/tools/flow/', {
            waitUntil: 'networkidle2',
            timeout: 30000,
        });

        // Check if redirected to login page (session expired)
        const currentUrl = page.url();
        if (currentUrl.includes('accounts.google.com') || currentUrl.includes('/signin')) {
            inst.page = page;
            inst.ready = false;
            console.error(`[reCAPTCHA:${instanceId.substring(0, 8)}] ⚠️ Google login required — session expired`);
            throw new Error(
                '🔐 Google session expired — Chrome profile needs re-login.\n' +
                'Run: node test-token-refresh.js\n' +
                'Then login in the Chrome window that opens.'
            );
        }

        // Wait for grecaptcha.enterprise to be available
        await page.waitForFunction(
            () => typeof grecaptcha !== 'undefined' && typeof grecaptcha.enterprise !== 'undefined' && typeof grecaptcha.enterprise.execute === 'function',
            { timeout: 15000 }
        );

        inst.page = page;
        inst.ready = true;
        console.error(`[reCAPTCHA:${instanceId.substring(0, 8)}] ✅ Page ready (SDK loaded)`);
    })();

    try {
        await inst.initPromise;
    } finally {
        inst.initPromise = null;
    }

    return inst.page;
}

/**
 * Close a specific reCAPTCHA browser instance.
 */
export async function closeRecaptchaBrowser(instanceId = 'default') {
    const inst = _chromePool.get(instanceId);
    if (!inst) return;

    if (inst.idleTimer) {
        clearTimeout(inst.idleTimer);
        inst.idleTimer = null;
    }
    if (inst.browser) {
        try {
            if (inst.chromeProcess) {
                // We own this Chrome process — close everything
                await inst.browser.close();
            } else {
                // We connected to existing Chrome — just disconnect, don't kill it
                inst.browser.disconnect();
            }
        } catch { /* ok */ }
    }
    if (inst.chromeProcess) {
        try { inst.chromeProcess.kill(); } catch { /* ok */ }
        inst.chromeProcess = null;
    }
    inst.page = null;
    inst.browser = null;
    inst.ready = false;
}

/**
 * Reset the idle timer for a specific instance.
 */
function _resetRecaptchaIdleTimer(instanceId = 'default') {
    const inst = _chromePool.get(instanceId);
    if (!inst) return;
    if (inst.idleTimer) clearTimeout(inst.idleTimer);
    if (!RECAPTCHA_PAGE_IDLE_TIMEOUT) return; // 0 = no idle timeout (macOS)
    inst.idleTimer = setTimeout(async () => {
        console.error(`[reCAPTCHA:${instanceId.substring(0, 8)}] Idle timeout — closing browser`);
        await closeRecaptchaBrowser(instanceId);
        _chromePool.delete(instanceId);
    }, RECAPTCHA_PAGE_IDLE_TIMEOUT);
}

/**
 * Fetch a FRESH reCAPTCHA Enterprise token using a specific Chrome instance.
 */
export async function fetchRecaptchaToken(sessionCookies, action = 'IMAGE_GENERATION', instanceId = 'default') {
    if (!sessionCookies) {
        console.error('[reCAPTCHA] No session cookies — will rely on Chrome profile');
    }

    try {
        const page = await _ensureRecaptchaPage(sessionCookies, instanceId);

        const token = await page.evaluate(async (siteKey, act) => {
            return await grecaptcha.enterprise.execute(siteKey, { action: act });
        }, RECAPTCHA_SITE_KEY, action);

        _resetRecaptchaIdleTimer(instanceId);

        if (token && token.length > 50) {
            console.error(`[reCAPTCHA:${instanceId.substring(0, 8)}] ✅ Fresh token (${token.length} chars)`);
            return token;
        }

        console.error(`[reCAPTCHA:${instanceId.substring(0, 8)}] Token too short or empty:`, token?.substring(0, 50));
        return '';

    } catch (e) {
        console.error(`[reCAPTCHA:${instanceId.substring(0, 8)}] Failed to fetch token:`, e.message);
        await closeRecaptchaBrowser(instanceId);
        return '';
    }
}

/**
 * Execute a fetch request INSIDE a specific Puppeteer Chrome page.
 * Falls back to Node.js fetch if browser is not available.
 */
export async function browserFetch(url, token, body, instanceId = 'default') {
    const inst = _chromePool.get(instanceId);
    if (inst?.page && inst?.browser?.isConnected() && inst?.ready) {
        try {
            const result = await inst.page.evaluate(async (fetchUrl, bearerToken, fetchBody) => {
                const res = await fetch(fetchUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'text/plain;charset=UTF-8',
                        'Authorization': `Bearer ${bearerToken}`,
                    },
                    body: fetchBody,
                    credentials: 'include',
                });
                const text = await res.text();
                return { status: res.status, ok: res.ok, body: text };
            }, url, token, JSON.stringify(body));

            console.error(`[BrowserFetch:${instanceId.substring(0, 8)}] Response status: ${result.status}`);
            return result;
        } catch (e) {
            console.error(`[BrowserFetch:${instanceId.substring(0, 8)}] Chrome fetch failed: ${e.message}, falling back`);
        }
    }

    // Fallback to Node.js fetch
    const res = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(token),
        body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, body: text };
}

/**
 * Clear a used reCAPTCHA token via Google's CLR endpoint.
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

/**
 * Build common auth headers (also used by Node.js fetch fallback).
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
 * Get the Chrome pool instance for a given instanceId (used by video download).
 */
export function getChromePoolInstance(instanceId) {
    return _chromePool.get(instanceId);
}

/**
 * Delete a Chrome pool entry (after cleanup).
 */
export function deleteChromePoolEntry(instanceId) {
    _chromePool.delete(instanceId);
}
