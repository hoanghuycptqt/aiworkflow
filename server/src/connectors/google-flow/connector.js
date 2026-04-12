/**
 * Google Flow Connector — Real Reverse-Engineered API
 *
 * Based on captured network traffic from labs.google/fx/tools/flow/
 *
 * Image Generation:
 *   POST https://aisandbox-pa.googleapis.com/v1/flow/uploadImage
 *   POST https://aisandbox-pa.googleapis.com/v1/projects/{projectId}/flowMedia:batchGenerateImages
 *
 * Video Generation (captured separately — see VideoConnector notes):
 *   POST https://aisandbox-pa.googleapis.com/v1/projects/{projectId}/flowMedia:generateVideo (estimated)
 *
 * Auth: Bearer token from active Google session (Authorization header)
 * Project ID: stored in credential metadata (extracted from URL pattern)
 */

import { BaseConnector } from '../base-connector.js';
import { writeFile, readFile, mkdir, unlink } from 'fs/promises';
import { join, extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import https from 'https';
import { prisma } from '../../index.js';
import { CHROME_PATH } from '../../services/browser-manager.js';
import { syncSiblingCredentials } from '../../services/credential-sync.js';
import puppeteer from 'puppeteer-core';

const API_BASE = 'https://aisandbox-pa.googleapis.com';
const TOOL = 'PINHOLE';

/**
 * Check if Google Flow token is expired or near expiry (< 5 min).
 * If so, call the session API to get a fresh token and update DB.
 * Returns the (possibly refreshed) token and updated credentials object.
 */
async function ensureFreshToken(credentials) {
    if (!credentials?.token || !credentials?.metadata?.sessionCookies) {
        return credentials; // Can't refresh without cookies, return as-is
    }

    const meta = credentials.metadata || {};
    let needsRefresh = false;

    // Check tokenExpiresAt (set by session API)
    if (meta.tokenExpiresAt) {
        const expiresAt = new Date(meta.tokenExpiresAt).getTime();
        const remainingMs = expiresAt - Date.now();
        const remainingMin = Math.floor(remainingMs / 60000);

        if (remainingMs <= 5 * 60 * 1000) { // < 5 minutes
            console.log(`[GoogleFlow] Token expires in ${remainingMin}m — refreshing...`);
            needsRefresh = true;
        }
    }
    // Check lastRefreshed + 1 hour (fallback for tokens without tokenExpiresAt)
    else if (meta.lastRefreshed) {
        const refreshedAt = new Date(meta.lastRefreshed).getTime();
        const elapsed = Date.now() - refreshedAt;
        if (elapsed > 55 * 60 * 1000) { // > 55 minutes (5 min buffer before 1h expiry)
            console.log(`[GoogleFlow] Token refreshed ${Math.round(elapsed / 60000)}m ago — refreshing...`);
            needsRefresh = true;
        }
    }

    if (!needsRefresh) return credentials;

    try {
        const sessionRes = await fetch('https://labs.google/fx/api/auth/session', {
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'Content-Type': 'application/json',
                'Cookie': meta.sessionCookies,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                'Referer': 'https://labs.google/fx/vi/tools/flow/',
            },
        });

        if (!sessionRes.ok) {
            console.warn(`[GoogleFlow] Session API returned ${sessionRes.status} — using existing token`);
            return credentials;
        }

        const sessionData = await sessionRes.json();
        if (!sessionData.access_token) {
            console.warn('[GoogleFlow] No access_token in session response — using existing token');
            return credentials;
        }

        const newToken = sessionData.access_token;
        const expiresAt = sessionData.expires || null;

        console.log('[GoogleFlow] ✅ Auto-refreshed token!', newToken.substring(0, 30) + '...');
        console.log('[GoogleFlow] New expiry:', expiresAt);

        // Update DB
        const newMeta = {
            ...meta,
            lastRefreshed: new Date().toISOString(),
            tokenExpiresAt: expiresAt,
            userName: sessionData.user?.name || meta.userName,
            userEmail: sessionData.user?.email || meta.userEmail,
        };

        await prisma.credential.update({
            where: { id: credentials.id },
            data: {
                token: newToken,
                metadata: JSON.stringify(newMeta),
            },
        });

        // Sync to sibling credentials sharing the same Google account
        await syncSiblingCredentials(credentials.id, newToken, newMeta);

        // Return updated credentials
        return {
            ...credentials,
            token: newToken,
            metadata: newMeta,
        };

    } catch (e) {
        console.warn('[GoogleFlow] Auto-refresh failed:', e.message, '— using existing token');
        return credentials;
    }
}

// ─────────────────────────────────────────────────────────
//  reCAPTCHA Token Manager — Fresh token per API call
//  Keeps a Puppeteer page alive to avoid relaunching browser
//  every time. Each call to fetchRecaptchaToken() returns a
//  FRESH token (tokens are single-use by Google).
// ─────────────────────────────────────────────────────────

const RECAPTCHA_SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
const RECAPTCHA_PAGE_IDLE_TIMEOUT = 10 * 60 * 1000; // 10 min idle → close browser

let _recaptchaPage = null;       // Persistent Puppeteer page
let _recaptchaBrowser = null;    // Persistent browser instance
let _recaptchaIdleTimer = null;  // Auto-close timer
let _recaptchaReady = false;     // SDK loaded flag
let _recaptchaInitPromise = null; // Prevents concurrent initializations
let _recaptchaChromeProcess = null; // Native Chrome process
const RECAPTCHA_DEBUG_PORT = 9339;  // Separate port from cookie harvester

// Global mutex for reCAPTCHA token generation — prevents parallel jobs from
// flooding the token endpoint and triggering rate limits
let _tokenMutexQueue = Promise.resolve();
let _lastTokenTime = 0;
const TOKEN_MIN_INTERVAL = 3000; // Minimum 3s between token generations

/**
 * Initialize (or reuse) the reCAPTCHA browser page.
 * Uses NATIVE Chrome launch (not puppeteer.launch) — same approach as cookie harvester.
 * This avoids automation detection flags that cause low reCAPTCHA scores.
 */
