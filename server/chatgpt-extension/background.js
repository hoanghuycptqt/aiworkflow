/**
 * VCW ChatGPT Bridge — Background Service Worker
 * 
 * Uses chrome.scripting.executeScript to interact with ChatGPT's UI:
 * 1. Types the prompt into ChatGPT's input box
 * 2. Clicks the send button
 * 3. Waits for the response to finish streaming
 * 4. Reads the response from the DOM
 * 
 * This approach lets ChatGPT's own frontend handle ALL security
 * (Turnstile, proof-of-work, cookies, etc.)
 */

const SERVER_URL = 'http://localhost:3001';
const POLL_INTERVAL = 1500;

console.log('[VCW Bridge] Starting...');
poll();

async function poll() {
    while (true) {
        try {
            const resp = await fetch(`${SERVER_URL}/api/bridge/poll`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source: 'extension' }),
            });

            if (!resp.ok) throw new Error(`Server ${resp.status}`);
            const data = await resp.json();

            if (data.request) {
                console.log('[VCW Bridge] Got request:', data.request.id);
                await processRequest(data.request);
            }
        } catch (err) {
            if (!err.message.includes('Failed to fetch')) {
                console.log('[VCW Bridge] Poll error:', err.message);
            }
        }

        await sleep(POLL_INTERVAL);
    }
}

async function processRequest(request) {
    try {
        const tab = await getOrCreateChatGPTTab();
        console.log('[VCW Bridge] Using tab:', tab.id);

        // Extract the prompt from the request body
        const body = request.body;
        const prompt = body?.messages?.[0]?.content?.parts?.[0] || '';
        console.log('[VCW Bridge] Prompt:', prompt.substring(0, 60) + '...');

        // Execute UI automation in the page
        console.log('[VCW Bridge] Automating ChatGPT UI...');
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: automateChat,
            args: [prompt],
        });

        const result = results[0]?.result;
        console.log('[VCW Bridge] Result:', result?.success ? '✅' : '❌ ' + (result?.error || 'empty'));

        await fetch(`${SERVER_URL}/api/bridge/result/${request.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result || { error: 'No result' }),
        });

        console.log('[VCW Bridge] Posted to server');

    } catch (err) {
        console.error('[VCW Bridge] Error:', err.message);
        try {
            await fetch(`${SERVER_URL}/api/bridge/result/${request.id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: err.message }),
            });
        } catch { }
    }
}

/**
 * Automate ChatGPT UI from within the page context.
 * Types the prompt, sends it, waits for response, extracts text.
 */
