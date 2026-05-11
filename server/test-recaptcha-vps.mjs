#!/usr/bin/env node
/**
 * VPS reCAPTCHA diagnostic test.
 * Run from /opt/vcw/app/server: node test-recaptcha-vps.mjs
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import Database from 'better-sqlite3';

const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
const PROJECT_ID = '58810a25-7522-492b-8071-72842a69e229';
const instanceId = 'minababy17012004_gmail_com';
const profileDir = join(process.cwd(), 'uploads', `.recaptcha-profile-${instanceId}`);
const port = 9399; // Different port from server (9339)

async function main() {
    // Get token from DB
    const db = new Database('prisma/dev.db');
    const cred = db.prepare("SELECT token FROM Credential WHERE provider = 'google-flow' LIMIT 1").get();
    const TOKEN = cred.token;
    db.close();
    console.log(`[1] Token: ${TOKEN.length} chars`);

    // Kill any Chrome on test port
    try { await fetch(`http://127.0.0.1:${port}/json/version`); } catch {}

    // Launch Chrome
    process.env.DISPLAY = ':99';
    await mkdir(profileDir, { recursive: true });
    console.log(`[2] Profile dir: ${profileDir}`);

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

    // Wait for Chrome
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
    if (!browser) { console.error('FAILED to connect to Chrome'); chrome.kill(); process.exit(1); }
    console.log('[3] Connected to Chrome');

    const page = await browser.newPage();

    // Check profile cookies
    const cookiesPath = join(profileDir, 'Default', 'Cookies');
    const hasCookies = existsSync(cookiesPath);
    console.log(`[4] Profile cookies exist: ${hasCookies} (${cookiesPath})`);
    console.log(`[5] SKIPPING setCookie — using profile cookies`);

    // Navigate
    await page.goto('https://labs.google/fx/tools/flow/', { waitUntil: 'networkidle2', timeout: 30000 });
    console.log(`[6] URL: ${page.url()}`);

    // Wait for SDK
    await page.waitForFunction(
        () => typeof grecaptcha !== 'undefined' && typeof grecaptcha.enterprise?.execute === 'function',
        { timeout: 15000 }
    );
    console.log('[7] reCAPTCHA SDK ready');

    // Get token
    const rcToken = await page.evaluate(async (sk) => {
        return await grecaptcha.enterprise.execute(sk, { action: 'IMAGE_GENERATION' });
    }, SITE_KEY);
    console.log(`[8] reCAPTCHA token: ${rcToken?.length} chars`);

    // API test via page context (same as browserFetch)
    const result = await page.evaluate(async (tok, pid, rc) => {
        const body = {
            clientContext: {
                recaptchaContext: { token: rc, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
                projectId: pid, tool: 'PINHOLE', sessionId: ';' + Date.now(), userPaygateTier: 'PAYGATE_TIER_TWO'
            },
            mediaGenerationContext: { batchId: 'test-' + Date.now() },
            useNewMedia: true,
            requests: [{
                clientContext: {
                    recaptchaContext: { token: rc, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
                    projectId: pid, tool: 'PINHOLE', sessionId: ';' + Date.now(), userPaygateTier: 'PAYGATE_TIER_TWO'
                },
                imageModelName: 'GEM_PIX_2', imageAspectRatio: 'IMAGE_ASPECT_RATIO_SQUARE',
                structuredPrompt: { parts: [{ text: 'a red circle on white' }] }, seed: 42
            }]
        };
        const res = await fetch('https://aisandbox-pa.googleapis.com/v1/projects/' + pid + '/flowMedia:batchGenerateImages', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Authorization': 'Bearer ' + tok },
            body: JSON.stringify(body), credentials: 'include'
        });
        return { status: res.status, body: (await res.text()).substring(0, 300) };
    }, TOKEN, PROJECT_ID, rcToken);

    console.log(`\n[9] API Status: ${result.status}`);
    if (result.status === 200) {
        console.log('✅ SUCCESS! Image generated.');
    } else {
        console.log('❌ FAILED:', result.body);
    }

    // Now test WITH setCookie (to prove it breaks things)
    console.log('\n--- Test 2: WITH setCookie (should fail) ---');
    const page2 = await browser.newPage();
    
    // Get cookies from DB
    const db2 = new Database('prisma/dev.db');
    const cred2 = db2.prepare("SELECT metadata FROM Credential WHERE provider = 'google-flow' LIMIT 1").get();
    const meta = JSON.parse(cred2.metadata);
    const cookies = meta.sessionCookies || '';
    db2.close();
    
    const parts = cookies.split(';').map(c => c.trim()).filter(Boolean);
    const validCookies = [];
    for (const p of parts) {
        const eq = p.indexOf('=');
        if (eq <= 0) continue;
        validCookies.push({ name: p.substring(0, eq).trim(), value: p.substring(eq + 1).trim() });
    }
    const puppeteerCookies = validCookies.flatMap(c => [
        { name: c.name, value: c.value, url: 'https://labs.google' },
        { name: c.name, value: c.value, url: 'https://www.google.com' },
    ]);
    await page2.setCookie(...puppeteerCookies);
    console.log(`[10] Set ${validCookies.length} cookies via setCookie`);
    
    await page2.goto('https://labs.google/fx/tools/flow/', { waitUntil: 'networkidle2', timeout: 30000 });
    await page2.waitForFunction(
        () => typeof grecaptcha !== 'undefined' && typeof grecaptcha.enterprise?.execute === 'function',
        { timeout: 15000 }
    );
    
    const rcToken2 = await page2.evaluate(async (sk) => {
        return await grecaptcha.enterprise.execute(sk, { action: 'IMAGE_GENERATION' });
    }, SITE_KEY);
    console.log(`[11] reCAPTCHA token with setCookie: ${rcToken2?.length} chars`);
    
    const result2 = await page2.evaluate(async (tok, pid, rc) => {
        const body = {
            clientContext: {
                recaptchaContext: { token: rc, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
                projectId: pid, tool: 'PINHOLE', sessionId: ';' + Date.now(), userPaygateTier: 'PAYGATE_TIER_TWO'
            },
            mediaGenerationContext: { batchId: 'test2-' + Date.now() },
            useNewMedia: true,
            requests: [{
                clientContext: {
                    recaptchaContext: { token: rc, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
                    projectId: pid, tool: 'PINHOLE', sessionId: ';' + Date.now(), userPaygateTier: 'PAYGATE_TIER_TWO'
                },
                imageModelName: 'GEM_PIX_2', imageAspectRatio: 'IMAGE_ASPECT_RATIO_SQUARE',
                structuredPrompt: { parts: [{ text: 'a blue square' }] }, seed: 99
            }]
        };
        const res = await fetch('https://aisandbox-pa.googleapis.com/v1/projects/' + pid + '/flowMedia:batchGenerateImages', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Authorization': 'Bearer ' + tok },
            body: JSON.stringify(body), credentials: 'include'
        });
        return { status: res.status, body: (await res.text()).substring(0, 300) };
    }, TOKEN, PROJECT_ID, rcToken2);

    console.log(`[12] API Status with setCookie: ${result2.status}`);
    if (result2.status === 200) console.log('Test 2 also passed (setCookie is NOT the issue)');
    else console.log('Test 2 FAILED (confirms setCookie IS the issue):', result2.body.substring(0, 100));

    browser.disconnect();
    chrome.kill('SIGTERM');
    process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
