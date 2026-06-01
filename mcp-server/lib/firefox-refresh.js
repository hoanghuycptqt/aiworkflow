/**
 * Mac MCP — refresh cookies via standalone Firefox reload (not via broker pool).
 *
 * Replaces `broker.refreshCookies()` on the Mac MCP path. Reason:
 *
 *   The broker's ephemeral session pool injects cookies from .env into a
 *   fresh Firefox context and lets NextAuth rotate the session-token JWT
 *   while harvesting. Once in a while (the 2026-05-24 incident) the
 *   rotation produces a JWT that's already-dead (refresh succeeded on
 *   Google's side but the JWT NextAuth re-issued can't refresh again).
 *   That dead JWT then lands in .env, every retry loops on
 *   ACCESS_TOKEN_REFRESH_NEEDED, and only a manual user intervention
 *   (re-running scripts/manual-login.sh) unsticks it.
 *
 *   This module reuses the SAME standalone Firefox + /app/firefox-profile
 *   that manual-login.sh uses — full persistent state (cookies.sqlite,
 *   indexedDB, service workers, …) instead of broker's ephemeral
 *   injected context. NextAuth refresh inside that browser is as
 *   robust as a real user-driven page load, no rotation-to-dead loop
 *   has been observed there. The trade-off is ~15-20s per refresh
 *   (Firefox cold-launch) vs ~3s for broker.refreshCookies — but token
 *   refresh only fires every ~1h on access_token expiry, so the cost
 *   is tolerable.
 *
 * Mac-only:
 *   - Container is Mac docker `vcw-broker-mac`. Override via
 *     MCP_BROKER_CONTAINER if user has a custom compose setup.
 *   - VPS broker runs via systemd, not docker — has its own refresh
 *     path through cookie-harvester.js, which is untouched by this file.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { broker } from './broker-client.js';

const execAsync = promisify(exec);

const CONTAINER = process.env.MCP_BROKER_CONTAINER || 'vcw-broker-mac';
const DOCKER_BIN = process.env.MCP_DOCKER_BIN || '/usr/local/bin/docker';
const PROFILE_DIR = '/app/firefox-profile';
// Match what manual-login.sh's standalone Firefox launches — same patched
// binary the broker uses internally, just driven directly instead of via
// Playwright.
const FIREFOX_BIN = '/root/.cache/invisible-playwright/firefox-7/firefox';
const FLOW_URL = 'https://labs.google/fx/tools/flow';
// Time we let Firefox sit at the Flow page after navigation kicks in.
// NextAuth's session refresh (decode JWT → refresh access_token via the
// stored Google refresh_token → re-sign JWT → Set-Cookie new
// session-token) completes well within 5-10s in practice; 20s gives a
// comfortable margin for cold-launch + network. Goes hand in hand with
// the post-extract /session validate in token-refresh.js — if 20s
// wasn't enough, validation will see the still-old JWT and fail
// cleanly rather than write garbage to .env.
const WAIT_AFTER_LAUNCH_MS = 20000;

async function killProfileFirefox() {
    // pkill returns non-zero when nothing matched — wrap in `|| true`
    // so we don't choke on "no leftover Firefox" (the normal case).
    try {
        await execAsync(`${DOCKER_BIN} exec ${CONTAINER} bash -c "pkill -9 -f 'profile /app/firefox-[p]rofile' || true"`);
    } catch (e) {
        console.error(`[FirefoxRefresh] pkill error (non-fatal): ${e.message}`);
    }
}

async function launchProfileFirefox() {
    // `-d` detaches so docker exec returns immediately. Firefox keeps
    // running inside the container until we kill it. log to /tmp inside
    // the container for diag if launch silently fails.
    await execAsync(
        `${DOCKER_BIN} exec -d ${CONTAINER} bash -c "DISPLAY=:99 HOME=/root ${FIREFOX_BIN} --no-remote --profile ${PROFILE_DIR} ${FLOW_URL} > /tmp/firefox-mcp-refresh.log 2>&1"`
    );
}

async function isFirefoxAlive() {
    try {
        const { stdout } = await execAsync(
            `${DOCKER_BIN} exec ${CONTAINER} bash -c "pgrep -f '[p]rofile ${PROFILE_DIR}' > /dev/null && echo alive || echo dead"`
        );
        return stdout.trim() === 'alive';
    } catch {
        return false;
    }
}

/**
 * Reload standalone Firefox at /app/firefox-profile to refresh NextAuth
 * session, then extract the resulting cookies via the broker's
 * cookies-from-profile endpoint (which just reads the on-disk sqlite,
 * no browser launch involved on its end).
 *
 * Returns the cookie string on success, or null on failure
 * (Firefox didn't launch, no cookies in profile, etc.). Caller is
 * expected to /session-validate the result and either commit to .env
 * (alive) or escalate to manual-login (dead).
 */
export async function refreshViaFirefox(accountId) {
    console.error(`[FirefoxRefresh] starting (container=${CONTAINER}, profile=${PROFILE_DIR})`);

    // 1. Cleanup any stale Firefox process on this profile (could be
    //    leftover from a previous failed refresh or a concurrent
    //    manual-login.sh — we accept clobbering the latter, the user
    //    can re-run manual-login if needed).
    await killProfileFirefox();
    await new Promise(r => setTimeout(r, 500));

    // 2. Launch detached. Verify it actually came up.
    try {
        await launchProfileFirefox();
    } catch (e) {
        console.error(`[FirefoxRefresh] launch error: ${e.message}`);
        return null;
    }
    await new Promise(r => setTimeout(r, 2000));
    if (!await isFirefoxAlive()) {
        console.error('[FirefoxRefresh] Firefox failed to come up — check container /tmp/firefox-mcp-refresh.log');
        return null;
    }

    // 3. Let Firefox finish loading + let NextAuth complete its refresh.
    console.error(`[FirefoxRefresh] Firefox up, waiting ${WAIT_AFTER_LAUNCH_MS / 1000}s for NextAuth refresh…`);
    await new Promise(r => setTimeout(r, WAIT_AFTER_LAUNCH_MS));

    // 4. Read cookies straight off disk through the existing broker
    //    endpoint (Mac single-account fallback path inside the broker
    //    reads /app/firefox-profile/cookies.sqlite — same file Firefox
    //    just rotated).
    let cookies = null;
    try {
        const res = await broker.cookiesFromProfile(accountId);
        if (res?.status === 'ok' && res.cookies) {
            cookies = res.cookies;
            console.error(`[FirefoxRefresh] extracted ${cookies.length} chars from profile`);
        } else {
            console.error(`[FirefoxRefresh] cookies-from-profile unexpected: ${JSON.stringify(res).substring(0, 200)}`);
        }
    } catch (e) {
        console.error(`[FirefoxRefresh] cookies-from-profile error: ${e.message}`);
    }

    // 5. Tear down Firefox so we don't leak processes or hold the
    //    profile lock against the next refresh.
    await killProfileFirefox();

    return cookies;
}
