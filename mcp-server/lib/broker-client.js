/**
 * Thin HTTP client for vcw-flow-broker (Python side-car, Docker on Mac).
 *
 * Replaces the Chrome+Puppeteer machinery previously in `lib/recaptcha.js`
 * (`_chromePool`, `_ensureRecaptchaPage`, `browserFetch`, `_reloadRecaptchaPage`).
 *
 * The broker (running on http://127.0.0.1:8002) handles:
 *   - Persistent Firefox session per Google account (keyed by accountId)
 *   - Per-account asyncio.Lock — serializes operations
 *   - Context rotation @ 15 requests (Phase 0 cliff defense)
 *   - 24h "Firefox forever" idle timeout (Mac preference vs VPS's 10m)
 *
 * MCP server only needs:
 *   1. ensureSession(accountId, sessionCookies) — once per execute()
 *   2. recaptchaToken(accountId, action) — mint fresh token
 *   3. flowFetch(accountId, url, bearer, body) — browser-side API call
 *   4. reload(accountId) — recover from sticky SDK failure
 *
 * See MIGRATION-MAC-MCP.md and memory `invisible-playwright-phase0` for the
 * architectural rationale. Differs from VPS's broker-client.js only in env
 * variable names (MCP_BROKER_URL/MCP_BROKER_TOKEN vs FLOW_BROKER_URL/
 * BROKER_AUTH_TOKEN) and exported singleton name (`broker` vs `flowBroker`).
 */

import fetch from 'node-fetch';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8002';
const DEFAULT_TIMEOUT_MS = 120000; // 2 min — covers worst-case Rosetta cold-start + nav

class BrokerError extends Error {
    constructor(message, { status, body } = {}) {
        super(message);
        this.name = 'BrokerError';
        this.status = status;
        this.body = body;
    }
}

export class FlowBroker {
    constructor(baseUrl, authToken) {
        this.baseUrl = (baseUrl || process.env.MCP_BROKER_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
        this.authToken = authToken || process.env.MCP_BROKER_TOKEN || '';
    }

    async _call(method, path, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        const url = `${this.baseUrl}${path}`;
        const headers = { 'Content-Type': 'application/json' };
        if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let res;
        try {
            res = await fetch(url, {
                method,
                headers,
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            });
        } catch (e) {
            clearTimeout(timer);
            if (e.name === 'AbortError') {
                throw new BrokerError(`Broker timeout after ${timeoutMs}ms on ${method} ${path}`);
            }
            throw new BrokerError(`Broker unreachable at ${this.baseUrl}: ${e.message}. Is Docker Desktop running and vcw-broker-mac container up?`);
        }
        clearTimeout(timer);

        const text = await res.text();
        let data;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            throw new BrokerError(`Broker returned non-JSON (${res.status}): ${text.substring(0, 200)}`,
                { status: res.status, body: text });
        }

        if (!res.ok) {
            const detail = data?.detail || data?.message || JSON.stringify(data);
            throw new BrokerError(`Broker ${res.status} on ${method} ${path}: ${String(detail).substring(0, 300)}`,
                { status: res.status, body: data });
        }
        return data;
    }

    async healthz() {
        return this._call('GET', '/healthz', undefined, { timeoutMs: 5000 });
    }

    async ensureSession(accountId, cookies = '') {
        return this._call('POST', `/sessions/${encodeURIComponent(accountId)}/init`, { cookies });
    }

    /** Returns { token, request_count }. */
    async recaptchaToken(accountId, action) {
        return this._call('POST', `/sessions/${encodeURIComponent(accountId)}/recaptcha-token`, { action });
    }

    /** Returns { status, ok, body } from the in-browser fetch — matches old browserFetch shape. */
    async flowFetch(accountId, url, bearer, body) {
        return this._call('POST', `/sessions/${encodeURIComponent(accountId)}/flow-fetch`,
            { url, bearer, body });
    }

    async reload(accountId) {
        return this._call('POST', `/sessions/${encodeURIComponent(accountId)}/reload`, undefined);
    }

    /** Returns { cookies: "name=val; name=val" }. */
    async harvestCookies(accountId) {
        return this._call('POST', `/sessions/${encodeURIComponent(accountId)}/harvest-cookies`, undefined);
    }

    /**
     * Refresh cookies on an account by re-navigating the Flow page.
     * Returns { status: "ok", cookies } or { status: "needs_relogin", message }.
     */
    async refreshCookies(accountId, cookies = '') {
        return this._call('POST', `/sessions/${encodeURIComponent(accountId)}/refresh-cookies`,
            { cookies });
    }

    async close(accountId) {
        return this._call('DELETE', `/sessions/${encodeURIComponent(accountId)}`, undefined);
    }
}

// Singleton — env-driven config so MCP-side callers don't repeat the boilerplate.
export const broker = new FlowBroker();
export { BrokerError };
