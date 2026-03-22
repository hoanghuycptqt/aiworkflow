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
    // STEP 1: Check if already signed in (navigate to /fx/vi/tools/flow first for cookie check)
    // ========================================
    process.stderr.write('[Worker] Checking session on labs.google/fx...\n');
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
        // Navigate to the actual Flow tool page
        await page.goto('https://labs.google/fx/vi/tools/flow/', { waitUntil: 'networkidle2', timeout: 30000 });
        browser.disconnect();
        return { success: true, url: page.url(), port: debugPort, alreadyLoggedIn: true };
    }
    process.stderr.write('[Worker] No session token found. Need to sign in.\n');

    // ========================================
    // STEP 2: Click "Sign in with Google" on /fx landing page
    // ========================================
    process.stderr.write('[Worker] Looking for "Sign in with Google" button on /fx landing page...\n');
    
    // Take screenshot to see the page
    await page.screenshot({ path: '/tmp/google-labs-page.png' }).catch(() => {});
    
    // The "Sign in with Google" button is on the /fx landing page (NOT /fx/vi/tools/flow)
    // NOTE: This button may NOT be a standard <a> or <button> — labs.google uses custom elements
    let signInClicked = false;
    
    // Strategy 1: Search ALL elements (not just a/button) for "Sign in" text
    try {
        signInClicked = await page.evaluate(() => {
            // Search broadly — include all clickable-looking elements
            const all = [...document.querySelectorAll('*')];
            for (const el of all) {
                // Only check leaf-ish elements (avoid matching a parent container)
                if (el.children.length > 5) continue;
                const t = el.textContent.trim();
                if ((t === 'Sign in with Google' || t === 'Sign in') && t.length < 40) {
                    el.click();
                    return true;
                }
            }
            return false;
        });
    } catch { signInClicked = false; }
    
    // Strategy 2: Try Puppeteer XPath for text matching
    if (!signInClicked) {
        try {
            const [btn] = await page.$$('::-p-xpath(//*[contains(text(), "Sign in")])');
            if (btn) {
                await btn.click();
                signInClicked = true;
            }
        } catch { /* xpath not supported or not found */ }
    }
    
    // Strategy 3: Coordinate-based click at top-right where button is visible
    if (!signInClicked) {
        process.stderr.write('[Worker] No element found. Trying coordinate click at top-right (sign-in button position)...\n');
        try {
            // "Sign in with Google" button is at approximately x=1130, y=40 on 1280x900 viewport
            await page.mouse.click(1130, 40);
            signInClicked = true;
        } catch { signInClicked = false; }
    }
    
    process.stderr.write(`[Worker] Sign-in clicked: ${signInClicked}\n`);
    
    if (signInClicked) {
        // Check if a popup window was opened (Google One Tap or OAuth popup)
        const pages = await browser.pages();
        process.stderr.write(`[Worker] Open pages: ${pages.length}\n`);
        if (pages.length > 1) {
            // Switch to the popup
            const popup = pages[pages.length - 1];
            process.stderr.write(`[Worker] Popup URL: ${popup.url()}\n`);
            // Wait for popup to finish OAuth
            try {
                await popup.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
            } catch { /* ok */ }
            await delay(3000, 5000);
        } else {
            // Wait for navigation on current page
            try {
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
            } catch { /* might already have navigated */ }
            await delay(2000, 3000);
        }
        process.stderr.write(`[Worker] After sign-in click URL: ${page.url()}\n`);
    }
    
    // If still on labs.google, use NextAuth POST form to trigger OAuth
    if (page.url().includes('labs.google')) {
        process.stderr.write('[Worker] Still on labs.google. Posting NextAuth signin form...\n');
        try {
            // Navigate to NextAuth signin page
            await page.goto('https://labs.google/fx/api/auth/signin', {
                waitUntil: 'networkidle2',
                timeout: 30000,
            });
            await delay(1000, 2000);
            
            // Take screenshot to see what NextAuth shows
            await page.screenshot({ path: '/tmp/nextauth-signin.png' }).catch(() => {});
            
            // Find and click the "Sign in with Google" button on NextAuth page
            const formSubmitted = await page.evaluate(() => {
                // NextAuth signin page has a form with a button for each provider
                const forms = [...document.querySelectorAll('form')];
                for (const form of forms) {
                    const action = form.action || '';
                    if (action.includes('google') || action.includes('signin')) {
                        form.submit();
                        return true;
                    }
                }
                // Also try clicking any button
                const btns = [...document.querySelectorAll('button')];
                for (const btn of btns) {
                    if (btn.textContent.includes('Google') || btn.textContent.includes('Sign in')) {
                        btn.click();
                        return true;
                    }
                }
                return false;
            }).catch(() => false);
            
            process.stderr.write(`[Worker] Form submitted: ${formSubmitted}\n`);
            
            if (formSubmitted) {
                try {
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
                } catch { /* ok */ }
                await delay(3000, 5000);
            }
            process.stderr.write(`[Worker] After form submit URL: ${page.url()}\n`);
            
            // OAuth done — navigate to tools page and check session
            if (!page.url().includes('accounts.google.com')) {
                process.stderr.write('[Worker] OAuth seems complete. Navigating to Flow tools page...\n');
                await page.goto('https://labs.google/fx/vi/tools/flow/', {
                    waitUntil: 'networkidle2',
                    timeout: 30000,
                });
                await delay(2000, 3000);
                
                // Check session token via CDP
                const cdp3 = await page.createCDPSession();
                const { cookies: postOAuthCookies } = await cdp3.send('Network.getAllCookies');
                await cdp3.detach();
                const postOAuthSession = postOAuthCookies.find(c =>
                    c.name === '__Secure-next-auth.session-token' && c.domain.includes('labs.google')
                );
                if (postOAuthSession) {
                    process.stderr.write('[Worker] ✅ Session token found after OAuth! Done.\n');
                    browser.disconnect();
                    return { success: true, url: page.url(), port: debugPort, hasSession: true };
                }
                process.stderr.write('[Worker] ⚠️ No session token after OAuth form submit.\n');
            }
        } catch (e) {
            process.stderr.write(`[Worker] NextAuth form error: ${e.message}\n`);
        }
    }

    // ========================================
    // STEP 3: Handle Google OAuth login
    // ========================================
    // At this point we should be on accounts.google.com (Google OAuth)
    // or already redirected back to labs.google with session
    
    let loginDone = false;
    let twoFASent = false; // Only send 2FA screenshot/Gemini once
    let leftLabsGoogle = !page.url().includes('labs.google'); // Track if we actually left
    for (let step = 0; step < 20; step++) {
        const url = page.url();
        process.stderr.write(`[Worker] Step ${step + 1}, URL: ${url.substring(0, 100)}\n`);

        // Only consider success if we already left labs.google and came back
        if (url.includes('labs.google') && leftLabsGoogle) {
            loginDone = true;
            break;
        }
        
        // Track when we leave labs.google (to avoid false success on first iteration)
        if (!url.includes('labs.google')) {
            leftLabsGoogle = true;
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

        // 2FA? (MUST check BEFORE account chooser — /challenge/dp page shows email which tricks chooser)
        const is2FAUrl = url.includes('/challenge/dp') || url.includes('/challenge/ipp') || url.includes('/challenge/ootp');
        const has2FA = is2FAUrl || await page.evaluate(() => {
            const t = document.body?.innerText || '';
            return t.includes('Check your phone') || t.includes('Kiểm tra điện thoại') ||
                   t.includes('2-Step Verification') || t.includes('Xác minh 2 bước') ||
                   t.includes('Confirm it') || t.includes('Verify it') ||
                   t.includes('confirm that it') || t.includes('xác nhận') ||
                   t.includes('trying to sign in') || t.includes('đang cố đăng nhập') ||
                   t.includes('Verify it\'s you') || t.includes('Xác minh danh tính');
        }).catch(() => false);
        if (has2FA) {
            // Send screenshot + Gemini analysis only ONCE
            if (!twoFASent) {
                twoFASent = true;
                await page.screenshot({ path: '/tmp/google-2fa.png' }).catch(() => {});
                process.stderr.write('2FA_SCREENSHOT:/tmp/google-2fa.png\n');
                process.stderr.write('[Worker] 2FA detected! Polling for user approval (max 120s)...\n');
            }

            // Poll every 5s for 120s — wait for user to approve on phone
            let twoFAApproved = false;
            for (let pollIdx = 0; pollIdx < 24; pollIdx++) {
                await new Promise(r => setTimeout(r, 5000)); // explicit 5s wait
                let pollUrl = '';
                try { pollUrl = page.url(); } catch { pollUrl = 'ERROR'; }
                
                // Extract just the pathname to avoid matching query string params
                // (e.g. redirect_uri=...callback/google was causing false matches)
                let pollPath = '';
                try { pollPath = new URL(pollUrl).pathname; } catch { pollPath = pollUrl; }
                process.stderr.write(`[Worker] 2FA-poll ${pollIdx+1}/24 path=${pollPath}\n`);
                
                // Success: URL path changed to consent, myaccount, or labs.google
                if (pollPath.includes('/consent') || pollUrl.includes('myaccount.google.com') || 
                    pollUrl.includes('labs.google')) {
                    process.stderr.write('[Worker] ✅ 2FA approved! URL changed.\n');
                    twoFAApproved = true;
                    break;
                }
                // Success: URL path no longer on challenge or signin pages
                if (!pollPath.includes('/challenge/') && !pollPath.includes('/signin/')) {
                    process.stderr.write(`[Worker] ✅ 2FA approved! Left signin pages. path=${pollPath}\n`);
                    twoFAApproved = true;
                    break;
                }
                // Failure: Google rejected
                if (pollPath.includes('rejected')) {
                    process.stderr.write('[Worker] ❌ 2FA rejected by Google.\n');
                    browser.disconnect();
                    chrome.kill();
                    return { success: false, error: '2FA rejected' };
                }
            }
            
            if (!twoFAApproved) {
                process.stderr.write('[Worker] ❌ 2FA timeout after 120s.\n');
                browser.disconnect();
                chrome.kill();
                return { success: false, error: '2FA timeout - user did not approve in 120s' };
            }
            
            // 2FA approved — break out of main loop
            loginDone = true;
            break;
        }

        // Account chooser? (runs AFTER 2FA check to avoid false match on /challenge/dp)
        const hasChooser = await page.evaluate((targetEmail) => {
            const items = [...document.querySelectorAll('[data-identifier], [data-email]')];
            const match = items.find(el => 
                el.getAttribute('data-identifier') === targetEmail ||
                el.getAttribute('data-email') === targetEmail
            );
            if (match) { match.click(); return true; }
            return false;
        }, email).catch(() => false);
        if (hasChooser) {
            process.stderr.write('[Worker] Selected account from chooser\n');
            await delay(3000, 5000);
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
            process.stderr.write('[Worker] On Google, navigating to labs.google/fx/vi/tools/flow...\n');
            await page.goto('https://labs.google/fx/vi/tools/flow/', { waitUntil: 'networkidle2', timeout: 30000 });
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
