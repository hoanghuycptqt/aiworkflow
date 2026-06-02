/**
 * Ollama service — shared client for the self-hosted local LLM.
 *
 * The Ollama server runs on the SAME box as this Node process, reachable at
 * OLLAMA_BASE_URL (default http://127.0.0.1:11434) with NO auth. The nginx
 * basic-auth (flowadmin) only gates the public /ollama/ endpoint for external
 * clients — server-side calls go straight to localhost.
 *
 * Used by:
 *  - connectors/ai-text/connector.js  (the "AI Text" workflow node)
 *  - services/telegram-ai.js          (the Telegram bot, provider=ollama)
 *  - routes/ollama.routes.js          (GET /api/ollama/models for dropdowns)
 */

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');

const MODEL_CACHE_TTL_MS = 60_000;
let _modelCache = { at: 0, models: [] };

export function getOllamaBaseUrl() {
    return OLLAMA_BASE_URL;
}

/**
 * List models currently pulled on the Ollama instance (via /api/tags), cached
 * for 60s. Never throws — returns the last good (or empty) list on failure so a
 * dead Ollama doesn't break the settings/node-config pages.
 */
export async function fetchOllamaModels({ force = false, baseUrl = OLLAMA_BASE_URL } = {}) {
    const now = Date.now();
    if (!force && _modelCache.models.length && now - _modelCache.at < MODEL_CACHE_TTL_MS) {
        return _modelCache.models;
    }
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`/api/tags returned ${res.status}`);
        const data = await res.json();
        const models = (data.models || [])
            .map((m) => m.name)
            .filter(Boolean)
            .sort();
        _modelCache = { at: now, models };
        return models;
    } catch (e) {
        console.warn(`[Ollama] model list fetch failed: ${e.message}`);
        return _modelCache.models; // stale or empty — caller decides on fallback
    }
}

/**
 * Call Ollama's native /api/chat (non-streaming).
 *
 * @param {object} opts
 * @param {string} opts.model      e.g. 'gemma4:e4b'
 * @param {Array}  opts.messages   [{ role, content, images? }]  (images = raw base64 strings)
 * @param {Array}  [opts.tools]    OpenAI-style tool/function declarations (gemma4 supports tools)
 * @param {number} [opts.temperature]
 * @param {boolean}[opts.think=false]  gemma4 has a thinking mode that is slow on CPU — off by default
 * @param {number} [opts.timeoutMs=180000]
 * @param {string} [opts.baseUrl]   override (per-credential) base URL
 * @returns {Promise<object>} raw Ollama response: { message: { content, tool_calls? }, ... }
 */
export async function callOllamaChat({
    model,
    messages,
    tools,
    temperature,
    think = false,
    timeoutMs = 180_000,
    baseUrl = OLLAMA_BASE_URL,
}) {
    // Stream the response (NDJSON). Streaming avoids Node fetch's ~5min
    // headers/body timeout on long CPU generations: headers arrive at the first
    // token and tokens flow continuously. The AbortController below is the only
    // overall cap (timeoutMs). We re-assemble the same shape a non-stream call
    // would return ({ message: { content, tool_calls }, ...stats }).
    const buildBody = (includeThink) => ({
        model,
        messages,
        ...(tools && tools.length ? { tools } : {}),
        stream: true,
        ...(includeThink ? { think } : {}),
        ...(temperature != null ? { options: { temperature } } : {}),
    });

    const post = async (body) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            return { res, clear: () => clearTimeout(timer) };
        } catch (e) {
            clearTimeout(timer);
            if (e.name === 'AbortError') {
                throw new Error(`Ollama request timed out (${Math.round(timeoutMs / 1000)}s) — model "${model}" may be loading or overloaded.`);
            }
            throw new Error(`Cannot reach Ollama at ${baseUrl}: ${e.message}`);
        }
    };

    const readStream = async (res, clear) => {
        let content = '';
        let toolCalls = null;
        let stats = {};
        let buf = '';
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (!line) continue;
                    let obj;
                    try { obj = JSON.parse(line); } catch { continue; }
                    if (obj.error) throw new Error(`Ollama error: ${String(obj.error).substring(0, 300)}`);
                    if (obj.message?.content) content += obj.message.content;
                    if (obj.message?.tool_calls) toolCalls = obj.message.tool_calls;
                    if (obj.done) stats = obj;
                }
            }
        } catch (e) {
            if (e.name === 'AbortError') {
                throw new Error(`Ollama request timed out (${Math.round(timeoutMs / 1000)}s) — generation exceeded the limit.`);
            }
            throw e;
        } finally {
            clear();
            try { reader.releaseLock(); } catch { /* already released */ }
        }
        return { message: { content, tool_calls: toolCalls }, ...stats };
    };

    let { res, clear } = await post(buildBody(true));

    // Some models reject the `think` field ("does not support thinking"); retry without it.
    if (!res.ok && res.status === 400) {
        const errText = await res.text().catch(() => '');
        clear();
        if (/think/i.test(errText)) {
            ({ res, clear } = await post(buildBody(false)));
        } else {
            throw new Error(`Ollama error (400): ${errText.substring(0, 300)}`);
        }
    }

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        clear();
        if (res.status === 404) {
            throw new Error(`Ollama model "${model}" not found. Pull it on the server: ollama pull ${model}`);
        }
        throw new Error(`Ollama error (${res.status}): ${text.substring(0, 300)}`);
    }

    return readStream(res, clear);
}
