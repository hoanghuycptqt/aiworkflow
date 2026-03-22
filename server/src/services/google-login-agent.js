/**
 * Google Login Agent — Gemini Vision + Puppeteer
 *
 * Automates Google login for Google Flow (labs.google) using:
 * - Puppeteer with stealth plugin + persistent Chrome profile (per-user)
 * - Gemini Vision API to interpret UI and decide actions
 * - Telegram as bridge for 2FA and unexpected challenges
 *
 * Usage:
 *   await loginGoogleFlow(userId, credentialId, telegramChatId)
 *   await refreshCookies(userId, credentialId)
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { GoogleGenAI } from '@google/genai';
import { prisma } from '../index.js';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { spawn } from 'child_process';
import { CHROME_PATH } from './browser-manager.js';

puppeteer.use(StealthPlugin());

const GOOGLE_FLOW_URL = 'https://labs.google/fx/vi/tools/flow';
const PROFILES_BASE = join(process.env.UPLOAD_DIR || './uploads', '.google-profiles');
const MAX_LOGIN_STEPS = 20;
const PAGE_LOAD_TIMEOUT = 30000;
const STEP_DELAY_MIN = 800;
const STEP_DELAY_MAX = 2000;
const DEBUG_PORT_BASE = 9222;
const DEBUG_PORT_RANGE = 100; // ports 9222-9322

// ─── Pending Telegram Input ─────────────────────────────
// Shared with telegram-bot.js for 2FA input flow
export const pendingInputRequests = new Map(); // chatId → { resolve, reject, timeout }

// ─── Per-user operation lock ─────────────────────────────
// Prevents concurrent login/refresh on same user's Chrome
const activeOperations = new Map(); // userId → true

/**
 * Wait for user input via Telegram.
 * Returns the user's reply text, or throws on timeout.
 */
function waitForTelegramInput(chatId, promptMessage, sendFn, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingInputRequests.delete(chatId);
            reject(new Error('Timeout waiting for user input via Telegram'));
        }, timeoutMs);

        pendingInputRequests.set(chatId, {
            resolve: (text) => {
                clearTimeout(timer);
                pendingInputRequests.delete(chatId);
                resolve(text);
            },
            reject: (err) => {
                clearTimeout(timer);
                pendingInputRequests.delete(chatId);
                reject(err);
            },
            timeout: timer,
        });

        // Send prompt to user
        sendFn(promptMessage);
    });
}

// ─── Helpers ─────────────────────────────────────────────

function randomDelay(min = STEP_DELAY_MIN, max = STEP_DELAY_MAX) {
    return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

function getProfileDir(userId) {
    return join(PROFILES_BASE, userId);
}

async function ensureProfileDir(userId) {
    const dir = getProfileDir(userId);
    await mkdir(dir, { recursive: true });
    return dir;
}

/**
 * Get the Gemini model from admin settings.
 */
async function getGeminiModel() {
    try {
        const setting = await prisma.systemSetting.findUnique({ where: { key: 'telegram_ai_model' } });
        return setting?.value || 'gemini-3-flash-preview';
    } catch {
        return 'gemini-3-flash-preview';
    }
}

/**
 * Get the expected Google email for a user from their google-account credential.
 */
async function getExpectedEmail(userId) {
    const googleAccount = await prisma.credential.findFirst({
        where: { userId, provider: 'google-account' },
    });
    if (!googleAccount?.metadata) return null;
    const meta = JSON.parse(googleAccount.metadata);
    return meta.email?.toLowerCase() || null;
}

/**
 * Get a consistent debug port per user (hash userId → port in 9222-9322 range).
 */
function getDebugPort(userId) {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
        hash = ((hash << 5) - hash) + userId.charCodeAt(i);
        hash |= 0; // Convert to 32bit integer
    }
    return DEBUG_PORT_BASE + (Math.abs(hash) % DEBUG_PORT_RANGE);
}

/**
 * Sign out of Google in Chrome (without deleting the profile).
 * Navigates to Google logout URL, then waits for it to complete.
 */
async function signOutGoogle(browser) {
    try {
        const pages = await browser.pages();
        const page = pages.length > 0 ? pages[0] : await browser.newPage();
        console.log('[GoogleLogin] Signing out of Google...');
        await page.goto('https://accounts.google.com/Logout', {
            waitUntil: 'networkidle2',
            timeout: 15000,
        });
        await randomDelay(1000, 2000);
        console.log('[GoogleLogin] ✅ Signed out of Google');
    } catch (e) {
        console.warn(`[GoogleLogin] Sign out error (non-fatal): ${e.message}`);
    }
}

/**
 * Launch Chrome NATIVELY (not via puppeteer.launch) and connect via CDP.
 * This makes Chrome appear 100% normal to Google — no automation flags.
 *
 * puppeteer.launch() adds automation markers (--enable-automation, navigator.webdriver=true, etc.)
 * that Google detects and blocks with "This browser or app may not be secure".
 *
 * By launching Chrome directly and connecting via remote debugging port,
 * the browser is indistinguishable from a real user's Chrome.
 */
