/**
 * Credential Sync — Sync cookies/token across sibling credentials
 *
 * When multiple users share the same Google account, their google-flow
 * credentials must stay in sync. After any successful token/cookie refresh,
 * this utility propagates the fresh data to all sibling credentials.
 *
 * "Sibling" = another google-flow credential with the same userEmail in metadata.
 */

import { prisma } from '../index.js';

/**
 * Sync fresh token + cookies to all sibling google-flow credentials
 * sharing the same Google account (identified by userEmail in metadata).
 *
 * @param {string} refreshedCredentialId - The credential that was just refreshed
 * @param {string} freshToken - The new access_token
 * @param {object} freshMetadata - The updated metadata (must contain userEmail, sessionCookies, etc.)
 * @returns {number} Number of siblings updated
 */
export async function syncSiblingCredentials(refreshedCredentialId, freshToken, freshMetadata) {
    try {
        const userEmail = freshMetadata?.userEmail;
        if (!userEmail) return 0;

        // Find all google-flow credentials except the one just refreshed
        const allGoogleFlow = await prisma.credential.findMany({
            where: { provider: 'google-flow', id: { not: refreshedCredentialId } },
            select: { id: true, metadata: true },
        });

        // Filter siblings by same userEmail
        const siblings = allGoogleFlow.filter(c => {
            try {
                const meta = JSON.parse(c.metadata || '{}');
                return meta.userEmail?.toLowerCase() === userEmail.toLowerCase();
            } catch { return false; }
        });

        if (siblings.length === 0) return 0;

        // Update all siblings with fresh token + cookies
        for (const sibling of siblings) {
            const siblingMeta = JSON.parse(sibling.metadata || '{}');
            const updatedMeta = {
                ...siblingMeta,
                sessionCookies: freshMetadata.sessionCookies,
                lastRefreshed: freshMetadata.lastRefreshed,
                tokenExpiresAt: freshMetadata.tokenExpiresAt,
                // Keep sibling's own userName/userEmail — don't overwrite
            };

            await prisma.credential.update({
                where: { id: sibling.id },
                data: {
                    token: freshToken,
                    metadata: JSON.stringify(updatedMeta),
                },
            });
        }

        console.log(`[CredSync] ✅ Synced ${siblings.length} sibling(s) for ${userEmail}`);
        return siblings.length;

    } catch (e) {
        // Non-fatal — log and continue
        console.warn(`[CredSync] Sync failed (non-fatal): ${e.message}`);
        return 0;
    }
}
