/**
 * Google Flow NextAuth session-API client (leaf module).
 *
 * Depends on nothing but global fetch, so BOTH the connector hot path
 * (connector.js `ensureFreshToken`) and the login agent / cookie harvester
 * can share ONE implementation. This gives a single source of truth for the
 * ACCESS_TOKEN_REFRESH_NEEDED ground-truth classification (no drift between
 * parallel inline /session parsers) AND avoids a circular import — previously
 * google-login-agent.js imported from connector.js while connector.js needed
 * getAccessToken from google-login-agent.js.
 */

/**
 * Call the session API to get a fresh access token using cookies.
 */
export async function getAccessToken(cookieString) {
    const res = await fetch('https://labs.google/fx/api/auth/session', {
        method: 'GET',
        headers: {
            'Accept': '*/*',
            'Content-Type': 'application/json',
            'Cookie': cookieString,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
            'Referer': 'https://labs.google/fx/vi/tools/flow/',
        },
    });

    if (!res.ok) {
        throw new Error(`Session API returned ${res.status}`);
    }

    const data = await res.json();
    // Ground-truth dead-session signal: NextAuth returns this on every
    // /api/auth/session call once the upstream Google OAuth refresh token
    // is revoked/expired (account suspended, password change, security
    // event, refresh-token expiry). The `access_token` field is still
    // present alongside this error but the token itself is dead, and
    // `expires` freezes at the last valid timestamp — refreshing forever
    // can't recover. Caller must escalate to a fresh OAuth signin.
    // Observed 2026-05-24 02:00Z, account minababy17012004@gmail.com.
    if (data.error === 'ACCESS_TOKEN_REFRESH_NEEDED') {
        throw new Error('ACCESS_TOKEN_REFRESH_NEEDED — Google OAuth refresh token revoked, needs re-login');
    }
    if (!data.access_token) {
        throw new Error('No access_token in session response');
    }

    return {
        accessToken: data.access_token,
        expiresAt: data.expires || null,
        userName: data.user?.name,
        userEmail: data.user?.email,
    };
}
