#!/usr/bin/env node
/**
 * VPS reCAPTCHA diagnostic test.
 * Run: cd /opt/vcw/app/server && node test-recaptcha-vps.mjs
 */
import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { join } from 'path';

const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
const PROJECT_ID = '58810a25-7522-492b-8071-72842a69e229';
const instanceId = 'minababy17012004_gmail_com';
const profileDir = join(process.cwd(), 'uploads', `.recaptcha-profile-${instanceId}`);
const port = 9399;

// Get token via sqlite3 CLI
const TOKEN = execSync("sqlite3 prisma/dev.db \"SELECT token FROM Credential WHERE provider = 'google-flow' LIMIT 1;\"").toString().trim();
console.log(`[1] Token: ${TOKEN.length} chars`);

// Kill any Chrome on test port
try { execSync(`pkill -f "chrome.*${port}"`, { stdio: 'ignore' }); } catch {}
await new Promise(r => setTimeout(r, 1000));

// Launch Chrome
process.env.DISPLAY = ':99';
await mkdir(profileDir, { recursive: true });
console.log(`[2] Profile: ${profileDir}`);

const chrome = spawn('/usr/bin/google-chrome', [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,900',
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--disable-software-rasterizer',
    '--lang=en-US,en', '--start-maximized',
], { stdio: 'ignore', detached: true, env: process.env });
chrome.unref();

let browser = null;
for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) {
            const data = await res.json();
            browser = await puppeteer.connect({ browserWSEndpoint: data.webSocketDebuggerUrl, defaultViewport: null });
            break;
        }
    } catch {}
}
if (!browser) { console.error('FAILED'); chrome.kill(); process.exit(1); }
console.log('[3] Chrome connected');

const page = await browser.newPage();
const cookiesPath = join(profileDir, 'Default', 'Cookies');
console.log(`[4] Profile cookies: ${existsSync(cookiesPath)}`);
console.log('[5] NO setCookie — profile handles auth');

await page.goto('https://labs.google/fx/tools/flow/', { waitUntil: 'networkidle2', timeout: 30000 });
console.log(`[6] URL: ${page.url()}`);

await page.waitForFunction(
    () => typeof grecaptcha !== 'undefined' && typeof grecaptcha.enterprise?.execute === 'function',
    { timeout: 15000 }
);
console.log('[7] SDK ready');

const rcToken = await page.evaluate(async (sk) => await grecaptcha.enterprise.execute(sk, { action: 'IMAGE_GENERATION' }), SITE_KEY);
console.log(`[8] Token: ${rcToken?.length} chars`);

const result = await page.evaluate(async (tok, pid, rc) => {
    const body = {
        clientContext: { recaptchaContext: { token: rc, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }, projectId: pid, tool: 'PINHOLE', sessionId: ';' + Date.now(), userPaygateTier: 'PAYGATE_TIER_TWO' },
        mediaGenerationContext: { batchId: 'test-' + Date.now() }, useNewMedia: true,
        requests: [{ clientContext: { recaptchaContext: { token: rc, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }, projectId: pid, tool: 'PINHOLE', sessionId: ';' + Date.now(), userPaygateTier: 'PAYGATE_TIER_TWO' }, imageModelName: 'GEM_PIX_2', imageAspectRatio: 'IMAGE_ASPECT_RATIO_SQUARE', structuredPrompt: { parts: [{ text: 'a red circle' }] }, seed: 42 }]
    };
    const res = await fetch('https://aisandbox-pa.googleapis.com/v1/projects/' + pid + '/flowMedia:batchGenerateImages', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Authorization': 'Bearer ' + tok }, body: JSON.stringify(body), credentials: 'include' });
    return { status: res.status, body: (await res.text()).substring(0, 300) };
}, TOKEN, PROJECT_ID, rcToken);

console.log(`\n=== RESULT: ${result.status} ===`);
if (result.status === 200) console.log('✅ SUCCESS');
else console.log('❌ FAIL:', result.body);

browser.disconnect();
chrome.kill('SIGTERM');
process.exit(0);
