/**
 * Credential Provider — Reads Google Flow credentials from .env file
 * No database dependency. Just set the env vars and go.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env manually to avoid ANY stdout output (dotenv prints to stdout which breaks MCP protocol)
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');
try {
    const envContent = readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = value; // don't override existing
    }
} catch { /* .env not found, rely on existing env vars */ }

/**
 * Get the Google Flow credential from environment variables.
 * Returns an object matching the shape the tools expect.
 */
export function getCredential() {
    const token = process.env.GOOGLE_FLOW_TOKEN;
    const sessionCookies = process.env.GOOGLE_FLOW_SESSION_COOKIES;
    const projectId = process.env.GOOGLE_FLOW_PROJECT_ID;
    const email = process.env.GOOGLE_FLOW_EMAIL;

    if (!token) {
        console.error('[DB] ⚠️ GOOGLE_FLOW_TOKEN is empty — will rely on Chrome profile auth');
    }

    return {
        id: 'env-credential',
        label: email || 'Google Flow (from .env)',
        token,
        metadata: {
            sessionCookies: sessionCookies || '',
            projectId: projectId || '',
            userEmail: email || '',
        },
    };
}

/**
 * Get credential summary for listing.
 */
export function getCredentialSummary() {
    try {
        const cred = getCredential();
        return {
            id: cred.id,
            label: cred.label,
            email: cred.metadata.userEmail || 'not set',
            projectId: cred.metadata.projectId || 'not set',
            hasToken: !!cred.token,
            hasSessionCookies: !!cred.metadata.sessionCookies,
        };
    } catch {
        return {
            id: 'env-credential',
            label: 'NOT CONFIGURED',
            email: 'not set',
            projectId: 'not set',
            hasToken: false,
            hasSessionCookies: false,
        };
    }
}
