/**
 * Standalone Google Login Worker
 * 
 * Runs OUTSIDE PM2 cluster mode. Logs in via labs.google sign-in flow
 * (not accounts.google.com directly) to ensure NextAuth session token is created.
 * 
 * Flow: labs.google/fx → Sign in → Google OAuth → type email/password → 2FA → 
 *       OAuth callback → labs.google with session token
 * 
 * Usage: node google-login-worker.mjs <profileDir> <port> <email> <password>
 * Output: JSON on stdout with { success, url, error }
 * 2FA:   Outputs 2FA_SCREENSHOT:<path> on stderr for agent to read with Gemini Vision
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

    // ========================================
    // STEP 1: Navigate to labs.google/fx
    // ========================================
    process.stderr.write('[Worker] Navigating to labs.google/fx...\n');
    await page.goto('https://labs.google/fx', {
        waitUntil: 'networkidle2',
        timeout: 30000,
    });
    await delay(2000, 3000);

    // Check if already signed in via CDP (catches HttpOnly cookies)
    const cdp = await page.createCDPSession();
    const { cookies: allCookies } = await cdp.send('Network.getAllCookies');
    await cdp.detach();
    const sessionToken = allCookies.find(c => 
        c.name === '__Secure-next-auth.session-token' && c.domain.includes('labs.google')
    );
    if (sessionToken) {
        process.stderr.write(`[Worker] ✅ Already signed in! Session token found (HttpOnly). Skipping login.\n`);
        browser.disconnect();
        return { success: true, url: page.url(), port: debugPort, alreadyLoggedIn: true };
    }
    process.stderr.write('[Worker] No session token found. Need to sign in.\n');

    // ========================================
    // STEP 2: Find and click Sign In on labs.google
    // ========================================
    process.stderr.write('[Worker] Looking for sign-in button on labs.google...\n');
    
    // Take screenshot to see the page
    await page.screenshot({ path: '/tmp/google-labs-page.png' }).catch(() => {});
    
    // Try to find sign-in link/button
    const signInResult = await page.evaluate(() => {
        // Look for sign-in links by href
        const links = [...document.querySelectorAll('a[href]')];
        const signInLink = links.find(a => 
            a.href.includes('/signin') || a.href.includes('/auth/') ||
            a.href.includes('accounts.google.com') ||
            a.textContent.trim().toLowerCase().includes('sign in') ||
            a.textContent.trim().toLowerCase().includes('log in')
        );
        if (signInLink) {
            return { found: true, href: signInLink.href, text: signInLink.textContent.trim(), type: 'link' };
        }

        // Look for sign-in buttons
        const btns = [...document.querySelectorAll('button')];
        const signInBtn = btns.find(b =>
            b.textContent.trim().toLowerCase().includes('sign in') ||
            b.textContent.trim().toLowerCase().includes('get started') ||
            b.textContent.trim().toLowerCase().includes('log in')
        );
        if (signInBtn) {
            signInBtn.click();
            return { found: true, text: signInBtn.textContent.trim(), type: 'button', clicked: true };
        }

        return { found: false, allLinks: links.slice(0, 10).map(a => ({text: a.textContent.trim().substring(0,30), href: a.href.substring(0,60)})) };
    });

    process.stderr.write(`[Worker] Sign-in result: ${JSON.stringify(signInResult)}\n`);

    if (signInResult.found) {
        if (signInResult.type === 'link') {
            // Navigate to the sign-in link
            process.stderr.write(`[Worker] Navigating to sign-in: ${signInResult.href}\n`);
            await page.goto(signInResult.href, { waitUntil: 'networkidle2', timeout: 30000 });
        }
        // If button was clicked, wait for navigation
        await delay(3000, 5000);
    } else {
        // Fallback: try direct NextAuth endpoint
        process.stderr.write('[Worker] No sign-in button found. Trying NextAuth endpoint...\n');
        try {
            await page.goto('https://labs.google/fx/api/auth/signin/google', {
                waitUntil: 'networkidle2',
                timeout: 30000,
            });
        } catch (e) {
            process.stderr.write(`[Worker] NextAuth endpoint error: ${e.message}\n`);
        }
        await delay(3000, 5000);
    }

    // ========================================
    // STEP 3: Handle Google OAuth login
    // ========================================
    // At this point we should be on accounts.google.com (Google OAuth)
    // or already redirected back to labs.google
    
    let loginDone = false;
    for (let step = 0; step < 20; step++) {
        const url = page.url();
        process.stderr.write(`[Worker] Step ${step + 1}, URL: ${url.substring(0, 100)}\n`);

        // Success: back on labs.google
        if (url.includes('labs.google')) {
            loginDone = true;
            break;
        }

        // Google rejected
        if (url.includes('/signin/rejected')) {
            await page.screenshot({ path: '/tmp/google-worker-rejected.png' });
            browser.disconnect();
            chrome.kill();
            return { success: false, error: 'Google rejected login' };
        }

        // Email input?
        const hasEmail = await page.evaluate(() => {
            const el = document.querySelector('input[type="email"]');
            return el && el.offsetParent !== null;
        }).catch(() => false);
        if (hasEmail) {
            process.stderr.write('[Worker] Typing email...\n');
            await page.type('input[type="email"]', email, { delay: 80 + Math.random() * 40 });
            await delay(800, 1500);
            const nextBtn = await page.evaluateHandle(() =>
                [...document.querySelectorAll('button')].find(b =>
                    b.textContent.includes('Next') || b.textContent.includes('Tiếp theo')
                )
            );
            if (nextBtn) await nextBtn.click();
            await delay(3000, 5000);
            continue;
        }

        // Password input?
        const hasPwd = await page.evaluate(() => {
            const el = document.querySelector('input[type="password"]');
            return el && el.offsetParent !== null;
        }).catch(() => false);
        if (hasPwd) {
            process.stderr.write('[Worker] Typing password...\n');
            await page.type('input[type="password"]', password, { delay: 60 + Math.random() * 40 });
            await delay(500, 1000);
            const nextBtn = await page.evaluateHandle(() =>
                [...document.querySelectorAll('button')].find(b =>
                    b.textContent.includes('Next') || b.textContent.includes('Tiếp theo')
                )
            );
            if (nextBtn) await nextBtn.click();
            await delay(4000, 6000);
            continue;
        }

        // Account chooser?
        const hasChooser = await page.evaluate((targetEmail) => {
            const items = [...document.querySelectorAll('[data-identifier], [data-email]')];
            const match = items.find(el => 
                el.getAttribute('data-identifier') === targetEmail ||
                el.getAttribute('data-email') === targetEmail ||
                el.textContent.includes(targetEmail)
            );
            if (match) { match.click(); return true; }
            
            // Also check for email text in divs
            const divs = [...document.querySelectorAll('div, li')];
            const emailDiv = divs.find(d => d.textContent.includes(targetEmail) && d.offsetParent !== null);
            if (emailDiv) { emailDiv.click(); return true; }
            return false;
        }, email).catch(() => false);
        if (hasChooser) {
            process.stderr.write('[Worker] Selected account from chooser\n');
            await delay(3000, 5000);
            continue;
        }

        // 2FA?
        const has2FA = await page.evaluate(() => {
            const t = document.body?.innerText || '';
            return t.includes('Check your phone') || t.includes('Kiểm tra điện thoại') ||
                   t.includes('2-Step Verification') || t.includes('Xác minh 2 bước') ||
                   t.includes('Confirm it') || t.includes('Tap') ||
                   t.includes('confirm that it') || t.includes('xác nhận') ||
                   t.includes('trying to sign in') || t.includes('đang cố đăng nhập');
        }).catch(() => false);
        if (has2FA) {
            await page.screenshot({ path: '/tmp/google-2fa.png' }).catch(() => {});
            process.stderr.write('2FA_SCREENSHOT:/tmp/google-2fa.png\n');
            process.stderr.write('[Worker] 2FA detected. Screenshot saved. Waiting 120s...\n');

            // Poll for approval
            let approved = false;
            for (let w = 0; w < 24; w++) {
                await delay(5000, 5000);
                const newUrl = page.url();
                process.stderr.write(`[Worker] 2FA poll ${w+1}/24, URL: ${newUrl.substring(0, 80)}\n`);
                if (!newUrl.includes('challenge') && !newUrl.includes('signin')) {
                    approved = true;
                    break;
                }
                if (newUrl.includes('myaccount.google') || newUrl.includes('labs.google')) {
                    approved = true;
                    break;
                }
            }
            if (!approved) {
                browser.disconnect();
                chrome.kill();
                return { success: false, error: '2FA timeout' };
            }
            continue;
        }

        // Passkey?
        const hasPasskey = await page.evaluate(() => {
            const t = document.body?.innerText || '';
            return t.includes('passkey') || t.includes('khóa truy cập') || t.includes('Use your');
        }).catch(() => false);
        if (hasPasskey) {
            process.stderr.write('[Worker] Passkey detected, trying another way...\n');
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

        // Consent/Allow?
        const hasConsent = await page.evaluate(() => {
            const t = document.body?.innerText || '';
            return t.includes('wants to access') || t.includes('muốn truy cập') ||
                   t.includes('Allow') || t.includes('Continue to');
        }).catch(() => false);
        if (hasConsent) {
            process.stderr.write('[Worker] Consent page, clicking Allow...\n');
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

    // ========================================
    // STEP 4: Verify we're on labs.google with session
    // ========================================
    const finalUrl = page.url();
    process.stderr.write(`[Worker] Final URL: ${finalUrl}\n`);

    if (!loginDone && !finalUrl.includes('labs.google')) {
        // One more try: if we ended up on myaccount.google, navigate to labs.google
        if (finalUrl.includes('myaccount.google') || finalUrl.includes('google.com')) {
            process.stderr.write('[Worker] On Google, navigating to labs.google/fx...\n');
            await page.goto('https://labs.google/fx', { waitUntil: 'networkidle2', timeout: 30000 });
            await delay(3000, 5000);
        }
    }

    // Check for session token via CDP (HttpOnly)
    const cdp2 = await page.createCDPSession();
    const { cookies: finalAllCookies } = await cdp2.send('Network.getAllCookies');
    await cdp2.detach();
    const finalSessionToken = finalAllCookies.find(c => 
        c.name === '__Secure-next-auth.session-token' && c.domain.includes('labs.google')
    );
    process.stderr.write(`[Worker] Session token: ${finalSessionToken ? 'FOUND' : 'NOT FOUND'}\n`);

    // Leave Chrome running
    browser.disconnect();

    if (finalSessionToken || page.url().includes('labs.google')) {
        return { success: true, url: page.url(), port: debugPort, hasSession: !!finalSessionToken };
    }

    chrome.kill();
    return { success: false, error: 'Failed to get labs.google session', url: page.url() };
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
