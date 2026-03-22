/**
 * Standalone Google Login Worker
 * 
 * This script runs OUTSIDE PM2 cluster mode as a standalone Node.js process.
 * Tests proved that the exact same Chrome/puppeteer code passes when run standalone
 * but fails when run from within PM2 cluster. This worker is executed via
 * child_process.execFile() from the login agent.
 * 
 * Usage: node google-login-worker.mjs <profileDir> <port> <email> <password>
 * Output: JSON on stdout with { success, url, error }
 */

import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';

const [,, profileDir, port, email, password] = process.argv;

if (!profileDir || !port || !email || !password) {
    console.error(JSON.stringify({ success: false, error: 'Missing arguments' }));
    process.exit(1);
}

const debugPort = parseInt(port);
const CHROME_PATH = '/usr/bin/google-chrome';

async function run() {
    // Launch Chrome
    const args = [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${debugPort}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1280,900',
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--lang=en-US,en',
        '--start-maximized',
    ];

    const chrome = spawn(CHROME_PATH, args, {
        stdio: 'ignore',
        detached: true,
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
    });
    chrome.unref();

    // Wait for Chrome to be ready
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
            const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
            if (r.ok) break;
        } catch { /* not ready */ }
    }

    let data;
    try {
        data = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
    } catch (e) {
        chrome.kill();
        return { success: false, error: 'Chrome failed to start' };
    }

    const browser = await puppeteer.connect({
        browserWSEndpoint: data.webSocketDebuggerUrl,
        defaultViewport: null,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Navigate to Google signin
    await page.goto('https://accounts.google.com/signin', {
        waitUntil: 'networkidle2',
        timeout: 30000,
    });
    await delay(2000, 3000);

    // Type email
    await page.waitForSelector('input[type="email"]', { timeout: 10000 });
    await page.type('input[type="email"]', email, { delay: 80 + Math.random() * 40 });
    await delay(800, 1500);

    // Click Next
    const nextBtn = await page.evaluateHandle(() =>
        [...document.querySelectorAll('button')].find(b =>
            b.textContent.includes('Next') || b.textContent.includes('Tiếp theo')
        )
    );
    if (nextBtn) await nextBtn.click();
    await delay(3000, 5000);

    // Check if rejected
    let url = page.url();
    if (url.includes('/signin/rejected')) {
        await page.screenshot({ path: '/tmp/google-worker-rejected.png' });
        browser.disconnect();
        chrome.kill();
        return { success: false, error: 'Google rejected login - browser detected as automated', url };
    }

    // Handle password/passkey/2FA
    let loginSuccess = false;
    for (let attempt = 0; attempt < 15; attempt++) {
        url = page.url();
        process.stderr.write(`[Worker] Attempt ${attempt + 1}, URL: ${url.substring(0, 80)}\n`);

        if (url.includes('labs.google') || url.includes('myaccount.google') || url.includes('google.com/?')) {
            loginSuccess = true;
            break;
        }

        // Password?
        const hasPwd = await page.evaluate(() => {
            const el = document.querySelector('input[type="password"]');
            return el && el.offsetParent !== null;
        }).catch(() => false);

        if (hasPwd) {
            process.stderr.write('[Worker] Typing password...\n');
            await page.type('input[type="password"]', password, { delay: 60 + Math.random() * 40 });
            await delay(500, 1000);
            const nextBtn2 = await page.evaluateHandle(() =>
                [...document.querySelectorAll('button')].find(b =>
                    b.textContent.includes('Next') || b.textContent.includes('Tiếp theo')
                )
            );
            if (nextBtn2) await nextBtn2.click();
            await delay(4000, 6000);

            url = page.url();
            if (url.includes('myaccount.google') || url.includes('labs.google') ||
                url.includes('google.com/?') || url.includes('signin/oauth')) {
                loginSuccess = true;
                break;
            }
            continue;
        }

        // Passkey?
        const hasPasskey = await page.evaluate(() => {
            const t = document.body?.innerText || '';
            return t.includes('passkey') || t.includes('khóa truy cập') || t.includes('Use your');
        }).catch(() => false);
        if (hasPasskey) {
            process.stderr.write('[Worker] Passkey detected...\n');
            const btn = await page.evaluateHandle(() =>
                [...document.querySelectorAll('button, a')].find(b =>
                    b.textContent.includes('Try another way') || b.textContent.includes('Thử cách khác')
                )
            );
            if (btn) { await btn.click(); await delay(2000, 3000); }
            const pwdOpt = await page.evaluateHandle(() =>
                [...document.querySelectorAll('li, div[role="link"], button, a')].find(el =>
                    el.textContent.includes('Enter your password') || el.textContent.includes('Nhập mật khẩu')
                )
            );
            if (pwdOpt) { await pwdOpt.click(); await delay(2000, 3000); }
            continue;
        }

        // 2FA?
        const has2FA = await page.evaluate(() => {
            const t = document.body?.innerText || '';
            return t.includes('Check your phone') || t.includes('Kiểm tra điện thoại') ||
                   t.includes('2-Step Verification') || t.includes('Xác minh 2 bước') ||
                   t.includes('Confirm it') || t.includes('Tap') ||
                   t.includes('confirm that it') || t.includes('xác nhận');
        }).catch(() => false);
        if (has2FA) {
            // Read the number or challenge info from the page
            const twoFAInfo = await page.evaluate(() => {
                const body = document.body?.innerText || '';
                // Google shows a number like "78" that user needs to tap
                const numberMatch = body.match(/(\d{2,3})/);
                return {
                    bodyText: body.substring(0, 500),
                    number: numberMatch ? numberMatch[1] : null,
                };
            }).catch(() => ({ bodyText: '', number: null }));

            // Save screenshot for debugging
            await page.screenshot({ path: '/tmp/google-2fa.png' }).catch(() => {});

            // Output 2FA info via stderr — agent reads this in real-time
            const msg = twoFAInfo.number
                ? `2FA_NUMBER:${twoFAInfo.number}`
                : `2FA_TEXT:${twoFAInfo.bodyText.substring(0, 200)}`;
            process.stderr.write(`${msg}\n`);
            process.stderr.write(`[Worker] 2FA detected. Number: ${twoFAInfo.number || 'N/A'}. Waiting 120s...\n`);

            // Poll for up to 120 seconds for user to approve
            let twoFAApproved = false;
            for (let w = 0; w < 24; w++) {
                await delay(5000, 5000);
                const newUrl = page.url();
                process.stderr.write(`[Worker] 2FA poll ${w+1}/24, URL: ${newUrl.substring(0, 80)}\n`);
                if (!newUrl.includes('challenge') && !newUrl.includes('signin')) {
                    twoFAApproved = true;
                    loginSuccess = true;
                    break;
                }
                // Also check if page changed to myaccount
                if (newUrl.includes('myaccount.google') || newUrl.includes('google.com/?')) {
                    twoFAApproved = true;
                    loginSuccess = true;
                    break;
                }
            }
            if (loginSuccess) break;
            if (!twoFAApproved) {
                process.stderr.write('[Worker] 2FA timeout after 120s\n');
                browser.disconnect();
                chrome.kill();
                return { success: false, error: '2FA timeout - user did not approve within 2 minutes' };
            }
            continue;
        }

        // Consent?
        const hasConsent = await page.evaluate(() => {
            const t = document.body?.innerText || '';
            return t.includes('wants to access') || t.includes('muốn truy cập');
        }).catch(() => false);
        if (hasConsent) {
            const allowBtn = await page.evaluateHandle(() =>
                [...document.querySelectorAll('button')].find(b =>
                    b.textContent.includes('Allow') || b.textContent.includes('Continue') ||
                    b.textContent.includes('Cho phép') || b.textContent.includes('Tiếp tục')
                )
            );
            if (allowBtn) await allowBtn.click();
            await delay(3000, 5000);
            continue;
        }

        await delay(2000, 3000);
    }

    if (!loginSuccess) {
        url = page.url();
        if (url.includes('labs.google') || url.includes('myaccount.google') || url.includes('google.com/?')) {
            loginSuccess = true;
        }
    }

    // Leave Chrome running (login agent will connect to it for cookie extraction)
    browser.disconnect();

    if (!loginSuccess) {
        await page.screenshot({ path: '/tmp/google-worker-fail.png' }).catch(() => {});
        chrome.kill();
        return { success: false, error: 'Login failed after all attempts', url };
    }

    return { success: true, url, port: debugPort };
}

function delay(min, max) {
    const ms = min + Math.random() * (max - min);
    return new Promise(r => setTimeout(r, ms));
}

try {
    const result = await run();
    console.log(JSON.stringify(result));
    process.exit(result.success ? 0 : 1);
} catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
    process.exit(1);
}
