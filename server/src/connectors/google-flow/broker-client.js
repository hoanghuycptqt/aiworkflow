/**
 * Thin HTTP client for vcw-flow-broker (Python side-car).
 *
 * Replaces the Chrome+Puppeteer machinery previously embedded in connector.js
 * (`_chromePool`, `_ensureRecaptchaPage`, `browserFetch`, `_reloadRecaptchaPage`).
 *
 * The broker handles:
 *   - Persistent Firefox session per Google account (keyed by instanceId)
 *   - Per-account asyncio.Lock — serializes operations
 *   - Context rotation @ 15 requests (avoids the stochastic ~20-25 cliff)
 *   - 10-min idle timeout — full browser close
 *
 * Connector code only needs to:
 *   1. ensureSession(instanceId, sessionCookies) — once per execute() call
 *   2. recaptchaToken(instanceId, action) — mint fresh token
 *   3. flowFetch(instanceId, url, bearer, body) — browser-side API call
 *   4. reload(instanceId) — recover from sticky SDK failure
 *
 * See `python-broker/README.md` and memory `invisible-playwright-phase0` for
 * the architectural rationale.
 */

import fetch from 'node-fetch';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8002';
const DEFAULT_TIMEOUT_MS = 120000; // 2 min — covers worst-case Firefox cold-start + nav

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
        this.baseUrl = (baseUrl || process.env.FLOW_BROKER_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
        this.authToken = authToken || process.env.BROKER_AUTH_TOKEN || '';
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
            throw new BrokerError(`Broker unreachable at ${this.baseUrl}: ${e.message}`);
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
     * Replaces the Chrome refreshCookies() in google-login-agent.js.
     */
    async refreshCookies(accountId, cookies = '') {
        return this._call('POST', `/sessions/${encodeURIComponent(accountId)}/refresh-cookies`,
            { cookies });
    }

    /**
     * Start a background login flow on the broker. Returns immediately.
     * Poll loginStatus(accountId) to track progress (state, screenshot_path, cookies).
     * Replaces the Chrome google-login-worker.mjs spawn in google-login-agent.js.
     */
    async startLogin(accountId, email, password) {
        return this._call('POST', `/sessions/${encodeURIComponent(accountId)}/login`,
            { email, password });
    }

    /** Get current login state. Returns { state, screenshot_path?, error?, cookies? }. */
    async loginStatus(accountId) {
        return this._call('GET', `/sessions/${encodeURIComponent(accountId)}/login-status`,
            undefined, { timeoutMs: 5000 });
    }

    async close(accountId) {
        return this._call('DELETE', `/sessions/${encodeURIComponent(accountId)}`, undefined);
    }
}

// Singleton — env-driven config so Node-side callers don't repeat the boilerplate.
export const flowBroker = new FlowBroker();
export { BrokerError };
