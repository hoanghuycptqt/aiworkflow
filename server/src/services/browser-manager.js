/**
 * BrowserManager — Centralized Puppeteer browser lifecycle management.
 *
 * Uses SHORT project-local profile paths (uploads/.cp/) to:
 *  - Avoid macOS Unix socket 104-byte path limit (SingletonSocket)
 *  - Avoid EPERM errors when system temp dir is restricted
 *
 * Also provides per-user browser isolation for multi-user deployment.
 * On Linux VPS (no display), auto-starts Xvfb for headful browser sessions.
 */

import puppeteer from 'puppeteer-core';
import { join } from 'path';
import { mkdir, rm, readdir } from 'fs/promises';
import { execSync, spawn } from 'child_process';

// ── Xvfb (Virtual Display) for headless VPS ─────────────
let xvfbProcess = null;
const XVFB_DISPLAY = ':99';

/**
 * Ensure a virtual display is available on Linux when no DISPLAY is set.
 * Starts Xvfb on :99 if needed. Only runs on Linux (VPS).
 */
function ensureDisplay() {
    // Only needed on Linux (VPS) — macOS/Windows have native displays
    if (process.platform !== 'linux') return;

    // Already has a display (e.g. desktop Linux)
    if (process.env.DISPLAY) return;

    // Xvfb already running
    if (xvfbProcess && !xvfbProcess.killed) {
        process.env.DISPLAY = XVFB_DISPLAY;
        return;
    }

    try {
        // Check if Xvfb is installed
        execSync('which Xvfb', { stdio: 'ignore' });
    } catch {
        console.warn('[BrowserManager] ⚠️ Xvfb not installed. Run: sudo apt-get install -y xvfb');
        throw new Error('Xvfb is required for headful browser on VPS. Install with: sudo apt-get install -y xvfb');
    }

    // Kill any stale Xvfb on :99
    try { execSync(`kill $(cat /tmp/.X99-lock 2>/dev/null) 2>/dev/null || true`, { stdio: 'ignore' }); } catch { /* ok */ }

    console.log('[BrowserManager] Starting Xvfb virtual display on :99...');
    xvfbProcess = spawn('Xvfb', [XVFB_DISPLAY, '-screen', '0', '1280x1024x24', '-ac'], {
        stdio: 'ignore',
        detached: true,
    });

    xvfbProcess.on('error', (err) => {
        console.error('[BrowserManager] Xvfb error:', err.message);
        xvfbProcess = null;
    });

    xvfbProcess.unref();

    // Give Xvfb a moment to start
    execSync('sleep 0.5');

    process.env.DISPLAY = XVFB_DISPLAY;
    console.log('[BrowserManager] ✅ Xvfb started on', XVFB_DISPLAY);
}

// ── Config ──────────────────────────────────────────────
export const CHROME_PATH = process.env.CHROME_PATH
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Short path to keep SingletonSocket under macOS 104-byte limit
const CP_DIR = join(process.env.UPLOAD_DIR || './uploads', '.cp');

// ── Instance tracking ───────────────────────────────────
// Map<string, { browser, profileDir, launchedAt, pid }>
const activeBrowsers = new Map();

// Auto-increment counter for short dir names
let profileCounter = 0;

/**
 * Create a short profile directory.
 * Uses counter-based names like ".cp/p0", ".cp/p1" to keep total path short.
 */
async function createShortProfileDir() {
    await mkdir(CP_DIR, { recursive: true });
    const dirName = `p${profileCounter++}`;
    const profileDir = join(CP_DIR, dirName);
    // Clean if leftover from previous run
    await rm(profileDir, { recursive: true, force: true }).catch(() => { });
    await mkdir(profileDir, { recursive: true });
    return profileDir;
}

/**
 * Clean up all profile directories not currently in use.
 */
async function cleanupProfiles() {
    try {
        const entries = await readdir(CP_DIR).catch(() => []);
        const activeDirs = new Set();
        for (const [, info] of activeBrowsers) {
            if (info.profileDir) activeDirs.add(info.profileDir);
        }
        for (const entry of entries) {
            const fullPath = join(CP_DIR, entry);
            if (!activeDirs.has(fullPath)) {
                await rm(fullPath, { recursive: true, force: true }).catch(() => { });
            }
        }
    } catch (e) { /* ignore */ }
}