async function launchPersistentChrome(userId) {
    const profileDir = await ensureProfileDir(userId);
    const chromePath = process.env.CHROME_PATH || CHROME_PATH;
    const debugPort = getDebugPort(userId);

    // Check if Chrome is already running for this user
    try {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
        if (res.ok) {
            console.log(`[GoogleLogin] Chrome already running on port ${debugPort} for user ${userId}, reusing...`);
            const data = await res.json();
            const browser = await puppeteer.connect({
                browserWSEndpoint: data.webSocketDebuggerUrl,
                defaultViewport: null,
            });
            return { browser, chromeProcess: null, debugPort };
        }
    } catch { /* not running, will launch */ }

    // Launch Chrome natively — NO automation flags
    const args = [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${debugPort}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1280,900',
        '--disable-blink-features=AutomationControlled', // Prevent navigator.webdriver = true
    ];

    // On Linux (VPS), need --no-sandbox and anti-detection flags for Xvfb
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

    console.log(`[GoogleLogin] Launching Chrome natively: ${chromePath}`);
    const chromeProcess = spawn(chromePath, args, {
        stdio: 'ignore',
        detached: true,
        env: { ...process.env },
    });

    chromeProcess.unref();

    // Wait for Chrome to be ready (poll the debug endpoint)
    let browser = null;
    for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise(r => setTimeout(r, 500));
        try {
            const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
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
        chromeProcess.kill();
        throw new Error('Chrome failed to start within 15 seconds');
    }

    // Note: stealth scripts are injected per-page via prepareStealthPage()\n    // called before each navigation in loginGoogleFlow and refreshCookies

    console.log(`[GoogleLogin] ✅ Chrome launched natively & connected via CDP (port: ${debugPort}, profile: ${profileDir})`);
    return { browser, chromeProcess, debugPort };
}

// Realistic macOS Chrome User-Agent
const STEALTH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.159 Safari/537.36';

// Stealth script injected before every page load
const STEALTH_SCRIPT = `
    // 1. Override navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // 2. Override navigator.plugins (Chrome normally has plugins)
    Object.defineProperty(navigator, 'plugins', {
        get: () => {
            const arr = [
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
                { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 1 },
            ];
            arr.item = (i) => arr[i];
            arr.namedItem = (name) => arr.find(p => p.name === name);
            arr.refresh = () => {};
            return arr;
        },
    });

    // 3. Override navigator.languages and navigator.platform
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'vi'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });

    // 4. Fix chrome.runtime (present in real Chrome, missing in automation)
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) {
        window.chrome.runtime = {
            connect: () => {},
            sendMessage: () => {},
            id: undefined,
        };
    }
    // Remove chrome.csi and chrome.loadTimes if they look fake
    if (!window.chrome.csi) window.chrome.csi = function() { return {}; };
    if (!window.chrome.loadTimes) window.chrome.loadTimes = function() { return {}; };

    // 5. Override permissions API
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
        window.navigator.permissions.query = (parameters) =>
            parameters.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : originalQuery(parameters);
    }

    // 6. Mask WebGL vendor/renderer (avoid "SwiftShader" on headless)
    const getParam = WebGLRenderingContext?.prototype?.getParameter;
    if (getParam) {
        WebGLRenderingContext.prototype.getParameter = function(param) {
            if (param === 37445) return 'Intel Inc.';
            if (param === 37446) return 'Intel Iris OpenGL Engine';
            return getParam.call(this, param);
        };
    }
    const getParam2 = WebGL2RenderingContext?.prototype?.getParameter;
    if (getParam2) {
        WebGL2RenderingContext.prototype.getParameter = function(param) {
            if (param === 37445) return 'Intel Inc.';
            if (param === 37446) return 'Intel Iris OpenGL Engine';
            return getParam2.call(this, param);
        };
    }

    // 7. Override navigator.userAgentData
    if (navigator.userAgentData) {
        Object.defineProperty(navigator, 'userAgentData', {
            get: () => ({
                brands: [
                    { brand: 'Google Chrome', version: '145' },
                    { brand: 'Chromium', version: '145' },
                    { brand: 'Not=A?Brand', version: '24' },
                ],
                mobile: false,
                platform: 'macOS',
                getHighEntropyValues: () => Promise.resolve({
                    architecture: 'x86',
                    model: '',
                    platform: 'macOS',
                    platformVersion: '15.0.0',
                    uaFullVersion: '145.0.7632.159',
                }),
            }),
        });
    }

    // 8. ★ CRITICAL: Remove cdc_ variables (CDP detection markers)
    // When Chrome DevTools Protocol connects, it injects variables like
    // cdc_adoQpoasnfa76pfcZLmcfl_Array, cdc_adoQpoasnfa76pfcZLmcfl_Promise etc.
    // Google scans for these to detect automated browsers.
    const removeCdcProps = () => {
        for (const key of Object.keys(document)) {
            if (key.startsWith('cdc_') || key.startsWith('__webdriver') || key.startsWith('$cdc_')) {
                delete document[key];
            }
        }
        for (const key of Object.keys(window)) {
            if (key.startsWith('cdc_') || key.startsWith('__webdriver') || key.startsWith('$cdc_')) {
                delete window[key];
            }
        }
    };
    removeCdcProps();
    // Keep removing as they may be re-injected
    const cdcInterval = setInterval(removeCdcProps, 50);
    setTimeout(() => clearInterval(cdcInterval), 10000);

    // 9. document.hasFocus() — headless often returns false
    Document.prototype.hasFocus = function() { return true; };

    // 10. Screen properties matching viewport
    Object.defineProperty(screen, 'width', { get: () => 1280 });
    Object.defineProperty(screen, 'height', { get: () => 900 });
    Object.defineProperty(screen, 'availWidth', { get: () => 1280 });
    Object.defineProperty(screen, 'availHeight', { get: () => 900 });
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });

    // 11. Mask window.outerWidth/outerHeight (0 in headless)
    if (window.outerWidth === 0) {
        Object.defineProperty(window, 'outerWidth', { get: () => 1280 });
        Object.defineProperty(window, 'outerHeight', { get: () => 900 });
    }

    // 12. Remove Puppeteer from Error stack traces
    const origGetStack = Object.getOwnPropertyDescriptor(Error.prototype, 'stack');
    if (origGetStack && origGetStack.get) {
        Object.defineProperty(Error.prototype, 'stack', {
            get: function() {
                const stack = origGetStack.get.call(this);
                if (typeof stack === 'string') {
                    return stack.replace(/puppeteer/gi, 'chrome').replace(/pptr:/gi, 'chrome:');
                }
                return stack;
            }
        });
    }
`;

