/**
 * VCW ChatGPT Bridge — Content Script
 * 
 * Runs on chatgpt.com pages.
 * Receives requests from the background service worker,
 * injects code into the page's MAIN WORLD to make API calls
 * with page cookies (bypasses Cloudflare).
 * 
 * Uses DOM elements for cross-world communication (more reliable
 * than CustomEvent.detail which doesn't cross world boundaries).
 */

console.log('[VCW Content] Loaded on', window.location.href);

// Listen for messages from background worker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'VCW_PING') {
        console.log('[VCW Content] Received PING');
        sendResponse({ pong: true });
        return false;
    }

    if (msg.type === 'VCW_CHATGPT_REQUEST') {
        console.log('[VCW Content] Received request:', msg.data.id);
        handleRequest(msg.data)
            .then(result => {
                console.log('[VCW Content] Sending result back:', result.success ? 'success' : 'error');
                sendResponse(result);
            })
            .catch(err => {
                console.error('[VCW Content] Error:', err.message);
                sendResponse({ error: err.message });
            });
        return true; // Keep message channel open for async response
    }
});

/**
 * Handle a ChatGPT API request
 * Uses a hidden DOM element to pass results between main world and content script
 */
async function handleRequest(request) {
    const { accessToken, body } = request;
    const requestId = request.id;
    const resultElementId = `__vcw_result_${requestId}`;

    return new Promise((resolve, reject) => {
        // Create a hidden div to receive result from injected script
        const resultDiv = document.createElement('div');
        resultDiv.id = resultElementId;
        resultDiv.style.display = 'none';
        document.documentElement.appendChild(resultDiv);

        // Poll for result (injected script will write to this div)
        let pollCount = 0;
        const maxPolls = 120; // 2 minutes (120 * 1s)
        const pollInterval = setInterval(() => {
            pollCount++;
            const content = resultDiv.textContent;

            if (content && content.length > 0) {
                clearInterval(pollInterval);
                resultDiv.remove();
                try {
                    const result = JSON.parse(content);
                    console.log('[VCW Content] Got result from injected script');
                    resolve(result);
                } catch (e) {
                    resolve({ text: content, success: true });
                }
            } else if (pollCount >= maxPolls) {
                clearInterval(pollInterval);
                resultDiv.remove();
                reject(new Error('Timeout waiting for ChatGPT response'));
            }
        }, 1000);

        // Inject script into page's MAIN WORLD
        const scriptContent = `
(async () => {
    const resultEl = document.getElementById('${resultElementId}');
    try {
        const accessToken = ${JSON.stringify(accessToken)};
        const bodyJson = ${JSON.stringify(JSON.stringify(body))};

        // Step 1: Get chat requirements token
        let chatReqToken = null;
        try {
            const rr = await fetch('/backend-api/sentinel/chat-requirements', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + accessToken,
                    'Content-Type': 'application/json',
                },
                body: '{}',
            });
            if (rr.ok) {
                const d = await rr.json();
                chatReqToken = d.token;
            }
        } catch(e) { console.log('[VCW Inject] Chat req error:', e); }

        // Step 2: Send conversation
        const headers = {
            'Accept': 'text/event-stream',
            'Authorization': 'Bearer ' + accessToken,
            'Content-Type': 'application/json',
        };
        if (chatReqToken) {
            headers['Openai-Sentinel-Chat-Requirements-Token'] = chatReqToken;
        }

        console.log('[VCW Inject] Sending conversation request...');
        const resp = await fetch('/backend-api/conversation', {
            method: 'POST',
            headers: headers,
            body: bodyJson,
        });

        if (!resp.ok) {
            const errTxt = await resp.text();
            resultEl.textContent = JSON.stringify({ error: 'API ' + resp.status + ': ' + errTxt.substring(0, 300) });
            return;
        }

        const text = await resp.text();
        console.log('[VCW Inject] Got response, length:', text.length);

        // Parse SSE response
        const lines = text.split('\\n');
        let lastMessage = '';
        for (const line of lines) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                    const data = JSON.parse(line.slice(6));
                    const part = data && data.message && data.message.content && 
                                 data.message.content.parts && data.message.content.parts[0];
                    if (typeof part === 'string' && part.length > lastMessage.length) {
                        lastMessage = part;
                    }
                } catch(e) {}
            }
        }

        console.log('[VCW Inject] Parsed message, length:', lastMessage.length);
        resultEl.textContent = JSON.stringify({ text: lastMessage || '', success: true });

    } catch(e) {
        console.error('[VCW Inject] Error:', e);
        resultEl.textContent = JSON.stringify({ error: e.message });
    }
})();
`;

        console.log('[VCW Content] Injecting script into page...');
        const script = document.createElement('script');
        script.textContent = scriptContent;
        document.documentElement.appendChild(script);
        script.remove();
        console.log('[VCW Content] Script injected');
    });
}
