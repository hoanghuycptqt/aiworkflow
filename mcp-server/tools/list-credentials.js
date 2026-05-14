/**
 * Tool: list_google_flow_credentials
 * Shows the configured Google Flow credential from .env
 */

import { getCredentialSummary } from '../lib/db.js';

export const name = 'list_google_flow_credentials';
export const description = 'Show the configured Google Flow credential status. Checks if token, session cookies, and project ID are set in the .env file.';
export const schema = {};

export async function handler() {
    const cred = getCredentialSummary();

    const lines = [
        `**${cred.label}**`,
        `  - Email: ${cred.email}`,
        `  - Project ID: \`${cred.projectId}\``,
        `  - Token: ${cred.hasToken ? '✅ Set' : '❌ NOT SET'}`,
        `  - Session Cookies: ${cred.hasSessionCookies ? '✅ Set' : '❌ NOT SET'}`,
    ];

    if (!cred.hasToken) {
        lines.push('', '⚠️ Please set GOOGLE_FLOW_TOKEN in `mcp-server/.env` to use the tools.');
    }

    return {
        content: [{ type: 'text', text: lines.join('\n') }],
    };
}
