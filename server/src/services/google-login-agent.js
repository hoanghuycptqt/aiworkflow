/**
 * Google Login Agent — Telegram-driven Google Flow login via the Python broker
 *
 * Drives Google login for Google Flow (labs.google) through the warm Firefox
 * owned by the Python broker (python-broker). Gemini Vision is used only to read
 * the 2FA "tap this number" screen so the prompt can be relayed to the user over
 * Telegram. The legacy Chrome/Puppeteer path was removed (Phase 3c).
 *
 * Usage:
 *   await loginGoogleFlow(userId, credentialId, telegramChatId, sendTelegram)
 */

import { GoogleGenAI } from '@google/genai';
import { prisma } from '../index.js';
import { syncSiblingCredentials } from './credential-sync.js';
import { flowBroker, BrokerError } from '../connectors/google-flow/broker-client.js';
import { getAccountInstanceId } from '../connectors/google-flow/connector.js';
// getAccessToken now lives in a shared leaf module so the Flow connector can reuse
// it without a circular import. Imported here for internal callers + re-exported
// for existing external importers (e.g. cookie-harvester.js).
import { getAccessToken } from './flow-session.js';
export { getAccessToken };

// ─── Pending Telegram Input ─────────────────────────────
// Shared with telegram-bot.js for 2FA input flow
export const pendingInputRequests = new Map(); // chatId → { resolve, reject, timeout }

// ─── Per-user operation lock ─────────────────────────────
// Prevents concurrent login on the same user's broker session
const activeOperations = new Map(); // userId → true

/**
 * Get the Gemini model from admin settings.
 */
async function getGeminiModel() {
    try {
        const setting = await prisma.systemSetting.findUnique({ where: { key: 'telegram_ai_model' } });
        const value = setting?.value || '';
        // telegram_ai_model is shared across providers; if the admin selected a
        // non-Gemini provider (e.g. Ollama 'gemma4:12b'), don't feed it to Gemini.
        return value.startsWith('gemini') ? value : 'gemini-3-flash-preview';
    } catch {
        return 'gemini-3-flash-preview';
    }
}

// getAccessToken() moved to ./flow-session.js (shared leaf module — see the
// import + re-export near the top of this file). Internal callers below use the
// imported binding unchanged.

/**
 * Save extracted cookies and access token to the google-flow credential.
 * Creates or updates the google-flow credential for this user.
 */
export async function saveCredentialsToDB(userId, cookieString, tokenData) {
    // Find or create google-flow credential for this user
    let credential = await prisma.credential.findFirst({
        where: { userId, provider: 'google-flow' },
    });

    const metadata = {
        sessionCookies: cookieString,
        lastRefreshed: new Date().toISOString(),
        tokenExpiresAt: tokenData.expiresAt,
        userName: tokenData.userName,
        userEmail: tokenData.userEmail,
        autoLoginEnabled: true,
    };

    if (credential) {
        // Update existing
        const existingMeta = credential.metadata ? JSON.parse(credential.metadata) : {};
        await prisma.credential.update({
            where: { id: credential.id },
            data: {
                token: tokenData.accessToken,
                metadata: JSON.stringify({ ...existingMeta, ...metadata }),
            },
        });
        console.log(`[GoogleLogin] Updated google-flow credential: ${credential.id}`);
    } else {
        // Create new
        credential = await prisma.credential.create({
            data: {
                userId,
                provider: 'google-flow',
                label: 'Auto-Login Google Flow',
                token: tokenData.accessToken,
                metadata: JSON.stringify(metadata),
            },
        });
        console.log(`[GoogleLogin] Created new google-flow credential: ${credential.id}`);
    }

    // Sync to sibling credentials sharing the same Google account
    const savedMeta = credential.metadata ? JSON.parse(credential.metadata) : metadata;
    await syncSiblingCredentials(credential.id, tokenData.accessToken, { ...savedMeta, ...metadata });

    return credential;
}

// ─── Main Login Function ─────────────────────────────────

/**
 * Full automated login to Google Flow.
 *
 * @param {string} userId - User ID
 * @param {string} googleAccountCredentialId - Credential ID of google-account (has email/password)
 * @param {string} telegramChatId - Telegram chat ID for notifications
 * @param {Function} sendTelegram - Function to send text to Telegram: (message) => Promise
 * @returns {object} { success, message, credentialId }
 */
/**
 * Read a 2FA screenshot from /tmp and ask Gemini Vision what number to tap on phone.
 * Returns a short Vietnamese description for Telegram.
 */
async function analyze2FAScreenshot(screenshotPath) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return 'Vui lòng xác minh trên điện thoại trong 2 phút.';
    try {
        const fs = await import('fs');
        const imgBuffer = fs.readFileSync(screenshotPath);
        const base64 = imgBuffer.toString('base64');
        const model = await getGeminiModel();
        const ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({
            model: model || 'gemini-2.5-flash',
            contents: [{
                role: 'user',
                parts: [
                    { inlineData: { mimeType: 'image/png', data: base64 } },
                    { text: 'Đây là trang xác minh 2 bước của Google. Hãy cho tôi biết:\n1. Số cần nhấn trên điện thoại (số lớn hiển thị trên màn hình)\n2. Hướng dẫn ngắn gọn bằng tiếng Việt\nTrả lời ngắn gọn, rõ ràng.' }
                ]
            }]
        });
        return response?.candidates?.[0]?.content?.parts?.[0]?.text || 'Vui lòng xác minh trên điện thoại trong 2 phút.';
    } catch (e) {
        console.warn(`[GoogleLogin] Gemini 2FA analysis failed: ${e.message}`);
        return `Không đọc được số. Screenshot tại ${screenshotPath}. Vui lòng xác minh trên điện thoại trong 2 phút.`;
    }
}

