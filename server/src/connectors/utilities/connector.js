/**
 * Utility Connectors — Delay, Text Template, etc.
 */

import { BaseConnector } from '../base-connector.js';

export class DelayConnector extends BaseConnector {
    static get metadata() {
        return {
            name: 'Delay',
            description: 'Wait for a specified duration before continuing',
            icon: '⏱️',
            category: 'utility',
            configSchema: {
                seconds: {
                    type: 'number',
                    label: 'Delay (seconds)',
                    description: 'Number of seconds to wait',
                    default: 5,
                    min: 1,
                    max: 3600,
                },
            },
        };
    }

    async execute(input, credentials, config) {
        const seconds = Math.min(Math.max(config.seconds || 5, 1), 3600);
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        return { ...input, delayed: true, delaySeconds: seconds };
    }
}

export class TextTemplateConnector extends BaseConnector {
    static get metadata() {
        return {
            name: 'Text Template',
            description: 'Create or transform text using templates with variable substitution',
            icon: '📝',
            category: 'utility',
            configSchema: {
                template: {
                    type: 'textarea',
                    label: 'Template',
                    description: 'Text template. Use {{nodeId.field}} to insert values from previous nodes.',
                    required: true,
                },
                outputField: {
                    type: 'text',
                    label: 'Output Field Name',
                    description: 'Name of the output field (default: "text")',
                    default: 'text',
                },
            },
        };
    }

    async execute(input, credentials, config) {
        const template = config.template || '';
        const outputField = config.outputField || 'text';

        // Template variables are already resolved by the workflow engine
        return {
            ...input,
            [outputField]: template,
        };
    }
}
