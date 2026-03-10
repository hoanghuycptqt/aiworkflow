/**
 * Google Gemini Connector — Direct Gemini API (REST)
 * 
 * Uses Google's Generative Language REST API directly.
 * Supports text generation, system instructions, and image input.
 * 
 * Get API key at: https://aistudio.google.com/apikey
 */

import { BaseConnector } from '../base-connector.js';

const GEMINI_MODELS = [
    'gemini-2.5-flash',
    'gemini-3-pro-preview',
];

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiConnector extends BaseConnector {
    static get metadata() {
        return {
            name: 'Google Gemini',
            description: 'AI text generation & image analysis via Google Gemini API (official)',
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
                    description: 'Custom instructions for the AI.',
                },
                model: {
                    type: 'select',
                    label: 'Model',
                    options: GEMINI_MODELS,
                    default: GEMINI_MODELS[0],
                },
                temperature: {
                    type: 'number',
                    label: 'Temperature',
                    description: 'Gemini 3 models recommend 1.0. Lower values may cause unexpected behavior.',
                    default: 1.0,
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
                'Gemini API key required.\n' +
                'Get your key at: https://aistudio.google.com/apikey\n' +
                'Then add it in Credentials page.'
            );
        }

        const apiKey = credentials.token;
        const prompt = config.prompt || '';
        const model = config.model || GEMINI_MODELS[0];
        const systemInstruction = config.systemInstruction || '';
        const temperature = parseFloat(config.temperature ?? 1.0);
        const includeImage = config.includeImage || false;

        console.log('[Gemini] === Starting execution ===');
        console.log('[Gemini] Model:', model);
        console.log('[Gemini] Prompt:', prompt.substring(0, 80) + '...');

        // Build parts array for the user content
        const parts = [];

        // Add images if requested
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
            console.log(`[Gemini] Including ${parts.length} image(s) in prompt`);
        } else if (includeImage && input.imageData) {
            // Legacy single image
            parts.push({
                inlineData: {
                    mimeType: input.imageMimeType || 'image/jpeg',
                    data: input.imageData,
                },
            });
        }

        // Add the text prompt
        parts.push({ text: prompt });

        // Build request body
        const body = {
            contents: [{ parts }],
            generationConfig: {
                temperature,
                maxOutputTokens: 8192,
            },
        };

        // Add system instruction if provided
        if (systemInstruction) {
            body.systemInstruction = {
                parts: [{ text: systemInstruction }],
            };
        }

        const url = `${API_BASE}/models/${model}:generateContent`;
        console.log(`[Gemini] 📤 Calling ${model}...`);

        // Timeout after 30s (Gemini API may be geo-blocked in some regions)
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        let response;
        try {
            response = await fetch(`${url}?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        } catch (fetchErr) {
            clearTimeout(timeout);
            if (fetchErr.name === 'AbortError') {
                throw new Error(
                    'Gemini API request timed out (30s). ' +
                    'This may be due to geo-blocking — Google Gemini API is not available in all regions. ' +
                    'Try using a VPN, or switch to OpenRouter provider.'
                );
            }
            throw new Error(`Network error calling Gemini API: ${fetchErr.message}`);
        }
        clearTimeout(timeout);

        if (!response.ok) {
            const errorText = await response.text();

            if (response.status === 400) {
                let detail = '';
                try { detail = JSON.parse(errorText).error?.message || errorText; } catch { detail = errorText; }
                throw new Error(`Bad request: ${detail.substring(0, 300)}`);
            }
            if (response.status === 401 || response.status === 403) {
                throw new Error('Invalid API key. Get a key at https://aistudio.google.com/apikey');
            }
            if (response.status === 429) {
                throw new Error(`Rate limited. Please wait and try again. (${model})`);
            }
            if (response.status === 503) {
                throw new Error(`Model ${model} temporarily unavailable. Try again in a moment.`);
            }
            throw new Error(`Gemini API error (${response.status}): ${errorText.substring(0, 300)}`);
        }

        const data = await response.json();

        // Extract text from response
        const candidates = data.candidates;
        if (!candidates || candidates.length === 0) {
            const blockReason = data.promptFeedback?.blockReason;
            if (blockReason) {
                throw new Error(`Prompt blocked by safety filter: ${blockReason}`);
            }
            throw new Error('No response generated. The prompt may have been filtered.');
        }

        const text = candidates[0]?.content?.parts
            ?.filter(p => p.text)
            .map(p => p.text)
            .join('') || '';

        if (!text) {
            const finishReason = candidates[0]?.finishReason;
            if (finishReason === 'SAFETY') {
                throw new Error('Response blocked by safety filter.');
            }
            throw new Error('Empty response from Gemini.');
        }

        console.log(`[Gemini] ✅ Success! Response length: ${text.length}`);

        return {
            text,
            prompt,
            model,
            usage: data.usageMetadata || null,
        };
    }

    async testConnection(credentials) {
        try {
            const controller = new AbortController();
            const tout = setTimeout(() => controller.abort(), 10000);
            const resp = await fetch(
                `${API_BASE}/models?key=${credentials.token}`,
                { signal: controller.signal },
            );
            clearTimeout(tout);
            return resp.ok;
        } catch {
            return false;
        }
    }
}
