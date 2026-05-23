/**
 * Token Auto-Refresh — Broker-backed (Plan v4.3 / v5.0).
 *
 * Triggered by handleTokenRefresh() in google-flow-api.js when an API call
 * returns 401. Flow:
 *   1. Call broker /refresh-cookies — broker re-navigates Flow page with
 *      existing session, returns fresh cookies (or needs_relogin if session
 *      truly expired).
 *   2. Call /api/auth/session via pure Node fetch with fresh cookies — returns
 *      new access_token + expires timestamp.
 *   3. Write both to mcp-server/.env (cache for subsequent MCP server startup).
 *      Also updates process.env for the running process.
 *
 * No Chrome page interception (legacy approach) — broker's Firefox session
 * handles the heavy lifting via its persistent state. Simpler + more reliable.
 *
 * Concurrency: `_refreshing` flag prevents two parallel refreshes from
 * stomping on .env or hammering Google's session API.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fetch from 'node-fetch';
import { broker, BrokerError } from './broker-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');

let _refreshing = false;

/**
 * Update a single key in mcp-server/.env. Replaces in place if present, else
 * appends. Also propagates to process.env so the running process picks it up
 * without restart.
 */
function updateEnvKey(key, value) {
    try {
        let content = readFileSync(ENV_PATH, 'utf-8');
        const regex = new RegExp(`^${key}=.*`, 'm');
        if (regex.test(content)) {
            content = content.replace(regex, `${key}=${value}`);
        } else {
            content += `\n${key}=${value}\n`;
        }
        writeFileSync(ENV_PATH, content);
        process.env[key] = value;
    } catch (e) {
        console.error(`[TokenRefresh] Failed to update ${key} in .env: ${e.message}`);
    }
}

/**
 * Refresh token + cookies via broker. Returns the new bearer token on success,
 * or null on failure / needs_relogin.
 *
 * Caller passes accountId derived from credentials.metadata.userEmail (see
 * getAccountInstanceId in recaptcha.js).
 */
export async function refreshToken(accountId) {
    if (_refreshing) {
        console.error('[TokenRefresh] Already refreshing, skipping concurrent call');
        return null;
    }
    _refreshing = true;
    try {
        // 1. Fresh cookies from broker (re-nav Flow page with current session).
        let cookies;
        try {
            const res = await broker.refreshCookies(accountId);
            if (res.status === 'needs_relogin') {
                console.error('[TokenRefresh] ❌ Session truly expired — needs full re-login. '
                    + 'Cookies in .env are past NextAuth maxAge ceiling (~60 days). '
                    + 'Extract fresh cookies from a logged-in browser and update mcp-server/.env.');
                return null;
            }
            if (res.status !== 'ok' || !res.cookies) {
                console.error(`[TokenRefresh] Unexpected broker response: ${JSON.stringify(res).substring(0, 200)}`);
                return null;
            }
            cookies = res.cookies;
        } catch (e) {
            const msg = e instanceof BrokerError ? `${e.status || ''}: ${e.message}` : e.message;
            console.error(`[TokenRefresh] Broker refresh failed: ${msg}`);
            return null;
        }

        // 2. Fresh bearer token via Node fetch to /api/auth/session. Same pattern
        //    as VPS server's ensureFreshToken — broker not needed for this step.
        const sessionRes = await fetch('https://labs.google/fx/api/auth/session', {
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'Content-Type': 'application/json',
                'Cookie': cookies,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                'Referer': 'https://labs.google/fx/vi/tools/flow/',
            },
        });
        if (!sessionRes.ok) {
            console.error(`[TokenRefresh] Session API returned ${sessionRes.status}`);
            return null;
        }
        const data = await sessionRes.json();
        if (!data.access_token) {
            console.error('[TokenRefresh] No access_token in session response');
            return null;
        }

        // 3. Persist to .env (subsequent MCP server startups read this) +
        //    process.env (this running process picks it up immediately).
        updateEnvKey('GOOGLE_FLOW_SESSION_COOKIES', cookies);
        updateEnvKey('GOOGLE_FLOW_TOKEN', data.access_token);
        console.error('[TokenRefresh] ✅ .env updated with fresh cookies + token');

        return data.access_token;
    } catch (e) {
        console.error(`[TokenRefresh] Failed: ${e.message}`);
        return null;
    } finally {
        _refreshing = false;
    }
}
