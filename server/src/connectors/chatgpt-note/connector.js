/**
 * ChatGPT Note Connector — Puppeteer UI Automation
 *
 * Uses headless Chrome to interact with ChatGPT's actual web UI.
 * The page's own JavaScript handles ALL sentinel tokens, PoW,
 * Turnstile, and Cloudflare — we just type and read the response.
 *
 * Flow:
 *   1. Launch headless Chrome (invisible)
 *   2. Inject session cookies
 *   3. Navigate to chatgpt.com (or Custom GPT URL)
 *   4. Type prompt into textarea → click send
 *   5. Wait for response to complete
 *   6. Extract response text from DOM
 *   7. Close browser
 */

import { BaseConnector } from '../base-connector.js';
import puppeteer from 'puppeteer-core';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { CHROME_PATH } from '../../services/browser-manager.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/**
 * Parse cookie string into Puppeteer cookie objects.
 */
function parseCookies(cookieStr) {
    if (!cookieStr) return [];
    return cookieStr.split(';').map(c => {
        const trimmed = c.trim();
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex <= 0) return null;

        const name = trimmed.substring(0, eqIndex).trim();
        const value = trimmed.substring(eqIndex + 1).trim();
        if (!name) return null;

        const cookie = { name, value, domain: 'chatgpt.com', path: '/' };
        if (name.startsWith('__Secure-') || name.startsWith('__Host-')) {
            cookie.secure = true;
        }
        return cookie;
    }).filter(Boolean);
}

/**
 * Resolve image paths from workflow input to absolute file paths.
 */
