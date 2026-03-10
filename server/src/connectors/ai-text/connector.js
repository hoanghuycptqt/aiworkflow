/**
 * AI Text Connector — Multi-provider AI text generation
 * 
 * Routes to the correct API based on the credential's provider:
 * - 'openrouter' → OpenRouter API (OpenAI-compatible)
 * - 'gemini'     → Google Gemini REST API
 * 
 * This connector powers the generic "AI Text" node which can use
 * any supported credential provider.
 */

import { BaseConnector } from '../base-connector.js';

// ─── Model Lists ─────────────────────────────────────────
const OPENROUTER_MODELS = [
    'nvidia/nemotron-nano-12b-v2-vl:free',
    'mistralai/mistral-small-3.1-24b-instruct:free',
    'google/gemma-3-27b-it:free',
    'google/gemma-3-12b-it:free',
    'nvidia/nemotron-nano-9b-v2:free',
    'qwen/qwen3-4b:free',
    'meta-llama/llama-3.2-3b-instruct:free',
];

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class AITextConnector extends BaseConnector {
    static get metadata() {
        return {
            name: 'AI Text',
            description: 'AI text generation & image analysis (OpenRouter + Google Gemini)',
            icon: '🔀',
            category: 'ai',
            configSchema: {
                prompt: {
                    type: 'textarea',
                    label: 'Prompt',
                    description: 'Message to send. Use {{nodeId.field}} to reference outputs from previous nodes.',
                    required: true,
                },
                systemInstruction: {
                    type: 'textarea',
                    label: 'System Instruction',
                    description: 'Custom instructions for the AI.',
                },
                model: {
                    type: 'select',
                    label: 'Model',
                    options: [],
                    default: '',
                },
                temperature: {
                    type: 'number',
                    label: 'Temperature',
                    default: 0.7,
                    min: 0,
                    max: 2,
                },
                includeImage: {
                    type: 'boolean',
                    label: 'Include Image from Previous Node',
                    default: false,
                },
            },
        };
    }

    async execute(input, credentials, config) {
        if (!credentials?.token) {
            throw new Error('API key required. Add a credential in the Credentials page.');
        }

        const provider = credentials.provider;
        console.log(`[AI-Text] Provider: ${provider}`);

        if (provider === 'gemini') {
            return this._executeGemini(input, credentials, config);
        }
        // Default: OpenRouter
        return this._executeOpenRouter(input, credentials, config);
    }

    // ─── OpenRouter Provider ─────────────────────────────────
    async _executeOpenRouter(input, credentials, config) {
        const apiKey = credentials.token;
        const prompt = config.prompt || '';
        const selectedModel = config.model || OPENROUTER_MODELS[0];
        const systemInstruction = config.systemInstruction || '';
        const temperature = parseFloat(config.temperature) || 0.7;
        const includeImage = config.includeImage || false;

        console.log('[AI-Text/OpenRouter] Model:', selectedModel);
        console.log('[AI-Text/OpenRouter] Prompt:', prompt.substring(0, 80) + '...');

        const messages = [];
        if (systemInstruction) {
            messages.push({ role: 'system', content: systemInstruction });
        }

        const userContent = [];
        if (includeImage && input.images && input.images.length > 0) {
            for (const img of input.images) {
                if (img.imageData) {
                    userContent.push({
                        type: 'image_url',
                        image_url: {
                            url: `data:${img.imageMimeType || 'image/jpeg'};base64,${img.imageData}`,
                        },
                    });
                } else if (img.imageUrl) {
                    userContent.push({
                        type: 'image_url',
                        image_url: { url: img.imageUrl },
                    });
                }
            }
        } else if (includeImage && input.imageData) {
            userContent.push({
                type: 'image_url',
                image_url: {
                    url: `data:${input.imageMimeType || 'image/jpeg'};base64,${input.imageData}`,
                },
            });
        } else if (includeImage && input.imageUrl) {
            userContent.push({
                type: 'image_url',
                image_url: { url: input.imageUrl },
            });
        }
        userContent.push({ type: 'text', text: prompt });

        messages.push({
            role: 'user',
            content: userContent.length === 1 ? prompt : userContent,
        });

        // Try selected model, then fallbacks
        const modelsToTry = [selectedModel, ...OPENROUTER_MODELS.filter(m => m !== selectedModel)];
        let lastError = '';

        for (const model of modelsToTry) {
            try {
                console.log(`[AI-Text/OpenRouter] 📤 Trying: ${model}...`);
                const result = await this._callOpenRouter(apiKey, model, messages, temperature);
                console.log(`[AI-Text/OpenRouter] ✅ Success! Length: ${result.length}`);
                return { text: result, prompt, model, usage: null };
            } catch (err) {
                lastError = err.message;
                console.log(`[AI-Text/OpenRouter] ⚠️ ${model} failed: ${err.message.substring(0, 100)}`);

                if (err.retryable && err.message.includes('rate-limited') && !err._retried) {
                    await new Promise(r => setTimeout(r, 2000));
                    try {
                        const result = await this._callOpenRouter(apiKey, model, messages, temperature);
                        return { text: result, prompt, model, usage: null };
                    } catch (retryErr) {
                        lastError = retryErr.message;
                    }
                }

                if (err.message.includes('not enabled') && messages[0]?.role === 'system') {
                    const fallbackMessages = messages.slice(1);
                    if (fallbackMessages[0]?.role === 'user') {
                        const sysContent = messages[0].content;
                        if (typeof fallbackMessages[0].content === 'string') {
                            fallbackMessages[0] = { ...fallbackMessages[0], content: `[Instructions: ${sysContent}]\n\n${fallbackMessages[0].content}` };
                        }
                    }
                    try {
                        const result = await this._callOpenRouter(apiKey, model, fallbackMessages, temperature);
                        return { text: result, prompt, model, usage: null };
                    } catch (retryErr) {
                        lastError = retryErr.message;
                    }
                }

                if (err.retryable) continue;
                throw err;
            }
        }

        throw new Error(`All models failed. Last error: ${lastError}`);
    }

    async _callOpenRouter(apiKey, model, messages, temperature) {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'http://localhost:5173',
                'X-Title': 'Video Creator Workflow',
            },
            body: JSON.stringify({ model, messages, temperature, max_tokens: 8192 }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            if (response.status === 401) {
                const err = new Error('Invalid API key. Get a free key at https://openrouter.ai/keys');
                err.retryable = false;
                throw err;
            }
            if (response.status === 402) {
                const err = new Error('Insufficient credits. Use free models with ":free" suffix.');
                err.retryable = false;
                throw err;
            }
            if (response.status === 429 || response.status === 503) {
                const err = new Error(`${model} rate-limited or unavailable`);
                err.retryable = true;
                throw err;
            }
            if (response.status === 404) {
                const err = new Error(`${model} not found`);
                err.retryable = true;
                throw err;
            }
            const err = new Error(`API error (${response.status}): ${errorText.substring(0, 200)}`);
            err.retryable = (response.status === 400);
            throw err;
        }

        const data = await response.json();
        const text = data.choices?.[0]?.message?.content || '';
        if (!text) {
            const err = new Error('Empty response');
            err.retryable = true;
            throw err;
        }
        return text;
    }

    // ─── Gemini Provider ─────────────────────────────────────
    async _executeGemini(input, credentials, config) {
        const apiKey = credentials.token;
        const prompt = config.prompt || '';
        const model = config.model || 'gemini-3-flash-preview';
        const systemInstruction = config.systemInstruction || '';
        const temperature = parseFloat(config.temperature ?? 1.0);
        const includeImage = config.includeImage || false;

        console.log('[AI-Text/Gemini] Model:', model);
        console.log('[AI-Text/Gemini] Prompt:', prompt.substring(0, 80) + '...');

        const parts = [];

        // Add images
        if (includeImage && input.images && input.images.length > 0) {
            for (const img of input.images) {
                if (img.imageData) {
                    parts.push({
                        inlineData: {
                            mimeType: img.imageMimeType || 'image/jpeg',
                            data: img.imageData,
                        },
                    });
                }
            }
        } else if (includeImage && input.imageData) {
            parts.push({
                inlineData: {
                    mimeType: input.imageMimeType || 'image/jpeg',
                    data: input.imageData,
                },
            });
        }

        parts.push({ text: prompt });

        const body = {
            contents: [{ parts }],
            generationConfig: { temperature, maxOutputTokens: 8192 },
        };

        if (systemInstruction) {
            body.systemInstruction = { parts: [{ text: systemInstruction }] };
        }

        const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`;
        console.log(`[AI-Text/Gemini] 📤 Calling ${model}...`);

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            if (response.status === 401 || response.status === 403) {
                throw new Error('Invalid Gemini API key. Get a key at https://aistudio.google.com/apikey');
            }
            if (response.status === 429) {
                throw new Error(`Rate limited on ${model}. Please wait and try again.`);
            }
            if (response.status === 400) {
                let detail = '';
                try { detail = JSON.parse(errorText).error?.message || errorText; } catch { detail = errorText; }
                throw new Error(`Bad request: ${detail.substring(0, 300)}`);
            }
            throw new Error(`Gemini API error (${response.status}): ${errorText.substring(0, 300)}`);
        }

        const data = await response.json();
        const candidates = data.candidates;

        if (!candidates || candidates.length === 0) {
            const blockReason = data.promptFeedback?.blockReason;
            if (blockReason) throw new Error(`Prompt blocked: ${blockReason}`);
            throw new Error('No response generated.');
        }

        const text = candidates[0]?.content?.parts
            ?.filter(p => p.text)
            .map(p => p.text)
            .join('') || '';

        if (!text) {
            const finishReason = candidates[0]?.finishReason;
            if (finishReason === 'SAFETY') throw new Error('Response blocked by safety filter.');
            throw new Error('Empty response from Gemini.');
        }

        console.log(`[AI-Text/Gemini] ✅ Success! Length: ${text.length}`);
        return { text, prompt, model, usage: data.usageMetadata || null };
    }

    async testConnection(credentials) {
        try {
            if (credentials.provider === 'gemini') {
                const resp = await fetch(`${GEMINI_API_BASE}/models?key=${credentials.token}`);
                return resp.ok;
            }
            const resp = await fetch('https://openrouter.ai/api/v1/models', {
                headers: { 'Authorization': `Bearer ${credentials.token}` },
            });
            return resp.ok;
        } catch {
            return false;
        }
    }
}