/**
 * Prepare a page with stealth settings before navigation.
 * Call this on every new page BEFORE page.goto().
 */
async function prepareStealthPage(page) {
    // Set realistic User-Agent via CDP (affects HTTP headers AND JS navigator.userAgent)
    const client = await page.target().createCDPSession();
    await client.send('Network.setUserAgentOverride', {
        userAgent: STEALTH_UA,
        platform: 'MacIntel',
        acceptLanguage: 'en-US,en;q=0.9,vi;q=0.8',
    });
    await client.detach();

    // Also inject stealth script on this specific page
    await page.evaluateOnNewDocument(new Function(STEALTH_SCRIPT));

    // Set realistic viewport
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
}

/**
 * Take screenshot and convert to base64 for Gemini.
 */
async function takeScreenshot(page) {
    const buffer = await page.screenshot({ type: 'jpeg', quality: 70 });
    return buffer.toString('base64');
}

/**
 * Call Gemini Vision to analyze screenshot and decide next action.
 */
async function analyzeWithGemini(screenshotBase64, context, model) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

    const ai = new GoogleGenAI({ apiKey });

    const systemPrompt = `You are a browser automation agent. You analyze screenshots of web pages and decide what action to take next.

CONTEXT: ${context}

You MUST respond with a valid JSON object (no markdown, no code fences, just raw JSON) with these fields:
- "status": one of "need_action", "need_2fa", "need_user_input", "login_complete", "already_logged_in", "error"
- "action": one of "type_text", "click_button", "wait", "press_enter", "navigate" (only when status is "need_action")
- "target": for click_button, use the VISIBLE TEXT on the button (e.g. "Tiếp theo", "Next", "Đăng nhập", "Sign in"). For type_text, use a simple CSS selector like "input[type=email]" or "input[type=password]"
- "value": text to type (for type_text) or URL (for navigate)
- "description": brief description in Vietnamese of what you see and what you're doing (1 sentence)
- "userMessage": message to send to user via Telegram (only for need_2fa, need_user_input, or error)

CRITICAL SELECTOR RULES:
- NEVER use :contains() — it is NOT valid CSS
- For click_button: "target" must be the VISIBLE BUTTON TEXT, not a CSS selector. Examples: "Tiếp theo", "Next", "Đăng nhập"
- For type_text: "target" must be a simple CSS selector like "input[type=email]", "input[type=password]", "#identifierId"
- For Google login: the email input is "#identifierId" or "input[type=email]"
- For Google login: the password input is "input[type=password]" or "input[name=Passwd]"

IMPORTANT RULES:
1. Google login flow: email page → password page → possibly 2FA → redirect to destination
2. If you see a Google login page with email input, type the email and click Next
3. If you see a password input, type the password and click Next
4. PASSKEY/BIOMETRICS: If you see "Sử dụng khóa truy cập" or "Use your passkey" or "Xác minh danh tính" with a passkey/fingerprint icon, this is NOT 2FA. You MUST click "Thử cách khác" or "Try another way" to get to the password page. Set status to "need_action" with action "click_button" and target "Thử cách khác".
5. After clicking "Try another way", if you see a list of verification methods, click "Nhập mật khẩu" or "Enter your password" or the password option.
6. REAL 2FA: Only set status to "need_2fa" when you see a phone approval prompt (Google sends notification to phone, or shows a number to tap). These look like "Kiểm tra điện thoại" or "Check your phone" or a number matching prompt.
7. If you see the Google Flow page (labs.google) with the Flow tool UI, set status to "login_complete"
8. If you see "Chọn tài khoản" (account picker), click the correct account email
9. If the page shows any unexpected challenge, set status to "need_user_input" and describe it
10. For the number matching 2FA (Google shows a number to tap on phone), read the number and include it in userMessage
11. If already on Google Flow (the creative tool page), set status to "already_logged_in"
12. Use Vietnamese for userMessage and description`;

    const response = await ai.models.generateContent({
        model,
        contents: [{
            parts: [
                {
                    inlineData: {
                        mimeType: 'image/jpeg',
                        data: screenshotBase64,
                    },
                },
                { text: 'Analyze this screenshot and respond with the JSON action.' },
            ],
        }],
        config: {
            systemInstruction: systemPrompt,
            temperature: 0.1, // Low temperature for deterministic actions
            maxOutputTokens: 1024,
        },
    });

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Parse JSON from response (handle markdown code fences)
    let jsonStr = text.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    try {
        return JSON.parse(jsonStr);
    } catch (e) {
        console.error('[GoogleLogin] Failed to parse Gemini response:', text);
        return {
            status: 'error',
            description: 'Gemini response was not valid JSON',
            userMessage: `Lỗi phân tích response từ AI: ${text.substring(0, 200)}`,
        };
    }
}