/**
 * Acquire a managed browser instance.
 *
 * If there's already a browser for this key, it gets closed first.
 *
 * @param {string} key  Unique key, e.g. `chatgpt_refresh_${userId}`
 * @param {object} opts Puppeteer launch options (headless, args, defaultViewport, etc.)
 *                      Do NOT include executablePath or userDataDir.
 * @returns {{ browser: Browser, profileDir: string }}
 */
export async function acquireBrowser(key, opts = {}) {
    // If headful mode requested, ensure virtual display on VPS
    if (opts.headless === false) ensureDisplay();

    // Close any existing browser for this key
    await releaseBrowser(key);

    // Cleanup old profiles
    await cleanupProfiles();

    // Create a short profile dir
    const profileDir = await createShortProfileDir();

    // Separate user args from opts
    const userArgs = opts.args || [];
    const { args: _, ...otherOpts } = opts;

    const launchOpts = {
        executablePath: CHROME_PATH,
        ...otherOpts,
        args: [
            `--user-data-dir=${profileDir}`,
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--no-first-run',
            '--no-default-browser-check',
            ...userArgs,
        ],
    };

    console.log(`[BrowserManager] Launching for key="${key}" → ${profileDir}`);
    const browser = await puppeteer.launch(launchOpts);

    const pid = browser.process()?.pid;
    activeBrowsers.set(key, { browser, profileDir, launchedAt: Date.now(), pid });
    console.log(`[BrowserManager] ✅ Launched (PID=${pid})`);

    // Auto-release on unexpected disconnect
    browser.on('disconnected', () => {
        const info = activeBrowsers.get(key);
        if (info?.browser === browser) {
            activeBrowsers.delete(key);
            rm(profileDir, { recursive: true, force: true }).catch(() => { });
        }
    });

    return { browser, profileDir };
}

/**
 * Launch a one-off headless browser (no key tracking).
 * Used by connectors and validators that don't need per-user isolation.
 *
 * @param {object} opts Puppeteer launch options
 * @returns {{ browser: Browser, profileDir: string }}
 */
export async function launchTempBrowser(opts = {}) {
    // If headful mode requested, ensure virtual display on VPS
    if (opts.headless === false) ensureDisplay();

    const profileDir = await createShortProfileDir();

    const userArgs = opts.args || [];
    const { args: _, ...otherOpts } = opts;

    const launchOpts = {
        executablePath: CHROME_PATH,
        ...otherOpts,
        args: [
            `--user-data-dir=${profileDir}`,
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--no-first-run',
            '--no-default-browser-check',
            ...userArgs,
        ],
    };

    const browser = await puppeteer.launch(launchOpts);
    console.log(`[BrowserManager] Temp browser launched → ${profileDir}`);

    // Auto-cleanup on close
    browser.on('disconnected', () => {
        rm(profileDir, { recursive: true, force: true }).catch(() => { });
    });

    return { browser, profileDir };
}

/**
 * Release (close) a managed browser instance.
 */
export async function releaseBrowser(key) {
    const info = activeBrowsers.get(key);
    if (!info) return;

    activeBrowsers.delete(key);

    try {
        if (info.browser.isConnected()) {
            await info.browser.close();
            console.log(`[BrowserManager] Closed browser for key="${key}"`);
        }
    } catch (e) {
        console.warn(`[BrowserManager] Error closing: ${e.message}`);
        if (info.pid) {
            try { process.kill(info.pid, 'SIGKILL'); } catch (e2) { /* dead */ }
        }
    }

    if (info.profileDir) {
        await rm(info.profileDir, { recursive: true, force: true }).catch(() => { });
    }
}

export function isActive(key) {
    const info = activeBrowsers.get(key);
    return !!(info?.browser?.isConnected());
}

// Initial cleanup on module load
cleanupProfiles();

export default { CHROME_PATH, acquireBrowser, launchTempBrowser, releaseBrowser, isActive };