async function automateChat(prompt) {
    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    try {
        console.log('[VCW UI] Starting chat automation...');

        // ========================================
        // STEP 1: Find the input element
        // ========================================
        // ChatGPT uses a contenteditable div with id="prompt-textarea"
        // or a ProseMirror editor
        let inputEl = document.getElementById('prompt-textarea');

        if (!inputEl) {
            // Try other selectors
            inputEl = document.querySelector('[contenteditable="true"]');
        }
        if (!inputEl) {
            inputEl = document.querySelector('textarea');
        }
        if (!inputEl) {
            return { error: 'Cannot find ChatGPT input box. Is the page loaded?' };
        }

        console.log('[VCW UI] Found input:', inputEl.tagName, inputEl.id || '');

        // ========================================
        // STEP 2: Count existing messages (to know when new one arrives)
        // ========================================
        const getAssistantMessages = () => {
            // ChatGPT renders messages in article elements or divs with data-message-author-role
            const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
            if (msgs.length > 0) return msgs;
            // Fallback: look for markdown-rendered content in agent turns
            return document.querySelectorAll('.agent-turn .markdown');
        };

        const beforeCount = getAssistantMessages().length;
        console.log('[VCW UI] Messages before:', beforeCount);

        // ========================================
        // STEP 3: Type the prompt
        // ========================================
        // Focus the input
        inputEl.focus();
        await sleep(300);

        if (inputEl.tagName === 'TEXTAREA') {
            // For textarea
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value'
            ).set;
            nativeInputValueSetter.call(inputEl, prompt);
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            // For contenteditable / ProseMirror
            // Clear existing content
            inputEl.innerHTML = '';
            await sleep(100);

            // Create a paragraph with the text
            const p = document.createElement('p');
            p.textContent = prompt;
            inputEl.appendChild(p);

            // Dispatch input event
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        }

        await sleep(500);
        console.log('[VCW UI] Prompt typed');

        // ========================================
        // STEP 4: Click the send button
        // ========================================
        let sendBtn = document.querySelector('[data-testid="send-button"]');
        if (!sendBtn) {
            sendBtn = document.querySelector('button[aria-label="Send prompt"]');
        }
        if (!sendBtn) {
            // Look for the send button near the input
            const buttons = document.querySelectorAll('form button, [class*="composer"] button');
            for (const btn of buttons) {
                // Send button is usually the last enabled button or has an SVG arrow icon
                if (!btn.disabled && btn.querySelector('svg')) {
                    sendBtn = btn;
                }
            }
        }

        if (!sendBtn) {
            // Try submitting form via Enter key
            console.log('[VCW UI] No send button found, trying Enter key...');
            inputEl.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                bubbles: true, cancelable: true,
            }));
        } else {
            console.log('[VCW UI] Clicking send button...');
            sendBtn.click();
        }

        await sleep(1000);

        // ========================================
        // STEP 5: Wait for response to complete
        // ========================================
        console.log('[VCW UI] Waiting for response...');

        let responseText = '';
        let stableCount = 0;
        const maxWait = 120; // 2 minutes

        for (let i = 0; i < maxWait; i++) {
            await sleep(1000);

            const currentMessages = getAssistantMessages();
            if (currentMessages.length > beforeCount) {
                // New message appeared!
                const lastMsg = currentMessages[currentMessages.length - 1];
                const newText = lastMsg.innerText || lastMsg.textContent || '';

                // Check if still streaming (text is growing)
                if (newText === responseText) {
                    stableCount++;
                    // If text hasn't changed for 3 seconds, it's done
                    if (stableCount >= 3) {
                        console.log('[VCW UI] Response complete (stable for 3s)');
                        break;
                    }
                } else {
                    responseText = newText;
                    stableCount = 0;
                    if (i % 5 === 0) {
                        console.log('[VCW UI] Streaming...', responseText.length, 'chars');
                    }
                }
            }

            // Also check for the "stop generating" button disappearing
            const isStreaming = document.querySelector('[data-testid="stop-button"]') ||
                document.querySelector('button[aria-label="Stop streaming"]') ||
                document.querySelector('[class*="stop"]');
            if (!isStreaming && currentMessages.length > beforeCount && responseText.length > 0) {
                console.log('[VCW UI] Streaming stopped (no stop button)');
                // Wait a tiny bit more for final render
                await sleep(1000);
                const finalMsgs = getAssistantMessages();
                const finalMsg = finalMsgs[finalMsgs.length - 1];
                responseText = finalMsg.innerText || finalMsg.textContent || responseText;
                break;
            }

            if (i === maxWait - 1) {
                return { error: 'Timeout: ChatGPT did not respond within 2 minutes' };
            }
        }

        if (!responseText) {
            return { error: 'No response from ChatGPT' };
        }

        console.log('[VCW UI] ✅ Got response:', responseText.length, 'chars');
        return { text: responseText.trim(), success: true };

    } catch (e) {
        console.error('[VCW UI] Error:', e);
        return { error: e.message };
    }
}

async function getOrCreateChatGPTTab() {
    const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
    if (tabs.length > 0) {
        const tab = tabs[0];
        if (tab.status !== 'complete') {
            await waitForTabLoad(tab.id);
        }
        return tab;
    }

    console.log('[VCW Bridge] Creating new ChatGPT tab...');
    const newTab = await chrome.tabs.create({
        url: 'https://chatgpt.com/',
        active: false,
    });
    await waitForTabLoad(newTab.id);
    await sleep(5000);
    return await chrome.tabs.get(newTab.id);
}

function waitForTabLoad(tabId) {
    return new Promise((resolve) => {
        const listener = (id, info) => {
            if (id === tabId && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
        }, 30000);
    });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_STATUS') {
        sendResponse({ isActive: true, serverUrl: SERVER_URL });
        return true;
    }
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