function resolveImagePaths(input) {
    const uploadsDir = process.env.UPLOAD_DIR || './uploads';
    const paths = [];

    // Collect image sources from input
    const sources = [];
    if (input.images && input.images.length > 0) {
        sources.push(...input.images);
    } else if (input.imageUrl || input.filePath) {
        sources.push({ imageUrl: input.imageUrl, filePath: input.filePath });
    }

    for (const src of sources) {
        let absPath = '';

        if (src.filePath) {
            absPath = resolve(src.filePath);
        } else if (src.imageUrl) {
            // Convert /uploads/filename.png → absolute path
            const relativePath = src.imageUrl.replace(/^\/uploads\//, '');
            absPath = resolve(join(uploadsDir, relativePath));
        }

        if (absPath && existsSync(absPath)) {
            paths.push(absPath);
            console.log(`[ChatGPTNote] Image found: ${absPath}`);
        } else if (absPath) {
            console.warn(`[ChatGPTNote] Image not found: ${absPath}`);
        }
    }

    return paths;
}

/**
 * Execute ChatGPT conversation via UI automation in headless Chrome.
 */
async function executeViaUI(cookies, { prompt, model, customGptId, imagePaths }) {
    console.log('[ChatGPTNote] Launching headless Chrome...');

    const browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: 'new',
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1728,1117',
        ],
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1728, height: 1117 });
        await page.setUserAgent(USER_AGENT);

        // Hide automation detection
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        // Inject session cookies BEFORE navigation
        const cookieObjs = parseCookies(cookies);
        if (cookieObjs.length > 0) {
            await page.setCookie(...cookieObjs);
            console.log(`[ChatGPTNote] Injected ${cookieObjs.length} cookies`);
        }

        // Navigate to ChatGPT or specific Custom GPT
        const targetUrl = customGptId
            ? `https://chatgpt.com/g/${customGptId}`
            : 'https://chatgpt.com';

        console.log('[ChatGPTNote] Navigating to', targetUrl);
        await page.goto(targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });

        // Check if we hit Cloudflare challenge
        const pageContent = await page.content();
        if (pageContent.includes('Just a moment') || pageContent.includes('cf-challenge')) {
            console.log('[ChatGPTNote] Cloudflare challenge detected, waiting...');
            await new Promise(r => setTimeout(r, 10000));
        }

        // Check if we were redirected to login page (session expired)
        const currentUrl = page.url();
        if (currentUrl.includes('auth0') || currentUrl.includes('auth.openai.com') ||
            currentUrl.includes('/auth/login') || currentUrl.includes('login.chatgpt.com')) {
            console.error('[ChatGPTNote] ❌ Redirected to login page — session expired');
            throw new Error('ChatGPT session expired (redirected to login). Go to Credentials → click "🔄 Auto Refresh" to re-login.');
        }

        // Wait for the chat textarea to appear (proves we're logged in)
        console.log('[ChatGPTNote] Waiting for chat UI...');
        try {
            await page.waitForSelector('#prompt-textarea', { visible: true, timeout: 30000 });
        } catch (e) {
            // Check again if we ended up on login page
            const urlNow = page.url();
            const titleNow = await page.title();

            if (urlNow.includes('auth') || urlNow.includes('login') ||
                titleNow.includes('Log in') || titleNow.includes('Sign up')) {
                throw new Error('ChatGPT session expired. Go to Credentials → click "🔄 Auto Refresh" to re-login.');
            }

            // Try alternative selectors
            try {
                await page.waitForSelector('[contenteditable="true"]', { visible: true, timeout: 10000 });
            } catch (e2) {
                console.error(`[ChatGPTNote] Chat UI not found. URL: ${urlNow}, Title: ${titleNow}`);
                throw new Error(`Chat UI did not load (possible session issue). URL: ${urlNow}. Try "🔄 Auto Refresh" on Credentials page.`);
            }
        }

        console.log('[ChatGPTNote] Chat UI ready');

        // Check for session expired MODAL overlay (not general body text)
        // Wait a moment for any overlays to render
        await new Promise(r => setTimeout(r, 2000));

        const pageState = await page.evaluate(() => {
            const bodyText = document.body.innerText || '';
            // Check for session expired overlay
            if (bodyText.includes('session has expired') && bodyText.includes('log in again')) {
                return 'session_expired';
            }
            // Check for fully logged-out state on Custom GPT pages
            if (bodyText.includes('Sign up for free') && !bodyText.includes('Generating')) {
                return 'logged_out';
            }
            return 'ok';
        });

        if (pageState !== 'ok') {
            console.error(`[ChatGPTNote] ❌ Auth issue detected: ${pageState}`);
            throw new Error(`ChatGPT ${pageState === 'session_expired' ? 'session expired' : 'not logged in'}. Go to Credentials → click "🔄 Auto Refresh" to re-login.`);
        }

        // Upload images if provided
        if (imagePaths && imagePaths.length > 0) {
            console.log(`[ChatGPTNote] Uploading ${imagePaths.length} image(s)...`);

            // ChatGPT has a hidden file input for uploads
            // Find it or create one that triggers the upload
            const fileInput = await page.$('input[type="file"]');

            if (fileInput) {
                // Upload all files at once
                await fileInput.uploadFile(...imagePaths);
                console.log(`[ChatGPTNote] Files uploaded via file input`);

                // Wait for uploads to process (thumbnails to appear)
                await new Promise(r => setTimeout(r, 3000));

                // Wait for upload indicators to complete
                try {
                    await page.waitForFunction(() => {
                        // Check if upload progress indicators are gone
                        const progressBars = document.querySelectorAll('[role="progressbar"]');
                        return progressBars.length === 0;
                    }, { timeout: 30000, polling: 1000 });
                } catch (e) {
                    console.log('[ChatGPTNote] Upload progress wait timed out, continuing...');
                }

                console.log(`[ChatGPTNote] Image uploads complete`);
            } else {
                console.warn('[ChatGPTNote] No file input found on page, skipping image upload');
            }
        }

        // Count existing assistant messages BEFORE sending
        const initialMsgCount = await page.evaluate(() => {
            return document.querySelectorAll('[data-message-author-role="assistant"]').length;
        });
        console.log(`[ChatGPTNote] Existing assistant messages: ${initialMsgCount}`);

        // Type the prompt into the textarea using clipboard paste
        // (ProseMirror editor doesn't reliably register keyboard.type())
        console.log('[ChatGPTNote] Typing prompt via clipboard...');
        await page.click('#prompt-textarea');
        await new Promise(r => setTimeout(r, 500));

        // Use evaluate to insert text directly into the ProseMirror editor
        await page.evaluate((text) => {
            const editor = document.querySelector('#prompt-textarea');
            if (editor) {
                editor.focus();
                // For ProseMirror/contenteditable, use execCommand or input event
                document.execCommand('insertText', false, text);
            }
        }, prompt);

        // Verify text was entered
        await new Promise(r => setTimeout(r, 500));
        const typedText = await page.evaluate(() => {
            const el = document.querySelector('#prompt-textarea');
            return el ? (el.innerText || el.textContent || '').trim() : '';
        });
        console.log(`[ChatGPTNote] Text in editor: "${typedText.substring(0, 50)}..." (${typedText.length} chars)`);

        if (!typedText) {
            // Fallback: try keyboard.type() 
            console.log('[ChatGPTNote] execCommand failed, trying keyboard.type()...');
            await page.click('#prompt-textarea');
            await page.keyboard.type(prompt, { delay: 10 });
            await new Promise(r => setTimeout(r, 500));
        }

        // Send the message
        console.log('[ChatGPTNote] Sending message...');

        // Save debug screenshot before sending
        try {
            await page.screenshot({ path: '/tmp/chatgpt_before_send.png' });
            console.log('[ChatGPTNote] Screenshot saved: /tmp/chatgpt_before_send.png');
        } catch (e) { /* ignore */ }

        // Make sure the textarea is focused
        await page.click('#prompt-textarea');
        await new Promise(r => setTimeout(r, 300));

        // PRIMARY method: Press Enter (works reliably in ChatGPT)
        await page.keyboard.press('Enter');
        console.log('[ChatGPTNote] Pressed Enter to send');

        // Wait and check if message was sent (URL changes for new conversations)
        await new Promise(r => setTimeout(r, 3000));
        let urlAfterSend = page.url();
        console.log(`[ChatGPTNote] URL after Enter: ${urlAfterSend}`);

        // Check if the user message appeared in the conversation
        const userMsgAppeared = await page.evaluate(() => {
            const userMsgs = document.querySelectorAll('[data-message-author-role="user"]');
            return userMsgs.length > 0;
        });
        console.log(`[ChatGPTNote] User message in conversation: ${userMsgAppeared}`);

        // If Enter didn't work, try clicking send button
        if (!userMsgAppeared) {
            console.log('[ChatGPTNote] Enter key failed, trying button click...');

            // Try JavaScript click (more reliable than Puppeteer click)
            const sendResult = await page.evaluate(() => {
                // Try various send button selectors
                const selectors = [
                    '[data-testid="send-button"]',
                    'button[aria-label="Send prompt"]',
                    'button[aria-label="Send"]',
                    'form button[type="submit"]',
                ];

                for (const sel of selectors) {
                    const btn = document.querySelector(sel);
                    if (btn && !btn.disabled) {
                        btn.click();
                        return `clicked:${sel}`;
                    }
                    if (btn && btn.disabled) {
                        return `disabled:${sel}`;
                    }
                }

                // Find send button by its SVG path (the arrow/up icon) 
                const allButtons = document.querySelectorAll('button');
                for (const btn of allButtons) {
                    const svg = btn.querySelector('svg');
                    if (!svg) continue;
                    const paths = svg.querySelectorAll('path');
                    for (const p of paths) {
                        const d = p.getAttribute('d') || '';
                        // ChatGPT send button arrow path signature
                        if (d.includes('M15.192') || d.includes('M7 11L12') || d.includes('arrow') || d.includes('send')) {
                            if (!btn.disabled) {
                                btn.click();
                                return 'clicked:svg-arrow';
                            }
                        }
                    }
                }

                // Last resort: click any enabled button in the composer area
                const composerBtns = document.querySelectorAll('#composer-background button, [class*="composer"] button');
                const btnInfo = [];
                for (const btn of composerBtns) {
                    const label = btn.getAttribute('aria-label') || btn.getAttribute('data-testid') || btn.textContent?.trim() || 'unknown';
                    const hasSvg = !!btn.querySelector('svg');
                    btnInfo.push(`${label}(disabled=${btn.disabled},svg=${hasSvg})`);
                }

                return `no-match. Buttons found: ${btnInfo.join(', ')}`;
            });

            console.log(`[ChatGPTNote] Send attempt result: ${sendResult}`);

            // If send button wasn't clickable, wait for it to become enabled and try again
            if (!sendResult.startsWith('clicked:')) {
                console.log('[ChatGPTNote] Send button not clickable, waiting for it to become enabled...');

                // Wait up to 10 seconds for send button to become enabled
                for (let i = 0; i < 10; i++) {
                    await new Promise(r => setTimeout(r, 1000));

                    const retryResult = await page.evaluate(() => {
                        const btn = document.querySelector('[data-testid="send-button"]');
                        if (btn && !btn.disabled) {
                            btn.click();
                            return 'clicked:send-button-retry';
                        }
                        // Try any non-disabled button with SVG in composer
                        const composerBtns = document.querySelectorAll('#composer-background button:not([disabled])');
                        for (const b of composerBtns) {
                            if (b.querySelector('svg') && !b.getAttribute('aria-label')?.includes('Voice')) {
                                b.click();
                                return 'clicked:composer-btn-retry';
                            }
                        }
                        return null;
                    });

                    if (retryResult) {
                        console.log(`[ChatGPTNote] Retry ${i + 1} result: ${retryResult}`);
                        break;
                    }
                }
            }

            // Final fallback: focus textarea and press Enter
            await new Promise(r => setTimeout(r, 1000));
            const userMsgCheck = await page.evaluate(() => {
                return document.querySelectorAll('[data-message-author-role="user"]').length > 0;
            });

            if (!userMsgCheck) {
                console.log('[ChatGPTNote] Button click failed, trying Enter key...');
                await page.focus('#prompt-textarea');
                await new Promise(r => setTimeout(r, 300));
                await page.keyboard.press('Enter');
                await new Promise(r => setTimeout(r, 3000));
            }
        }

        // Save screenshot after send attempt
        try {
            await page.screenshot({ path: '/tmp/chatgpt_after_send.png' });
            console.log('[ChatGPTNote] Screenshot saved: /tmp/chatgpt_after_send.png');
        } catch (e) { /* ignore */ }

        urlAfterSend = page.url();
        console.log(`[ChatGPTNote] Final URL: ${urlAfterSend}`);

        // Wait for response to start appearing (a NEW assistant message)
        console.log('[ChatGPTNote] Waiting for NEW response...');
        try {
            await page.waitForFunction((prevCount) => {
                const currentCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;
                return currentCount > prevCount;
            }, { timeout: 60000, polling: 1000 }, initialMsgCount);
            console.log('[ChatGPTNote] New assistant message detected!');
        } catch (e) {
            // Maybe the selector is different, try alternative approach
            console.log('[ChatGPTNote] No new assistant message via selector, waiting by time...');
            await new Promise(r => setTimeout(r, 15000));
        }

        // Wait for response to COMPLETE (streaming finishes)
        console.log('[ChatGPTNote] Waiting for completion...');

        // Wait longer for streaming to finish — check for stop button first 
        await new Promise(r => setTimeout(r, 3000));

        await page.waitForFunction(() => {
            // The response is complete when there's no stop/cancel button visible
            const stopBtn = document.querySelector('[data-testid="stop-button"]');
            if (stopBtn && stopBtn.offsetParent !== null) return false;

            const cancelBtn = document.querySelector('button[aria-label="Stop generating"]');
            if (cancelBtn && cancelBtn.offsetParent !== null) return false;

            // Also look for any streaming indicators
            const streaming = document.querySelector('.result-streaming');
            if (streaming) return false;

            return true;
        }, { timeout: 180000, polling: 2000 });

        // Extra wait for DOM to finalize
        await new Promise(r => setTimeout(r, 3000));

        // Extract the response text
        console.log('[ChatGPTNote] Extracting response text...');
        const result = await page.evaluate(() => {
            // Try multiple selector strategies to find the assistant's response

            // Strategy 1: data-message-author-role attribute
            let messages = document.querySelectorAll('[data-message-author-role="assistant"]');

            // Strategy 2: article elements with assistant messages
            if (messages.length === 0) {
                messages = document.querySelectorAll('article[data-testid*="conversation-turn"] .agent-turn');
            }

            // Strategy 3: Generic message containers
            if (messages.length === 0) {
                messages = document.querySelectorAll('.group\\/conversation-turn');
            }

            // Strategy 4: Look for any .markdown or .prose content
            if (messages.length === 0) {
                const markdowns = document.querySelectorAll('.markdown.prose');
                if (markdowns.length > 0) {
                    const lastMd = markdowns[markdowns.length - 1];
                    return { text: (lastMd.innerText || lastMd.textContent || '').trim() };
                }
            }

            // Strategy 5: Broadest — find all conversation turns and get the last non-user one
            if (messages.length === 0) {
                const allTurns = document.querySelectorAll('[data-testid*="conversation-turn"]');
                const assistantTurns = [];
                for (const turn of allTurns) {
                    // Skip user turns
                    if (turn.querySelector('[data-message-author-role="user"]')) continue;
                    assistantTurns.push(turn);
                }
                if (assistantTurns.length > 0) {
                    messages = assistantTurns;
                }
            }

            if (messages.length === 0) {
                // Debug: dump what we can see
                const body = document.body.innerText || '';
                const bodyPreview = body.substring(Math.max(0, body.length - 500));
                return {
                    text: '',
                    error: 'No assistant messages found',
                    debug: `Page text tail: ${bodyPreview}`,
                };
            }

            // Get the LAST assistant message
            const lastMessage = messages[messages.length - 1];

            // Try extractors in order of preference
            const markdownBody = lastMessage.querySelector('.markdown') || lastMessage.querySelector('.prose');
            let text = '';

            if (markdownBody) {
                text = markdownBody.innerText || markdownBody.textContent || '';
            } else {
                text = lastMessage.innerText || lastMessage.textContent || '';
            }

            return { text: text.trim() };
        });

        // Log debug info if extraction failed
        if (result.debug) {
            console.log('[ChatGPTNote] Debug:', result.debug);
        }

        return result;

    } finally {
        await browser.close();
        console.log('[ChatGPTNote] Browser closed');
    }
}


