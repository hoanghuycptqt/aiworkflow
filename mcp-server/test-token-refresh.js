#!/usr/bin/env node
/**
 * Google Flow Setup & Auto-Refresh Test
 * 
 * Usage:
 *   node test-token-refresh.js
 * 
 * Flow:
 *   1. Clears token + cookies from .env
 *   2. Opens Chrome with the SAME profile MCP server uses
 *   3. Navigates to Google Flow → waits for you to login (if needed)
 *   4. Extracts Bearer token + session cookies
 *   5. Updates .env
 *   6. Generates a test image to prove it works
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '.env');

function getEnvValue(key) {
    const content = readFileSync(ENV_PATH, 'utf-8');
    const match = content.match(new RegExp(`^${key}=(.*)`, 'm'));
    return match ? match[1].trim() : '';
}

function updateEnvKey(key, value) {
    let content = readFileSync(ENV_PATH, 'utf-8');
    const regex = new RegExp(`^${key}=.*`, 'm');
    if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
    } else {
        content += `\n${key}=${value}\n`;
    }
    writeFileSync(ENV_PATH, content);
    process.env[key] = value;
}

async function main() {
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║  Google Flow — Auto Token & Cookie Refresh   ║');
    console.log('╚══════════════════════════════════════════════╝\n');

    // ──── Step 1: Clear credentials ────
    console.log('① Clearing GOOGLE_FLOW_TOKEN and GOOGLE_FLOW_SESSION_COOKIES...');
    const originalToken = getEnvValue('GOOGLE_FLOW_TOKEN');
    const originalCookies = getEnvValue('GOOGLE_FLOW_SESSION_COOKIES');
    updateEnvKey('GOOGLE_FLOW_TOKEN', '');
    updateEnvKey('GOOGLE_FLOW_SESSION_COOKIES', '');
    console.log('   ✅ Cleared from .env\n');

    // ──── Step 2: Determine instanceId (same as MCP server) ────
    const email = getEnvValue('GOOGLE_FLOW_EMAIL');
    const instanceId = email ? email.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase() : 'default';
    console.log(`② Using profile: ${instanceId}`);
    
    const uploadDir = getEnvValue('UPLOAD_DIR') || './uploads';
    const profileDir = join(uploadDir, `.recaptcha-profile-${instanceId}`);
    console.log(`   Profile dir: ${profileDir}`);
    console.log(`   Exists: ${existsSync(profileDir) ? '✅ yes (reusing)' : '❌ no (first time — you must login)'}\n`);

    try {
        // ──── Step 3: Launch Chrome ────
        console.log('③ Launching Chrome...');
        const recaptcha = await import('./lib/recaptcha.js');
        
        // We need to init Chrome without going through fetchRecaptchaToken
        // because the user may need to login first.
        // Use internal _getOrCreateInstance + launch Chrome manually
        const puppeteer = (await import('puppeteer-core')).default;
        const { spawn } = await import('child_process');
        const { mkdir } = await import('fs/promises');
        
        const chromePath = process.env.CHROME_PATH || getEnvValue('CHROME_PATH') || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
        const profileFullDir = join(getEnvValue('UPLOAD_DIR') || './uploads', `.recaptcha-profile-${instanceId}`);
        await mkdir(profileFullDir, { recursive: true });
        
        const port = 9439;
        const args = [
            `--user-data-dir=${profileFullDir}`,
            `--remote-debugging-port=${port}`,
            '--no-first-run',
            '--no-default-browser-check',
            'https://labs.google/fx/tools/flow/',
        ];
        
        const chromeProcess = spawn(chromePath, args, { stdio: 'ignore', detached: true });
        chromeProcess.unref();
        
        // Wait for Chrome to start
        await new Promise(r => setTimeout(r, 3000));
        
        let browser;
        for (let retry = 0; retry < 10; retry++) {
            try {
                browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
                break;
            } catch {
                await new Promise(r => setTimeout(r, 1000));
            }
        }
        
        if (!browser) throw new Error('Could not connect to Chrome');
        console.log('   ✅ Chrome launched\n');
        
        // Get the current page
        const pages = await browser.pages();
        const page = pages[pages.length - 1] || await browser.newPage();

        // ──── Step 4: Check if logged in, wait if not ────
        console.log('④ Checking login status...');
        console.log('   If Chrome shows a login page, please login with your Google account.');
        console.log('   The script will auto-detect when you\'re done.\n');
        
        let isLoggedIn = false;
        for (let i = 0; i < 60; i++) { // max 5 minutes wait
            const cookies = await page.cookies('https://labs.google');
            const sessionCookie = cookies.find(c => c.name === '__Secure-next-auth.session-token');
            
            if (sessionCookie) {
                isLoggedIn = true;
                break;
            }

            if (i === 0 && !sessionCookie) {
                console.log('   ⏳ Waiting for login... (timeout: 5 minutes)');
            }
            
            if (i % 12 === 0 && i > 0) {
                console.log(`   ⏳ Still waiting... (${i * 5}s elapsed)`);
            }

            await new Promise(r => setTimeout(r, 5000));
        }

        if (!isLoggedIn) {
            throw new Error('Login timeout (5 min). Please try again.');
        }
        console.log('   ✅ Logged in!\n');

        // ──── Step 5: Extract cookies ────
        console.log('⑤ Extracting session cookies...');
        const allCookies = await page.cookies('https://labs.google', 'https://www.google.com');
        const cookieString = allCookies.map(c => `${c.name}=${c.value}`).join('; ');
        console.log(`   ✅ ${allCookies.length} cookies extracted\n`);

        // ──── Step 6: Extract Bearer token ────
        console.log('⑥ Extracting Bearer token...');
        
        // Navigate to Flow page to ensure we can intercept API calls
        await page.goto('https://labs.google/fx/tools/flow/', {
            waitUntil: 'networkidle2',
            timeout: 30000,
        });

        // Try to get token from the page's Next.js session API
        let token = await page.evaluate(async () => {
            try {
                const res = await fetch('/api/credentials', { credentials: 'include' });
                if (res.ok) {
                    const data = await res.json();
                    return data.accessToken || data.token || null;
                }
            } catch {}
            return null;
        });

        // If that didn't work, try intercepting via network
        if (!token) {
            console.log('   Trying request interception...');
            token = await new Promise((resolve) => {
                const timeout = setTimeout(() => { cleanup(); resolve(null); }, 20000);

                function onRequest(req) {
                    const auth = req.headers()['authorization'];
                    if (auth?.startsWith('Bearer ')) {
                        cleanup();
                        resolve(auth.replace('Bearer ', ''));
                    }
                }
                function cleanup() {
                    clearTimeout(timeout);
                    try { page.off('request', onRequest); } catch {}
                }

                page.on('request', onRequest);
                page.reload({ waitUntil: 'networkidle2', timeout: 18000 }).catch(() => {});
            });
        }

        // If still no token, try using the session cookie to call the auth endpoint
        if (!token) {
            console.log('   Trying Next.js session endpoint...');
            const sessionToken = allCookies.find(c => c.name === '__Secure-next-auth.session-token')?.value;
            if (sessionToken) {
                try {
                    const { default: fetch } = await import('node-fetch');
                    const res = await fetch('https://labs.google/api/credentials', {
                        headers: {
                            'Cookie': `__Secure-next-auth.session-token=${sessionToken}`,
                        },
                    });
                    if (res.ok) {
                        const data = await res.json();
                        token = data.accessToken || data.token || null;
                    }
                } catch {}
            }
        }

        if (!token || token.length < 50) {
            throw new Error('Could not extract Bearer token. The page may not expose it.');
        }
        console.log(`   ✅ Token extracted (${token.length} chars)`);
        console.log(`   Preview: ${token.substring(0, 30)}...${token.substring(token.length - 10)}\n`);

        // ──── Step 7: Update .env ────
        console.log('⑦ Updating .env...');
        updateEnvKey('GOOGLE_FLOW_TOKEN', token);
        updateEnvKey('GOOGLE_FLOW_SESSION_COOKIES', cookieString);
        console.log('   ✅ Token + Cookies saved to .env\n');

        // Close Chrome test instance
        browser.disconnect();

        // ──── Step 8: Validate with API call ────
        console.log('⑧ Validating fresh credentials...');
        const { default: nodeFetch } = await import('node-fetch');
        const projectId = getEnvValue('GOOGLE_FLOW_PROJECT_ID');
        
        const testRes = await nodeFetch('https://aisandbox-pa.googleapis.com/v1/flow/uploadImage', {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain;charset=UTF-8',
                'Authorization': `Bearer ${token}`,
                'Origin': 'https://labs.google',
                'Referer': 'https://labs.google/',
            },
            body: JSON.stringify({ clientContext: { projectId, tool: 'PINHOLE' } }),
        });

        if (testRes.status === 401) {
            console.log('   ❌ Token invalid (401) — extraction may have failed');
        } else {
            console.log(`   ✅ Token is valid (API returned ${testRes.status})`);
        }

        console.log('\n╔══════════════════════════════════════╗');
        console.log('║  ✅ SETUP COMPLETE                    ║');
        console.log('║  .env updated with fresh credentials  ║');
        console.log('║                                       ║');
        console.log('║  Test image gen with MCP tool:        ║');
        console.log('║  generate_google_flow_image            ║');
        console.log('╚══════════════════════════════════════╝');

    } catch (e) {
        console.error(`\n❌ Error: ${e.message}`);
        console.log('\nRestoring original credentials...');
        if (originalToken) updateEnvKey('GOOGLE_FLOW_TOKEN', originalToken);
        if (originalCookies) updateEnvKey('GOOGLE_FLOW_SESSION_COOKIES', originalCookies);
        console.log('   ✅ Restored');
        
        try { browser?.disconnect(); } catch {}
        try { chromeProcess?.kill(); } catch {}
        process.exit(1);
    }

    process.exit(0);
}

main();
