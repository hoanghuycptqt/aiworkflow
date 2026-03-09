/**
 * AI Connector — OpenRouter with automatic model fallback
 * 
 * Uses OpenRouter's API (OpenAI-compatible format).
 * If the selected model is rate-limited or unavailable,
 * automatically tries other free models.
 * 
 * Get free API key at: https://openrouter.ai/keys
 */

import { BaseConnector } from '../base-connector.js';

// Free models verified working on OpenRouter (tested live with curl)
// Vision models (support image input) listed first
const FREE_MODELS = [
    'nvidia/nemotron-nano-12b-v2-vl:free',       // ✅ Vision + text, confirmed working
    'mistralai/mistral-small-3.1-24b-instruct:free', // ✅ Vision + text, sometimes rate-limited
    'google/gemma-3-27b-it:free',                // ✅ Vision + text, sometimes rate-limited  
    'google/gemma-3-12b-it:free',                // ✅ Vision + text
    'nvidia/nemotron-nano-9b-v2:free',           // Text only
    'qwen/qwen3-4b:free',                       // Text only
    'meta-llama/llama-3.2-3b-instruct:free',     // Text only
];

export class GeminiConnector extends BaseConnector {
    static get metadata() {
        return {
            name: 'Google Gemini',
            description: 'AI text generation and image analysis (via OpenRouter, auto-fallback)',
            icon: '✨',
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
                    description: 'Custom instructions for the AI (like Custom GPT instructions).',
                },
                model: {
                    type: 'select',
                    label: 'Model',
                    options: FREE_MODELS,
                    default: FREE_MODELS[0],
                },
                temperature: {
                    type: 'number',
                    label: 'Temperature',
                    description: 'Creativity level (0 = focused, 1 = creative, 2 = very creative)',
                    default: 0.7,
                    min: 0,
                    max: 2,
                },
                includeImage: {
                    type: 'boolean',
                    label: 'Include Image from Previous Node',
                    description: 'If enabled, sends image data from connected upstream node for analysis',
                    default: false,
                },
            },
        };
    }

    async execute(input, credentials, config) {
        if (!credentials?.token) {
            throw new Error(
                'API key required.\n' +
                'Get your free key at: https://openrouter.ai/keys\n' +
                'Then add it in Credentials page.'
            );
        }

        const apiKey = credentials.token;
        const prompt = config.prompt || '';
        const selectedModel = config.model || FREE_MODELS[0];
        const systemInstruction = config.systemInstruction || '';
        const temperature = parseFloat(config.temperature) || 0.7;
        const includeImage = config.includeImage || false;

        console.log('[AI] === Starting execution ===');
        console.log('[AI] Preferred model:', selectedModel);
        console.log('[AI] Prompt:', prompt.substring(0, 80) + '...');
        console.log(`[AI] input.images: ${input.images ? input.images.length : 0} image(s), includeImage: ${includeImage}`);

        // Build messages array (OpenAI format)
        const messages = [];

        // Add system instruction as system message
        if (systemInstruction) {
            messages.push({ role: 'system', content: systemInstruction });
        }

        const userContent = [];
        if (includeImage && input.images && input.images.length > 0) {
            // Multi-image support: send all images
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
            console.log(`[AI] Including ${userContent.length} image(s) in prompt`);
        } else if (includeImage && input.imageData) {
            // Legacy single image
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

        // Build ordered model list: selected first, then fallbacks
        const modelsToTry = [selectedModel, ...FREE_MODELS.filter(m => m !== selectedModel)];

        // Try each model until one works
        let lastError = '';
        for (const model of modelsToTry) {
            try {
                console.log(`[AI] 📤 Trying model: ${model}...`);
                const result = await this._callOpenRouter(apiKey, model, messages, temperature);
                console.log(`[AI] ✅ Success with ${model}! Response length: ${result.length}`);
                return {
                    text: result,
                    prompt,
                    model,
                    usage: null,
                };
            } catch (err) {
                lastError = err.message;
                console.log(`[AI] ⚠️ ${model} failed: ${err.message.substring(0, 100)}`);

                // If rate-limited, wait 2s and retry same model once
                if (err.retryable && err.message.includes('rate-limited') && !err._retried) {
                    console.log(`[AI] ⏳ Rate-limited, waiting 2s and retrying ${model}...`);
                    await new Promise(r => setTimeout(r, 2000));
                    try {
                        const result = await this._callOpenRouter(apiKey, model, messages, temperature);
                        console.log(`[AI] ✅ Retry success with ${model}! Response length: ${result.length}`);
                        return { text: result, prompt, model, usage: null };
                    } catch (retryErr) {
                        console.log(`[AI] ⚠️ Retry also failed: ${retryErr.message.substring(0, 60)}`);
                        lastError = retryErr.message;
                    }
                }

                // If model doesn't support system instructions, retry without system message
                if (err.message.includes('not enabled') && messages[0]?.role === 'system') {
                    console.log(`[AI] 🔄 Retrying ${model} without system instruction...`);
                    const sysContent = messages[0].content;
                    const fallbackMessages = messages.slice(1);
                    // Prepend system instruction to user message
                    if (fallbackMessages[0]?.role === 'user') {
                        const userMsg = fallbackMessages[0];
                        if (typeof userMsg.content === 'string') {
                            fallbackMessages[0] = { ...userMsg, content: `[Instructions: ${sysContent}]\n\n${userMsg.content}` };
                        }
                    }
                    try {
                        const result = await this._callOpenRouter(apiKey, model, fallbackMessages, temperature);
                        console.log(`[AI] ✅ Success with ${model} (no system)! Response length: ${result.length}`);
                        return { text: result, prompt, model, usage: null };
                    } catch (retryErr) {
                        lastError = retryErr.message;
                    }
                }

                // Only retry next model on rate limit / unavailable errors
                if (err.retryable) {
                    continue;
                }
                // Non-retryable error (auth, bad request, etc.) — throw immediately
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
            body: JSON.stringify({
                model,
                messages,
                temperature,
                max_tokens: 8192,
            }),
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

            // For 400 errors, check if it's a model-specific issue (retryable) vs. bad request (not retryable)
            const err = new Error(`API error (${response.status}): ${errorText.substring(0, 200)}`);
            err.retryable = (response.status === 400); // 400 = likely model-specific, try another
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

    async testConnection(credentials) {
        try {
            const resp = await fetch('https://openrouter.ai/api/v1/models', {
                headers: { 'Authorization': `Bearer ${credentials.token}` },
            });
            return resp.ok;
        } catch {
            return false;
        }
    }
}