// ─────────────────────────────────────────────────────────
//  ChatGPTNoteConnector
// ─────────────────────────────────────────────────────────

export class ChatGPTNoteConnector extends BaseConnector {
    static get metadata() {
        return {
            name: 'ChatGPT Note',
            description: 'Send messages to ChatGPT via headless browser (auto-handles all security). Runs invisibly.',
            icon: '💬',
            category: 'ai',
            configSchema: {
                prompt: {
                    type: 'textarea',
                    label: 'Prompt',
                    description: 'Message to send. Use {{nodeId.field}} for dynamic values.',
                    required: true,
                },
                model: {
                    type: 'select',
                    label: 'Model',
                    options: [
                        { label: 'GPT-5.3', value: 'gpt-5-3' },
                        { label: 'GPT-4o', value: 'gpt-4o' },
                        { label: 'o3', value: 'o3' },
                        { label: 'o4-mini', value: 'o4-mini' },
                        { label: 'GPT-4o Mini', value: 'gpt-4o-mini' },
                    ],
                    default: 'gpt-5-3',
                },
                customGptId: {
                    type: 'text',
                    label: 'Custom GPT ID',
                    description: 'Full Custom GPT ID from URL (e.g. g-69aad283a8b...). Leave empty for default.',
                },
                credentialId: {
                    type: 'credential',
                    label: 'ChatGPT Credential',
                    provider: 'chatgpt',
                    required: true,
                },
            },
        };
    }