/**
 * Execute a Gemini-decided action on the page.
 */
async function executeAction(page, action) {
    const { action: actionType, target, value } = action;

    switch (actionType) {
        case 'type_text': {
            // Try multiple strategies to find and type into the input
            try {
                // Strategy 1: Use the selector directly
                await page.waitForSelector(target, { timeout: 5000 });
                await page.click(target, { clickCount: 3 }); // Triple-click to select all text
                await randomDelay(100, 200);
                await page.keyboard.press('Backspace'); // Delete selected text
                await randomDelay(200, 500);
                // Type with random delay between keystrokes
                await page.type(target, value, { delay: 50 + Math.random() * 100 });
            } catch {
                // Strategy 2: Focus on active element, clear, and type
                console.log(`[GoogleLogin] Selector "${target}" not found, trying active element`);
                // Select all + delete to clear any existing text
                const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
                await page.keyboard.down(modKey);
                await page.keyboard.press('a');
                await page.keyboard.up(modKey);
                await page.keyboard.press('Backspace');
                await randomDelay(200, 400);
                await page.keyboard.type(value, { delay: 50 + Math.random() * 100 });
            }
            break;
        }
        case 'click_button': {
            // Extract the meaningful text from target (strip jQuery-style selectors)
            let buttonText = target;
            const containsMatch = target.match(/:contains\(['"](.+?)['"]\)/);
            if (containsMatch) buttonText = containsMatch[1];

            console.log(`[GoogleLogin] Clicking button with text: "${buttonText}"`);
            await randomDelay(300, 800);

            // Use evaluateHandle to return actual DOM element (not serialized data)
            const elementHandle = await page.evaluateHandle((searchText) => {
                const normalize = (s) => (s || '').trim().toLowerCase();
                const searchLower = normalize(searchText);

                // Strategy 1: Buttons, links, role=button
                const clickables = document.querySelectorAll('button, [role="button"], a, input[type="submit"], input[type="button"]');
                for (const el of clickables) {
                    const text = normalize(el.textContent);
                    const ariaLabel = normalize(el.getAttribute('aria-label'));
                    if (text.includes(searchLower) || ariaLabel.includes(searchLower)) {
                        return el;
                    }
                }

                // Strategy 2: Find text in any element → walk up to best clickable ancestor
                // Collect ALL matching elements, then pick the smallest (most specific) one
                const allElements = document.querySelectorAll('span, div, p, label, li');
                const candidates = [];
                for (const el of allElements) {
                    if (el.children.length > 5) continue;
                    const elText = normalize(el.textContent);
                    if (elText === searchLower || elText.includes(searchLower)) {
                        candidates.push({ el, len: el.textContent.length });
                    }
                }
                // Sort by text length — smallest first (most specific match)
                candidates.sort((a, b) => a.len - b.len);

                for (const { el } of candidates) {
                    // Walk up to find best clickable ancestor (EXCLUDE body, html, main, header, footer)
                    const skipTags = new Set(['BODY', 'HTML', 'MAIN', 'HEADER', 'FOOTER', 'SECTION', 'ARTICLE']);
                    let ancestor = el.parentElement;
                    for (let depth = 0; depth < 8 && ancestor; depth++) {
                        if (skipTags.has(ancestor.tagName)) break; // stop before reaching page-level containers
                        const style = window.getComputedStyle(ancestor);
                        if (style.cursor === 'pointer' ||
                            ancestor.onclick ||
                            ancestor.tagName === 'BUTTON' ||
                            ancestor.tagName === 'A' ||
                            ancestor.tagName === 'LI' ||
                            ancestor.getAttribute('role') === 'button' ||
                            ancestor.getAttribute('role') === 'link' ||
                            ancestor.getAttribute('data-challengeid') ||
                            ancestor.getAttribute('tabindex')) {
                            return ancestor;
                        }
                        ancestor = ancestor.parentElement;
                    }
                    // No clickable ancestor found — return the element itself
                    return el;
                }

                // Strategy 3: Google-specific selectors
                const googleSelectors = [
                    '#identifierNext button', '#passwordNext button',
                    '#identifierNext', '#passwordNext',
                    'button[jsname="LgbsSe"]', 'div[jsname="Njthtb"]',
                ];
                for (const sel of googleSelectors) {
                    const el = document.querySelector(sel);
                    if (el) return el;
                }

                return null;
            }, buttonText);

            // Get the element from the handle
            const element = elementHandle.asElement();

            if (element) {
                // Get info for logging
                const info = await element.evaluate(el => ({
                    tag: el.tagName,
                    text: el.textContent?.trim()?.substring(0, 50),
                    role: el.getAttribute('role'),
                    jsaction: el.getAttribute('jsaction'),
                }));
                console.log(`[GoogleLogin] ✅ Found element: <${info.tag}> role=${info.role} jsaction=${info.jsaction ? 'yes' : 'no'}`);

                // Use Puppeteer's native element click (scrolls + moves mouse + CDP events)
                try {
                    await element.click();
                    console.log(`[GoogleLogin] ✅ Clicked via elementHandle.click()`);
                } catch (clickErr) {
                    // Fallback: get bounding box and use page.mouse.click
                    console.log(`[GoogleLogin] elementHandle.click failed: ${clickErr.message}, trying mouse.click`);
                    const box = await element.boundingBox();
                    if (box) {
                        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                        console.log(`[GoogleLogin] ✅ Clicked via mouse.click at (${Math.round(box.x + box.width / 2)}, ${Math.round(box.y + box.height / 2)})`);
                    }
                }
            } else {
                console.warn(`[GoogleLogin] ⚠️ Could not find button "${buttonText}", trying Enter key`);
                await page.keyboard.press('Enter');
            }

            await elementHandle.dispose();
            break;
        }
        case 'press_enter': {
            await page.keyboard.press('Enter');
            break;
        }
        case 'wait': {
            await randomDelay(2000, 4000);
            break;
        }
        case 'navigate': {
            await page.goto(value, { waitUntil: 'networkidle2', timeout: PAGE_LOAD_TIMEOUT });
            break;
        }
    }

    // Wait for page to settle after action
    await randomDelay(1500, 3000);
}

/**
 * Extract ALL cookies from the browser (including HttpOnly) via CDP.
 */
async function extractAllCookies(page) {
    const client = await page.target().createCDPSession();
    const { cookies } = await client.send('Network.getAllCookies');
    await client.detach();

    console.log(`[GoogleLogin] CDP returned ${cookies.length} total cookies`);

    // Filter for Google/Labs-related cookies
    const googleCookies = cookies.filter(c =>
        c.domain.includes('.google.com') ||
        c.domain.includes('labs.google') ||
        c.domain.includes('.google.') ||
        c.domain.includes('google.com')
    );

    console.log(`[GoogleLogin] Filtered to ${googleCookies.length} Google cookies`);

    // Log key cookies for debugging
    const keyCookieNames = ['__Secure-next-auth.session-token', '__Secure-next-auth.callback-url', '__Host-next-auth.csrf-token', 'email', 'EMAIL'];
    for (const name of keyCookieNames) {
        const found = googleCookies.find(c => c.name === name);
        console.log(`[GoogleLogin]   ${name}: ${found ? `✅ (${found.value.substring(0, 30)}...)` : '❌ NOT FOUND'}`);
    }

    // Format as cookie header string
    const cookieString = googleCookies
        .map(c => `${c.name}=${c.value}`)
        .join('; ');

    return { cookies: googleCookies, cookieString };
}

/**
 * Call the session API to get a fresh access token using cookies.
 */
async function getAccessToken(cookieString) {
    const res = await fetch('https://labs.google/fx/api/auth/session', {
        method: 'GET',
        headers: {
            'Accept': '*/*',
            'Content-Type': 'application/json',
            'Cookie': cookieString,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
            'Referer': 'https://labs.google/fx/vi/tools/flow/',
        },
    });

    if (!res.ok) {
        throw new Error(`Session API returned ${res.status}`);
    }

    const data = await res.json();
    if (!data.access_token) {
        throw new Error('No access_token in session response');
    }

    return {
        accessToken: data.access_token,
        expiresAt: data.expires || null,
        userName: data.user?.name,
        userEmail: data.user?.email,
    };
}

/**
 * Save extracted cookies and access token to the google-flow credential.
 * Creates or updates the google-flow credential for this user.
 */
async function saveCredentialsToDB(userId, cookieString, tokenData) {
    // Find or create google-flow credential for this user
    let credential = await prisma.credential.findFirst({
        where: { userId, provider: 'google-flow' },
    });

    const metadata = {
        sessionCookies: cookieString,
        lastRefreshed: new Date().toISOString(),
        tokenExpiresAt: tokenData.expiresAt,
        userName: tokenData.userName,
        userEmail: tokenData.userEmail,
        autoLoginEnabled: true,
    };

    if (credential) {
        // Update existing
        const existingMeta = credential.metadata ? JSON.parse(credential.metadata) : {};
        await prisma.credential.update({
            where: { id: credential.id },
            data: {
                token: tokenData.accessToken,
                metadata: JSON.stringify({ ...existingMeta, ...metadata }),
            },
        });
        console.log(`[GoogleLogin] Updated google-flow credential: ${credential.id}`);
    } else {
        // Create new
        credential = await prisma.credential.create({
            data: {
                userId,
                provider: 'google-flow',
                label: 'Auto-Login Google Flow',
                token: tokenData.accessToken,
                metadata: JSON.stringify(metadata),
            },
        });
        console.log(`[GoogleLogin] Created new google-flow credential: ${credential.id}`);
    }

    return credential;
}

// ─── Main Login Function ─────────────────────────────────

/**
 * Full automated login to Google Flow.
 *
 * @param {string} userId - User ID
 * @param {string} googleAccountCredentialId - Credential ID of google-account (has email/password)
 * @param {string} telegramChatId - Telegram chat ID for notifications
 * @param {Function} sendTelegram - Function to send text to Telegram: (message) => Promise
 * @returns {object} { success, message, credentialId }
 */
export async function loginGoogleFlow(userId, googleAccountCredentialId, telegramChatId, sendTelegram) {
    // Check if another operation is already running for this user
    if (activeOperations.get(userId)) {
        return { success: false, message: '⚠️ Đang có thao tác login/refresh khác đang chạy cho user này. Vui lòng đợi.' };
    }
    activeOperations.set(userId, true);

    let browser = null;
    let chromeProcess = null;

    try {
        // 1. Get Google account credentials
        const googleAccount = await prisma.credential.findFirst({
            where: { id: googleAccountCredentialId, userId, provider: 'google-account' },
        });

        if (!googleAccount) {
            throw new Error('Google Account credential not found. Add it in Web UI → Credentials.');
        }

        const accountMeta = googleAccount.metadata ? JSON.parse(googleAccount.metadata) : {};
        const email = accountMeta.email;
        const password = accountMeta.password; // TODO: decrypt when encryption is implemented

        if (!email || !password) {
            throw new Error('Google Account credential is missing email or password.');
        }

        // 2. Get Gemini model
        const model = await getGeminiModel();
        console.log(`[GoogleLogin] Using model: ${model}`);

        // 3. Launch Chrome
        await sendTelegram('🚀 Đang khởi động trình duyệt...');
        const launched = await launchPersistentChrome(userId);
        browser = launched.browser;
        chromeProcess = launched.chromeProcess;

        // Always create a new page (old pages may be detached after server restart)
        const page = await browser.newPage();
        await prepareStealthPage(page); // Stealth: UA, viewport, scripts BEFORE navigation
        await page.setDefaultNavigationTimeout(PAGE_LOAD_TIMEOUT);

        // 4. Navigate to Google Flow
        console.log(`[GoogleLogin] Navigating to ${GOOGLE_FLOW_URL}`);
        await page.goto(GOOGLE_FLOW_URL, {
            waitUntil: 'networkidle2',
            timeout: PAGE_LOAD_TIMEOUT,
        });

        await randomDelay(2000, 3000);

        // 5. Gemini Vision Loop
        const context = `Logging into Google Flow. Email: ${email}. Password: [AVAILABLE - type it when you see password input]. Goal: reach ${GOOGLE_FLOW_URL} logged in. You have both email and password, so ALWAYS use type_text with status "need_action" for password fields. NEVER ask for the password via need_user_input.`;
        let step = 0;
        let loginSuccess = false;

        while (step < MAX_LOGIN_STEPS) {
            step++;
            console.log(`[GoogleLogin] Step ${step}/${MAX_LOGIN_STEPS}`);

            // Take screenshot
            const screenshot = await takeScreenshot(page);

            // Analyze with Gemini
            const analysis = await analyzeWithGemini(screenshot, context, model);
            console.log(`[GoogleLogin] Gemini says: ${analysis.status} — ${analysis.description}`);

            switch (analysis.status) {
                case 'already_logged_in':
                case 'login_complete': {
                    console.log('[GoogleLogin] ✅ Login complete!');
                    loginSuccess = true;
                    break;
                }

                case 'need_action': {
                    // Gemini wants to type/click something
                    const actionToExecute = { ...analysis };
                    // Inject actual credentials (Gemini only knows to type, not the actual values)
                    if (analysis.action === 'type_text') {
                        if (analysis.value === email || analysis.description?.toLowerCase().includes('email')) {
                            actionToExecute.value = email;
                        }
                        if (analysis.description?.toLowerCase().includes('password') || 
                            analysis.description?.toLowerCase().includes('mật khẩu') ||
                            analysis.target?.includes('password') ||
                            analysis.target?.includes('Passwd')) {
                            actionToExecute.value = password;
                        }
                    }
                    await executeAction(page, actionToExecute);
                    break;
                }


                case 'need_2fa': {
                    // 2FA required — notify user via Telegram
                    const msg = analysis.userMessage || '🔔 Google yêu cầu xác thực. Vui lòng nhấn "Có" trên điện thoại trong 2 phút.';
                    await sendTelegram(msg);

                    // Poll for page change (user approves on phone)
                    let approved = false;
                    const startTime = Date.now();
                    while (Date.now() - startTime < 120000) { // 2 min timeout
                        await randomDelay(3000, 5000);
                        const currentUrl = page.url();
                        // If redirected away from accounts.google.com → 2FA approved
                        if (!currentUrl.includes('accounts.google.com/v3/signin') &&
                            !currentUrl.includes('accounts.google.com/signin')) {
                            approved = true;
                            break;
                        }
                        // Also check if page content changed (some 2FA stays on same URL)
                        const newScreenshot = await takeScreenshot(page);
                        const recheck = await analyzeWithGemini(newScreenshot, context, model);
                        if (recheck.status === 'login_complete' || recheck.status === 'already_logged_in') {
                            approved = true;
                            loginSuccess = true;
                            break;
                        }
                        if (recheck.status === 'need_action') {
                            // 2FA approved, now there's another action needed
                            await executeAction(page, recheck);
                            approved = true;
                            break;
                        }
                    }

                    if (!approved) {
                        await sendTelegram('⏰ Hết thời gian chờ xác thực 2FA. Vui lòng thử lại.');
                        throw new Error('2FA timeout — user did not approve within 2 minutes');
                    }
                    await sendTelegram('✅ Xác thực thành công!');
                    break;
                }

                case 'need_user_input': {
                    // Check if this is actually a password prompt — auto-fill from DB
                    const inputDesc = (analysis.description || '').toLowerCase() + ' ' + (analysis.userMessage || '').toLowerCase();
                    if (inputDesc.includes('password') || inputDesc.includes('mật khẩu')) {
                        console.log('[GoogleLogin] Gemini asked for password but we have it — auto-typing');
                        const pwTarget = analysis.target || 'input[type=password]';
                        await executeAction(page, { action: 'type_text', target: pwTarget, value: password });
                        await randomDelay(500, 1000);
                        await page.keyboard.press('Enter');
                        break;
                    }
                    // Not a password prompt — ask user via Telegram
                    const inputMsg = analysis.userMessage || '❓ Google yêu cầu thông tin bổ sung. Vui lòng trả lời tin nhắn này.';
                    try {
                        const userReply = await waitForTelegramInput(
                            telegramChatId,
                            inputMsg,
                            sendTelegram,
                            120000
                        );
                        // Type the user's reply
                        if (analysis.target) {
                            await executeAction(page, { action: 'type_text', target: analysis.target, value: userReply });
                        } else {
                            await page.keyboard.type(userReply, { delay: 80 });
                        }
                        await randomDelay(500, 1000);
                        await page.keyboard.press('Enter');
                    } catch (e) {
                        await sendTelegram('⏰ Hết thời gian chờ phản hồi.');
                        throw e;
                    }
                    break;
                }

                case 'error': {
                    const errMsg = analysis.userMessage || analysis.description || 'Unknown error';
                    // Save error screenshot for debugging
                    try {
                        const errScreenshot = await page.screenshot({ type: 'png', fullPage: true });
                        const errPath = path.join('uploads', `google-login-error-${Date.now()}.png`);
                        await fs.writeFile(errPath, errScreenshot);
                        console.log(`[GoogleLogin] ⚠️ Error screenshot saved: ${errPath}`);
                    } catch { /* ok */ }
                    throw new Error(`Login agent error: ${errMsg}`);
                }
            }

            if (loginSuccess) break;
            await randomDelay();
        }

        if (!loginSuccess) {
            // May have landed on the page after many steps — do a final check
            const finalUrl = page.url();
            if (finalUrl.includes('labs.google')) {
                loginSuccess = true;
            }
        }

        if (!loginSuccess) {
            throw new Error(`Login failed after ${MAX_LOGIN_STEPS} steps`);
        }

        // 6. Navigate to Google Flow page to ensure NextAuth cookies are present
        console.log('[GoogleLogin] Navigating to Google Flow to ensure cookies are set...');
        const currentUrl = page.url();
        if (!currentUrl.includes('labs.google/fx')) {
            await page.goto(GOOGLE_FLOW_URL, { waitUntil: 'networkidle2', timeout: PAGE_LOAD_TIMEOUT });
        }
        await randomDelay(3000, 5000); // Wait for cookies to settle

        // 7. Extract cookies
        console.log('[GoogleLogin] Extracting cookies via CDP...');
        const { cookieString } = await extractAllCookies(page);
        console.log(`[GoogleLogin] Cookie string length: ${cookieString.length} chars`);

        if (!cookieString || cookieString.length < 50) {
            throw new Error('Extracted cookies are too short — login may have failed');
        }

        // 8. Get access token via session API
        console.log('[GoogleLogin] Getting access token via session API...');
        const tokenData = await getAccessToken(cookieString);

        // 9. Verify correct account
        if (tokenData.userEmail && email) {
            const actualEmail = tokenData.userEmail.toLowerCase();
            const expectedEmail = email.toLowerCase();
            if (actualEmail !== expectedEmail) {
                console.log(`[GoogleLogin] ❌ Wrong account! Expected: ${expectedEmail}, Got: ${actualEmail}`);
                await sendTelegram(`⚠️ Đang đăng nhập bằng tài khoản sai (${actualEmail}). Đang đăng xuất và đăng nhập lại bằng ${expectedEmail}...`);
                
                // Sign out of Google (keep profile intact) and retry
                await signOutGoogle(browser);
                browser.disconnect();
                browser = null;
                chromeProcess = null;
                
                // Wait a bit then retry
                await randomDelay(2000, 3000);
                return loginGoogleFlow(userId, googleAccountCredentialId, telegramChatId, sendTelegram);
            }
        }

        // 10. Save to DB
        const savedCredential = await saveCredentialsToDB(userId, cookieString, tokenData);

        // Close Chrome completely — profile on disk preserves the session
        try { await page.close(); } catch { /* ok */ }
        try { await browser.close(); } catch { browser.disconnect(); }
        if (chromeProcess) try { chromeProcess.kill(); } catch { /* ok */ }
        browser = null;
        chromeProcess = null;

        const result = {
            success: true,
            message: `✅ Login Google Flow thành công (${tokenData.userEmail})! Token expires: ${tokenData.expiresAt || 'N/A'}`,
            credentialId: savedCredential.id,
        };

        await sendTelegram(result.message);
        return result;

    } catch (error) {
        console.error('[GoogleLogin] Error:', error.message);

        if (browser) {
            try { browser.disconnect(); } catch { /* ok */ }
        }
        if (chromeProcess) {
            try { chromeProcess.kill(); } catch { /* ok */ }
        }

        const result = {
            success: false,
            message: `❌ Login thất bại: ${error.message}`,
        };

        try { await sendTelegram(result.message); } catch { /* ok */ }
        return result;
    } finally {
        activeOperations.delete(userId);
    }
}

// ─── Cookie Refresh Function ─────────────────────────────

/**
 * Refresh cookies by opening Chrome with saved profile and navigating to Google Flow.
 * Does NOT require email/password if profile still has a valid Google session.
 *
 * @param {string} userId
 * @param {Function} sendTelegram - optional
 * @returns {object} { success, needsRelogin, message }
 */
export async function refreshCookies(userId, sendTelegram = null) {
    // Check if another operation is already running for this user
    if (activeOperations.get(userId)) {
        console.log(`[CookieRefresh] Skipping user ${userId} — operation already in progress`);
        return { success: false, needsRelogin: false, message: 'Another operation in progress' };
    }
    activeOperations.set(userId, true);

    let browser = null;
    let chromeProcess = null;

    try {
        // Launch Chrome with existing profile
        const launched = await launchPersistentChrome(userId);
        browser = launched.browser;
        chromeProcess = launched.chromeProcess;

        // Always create a new page (old pages may be detached after server restart)
        const page = await browser.newPage();
        await prepareStealthPage(page); // Stealth: UA, viewport, scripts BEFORE navigation

        // Navigate to Google Flow
        console.log(`[CookieRefresh] Navigating to ${GOOGLE_FLOW_URL}`);
        await page.goto(GOOGLE_FLOW_URL, {
            waitUntil: 'networkidle2',
            timeout: PAGE_LOAD_TIMEOUT,
        });

        await randomDelay(3000, 5000);

        // ── Check 1: URL redirect ──
        const currentUrl = page.url();
        if (currentUrl.includes('accounts.google.com')) {
            console.log('[CookieRefresh] ❌ Redirected to login page — session expired');
            try { await page.close(); } catch { /* ok */ }
            browser.disconnect();
            if (chromeProcess) try { chromeProcess.kill(); } catch { /* ok */ }
            return { success: false, needsRelogin: true, message: 'Session expired — cần re-login' };
        }

        // ── Check 2: Cookie existence ──
        const { cookies, cookieString } = await extractAllCookies(page);
        const hasSessionCookie = cookies.some(c => c.name === '__Secure-1PSID' && c.value.length > 10);

        if (!hasSessionCookie) {
            console.log('[CookieRefresh] ❌ No __Secure-1PSID cookie — session expired');
            try { await page.close(); } catch { /* ok */ }
            browser.disconnect();
            if (chromeProcess) try { chromeProcess.kill(); } catch { /* ok */ }
            return { success: false, needsRelogin: true, message: 'Session cookie missing — cần re-login' };
        }

        // ── Check 3: Session API test ──
        try {
            const tokenData = await getAccessToken(cookieString);

            // ── Check 4: Correct account? ──
            const expectedEmail = await getExpectedEmail(userId);
            if (expectedEmail && tokenData.userEmail) {
                const actualEmail = tokenData.userEmail.toLowerCase();
                if (actualEmail !== expectedEmail) {
                    console.log(`[CookieRefresh] ❌ Wrong account! Expected: ${expectedEmail}, Got: ${actualEmail}`);
                    if (sendTelegram) await sendTelegram(`⚠️ Chrome đang login bằng tài khoản sai (${actualEmail}). Cần re-login bằng ${expectedEmail}.`);
                    // Sign out of Google (keep profile intact)
                    await signOutGoogle(browser);
                    browser.disconnect();
                    return { success: false, needsRelogin: true, message: `Wrong account: ${actualEmail} (expected ${expectedEmail})` };
                }
            }

            // Save to DB
            await saveCredentialsToDB(userId, cookieString, tokenData);

            try { await page.close(); } catch { /* ok */ }
            try { await browser.close(); } catch { browser.disconnect(); }
            if (chromeProcess) try { chromeProcess.kill(); } catch { /* ok */ }
            browser = null;
            chromeProcess = null;

            const msg = `✅ Cookie refreshed (${tokenData.userEmail})! Token expires: ${tokenData.expiresAt || 'N/A'}`;
            console.log(`[CookieRefresh] ${msg}`);
            if (sendTelegram) await sendTelegram(msg);

            return { success: true, needsRelogin: false, message: msg };

        } catch (e) {
            console.log(`[CookieRefresh] ❌ Session API failed: ${e.message}`);
            try { await page.close(); } catch { /* ok */ }
            browser.disconnect();
            if (chromeProcess) try { chromeProcess.kill(); } catch { /* ok */ }
            return { success: false, needsRelogin: true, message: `Session API failed: ${e.message}` };
        }

    } catch (error) {
        console.error('[CookieRefresh] Error:', error.message);
        if (browser) {
            try { browser.disconnect(); } catch { /* ok */ }
        }
        if (chromeProcess) {
            try { chromeProcess.kill(); } catch { /* ok */ }
        }
        return { success: false, needsRelogin: false, message: error.message };
    } finally {
        activeOperations.delete(userId);
    }
}
