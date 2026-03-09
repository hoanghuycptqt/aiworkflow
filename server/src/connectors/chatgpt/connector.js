/**
 * ChatGPT Connector — Chrome Extension Bridge
 * 
 * Uses the VCW ChatGPT Bridge Chrome Extension to make API calls.
 * 
 * Flow:
 * 1. Connector creates a bridge request with the prompt and tokens
 * 2. Server queues the request
 * 3. Chrome Extension picks up the request (via polling)
 * 4. Extension injects code into chatgpt.com page (main world)
 * 5. Code makes API call with page cookies (bypasses Cloudflare!)
 * 6. Extension posts result back to server
 * 7. Connector receives the result
 * 
 * Requirements:
 * - VCW ChatGPT Bridge extension installed in Chrome
 * - User logged into chatgpt.com in Chrome
 * - A chatgpt.com tab open (extension creates one if needed)
 */

import { BaseConnector } from '../base-connector.js';
import { createBridgeRequest } from '../../routes/bridge.routes.js';

export class ChatGPTConnector extends BaseConnector {
    static get metadata() {
        return {
            name: 'ChatGPT',
            description: 'Send messages to ChatGPT (including Custom GPTs) via Chrome Extension Bridge',
            icon: '🤖',
            category: 'ai',
            configSchema: {
                prompt: {
                    type: 'textarea',
                    label: 'Prompt',
                    description: 'Message to send. Use {{nodeId.field}} to reference outputs from previous nodes.',
                    required: true,
                },
                gptModelSlug: {
                    type: 'text',
                    label: 'Model',
                    description: 'Model slug (e.g., gpt-5.3, gpt-4o)',
                    default: 'gpt-5.3',
                },
                customGptId: {
                    type: 'text',
                    label: 'Custom GPT ID',
                    description: 'ID of your Custom GPT (from URL). Leave empty for default ChatGPT.',
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
            throw new Error('ChatGPT credentials required. Go to Credentials page and add your session data.');
        }

        const accessToken = credentials.token;
        const prompt = config.prompt || '';
        const modelSlug = config.gptModelSlug || 'gpt-5.3';
        const customGptId = config.customGptId || null;

        console.log('[ChatGPT] === Starting execution (Extension Bridge) ===');
        console.log('[ChatGPT] Model:', modelSlug);
        console.log('[ChatGPT] Prompt:', prompt.substring(0, 80) + '...');

        // Build conversation body
        const body = {
            action: 'next',
            messages: [{
                id: generateUUID(),
                author: { role: 'user' },
                content: { content_type: 'text', parts: [prompt] },
                metadata: {},
            }],
            parent_message_id: generateUUID(),
            model: modelSlug,
            timezone_offset_min: -420,
            suggestions: [],
            history_and_training_disabled: false,
            conversation_mode: customGptId
                ? { kind: 'gizmo_interaction', gizmo_id: customGptId }
                : { kind: 'primary_assistant' },
            force_paragen: false,
            force_paragen_model_slug: '',
            force_nulligen: false,
            force_rate_limit: false,
            reset_rate_limits: false,
            websocket_request_id: generateUUID(),
        };

        // Send request through bridge and wait for extension to process it
        console.log('[ChatGPT] 📤 Sending request to Chrome Extension Bridge...');

        const result = await createBridgeRequest({
            accessToken,
            body,
            customGptId,
        });

        if (result.error) {
            throw new Error(result.error);
        }

        console.log('[ChatGPT] ✅ Response received! Length:', (result.text || '').length);

        return {
            text: result.text || '',
            prompt,
            model: modelSlug,
        };
    }

    async testConnection(credentials) {
        return !!credentials?.token;
    }
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