    async execute(input, credentials, config) {
        if (!credentials?.token) {
            throw new Error('ChatGPT credentials required.');
        }

        const cookies = credentials.metadata?.cookies || '';
        if (!cookies) {
            throw new Error('Browser cookies required for ChatGPT. Go to Credentials → ChatGPT → paste cookies from DevTools.');
        }

        const prompt = config.prompt || input.text || '';
        if (!prompt) throw new Error('Prompt is required.');

        const model = config.model || 'gpt-5-3';
        const customGptId = config.customGptId || null;

        console.log('[ChatGPTNote] === Execution (UI Automation) ===');
        console.log('[ChatGPTNote] Model:', model, '| CustomGPT:', customGptId || '(default)');
        console.log('[ChatGPTNote] Prompt:', prompt.substring(0, 80) + (prompt.length > 80 ? '...' : ''));

        // Resolve image paths from upstream nodes
        const imagePaths = resolveImagePaths(input);
        if (imagePaths.length > 0) {
            console.log(`[ChatGPTNote] ${imagePaths.length} image(s) to upload`);
        }

        const result = await executeViaUI(cookies, {
            prompt, model, customGptId, imagePaths,
        });

        if (result.error) {
            throw new Error(result.error);
        }

        const responseText = result.text || '';
        console.log('[ChatGPTNote] ✅ Response:', responseText.length, 'chars');
        console.log('[ChatGPTNote]   Preview:', responseText.substring(0, 100) + (responseText.length > 100 ? '...' : ''));

        return {
            text: responseText,
            prompt,
            model,
        };
    }

    async testConnection(credentials) {
        return !!credentials?.token && !!credentials?.metadata?.cookies;
    }
}