export async function loginGoogleFlow(userId, googleAccountCredentialId, telegramChatId, sendTelegram) {
    // Check if another operation is already running for this user
    if (activeOperations.get(userId)) {
        return { success: false, message: '⚠️ Đang có thao tác login/refresh khác đang chạy cho user này. Vui lòng đợi.' };
    }
    activeOperations.set(userId, true);

    // File-based lock — survives PM2 cluster restarts
    const lockFile = '/tmp/google-login.lock';
    try {
        const fs = await import('fs');
        if (fs.existsSync(lockFile)) {
            const lockAge = Date.now() - fs.statSync(lockFile).mtimeMs;
            if (lockAge < 180000) { // Lock younger than 3 minutes
                console.log(`[GoogleLogin] ⏳ Another login in progress (lock age: ${Math.round(lockAge/1000)}s). Skipping.`);
                activeOperations.delete(userId);
                await sendTelegram('⏳ Đang có một phiên đăng nhập khác đang chạy. Vui lòng đợi.');
                return { success: false, message: 'Another login in progress' };
            }
            fs.unlinkSync(lockFile);
        }
        fs.writeFileSync(lockFile, `${Date.now()}\n${process.pid}`);
    } catch (lockErr) {
        console.log(`[GoogleLogin] Lock error (non-critical): ${lockErr.message}`);
    }

    try {
        // 1. Get Google account credentials
        const googleAccount = await prisma.credential.findFirst({
            where: { id: googleAccountCredentialId, userId, provider: 'google-account' },
        });
        if (!googleAccount) throw new Error('Google Account credential not found.');
        const accountMeta = googleAccount.metadata ? JSON.parse(googleAccount.metadata) : {};
        const { email, password } = accountMeta;
        if (!email || !password) throw new Error('Google Account is missing email or password.');

        // 2. Derive broker accountId from existing google-flow credential (or fallback to email)
        const flowCred = await prisma.credential.findFirst({
            where: { userId, provider: 'google-flow' },
        });
        const flowMeta = flowCred?.metadata ? JSON.parse(flowCred.metadata) : { userEmail: email };
        const accountId = getAccountInstanceId({ metadata: { userEmail: flowMeta.userEmail || email } });

        // 3. Kick off broker login in background
        await sendTelegram('🚀 Đang khởi động Firefox để đăng nhập...');
        await flowBroker.startLogin(accountId, email, password);

        // 4. Poll status every 2s for max 360s. The VPS persistent login (login runs
        //    inside the per-account profile dir) spends ~60-90s acquiring a working
        //    launch_persistent_context under FEX (retry + cleanup) BEFORE navigating,
        //    so 2FA appears later than the old ephemeral login — 180s was too tight.
        const startedAt = Date.now();
        const MAX_MS = 360000;
        const POLL_MS = 2000;
        let twoFAReported = false;

        while (Date.now() - startedAt < MAX_MS) {
            await new Promise(r => setTimeout(r, POLL_MS));
            let status;
            try {
                status = await flowBroker.loginStatus(accountId);
            } catch (e) {
                console.warn(`[GoogleLogin] poll error: ${e.message}`);
                continue;
            }

            if (status.state === 'awaiting_2fa' && !twoFAReported) {
                twoFAReported = true;
                const geminiText = status.screenshot_path
                    ? await analyze2FAScreenshot(status.screenshot_path)
                    : 'Vui lòng xác minh trên điện thoại trong 2 phút.';
                await sendTelegram(`🔐 Google yêu cầu xác minh 2 bước:\n\n${geminiText}\n\n⏰ Bạn có 2 phút để xác nhận.`);
            }

            if (status.state === 'completed') {
                if (!status.cookies || status.cookies.length < 50) {
                    throw new Error('Broker returned empty cookies');
                }
                const tokenData = await getAccessToken(status.cookies);
                // Verify correct account
                if (tokenData.userEmail && tokenData.userEmail.toLowerCase() !== email.toLowerCase()) {
                    throw new Error(`Wrong account: ${tokenData.userEmail} (expected ${email})`);
                }
                await saveCredentialsToDB(userId, status.cookies, tokenData);
                // NO profile snapshot here. On the VPS (BROKER_PROFILE_BASE set) the
                // broker ran THIS login directly inside the per-account persistent
                // profile dir (session_pool._run_login persistent mode), so Firefox
                // already wrote a real, coherent login there — the exact dir
                // reload-via-firefox launches at. A synthetic cookie snapshot would
                // only DOWNGRADE that real login (wrong host/httpOnly/sameSite →
                // Firefox renders logged-out → reload can never rotate). That
                // profile-dir mismatch was the root cause of the ~20h-rollover
                // re-login pain (fixed 2026-06-02).
                const msg = `✅ Login Google Flow thành công (${tokenData.userEmail})! Token expires: ${tokenData.expiresAt || 'N/A'}`;
                await sendTelegram(msg);
                return { success: true, message: msg };
            }

            if (status.state === 'failed') {
                throw new Error(status.error || 'Broker login failed');
            }
        }

        throw new Error('Login timeout 360s — Firefox/Telegram chưa hoàn thành 2FA');

    } catch (error) {
        console.error('[GoogleLogin] Error:', error.message);
        const result = { success: false, message: `❌ Login thất bại: ${error.message}` };
        try { await sendTelegram(result.message); } catch { /* ok */ }
        return result;
    } finally {
        activeOperations.delete(userId);
        try { const fs = await import('fs'); fs.unlinkSync('/tmp/google-login.lock'); } catch { /* ok */ }
    }
}