async function _ensureRecaptchaPage(sessionCookies) {
    // Already initialized and alive
    if (_recaptchaPage && _recaptchaBrowser?.isConnected() && _recaptchaReady) {
        return _recaptchaPage;
    }

    // Prevent concurrent initializations
    if (_recaptchaInitPromise) {
        await _recaptchaInitPromise;
        if (_recaptchaPage && _recaptchaBrowser?.isConnected() && _recaptchaReady) {
            return _recaptchaPage;
        }
    }

    _recaptchaInitPromise = (async () => {
        // Clean up any stale browser
        await _closeRecaptchaBrowser();

        console.log('[reCAPTCHA] Launching NATIVE Chrome for token generation...');

        const chromePath = process.env.CHROME_PATH || CHROME_PATH;
        const profileDir = join(process.cwd(), 'uploads', '.recaptcha-profile');
        await mkdir(profileDir, { recursive: true });

        // Launch Chrome natively — NO automation flags (same as cookie harvester)
        const args = [
            `--user-data-dir=${profileDir}`,
            `--remote-debugging-port=${RECAPTCHA_DEBUG_PORT}`,
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
            const res = await fetch(`http://127.0.0.1:${RECAPTCHA_DEBUG_PORT}/json/version`);
            if (res.ok) {
                const data = await res.json();
                browser = await puppeteer.connect({
                    browserWSEndpoint: data.webSocketDebuggerUrl,
                    defaultViewport: null,
                });
                console.log('[reCAPTCHA] Reusing existing Chrome instance');
            }
        } catch { /* not running, will launch */ }

        if (!browser) {
            const { spawn } = await import('child_process');
            _recaptchaChromeProcess = spawn(chromePath, args, {
                stdio: 'ignore',
                detached: true,
                env: { ...process.env },
            });
            _recaptchaChromeProcess.unref();

            // Wait for Chrome to be ready
            for (let attempt = 0; attempt < 30; attempt++) {
                await new Promise(r => setTimeout(r, 500));
                try {
                    const res = await fetch(`http://127.0.0.1:${RECAPTCHA_DEBUG_PORT}/json/version`);
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
                if (_recaptchaChromeProcess) _recaptchaChromeProcess.kill();
                throw new Error('Chrome failed to start for reCAPTCHA');
            }

            console.log(`[reCAPTCHA] ✅ Native Chrome launched & connected via CDP (port: ${RECAPTCHA_DEBUG_PORT})`);
        }

        _recaptchaBrowser = browser;

        // Auto-cleanup on unexpected disconnect
        _recaptchaBrowser.on('disconnected', () => {
            console.log('[reCAPTCHA] Browser disconnected unexpectedly');
            _recaptchaPage = null;
            _recaptchaBrowser = null;
            _recaptchaReady = false;
        });

        const page = await _recaptchaBrowser.newPage();

        // Parse and set session cookies
        const cookieParts = sessionCookies.split(';').map(c => c.trim()).filter(Boolean);
        const validCookies = [];
        for (const part of cookieParts) {
            const eqIdx = part.indexOf('=');
            if (eqIdx <= 0) continue;
            const name = part.substring(0, eqIdx).trim();
            const value = part.substring(eqIdx + 1).trim();
            if (!name) continue;
            validCookies.push({ name, value });
        }

        if (validCookies.length === 0) {
            throw new Error('No valid cookies parsed from session cookies');
        }

        const cookiesForPuppeteer = validCookies.flatMap(c => [
            { name: c.name, value: c.value, url: 'https://labs.google' },
            { name: c.name, value: c.value, url: 'https://www.google.com' },
        ]);
        await page.setCookie(...cookiesForPuppeteer);
        console.log(`[reCAPTCHA] Set ${validCookies.length} cookies`);

        // Navigate to Flow page (loads reCAPTCHA Enterprise SDK)
        await page.goto('https://labs.google/fx/tools/flow/', {
            waitUntil: 'networkidle2',
            timeout: 30000,
        });

        // Wait for grecaptcha.enterprise to be available
        await page.waitForFunction(
            () => typeof grecaptcha !== 'undefined' && typeof grecaptcha.enterprise !== 'undefined' && typeof grecaptcha.enterprise.execute === 'function',
            { timeout: 15000 }
        );

        // Simulate human-like interactions to boost reCAPTCHA score
        // Without these signals, Google gives a low score on headless/VPS environments
        try {
            // Random mouse movements
            for (let i = 0; i < 5; i++) {
                await page.mouse.move(
                    100 + Math.random() * 800,
                    100 + Math.random() * 500,
                    { steps: 5 + Math.floor(Math.random() * 10) }
                );
                await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
            }
            // Scroll down and back up
            await page.evaluate(() => {
                window.scrollTo({ top: 300, behavior: 'smooth' });
            });
            await new Promise(r => setTimeout(r, 500));
            await page.evaluate(() => {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
            await new Promise(r => setTimeout(r, 500));
            // Click on empty area
            await page.mouse.click(400, 300);
            await new Promise(r => setTimeout(r, 300));
            console.log('[reCAPTCHA] ✅ Human interaction simulation complete');
        } catch (e) {
            console.warn('[reCAPTCHA] Interaction simulation failed (non-fatal):', e.message);
        }

        // Wait for reCAPTCHA SDK to process behavioral signals before first token
        // Without this delay, the first token gets a low score → 403
        console.log('[reCAPTCHA] ⏳ Warming up (5s wait for SDK to process signals)...');
        await new Promise(r => setTimeout(r, 5000));

        _recaptchaPage = page;
        _recaptchaReady = true;
        console.log('[reCAPTCHA] ✅ Persistent page ready (SDK loaded)');
    })();

    try {
        await _recaptchaInitPromise;
    } finally {
        _recaptchaInitPromise = null;
    }

    return _recaptchaPage;
}

/**
 * Close the persistent reCAPTCHA browser.
 */
async function _closeRecaptchaBrowser() {
    if (_recaptchaIdleTimer) {
        clearTimeout(_recaptchaIdleTimer);
        _recaptchaIdleTimer = null;
    }
    if (_recaptchaBrowser) {
        try { await _recaptchaBrowser.close(); } catch { /* ok */ }
    }
    if (_recaptchaChromeProcess) {
        try { _recaptchaChromeProcess.kill(); } catch { /* ok */ }
        _recaptchaChromeProcess = null;
    }
    _recaptchaPage = null;
    _recaptchaBrowser = null;
    _recaptchaReady = false;
}

/**
 * Reset the idle timer — browser auto-closes after 5 min of inactivity.
 */
function _resetRecaptchaIdleTimer() {
    if (_recaptchaIdleTimer) clearTimeout(_recaptchaIdleTimer);
    _recaptchaIdleTimer = setTimeout(async () => {
        console.log('[reCAPTCHA] Idle timeout — closing persistent browser');
        await _closeRecaptchaBrowser();
    }, RECAPTCHA_PAGE_IDLE_TIMEOUT);
}

/**
 * Fetch a FRESH reCAPTCHA Enterprise token.
 * Each call returns a new single-use token (never reused).
 * Keeps the browser page alive for efficiency.
 * @param {string} sessionCookies - Session cookies for auth
 * @param {string} action - reCAPTCHA action name (IMAGE_GENERATION or VIDEO_GENERATION)
 */
async function fetchRecaptchaToken(sessionCookies, action = 'IMAGE_GENERATION') {
    // Use mutex to serialize token generation across parallel jobs
    return new Promise((resolve, reject) => {
        _tokenMutexQueue = _tokenMutexQueue.then(async () => {
            // Enforce minimum interval between token generations
            const now = Date.now();
            const elapsed = now - _lastTokenTime;
            if (elapsed < TOKEN_MIN_INTERVAL) {
                await new Promise(r => setTimeout(r, TOKEN_MIN_INTERVAL - elapsed));
            }
            const token = await _fetchRecaptchaTokenInner(sessionCookies, action);
            _lastTokenTime = Date.now();
            return token;
        }).then(resolve).catch(reject);
    });
}

async function _fetchRecaptchaTokenInner(sessionCookies, action = 'IMAGE_GENERATION') {
    if (!sessionCookies) {
        console.warn('[reCAPTCHA] No session cookies — cannot fetch token');
        return '';
    }

    try {
        const page = await _ensureRecaptchaPage(sessionCookies);

        // Each call to execute() returns a FRESH single-use token
        const token = await page.evaluate(async (siteKey, act) => {
            return await grecaptcha.enterprise.execute(siteKey, { action: act });
        }, RECAPTCHA_SITE_KEY, action);

        // Reset idle timer on each successful call
        _resetRecaptchaIdleTimer();

        if (token && token.length > 50) {
            console.log(`[reCAPTCHA] ✅ Fresh token (${token.length} chars)`);
            return token;
        }

        console.warn('[reCAPTCHA] Token too short or empty:', token?.substring(0, 50));
        return '';

    } catch (e) {
        console.error('[reCAPTCHA] Failed to fetch token:', e.message);
        // Page may be dead — force cleanup so next call reinitializes
        await _closeRecaptchaBrowser();
        return '';
    }
}

/**
 * Execute a fetch request INSIDE the Puppeteer Chrome page.
 * This ensures Chrome attaches all native headers (x-browser-*, x-client-data)
 * that Google now validates alongside the reCAPTCHA token.
 *
 * Falls back to Node.js fetch if browser is not available.
 */
async function browserFetch(url, token, body) {
    // Try to use the reCAPTCHA browser page for the fetch
    if (_recaptchaPage && _recaptchaBrowser?.isConnected() && _recaptchaReady) {
        try {
            const result = await _recaptchaPage.evaluate(async (fetchUrl, bearerToken, fetchBody) => {
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

            console.log(`[BrowserFetch] Response status: ${result.status}`);

            // If reCAPTCHA rejected (403), the Chrome session is "tainted"
            // Close it so next request gets a fresh browser with clean score
            if (result.status === 403 && result.body.includes('reCAPTCHA')) {
                console.warn('[BrowserFetch] ⚠️ reCAPTCHA 403 — closing tainted browser session');
                await _closeRecaptchaBrowser();
            }

            return result;
        } catch (e) {
            console.warn(`[BrowserFetch] Chrome fetch failed: ${e.message}, falling back to Node.js fetch`);
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
 * Matches Google Flow web behavior: Token → API call → CLR → next token.
 */
async function clearRecaptchaToken(usedToken) {
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
        console.log(`[reCAPTCHA] CLR sent (status=${res.status})`);
    } catch (e) {
        console.warn('[reCAPTCHA] CLR call failed:', e.message);
    }
}

// Model name mapping (UI label -> API value)
const IMAGE_MODELS = {
    'banana2': 'NARWHAL',              // ✅ Nano Banana 2 — CONFIRMED
    'banana_pro': 'GEM_PIX_2',         // ✅ Nano Banana Pro — CONFIRMED
};

// Aspect ratio enum mapping
const ASPECT_RATIO_MAP = {
    '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
    '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
    '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
    '4:3': 'IMAGE_ASPECT_RATIO_LANDSCAPE_4_3',
    '3:4': 'IMAGE_ASPECT_RATIO_PORTRAIT_3_4',
};

/**
 * Build common auth headers
 */
function buildHeaders(token) {
    return {
        'Content-Type': 'text/plain;charset=UTF-8',
        'Authorization': `Bearer ${token}`,
        'Origin': 'https://labs.google',
        'Referer': 'https://labs.google/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    };
}

/**
 * Step 1: Upload reference image to Google Flow
 * Returns the media UUID assigned by the API.
 */
async function uploadReferenceImage(token, projectId, imageBase64, mimeType = 'image/jpeg') {
    console.log('[FlowImage] Uploading reference image...');

    const body = {
        clientContext: {
            projectId,
            tool: TOOL,
        },
        imageBytes: imageBase64,
    };

    const res = await fetch(`${API_BASE}/v1/flow/uploadImage`, {
        method: 'POST',
        headers: buildHeaders(token),
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const errText = await res.text();
        if (res.status === 401) {
            throw new Error('🔑 Token Google Flow đã hết hạn. Vui lòng vào Credentials và tạo token mới.');
        }
        throw new Error(`Upload failed (${res.status}): ${errText.substring(0, 400)}`);
    }

    const data = await res.json();
    // Response format: { media: { name: "uuid", ... } }
    const mediaId = data.media?.name || data.mediaId || data.name || data.id;
    if (!mediaId) {
        throw new Error(`Upload succeeded but no mediaId returned. Response: ${JSON.stringify(data).substring(0, 200)}`);
    }

    console.log('[FlowImage] Reference image uploaded, mediaId:', mediaId);
    return mediaId;
}

/**
 * Step 2: Generate a SINGLE image via batchGenerateImages API.
 * Caller provides batchId + sessionId to group multiple calls.
 * Returns array of { mediaId, fifeUrl, ... } (usually 1 item).
 */
async function batchGenerateImages(token, projectId, { prompt, modelName, aspectRatio, referenceMediaIds, seed, recaptchaToken, batchId, sessionId, sessionCookies }) {
    // Build recaptcha context
    const recaptchaContext = {
        applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
        ...(recaptchaToken && { token: recaptchaToken }),
    };

    // Build single request object — 1 request = 1 image
    const request = {
        clientContext: {
            recaptchaContext,
            projectId,
            tool: TOOL,
            sessionId,
        },
        imageModelName: modelName,
        imageAspectRatio: aspectRatio,
        structuredPrompt: {
            parts: [{ text: prompt }],
        },
        seed: seed || Math.floor(Math.random() * 2147483647),
    };

    // Attach reference images if provided
    if (referenceMediaIds && referenceMediaIds.length > 0) {
        request.imageInputs = referenceMediaIds.map(id => ({
            imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE',
            name: id,
        }));
    }

    const body = {
        clientContext: {
            recaptchaContext,
            projectId,
            tool: TOOL,
            sessionId,
        },
        mediaGenerationContext: { batchId },
        useNewMedia: true,
        requests: [request],  // Always 1 request per API call
    };

    console.log(`[FlowImage] Generating 1 image(s), model=${modelName}, ratio=${aspectRatio}, seed=${request.seed}...`);

    const apiUrl = `${API_BASE}/v1/projects/${projectId}/flowMedia:batchGenerateImages`;
    let result;
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        result = await browserFetch(apiUrl, token, body);

        if (result.ok) break;

        console.log(`[FlowImage] Error response (${result.status}): ${result.body.substring(0, 300)}`);

        // Retry on 403 reCAPTCHA: close tainted Chrome, get fresh token, rebuild body
        if (result.status === 403 && result.body.includes('reCAPTCHA') && attempt < MAX_RETRIES) {
            console.log(`[FlowImage] ⚠️ reCAPTCHA 403, retrying with fresh Chrome (${attempt + 1}/${MAX_RETRIES})...`);
            const freshToken = await fetchRecaptchaToken(sessionCookies || '', 'IMAGE_GENERATION');
            if (freshToken) {
                body.clientContext.recaptchaContext.token = freshToken;
            }
            continue;
        }
        // Only retry on 5xx server errors
        if (result.status >= 500 && attempt < MAX_RETRIES) {
            console.log(`[FlowImage] ⚠️ Server error ${result.status}, retrying (${attempt + 1}/${MAX_RETRIES})...`);
            await new Promise(r => setTimeout(r, 3000)); // wait 3s before retry
            continue;
        }
        // Detect content policy violation on input image
        if (result.body.includes('PUBLIC_ERROR_MINOR_INPUT_IMAGE')) {
            throw new Error('⚠️ Ảnh bạn tải lên có nội dung không phù hợp hoặc không được hỗ trợ. Vui lòng thử ảnh khác.');
        }
        if (result.status === 401) {
            throw new Error('🔑 Token Google Flow đã hết hạn. Vui lòng vào Credentials và tạo token mới.');
        }
        throw new Error(`Generation failed (${result.status}): ${result.body.substring(0, 400)}`);
    }

    const data = JSON.parse(result.body);

    // Response: { media: [ { name, image: { generatedImage: { fifeUrl, ... } } } ], workflows: [...] }
    const mediaItems = data.media || [];
    if (!mediaItems.length) {
        throw new Error(`No images returned. Response: ${JSON.stringify(data).substring(0, 300)}`);
    }

    return mediaItems.map(item => ({
        mediaId: item.name,
        fifeUrl: item.image?.generatedImage?.fifeUrl,
        dimensions: item.image?.dimensions,
        seed: item.image?.generatedImage?.seed,
        workflowId: item.workflowId,
    }));
}

/**
 * Download an image from a signed GCS URL and save to disk.
 * Returns the local file path and imageUrl (relative).
 */
async function downloadAndSaveImage(fifeUrl, outputDir, prefix = 'gflow') {
    const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
    const filepath = join(outputDir, filename);

    const imgRes = await fetch(fifeUrl);
    if (!imgRes.ok) {
        throw new Error(`Failed to download image (${imgRes.status})`);
    }

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    await writeFile(filepath, buffer);
    return { filepath, filename };
}

// ─────────────────────────────────────────────────────────
//  GoogleFlowImageConnector
// ─────────────────────────────────────────────────────────

export class GoogleFlowImageConnector extends BaseConnector {
    static get metadata() {
        return {
            name: 'Google Flow — Image',
            description: 'Generate images with Google Flow (ImageFX). Accepts reference image from upstream File Upload.',
            icon: '🎨',
            category: 'ai',
            configSchema: {
                prompt: {
                    type: 'textarea',
                    label: 'Image Prompt',
                    description: 'Use {{nodeId.imagePrompt}} from Text Extractor',
                    required: true,
                },
                model: {
                    type: 'select',
                    label: 'Model',
                    options: [
                        { label: 'Nano Banana 2 (Gemini 2.5 Pro)', value: 'banana2' },
                        { label: 'Nano Banana (Gemini 2.5 Flash)', value: 'banana' },
                        { label: 'Nano Banana Pro (Gemini 3 Pro)', value: 'banana_pro' },
                        { label: 'Imagen 4', value: 'imagen4' },
                        { label: 'Nano (Imagen 3.5)', value: 'nano' },
                    ],
                    default: 'banana2',
                },
                aspectRatio: {
                    type: 'select',
                    label: 'Aspect Ratio',
                    options: ['9:16', '1:1', '16:9', '4:3', '3:4'],
                    default: '9:16',
                },
                count: {
                    type: 'number',
                    label: 'Number of Images',
                    description: '1–4',
                    default: 1,
                },
                useReferenceImage: {
                    type: 'boolean',
                    label: 'Use Reference Image from Upstream',
                    description: 'Send uploaded image as reference (from File Upload node)',
                    default: true,
                },
                resolution: {
                    type: 'select',
                    label: 'Resolution',
                    options: [
                        { label: '1K (Original)', value: '1k' },
                        { label: '2K (Upscaled)', value: '2k' },
                        { label: '4K (Upscaled)', value: '4k' },
                    ],
                    default: '1k',
                },
                projectId: {
                    type: 'text',
                    label: 'Project ID',
                    description: 'Your Google Flow project UUID (found in network requests)',
                    required: true,
                },
                credentialId: {
                    type: 'credential',
                    label: 'Google Auth Token',
                    provider: 'google-flow',
                    required: true,
                },
            },
        };
    }

    async execute(input, credentials, config, context = {}) {
        if (!credentials?.token) {
            throw new Error('Google Flow credentials required (Bearer token).');
        }

        // Auto-refresh token if expired or near expiry
        credentials = await ensureFreshToken(credentials);

        const token = credentials.token;
        const projectId = config.projectId;
        if (!projectId) {
            throw new Error('Project ID is required. Set it in the Flow Image node config.');
        }

        // Resolve prompt
        const prompt = config.prompt || input.imagePrompt || input.text || '';
        if (!prompt) throw new Error('Image prompt is required.');

        const modelKey = config.model || 'banana2';
        const modelName = IMAGE_MODELS[modelKey] || 'GEM_PIX_2';
        const aspectRatioKey = config.aspectRatio || '9:16';
        const aspectRatio = ASPECT_RATIO_MAP[aspectRatioKey] || 'IMAGE_ASPECT_RATIO_PORTRAIT';
        const count = Math.min(Math.max(parseInt(config.count) || 1, 1), 4);

        // Upload reference images if available
        const referenceMediaIds = [];
        console.log(`[FlowImage] input.images: ${input.images ? input.images.length : 0} image(s), useReferenceImage: ${config.useReferenceImage}`);
        if (config.useReferenceImage !== false) {
            // Multi-image support: check input.images[] array first
            const imageSources = (input.images && input.images.length > 0)
                ? input.images
                : (input.imageData || input.filePath || input.imageUrl)
                    ? [{ imageData: input.imageData, filePath: input.filePath, imageUrl: input.imageUrl }]
                    : [];

            for (const imgSrc of imageSources) {
                let imageBase64 = imgSrc.imageData;

                if (!imageBase64 && (imgSrc.filePath || imgSrc.imageUrl)) {
                    const uploadsDir = process.env.UPLOAD_DIR || './uploads';
                    const imgPath = imgSrc.filePath
                        || join(uploadsDir, (imgSrc.imageUrl || '').replace('/uploads/', ''));
                    try {
                        const buf = await readFile(imgPath);
                        imageBase64 = buf.toString('base64');
                        console.log('[FlowImage] Loaded reference image from:', imgPath);
                    } catch (e) {
                        console.warn('[FlowImage] Could not load reference image:', e.message);
                    }
                }

                if (imageBase64) {
                    try {
                        const mediaId = await uploadReferenceImage(token, projectId, imageBase64);
                        referenceMediaIds.push(mediaId);
                        console.log(`[FlowImage] Uploaded reference image, mediaId: ${mediaId}`);
                    } catch (e) {
                        console.warn('[FlowImage] Upload failed for one image:', e.message);
                    }
                }
            }

            if (referenceMediaIds.length > 0) {
                console.log(`[FlowImage] ${referenceMediaIds.length} reference image(s) uploaded`);
            }
        }

        // ── Batch generation: 1 API call per image, fresh reCAPTCHA each ──
        const sessionCookies = credentials.metadata?.sessionCookies || '';
        const batchId = uuidv4();
        const sessionId = `;${Date.now()}`;
        const allResults = [];

        console.log(`[FlowImage] Starting batch of ${count} image(s), batchId=${batchId}`);

        for (let i = 0; i < count; i++) {
            // Fresh reCAPTCHA token for each API call
            const recaptchaToken = await fetchRecaptchaToken(sessionCookies);

            const result = await batchGenerateImages(token, projectId, {
                prompt,
                modelName,
                aspectRatio,
                referenceMediaIds,
                recaptchaToken,
                batchId,
                sessionId,
                sessionCookies,
                seed: Math.floor(Math.random() * 2147483647),
            });
            allResults.push(...result);

            // Clear the used token (matches Google Flow web behavior)
            await clearRecaptchaToken(recaptchaToken);
        }

        const results = allResults;

        // Download and save images to job folder (or fallback)
        const uploadsDir = process.env.UPLOAD_DIR || './uploads';
        const outputDir = context.jobDir || join(uploadsDir, 'generated');
        await mkdir(outputDir, { recursive: true });
        const relativeBase = context.jobDir
            ? outputDir.replace(/^\.\//, '')
            : 'uploads/generated';

        // Upscale if resolution is 2k or 4k
        const resolution = config.resolution || '1k';

        const savedImages = [];
        for (const r of results) {
            if (r.fifeUrl) {
                // Upscale if needed — each upscale also gets a fresh reCAPTCHA token
                if (resolution !== '1k' && r.mediaId) {
                    try {
                        console.log(`[FlowImage] 🔄 Upscaling image to ${resolution.toUpperCase()}...`);
                        const upscaleRecaptcha = await fetchRecaptchaToken(sessionCookies);
                        const upscaleResult = await this._upscaleImage(token, projectId, r.mediaId, resolution, upscaleRecaptcha);
                        await clearRecaptchaToken(upscaleRecaptcha);
                        if (upscaleResult.encodedImage) {
                            const filename = `gflow_${resolution}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
                            const filepath = join(outputDir, filename);
                            await writeFile(filepath, Buffer.from(upscaleResult.encodedImage, 'base64'));
                            console.log(`[FlowImage] ✅ Upscale to ${resolution.toUpperCase()} saved: ${filepath}`);
                            savedImages.push({
                                imageUrl: `/${relativeBase}/${filename}`,
                                imagePath: filepath,
                                mediaId: r.mediaId,
                                dimensions: r.dimensions,
                            });
                            continue;
                        } else {
                            console.warn(`[FlowImage] ⚠️ Upscale returned no encodedImage, downloading original`);
                        }
                    } catch (e) {
                        console.warn(`[FlowImage] ⚠️ Upscale to ${resolution.toUpperCase()} failed: ${e.message}, downloading original`);
                    }
                }

                // Download original (1k or fallback)
                try {
                    const { filepath, filename } = await downloadAndSaveImage(r.fifeUrl, outputDir);
                    savedImages.push({
                        imageUrl: `/${relativeBase}/${filename}`,
                        imagePath: filepath,
                        mediaId: r.mediaId,
                        fifeUrl: r.fifeUrl,
                        dimensions: r.dimensions,
                    });
                } catch (e) {
                    console.warn('[FlowImage] Could not save image:', e.message);
                    savedImages.push({ fifeUrl: r.fifeUrl, mediaId: r.mediaId });
                }
            }
        }

        if (!savedImages.length) {
            throw new Error('No images could be downloaded from Google Flow.');
        }

        const primary = savedImages[0];

        // Read back as base64 for downstream (Flow Video)
        let imageData = null;
        if (primary.imagePath) {
            try {
                const buf = await readFile(primary.imagePath);
                imageData = buf.toString('base64');
            } catch (_) { }
        }

        // Close reCAPTCHA browser after batch completes
        // Don't close browser here — video batch runs next in the same job
        // and needs to reuse this Chrome instance. Idle timer will auto-close if unused.
        _resetRecaptchaIdleTimer();

        return {
            text: prompt,
            imageUrl: primary.imageUrl || primary.fifeUrl,
            imagePath: primary.imagePath,
            imageData,          // base64 for Flow Video start frame
            fifeUrl: primary.fifeUrl,
            mediaId: primary.mediaId,
            allImages: savedImages,
            status: 'generated',
            model: modelName,
        };
    }

    /**
     * Upscale an image to 2K or 4K resolution.
     * POST /v1/flow/upsampleImage
     * Response returns { encodedImage: "<base64 JPEG>" }
     */
    async _upscaleImage(token, projectId, mediaId, resolution, recaptchaToken = '') {
        const targetResolution = resolution === '4k'
            ? 'UPSAMPLE_IMAGE_RESOLUTION_4K'
            : 'UPSAMPLE_IMAGE_RESOLUTION_2K';
        const sessionId = `;${Date.now()}`;

        const body = {
            mediaId,
            targetResolution,
            clientContext: {
                recaptchaContext: {
                    token: recaptchaToken,
                    applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
                },
                projectId,
                tool: TOOL,
                userPaygateTier: 'PAYGATE_TIER_TWO',
                sessionId,
            },
        };

        console.log(`[FlowImage] Upscale request: POST /v1/flow/upsampleImage (${targetResolution})`);
        const result = await browserFetch(`${API_BASE}/v1/flow/upsampleImage`, token, body);

        if (!result.ok) {
            if (result.status === 401) {
                throw new Error('🔑 Token Google Flow đã hết hạn. Vui lòng vào Credentials và tạo token mới.');
            }
            throw new Error(`Image upscale failed (${result.status}): ${result.body.substring(0, 300)}`);
        }

        const data = JSON.parse(result.body);
        const hasImage = !!data.encodedImage;
        console.log(`[FlowImage] Upscale response: hasEncodedImage=${hasImage}, keys=${Object.keys(data).join(',')}`);

        return { encodedImage: data.encodedImage || null };
    }

    async testConnection(credentials) {
        if (!credentials?.token) return false;
        try {
            // Lightweight check: try to hit the API base to see if token is accepted
            const res = await fetch(`${API_BASE}/v1/flow/uploadImage`, {
                method: 'POST',
                headers: buildHeaders(credentials.token),
                body: JSON.stringify({ clientContext: { projectId: credentials.metadata?.projectId || 'test', tool: TOOL }, imageBytes: '' }),
            });
            // 400 = bad request (expected since imageBytes is empty) but token accepted
            // 401/403 = token invalid
            return res.status !== 401 && res.status !== 403;
        } catch {
            return false;
        }
    }
}

// ─────────────────────────────────────────────────────────
//  GoogleFlowVideoConnector
// ─────────────────────────────────────────────────────────

// Video model mapping (confirmed from HAR)
const VIDEO_MODELS = {
    'veo3_fast_low': 'veo_3_1_i2v_s_fast_portrait_ultra_relaxed',  // Veo 3.1 Fast (Low Priority) — CONFIRMED
    'veo3_fast': 'veo_3_1_i2v_s_fast_portrait_ultra',              // Veo 3.1 - Fast — CONFIRMED via HAR
    'veo3': 'veo_3_1_i2v_s_portrait',                              // Veo 3.1 - Quality — CONFIRMED via HAR
    'veo3_lite': 'veo_3_1_i2v_lite',                               // Veo 3.1 - Lite
    'veo3_lite_low': 'veo_3_1_i2v_lite_low_priority',              // Veo 3.1 - Lite (Low Priority)
};

// Video aspect ratio enum mapping
const VIDEO_ASPECT_RATIO_MAP = {
    '16:9': 'VIDEO_ASPECT_RATIO_LANDSCAPE',
    '9:16': 'VIDEO_ASPECT_RATIO_PORTRAIT',
    '1:1': 'VIDEO_ASPECT_RATIO_SQUARE',
};

export class GoogleFlowVideoConnector extends BaseConnector {
    static get metadata() {
        return {
            name: 'Google Flow — Video',
            description: 'Generate videos with Google Flow (Veo 3.1). Auto-uses a random generated image as start frame.',
            icon: '🎬',
            category: 'ai',
            configSchema: {
                prompt: {
                    type: 'textarea',
                    label: 'Video Prompt',
                    description: 'Use {{nodeId.videoPrompt}} from Text Extractor',
                    required: true,
                },
                model: {
                    type: 'select',
                    label: 'Model',
                    options: [
                        { label: 'Veo 3.1 Fast (Low Priority)', value: 'veo3_fast_low' },
                        { label: 'Veo 3.1 - Fast', value: 'veo3_fast' },
                        { label: 'Veo 3.1 - Quality', value: 'veo3' },
                    ],
                    default: 'veo3_fast_low',
                },
                aspectRatio: {
                    type: 'select',
                    label: 'Aspect Ratio',
                    options: [
                        { label: 'Portrait (9:16)', value: '9:16' },
                        { label: 'Landscape (16:9)', value: '16:9' },
                        { label: 'Square (1:1)', value: '1:1' },
                    ],
                    default: '9:16',
                },
                useStartFrame: {
                    type: 'boolean',
                    label: 'Use Start Frame from Upstream Image',
                    description: 'Use a generated image from Flow Image as the video start frame',
                    default: true,
                },
                resolution: {
                    type: 'select',
                    label: 'Resolution',
                    options: [
                        { label: '720p (Original)', value: '720p' },
                        { label: '1080p (Upscaled)', value: '1080p' },
                    ],
                    default: '720p',
                },
                projectId: {
                    type: 'text',
                    label: 'Project ID',
                    description: 'Your Google Flow project UUID',
                    required: true,
                },
                credentialId: {
                    type: 'credential',
                    label: 'Google Auth Token',
                    provider: 'google-flow',
                    required: true,
                },
            },
        };
    }

    async execute(input, credentials, config, context = {}) {
        if (!credentials?.token) {
            throw new Error('Google Flow credentials required (Bearer token).');
        }

        // Auto-refresh token if expired or near expiry
        credentials = await ensureFreshToken(credentials);

        const token = credentials.token;
        const projectId = config.projectId;
        if (!projectId) throw new Error('Project ID is required.');

        const prompt = config.prompt || input.videoPrompt || input.text || '';
        if (!prompt) throw new Error('Video prompt is required.');

        const modelKey = config.model || 'veo3_fast_low';
        const videoModelKey = VIDEO_MODELS[modelKey] || 'veo_3_1_i2v_s_fast_portrait_ultra_relaxed';
        const aspectRatio = VIDEO_ASPECT_RATIO_MAP[config.aspectRatio || '9:16'] || 'VIDEO_ASPECT_RATIO_PORTRAIT';
        const sessionId = `;${Date.now()}`;

        // ─── Get start frame from upstream Flow Image ───
        let startFrameMediaId = null;
        const useStartFrame = config.useStartFrame !== false; // default true

        if (useStartFrame) {
            // Priority 1: Pick random image from Flow Image's allImages (which have mediaId)
            if (input.allImages && input.allImages.length > 0) {
                const randomIdx = Math.floor(Math.random() * input.allImages.length);
                const picked = input.allImages[randomIdx];
                if (picked.mediaId) {
                    startFrameMediaId = picked.mediaId;
                    console.log(`[FlowVideo] Picked random image #${randomIdx + 1}/${input.allImages.length}, mediaId: ${startFrameMediaId}`);
                } else if (picked.imagePath || picked.fifeUrl) {
                    // Upload the image to get mediaId
                    let base64 = null;
                    if (picked.imagePath) {
                        try { base64 = (await readFile(picked.imagePath)).toString('base64'); } catch (_) { }
                    }
                    if (!base64 && picked.fifeUrl) {
                        try {
                            const r = await fetch(picked.fifeUrl);
                            base64 = Buffer.from(await r.arrayBuffer()).toString('base64');
                        } catch (_) { }
                    }
                    if (base64) {
                        startFrameMediaId = await uploadReferenceImage(token, projectId, base64);
                        console.log(`[FlowVideo] Uploaded random image #${randomIdx + 1}, mediaId: ${startFrameMediaId}`);
                    }
                }
            }

            // Priority 2: Single image from upstream (legacy)
            if (!startFrameMediaId && input.mediaId) {
                startFrameMediaId = input.mediaId;
                console.log('[FlowVideo] Using upstream mediaId:', startFrameMediaId);
            }

            if (!startFrameMediaId && input.imageData) {
                startFrameMediaId = await uploadReferenceImage(token, projectId, input.imageData);
                console.log('[FlowVideo] Uploaded upstream base64 as start frame, mediaId:', startFrameMediaId);
            }

            if (!startFrameMediaId) {
                console.log('[FlowVideo] ⚠️ No start frame available — video will be text-only.');
            }
        } else {
            console.log('[FlowVideo] Start frame disabled by config — video will be text-only.');
        }

        // ─── Build request (from HAR capture) ───
        const recaptchaToken = await fetchRecaptchaToken(credentials.metadata?.sessionCookies || '', 'VIDEO_GENERATION');
        const batchId = uuidv4();

        const request = {
            aspectRatio,
            seed: Math.floor(Math.random() * 100000),
            textInput: {
                structuredPrompt: {
                    parts: [{ text: prompt }],
                },
            },
            videoModelKey,
            metadata: {},
        };

        if (startFrameMediaId) {
            request.startImage = { mediaId: startFrameMediaId };
        }

        const body = {
            mediaGenerationContext: { batchId },
            clientContext: {
                projectId,
                tool: TOOL,
                userPaygateTier: 'PAYGATE_TIER_TWO',
                sessionId,
                recaptchaContext: {
                    applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
                    ...(recaptchaToken && { token: recaptchaToken }),
                },
            },
            requests: [request],
            useV2ModelConfig: true,
        };

        console.log(`[FlowVideo] Submitting video generation, model=${videoModelKey}, aspect=${aspectRatio}, startFrame=${!!startFrameMediaId}...`);
        console.log('[FlowVideo] Request body:', JSON.stringify(body, null, 2).substring(0, 1000));

        let result;
        const MAX_RETRIES = 2;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            result = await browserFetch(
                `${API_BASE}/v1/video:batchAsyncGenerateVideoStartImage`,
                token,
                body
            );

            if (result.ok) break;

            // Retry on 403 reCAPTCHA: close tainted Chrome, get fresh token
            if (result.status === 403 && result.body.includes('reCAPTCHA') && attempt < MAX_RETRIES) {
                console.log(`[FlowVideo] ⚠️ reCAPTCHA 403, retrying with fresh Chrome (${attempt + 1}/${MAX_RETRIES})...`);
                const freshToken = await fetchRecaptchaToken(credentials.metadata?.sessionCookies || '', 'VIDEO_GENERATION');
                if (freshToken) {
                    body.clientContext.recaptchaContext.token = freshToken;
                }
                continue;
            }
            if (result.status >= 500 && attempt < MAX_RETRIES) {
                console.log(`[FlowVideo] ⚠️ Server error ${result.status}, retrying (${attempt + 1}/${MAX_RETRIES})...`);
                await new Promise(r => setTimeout(r, 3000));
                continue;
            }
            if (result.status === 401) {
                throw new Error('🔑 Token Google Flow đã hết hạn. Vui lòng vào Credentials và tạo token mới.');
            }
            throw new Error(`Video generation failed (${result.status}): ${result.body.substring(0, 400)}`);
        }

        const data = JSON.parse(result.body);
        console.log('[FlowVideo] Response:', JSON.stringify(data).substring(0, 1000));

        // Extract all IDs from response
        const operationName = data.operations?.[0]?.operation?.name
            || data.operations?.[0]?.name
            || data.name || '';
        const mediaId = data.media?.[0]?.name || '';
        const workflowId = data.workflows?.[0]?.name || '';
        const status = data.operations?.[0]?.status || 'SUBMITTED';
        const remainingCredits = data.remainingCredits;

        console.log(`[FlowVideo] Video submitted!`);
        console.log(`[FlowVideo]   Operation: ${operationName}`);
        console.log(`[FlowVideo]   MediaId: ${mediaId}`);
        console.log(`[FlowVideo]   WorkflowId: ${workflowId}`);
        console.log(`[FlowVideo]   Status: ${status}`);
        console.log(`[FlowVideo]   Credits: ${remainingCredits}`);

        if (!operationName && !mediaId && !workflowId) {
            return {
                text: prompt,
                status: 'submitted',
                message: 'Video submitted but no IDs returned. Cannot poll.',
                rawResponse: JSON.stringify(data).substring(0, 500),
            };
        }

        // Poll until video generation is 100% complete
        console.log(`[FlowVideo] Starting polling for completion...`);
        const pollResult = await this._pollVideoOperation(token, projectId, operationName, mediaId, workflowId);

        console.log(`[FlowVideo] ✅ Video generation complete!`);

        // Upscale to 1080p if requested
        let downloadMediaId = mediaId;
        const resolution = config.resolution || '720p';
        if (resolution === '1080p') {
            console.log(`[FlowVideo] 🔄 Upscaling to 1080p...`);
            // Fetch fresh reCAPTCHA token for upscale (previous one may have expired during generation)
            const upscaleRecaptchaToken = await fetchRecaptchaToken(credentials.metadata?.sessionCookies || '', 'VIDEO_GENERATION');
            const upsampleResult = await this._upscaleVideo(token, projectId, mediaId, aspectRatio, upscaleRecaptchaToken);
            if (upsampleResult.upsampledMediaId) {
                const upsampledMediaId = upsampleResult.upsampledMediaId;
                console.log(`[FlowVideo] Upscale submitted: ${upsampledMediaId}`);
                // Poll upscale status
                await this._pollUpscaleStatus(token, projectId, upsampledMediaId);
                downloadMediaId = upsampledMediaId;
                console.log(`[FlowVideo] ✅ Upscale to 1080p complete!`);
            } else {
                console.warn(`[FlowVideo] ⚠️ Upscale failed, downloading 720p instead`);
            }
        }

        // Fetch the actual video download URL (poll response doesn't contain it)
        let videoUrl = '';
        const sessionCookies = credentials?.metadata?.sessionCookies || '';
        videoUrl = await this._fetchVideoDownloadUrl(token, projectId, downloadMediaId, sessionCookies);

        // Download video to job folder if available
        let videoPath = '';
        if (videoUrl && context.jobDir) {
            try {
                console.log('[FlowVideo] Downloading video to job folder...');
                const videoRes = await fetch(videoUrl);
                if (videoRes.ok) {
                    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
                    const videoFilename = `video_${uuidv4().substring(0, 8)}.mp4`;
                    videoPath = join(context.jobDir, videoFilename);
                    await writeFile(videoPath, videoBuffer);
                    console.log(`[FlowVideo] ✅ Video saved: ${videoPath} (${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB)`);
                } else {
                    console.warn(`[FlowVideo] Video download failed: ${videoRes.status}`);
                }
            } catch (e) {
                console.warn('[FlowVideo] Could not download video:', e.message);
            }
        }

        // Close reCAPTCHA browser after batch completes
        await _closeRecaptchaBrowser();
        console.log('[FlowVideo] 🧹 reCAPTCHA browser closed after batch');

        return {
            text: prompt,
            status: 'completed',
            operationName,
            mediaId,
            videoUrl,
            videoPath,
            remainingCredits,
            model: videoModelKey,
            startFrameMediaId,
            message: `Video generation completed (${videoModelKey}).`,
        };
    }

    /**
     * Upscale a completed video from 720p to 1080p.
     * POST /v1/video:batchAsyncGenerateVideoUpsampleVideo
     */
    async _upscaleVideo(token, projectId, mediaId, aspectRatio, recaptchaToken = '') {
        const url = `${API_BASE}/v1/video:batchAsyncGenerateVideoUpsampleVideo`;
        const sessionId = `;${Date.now()}`;
        const body = {
            mediaGenerationContext: { batchId: uuidv4() },
            clientContext: {
                projectId,
                tool: TOOL,
                userPaygateTier: 'PAYGATE_TIER_TWO',
                sessionId,
                recaptchaContext: {
                    applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
                    ...(recaptchaToken && { token: recaptchaToken }),
                },
            },
            requests: [{
                resolution: 'VIDEO_RESOLUTION_1080P',
                aspectRatio: aspectRatio || 'VIDEO_ASPECT_RATIO_PORTRAIT',
                seed: Math.floor(Math.random() * 100000),
                videoModelKey: 'veo_3_1_upsampler_1080p',
                metadata: {},
                videoInput: { mediaId },
            }],
            useV2ModelConfig: true,
        };

        console.log(`[FlowVideo] Upscale request: POST ${url}`);
        const result = await browserFetch(url, token, body);

        if (!result.ok) {
            console.error(`[FlowVideo] Upscale API error: ${result.status} - ${result.body.substring(0, 300)}`);
            return { upsampledMediaId: null };
        }

        const data = JSON.parse(result.body);
        console.log(`[FlowVideo] Upscale response: ${JSON.stringify(data).substring(0, 500)}`);

        // Extract upsampled media ID (e.g. "{mediaId}_upsampled")
        const upsampledMediaId = data.operations?.[0]?.operation?.name
            || data.media?.[0]?.name
            || `${mediaId}_upsampled`;

        return { upsampledMediaId };
    }

    /**
     * Poll upscale operation until complete.
     * Uses same endpoint as video generation polling.
     */
    async _pollUpscaleStatus(token, projectId, upsampledMediaId, maxAttempts = 60) {
        const POLL_URL = `${API_BASE}/v1/video:batchCheckAsyncVideoGenerationStatus`;
        const pollBody = JSON.stringify({
            media: [{ name: upsampledMediaId, projectId }],
        });

        console.log(`[FlowVideo] Polling upscale status for: ${upsampledMediaId}`);

        // Wait 5s before first poll
        await new Promise(r => setTimeout(r, 5000));

        for (let i = 0; i < maxAttempts; i++) {
            try {
                const res = await fetch(POLL_URL, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'text/plain;charset=UTF-8',
                        'Origin': 'https://labs.google',
                        'Referer': 'https://labs.google/',
                    },
                    body: pollBody,
                });

                if (!res.ok) {
                    console.warn(`[FlowVideo] Upscale poll ${i + 1}: HTTP ${res.status}`);
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                }

                const data = await res.json();
                const status = data.media?.[0]?.mediaMetadata?.mediaStatus?.mediaGenerationStatus || '';
                console.log(`[FlowVideo] Upscale poll ${i + 1}/${maxAttempts}: ${status}`);

                if (status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') {
                    return data;
                }
                if (status === 'MEDIA_GENERATION_STATUS_FAILED') {
                    throw new Error('Video upscale failed');
                }
            } catch (e) {
                if (e.message === 'Video upscale failed') throw e;
                console.warn(`[FlowVideo] Upscale poll error: ${e.message}`);
            }

            await new Promise(r => setTimeout(r, 5000));
        }

        throw new Error('Video upscale timed out after 5 minutes');
    }

    /**
     * Fetch the actual video download URL after generation completes.
     * The poll response only contains metadata, not a download URL.
     * Uses the tRPC redirect endpoint to get a signed GCS URL.
     */
    async _fetchVideoDownloadUrl(token, projectId, mediaId, sessionCookies = '') {
        // Strategy 1: tRPC redirect (needs Google session cookie, may fail)
        try {
            const redirectUrl = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${mediaId}`;
            const cookieHeader = sessionCookies || '';
            console.log(`[FlowVideo] Trying tRPC redirect (cookies: ${cookieHeader ? 'yes (' + cookieHeader.length + ' chars)' : 'none'})...`);
            const tRPCHeaders = {
                'Referer': 'https://labs.google/',
            };
            if (cookieHeader) tRPCHeaders['Cookie'] = cookieHeader;
            const res = await fetch(redirectUrl, {
                redirect: 'manual',
                headers: tRPCHeaders,
            });
            console.log(`[FlowVideo] tRPC status: ${res.status}`);
            if ([301, 302, 307, 308].includes(res.status)) {
                const location = res.headers.get('location');
                if (location) {
                    console.log(`[FlowVideo] ✅ Got signed URL via tRPC redirect`);
                    return location;
                }
            }
            if (res.ok) {
                const text = await res.text();
                console.log(`[FlowVideo] tRPC body: ${text.substring(0, 300)}`);
                const match = text.match(/(https?:\/\/storage\.googleapis\.com\/[^"'\s]+)/);
                if (match) return match[1];
            }
        } catch (e) {
            console.log(`[FlowVideo] tRPC error: ${e.message}`);
        }

        // Strategy 2: Try direct GCS download (unsigned — may work for public/temp access)
        const directGcsUrl = `https://storage.googleapis.com/ai-sandbox-videofx/video/${mediaId}`;
        try {
            console.log(`[FlowVideo] Trying direct GCS URL (unsigned)...`);
            const res = await fetch(directGcsUrl, { method: 'HEAD' });
            console.log(`[FlowVideo] Direct GCS status: ${res.status}, content-type: ${res.headers.get('content-type')}`);
            if (res.ok) {
                console.log(`[FlowVideo] ✅ Direct GCS URL works without signing!`);
                return directGcsUrl;
            }
        } catch (e) {
            console.log(`[FlowVideo] Direct GCS error: ${e.message}`);
        }

        // Strategy 3: aisandbox API with Bearer token
        const apiEndpoints = [
            { url: `${API_BASE}/v1/video:getSignedUrl`, method: 'POST', body: { name: mediaId, projectId } },
            { url: `${API_BASE}/v1/media:getSignedUrl`, method: 'POST', body: { name: mediaId, projectId } },
        ];
        for (const ep of apiEndpoints) {
            try {
                console.log(`[FlowVideo] Trying ${ep.url}...`);
                const res = await fetch(ep.url, {
                    method: ep.method,
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'text/plain;charset=UTF-8',
                        'Origin': 'https://labs.google',
                        'Referer': 'https://labs.google/',
                    },
                    body: ep.body ? JSON.stringify(ep.body) : undefined,
                    signal: AbortSignal.timeout(10000),
                });
                console.log(`[FlowVideo] API status: ${res.status}`);
                if (res.ok) {
                    const data = await res.json();
                    const dataStr = JSON.stringify(data);
                    console.log(`[FlowVideo] API response: ${dataStr.substring(0, 300)}`);
                    const match = dataStr.match(/(https?:\/\/[^"]+)/);
                    if (match) return match[1];
                }
            } catch (e) {
                console.log(`[FlowVideo] API error: ${e.message}`);
            }
        }

        console.log(`[FlowVideo] ⚠️ Could not get video download URL`);
        return '';
    }

    /**
     * Poll for video generation completion using the real Google Flow endpoint.
     * Uses: POST /v1/video:batchCheckAsyncVideoGenerationStatus
     * Body: {"media":[{"name":"<mediaId>","projectId":"<projectId>"}]}
     * This is exactly what the Google Flow UI polls every ~10s.
     */
    async _pollVideoOperation(token, projectId, operationName, mediaId, workflowId, maxAttempts = 120) {
        const POLL_URL = `${API_BASE}/v1/video:batchCheckAsyncVideoGenerationStatus`;
        const pollBody = JSON.stringify({
            media: [{ name: mediaId, projectId }],
        });

        console.log(`[FlowVideo] Polling endpoint: ${POLL_URL}`);
        console.log(`[FlowVideo] Poll body: ${pollBody}`);

        // Wait 15s before first poll
        await new Promise(r => setTimeout(r, 15000));

        for (let i = 0; i < maxAttempts; i++) {
            try {
                const res = await fetch(POLL_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'text/plain;charset=UTF-8',
                        'Origin': 'https://labs.google',
                        'Referer': 'https://labs.google/',
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                    },
                    body: pollBody,
                });

                if (!res.ok) {
                    // If no auth works, try with Bearer token
                    const resWithAuth = await fetch(POLL_URL, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'text/plain;charset=UTF-8',
                            'Origin': 'https://labs.google',
                            'Referer': 'https://labs.google/',
                            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                        },
                        body: pollBody,
                    });

                    if (!resWithAuth.ok) {
                        if (i % 4 === 0) {
                            console.log(`[FlowVideo] Poll ${i + 1}: status=${res.status}/${resWithAuth.status}`);
                        }
                        await new Promise(r => setTimeout(r, 10000));
                        continue;
                    }

                    // Auth version worked
                    const data = await resWithAuth.json();
                    const result = this._checkBatchStatus(data, mediaId, i);
                    if (result) return result;
                    await new Promise(r => setTimeout(r, 10000));
                    continue;
                }

                const data = await res.json();
                const result = this._checkBatchStatus(data, mediaId, i);
                if (result) return result;

            } catch (e) {
                // Re-throw fatal errors (FAILED/ERROR status from _checkBatchStatus)
                if (e.message.includes('failed with status') || e.message.includes('generation failed')) {
                    throw e;
                }
                if (i % 4 === 0) console.log(`[FlowVideo] Poll ${i + 1}: error: ${e.message}`);
            }

            await new Promise(r => setTimeout(r, 10000)); // poll every 10s
        }

        throw new Error('Video generation timed out after 20 minutes.');
    }

    /**
     * Check batchCheckAsyncVideoGenerationStatus response for completion.
     */
    _checkBatchStatus(data, mediaId, pollIndex) {
        const dataStr = JSON.stringify(data);

        // Log progress on every 4th poll or when status changes
        const statusMatch = dataStr.match(/MEDIA_GENERATION_STATUS_(\w+)/);
        const currentStatus = statusMatch ? statusMatch[1] : 'UNKNOWN';

        // Look for percentage in link_text or in response data
        const pctMatch = dataStr.match(/(\d+)%/) || dataStr.match(/percentComplete[":]*\s*(\d+)/);
        const pct = pctMatch ? pctMatch[1] : '';

        if (pollIndex % 2 === 0 || currentStatus === 'SUCCEEDED' || currentStatus === 'COMPLETE') {
            console.log(`[FlowVideo] Poll ${pollIndex + 1}: status=${currentStatus}${pct ? `, progress=${pct}%` : ''}`);
            if (pollIndex % 8 === 0) {
                console.log(`[FlowVideo]   Response: ${dataStr.substring(0, 500)}`);
            }
        }

        // Check for completion - various patterns
        if (currentStatus === 'SUCCEEDED' || currentStatus === 'SUCCESSFUL' || currentStatus === 'COMPLETE' || currentStatus === 'COMPLETED') {
            console.log(`[FlowVideo] ✅ Video generation COMPLETE! Status: ${currentStatus}`);
            console.log(`[FlowVideo] Full response: ${dataStr.substring(0, 1000)}`);
            return this._extractVideoResult(data);
        }

        // Check for error
        if (currentStatus === 'FAILED' || currentStatus === 'ERROR') {
            throw new Error(`Video generation failed with status: ${currentStatus}`);
        }

        // Check media array for status
        if (data.media && Array.isArray(data.media)) {
            for (const m of data.media) {
                const mStatus = m.status || m.mediaMetadata?.status || '';
                if (mStatus.includes('SUCCEEDED') || mStatus.includes('SUCCESSFUL') || mStatus.includes('COMPLETE')) {
                    console.log(`[FlowVideo] ✅ Media complete! Status: ${mStatus}`);
                    return this._extractVideoResult(data);
                }
            }
        }

        // Check operations array
        if (data.operations && Array.isArray(data.operations)) {
            for (const op of data.operations) {
                const opStatus = op.status || '';
                if (opStatus.includes('SUCCEEDED') || opStatus.includes('COMPLETE')) {
                    console.log(`[FlowVideo] ✅ Operation complete! Status: ${opStatus}`);
                    return this._extractVideoResult(data);
                }
            }
        }

        // Check if done flag
        if (data.done === true) {
            console.log(`[FlowVideo] ✅ Done flag is true!`);
            return this._extractVideoResult(data);
        }

        return null; // Not done yet
    }

    _extractVideoResult(data) {
        const media = data.response?.generatedMedia
            || data.response?.media
            || data.result?.generatedMedia
            || data.media
            || [];

        // Debug: log structure of first media item
        if (media.length > 0) {
            console.log(`[FlowVideo] Media[0] keys: ${Object.keys(media[0]).join(', ')}`);
            if (media[0].video) {
                console.log(`[FlowVideo] Media[0].video keys: ${Object.keys(media[0].video).join(', ')}`);
                if (media[0].video.generatedVideo) {
                    console.log(`[FlowVideo] generatedVideo keys: ${Object.keys(media[0].video.generatedVideo).join(', ')}`);
                    console.log(`[FlowVideo] generatedVideo JSON: ${JSON.stringify(media[0].video.generatedVideo).substring(0, 800)}`);
                }
            }
        }

        let videoUrl = '';

        // 1. Try known nested paths
        if (media.length > 0) {
            const m = media[0];
            videoUrl = m?.video?.uri
                || m?.video?.generatedVideo?.fifeUrl
                || m?.video?.generatedVideo?.uri
                || m?.video?.generatedVideo?.signedUri
                || m?.video?.generatedVideo?.encodedVideoUri
                || m?.video?.generatedVideo?.videoUrl
                || m?.video?.generatedVideo?.url
                || m?.video?.fifeUrl
                || m?.fifeUrl
                || m?.uri
                || '';
        }

        if (!videoUrl) {
            videoUrl = data.response?.videoUrl || data.result?.videoUrl || '';
        }

        // 2. Regex scan entire JSON for URLs
        if (!videoUrl) {
            const dataStr = JSON.stringify(data);

            // Look for signed GCS URLs (storage.googleapis.com)
            const gcsMatch = dataStr.match(/"(https?:\/\/storage\.googleapis\.com\/[^"]+)"/);
            if (gcsMatch) {
                videoUrl = gcsMatch[1];
                console.log(`[FlowVideo] Found video URL via regex (GCS signed URL)`);
            }

            // Look for fifeUrl
            if (!videoUrl) {
                const fifeMatch = dataStr.match(/"fifeUrl"\s*:\s*"(https?:\/\/[^"]+)"/);
                if (fifeMatch) {
                    videoUrl = fifeMatch[1];
                    console.log(`[FlowVideo] Found video URL via regex (fifeUrl)`);
                }
            }

            // Look for any uri
            if (!videoUrl) {
                const uriMatch = dataStr.match(/"uri"\s*:\s*"(https?:\/\/[^"]+)"/);
                if (uriMatch) {
                    videoUrl = uriMatch[1];
                    console.log(`[FlowVideo] Found video URL via regex (uri)`);
                }
            }

            if (!videoUrl) {
                console.log(`[FlowVideo] Full response: ${dataStr.substring(0, 1000)}`);
            }
        }

        console.log(`[FlowVideo] Extracted video URL: ${videoUrl ? videoUrl.substring(0, 200) + '...' : '(none)'}`);
        return { videoUrl };
    }
}
