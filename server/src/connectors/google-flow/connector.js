/**
 * Google Flow Connector — Real Reverse-Engineered API
 *
 * Based on captured network traffic from labs.google/fx/tools/flow/
 *
 * Image Generation:
 *   POST https://aisandbox-pa.googleapis.com/v1/flow/uploadImage
 *   POST https://aisandbox-pa.googleapis.com/v1/projects/{projectId}/flowMedia:batchGenerateImages
 *
 * Video Generation (captured separately — see VideoConnector notes):
 *   POST https://aisandbox-pa.googleapis.com/v1/projects/{projectId}/flowMedia:generateVideo (estimated)
 *
 * Auth: Bearer token from active Google session (Authorization header)
 * Project ID: stored in credential metadata (extracted from URL pattern)
 */

import { BaseConnector } from '../base-connector.js';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import { prisma } from '../../index.js';
import { syncSiblingCredentials } from '../../services/credential-sync.js';
import { flowBroker, BrokerError } from './broker-client.js';

const API_BASE = 'https://aisandbox-pa.googleapis.com';
const TOOL = 'PINHOLE';

/**
 * Check if Google Flow token is expired or near expiry (< 5 min).
 * If so, call the session API to get a fresh token and update DB.
 * Returns the (possibly refreshed) token and updated credentials object.
 */
async function ensureFreshToken(credentials) {
    if (!credentials?.token || !credentials?.metadata?.sessionCookies) {
        return credentials; // Can't refresh without cookies, return as-is
    }

    const meta = credentials.metadata || {};
    let needsRefresh = false;

    // Check tokenExpiresAt (set by session API)
    if (meta.tokenExpiresAt) {
        const expiresAt = new Date(meta.tokenExpiresAt).getTime();
        const remainingMs = expiresAt - Date.now();
        const remainingMin = Math.floor(remainingMs / 60000);

        if (remainingMs <= 5 * 60 * 1000) { // < 5 minutes
            console.log(`[GoogleFlow] Token expires in ${remainingMin}m — refreshing...`);
            needsRefresh = true;
        }
    }
    // Check lastRefreshed + 1 hour (fallback for tokens without tokenExpiresAt)
    else if (meta.lastRefreshed) {
        const refreshedAt = new Date(meta.lastRefreshed).getTime();
        const elapsed = Date.now() - refreshedAt;
        if (elapsed > 55 * 60 * 1000) { // > 55 minutes (5 min buffer before 1h expiry)
            console.log(`[GoogleFlow] Token refreshed ${Math.round(elapsed / 60000)}m ago — refreshing...`);
            needsRefresh = true;
        }
    }

    if (!needsRefresh) return credentials;

    try {
        const sessionRes = await fetch('https://labs.google/fx/api/auth/session', {
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'Content-Type': 'application/json',
                'Cookie': meta.sessionCookies,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                'Referer': 'https://labs.google/fx/vi/tools/flow/',
            },
        });

        if (!sessionRes.ok) {
            console.warn(`[GoogleFlow] Session API returned ${sessionRes.status} — using existing token`);
            return credentials;
        }

        const sessionData = await sessionRes.json();
        if (!sessionData.access_token) {
            console.warn('[GoogleFlow] No access_token in session response — using existing token');
            return credentials;
        }

        const newToken = sessionData.access_token;
        const expiresAt = sessionData.expires || null;

        console.log('[GoogleFlow] ✅ Auto-refreshed token!', newToken.substring(0, 30) + '...');
        console.log('[GoogleFlow] New expiry:', expiresAt);

        // Update DB
        const newMeta = {
            ...meta,
            lastRefreshed: new Date().toISOString(),
            tokenExpiresAt: expiresAt,
            userName: sessionData.user?.name || meta.userName,
            userEmail: sessionData.user?.email || meta.userEmail,
        };

        await prisma.credential.update({
            where: { id: credentials.id },
            data: {
                token: newToken,
                metadata: JSON.stringify(newMeta),
            },
        });

        // Sync to sibling credentials sharing the same Google account
        await syncSiblingCredentials(credentials.id, newToken, newMeta);

        // Return updated credentials
        return {
            ...credentials,
            token: newToken,
            metadata: newMeta,
        };

    } catch (e) {
        console.warn('[GoogleFlow] Auto-refresh failed:', e.message, '— using existing token');
        return credentials;
    }
}

// ─────────────────────────────────────────────────────────
//  reCAPTCHA + browser fetch — delegated to Python broker
//  (server/python-broker, invisible_playwright Firefox).
//  See memory `invisible-playwright-phase0` for rationale.
// ─────────────────────────────────────────────────────────

// Per-account Flow operation queue.
// reCAPTCHA Enterprise's risk engine scores per-profile lifetime traffic; concurrent
// submits from one account (observed: JobBatch parallel mode runs 3 workflows at once on
// the same Chrome profile) trip both PUBLIC_ERROR_UNUSUAL_ACTIVITY (upscale, 2026-05-14)
// and reCAPTCHA-eval 403s at generate-time. Earlier scope was upscale-only; widened to
// cover the entire execute() body of each connector after field reports of frequent
// 403s on parallel generate calls. Net effect: parallel JobBatches on the same Google
// account run sequentially; different accounts (different instanceId → different profile)
// still parallelize.
const _flowQueues = new Map(); // instanceId -> tail Promise

function withFlowLock(instanceId, fn) {
    const tail = _flowQueues.get(instanceId) || Promise.resolve();
    const next = tail.then(fn, fn); // run fn whether previous resolved or rejected
    _flowQueues.set(instanceId, next.catch(() => { /* swallow so chain never breaks */ }));
    return next;
}

/**
 * Derive a stable Chrome instance ID from Google account email.
 * Same email → same instanceId → same profile directory → profile reuse.
 * This prevents creating new Chrome profiles per job (which caused disk bloat
 * and low reCAPTCHA trust scores from fresh profiles).
 */
export function getAccountInstanceId(credentials) {
    // Handle both parsed and stringified metadata
    let meta = credentials?.metadata;
    if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { meta = {}; }
    }
    const email = meta?.userEmail;
    if (email) {
        // Sanitize email to be filesystem-safe: minababy17012004@gmail.com → minababy17012004_gmail_com
        return email.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    }
    // Fallback: static 'default' (still better than UUID — reuses 1 profile)
    console.warn('[reCAPTCHA] ⚠️ No userEmail in credentials.metadata — using default profile');
    return 'default';
}

// Per-account fingerprint of the last cookies pushed to broker. When the string
// changes (CookieHarvester just refreshed), we re-init the broker session to
// inject the new cookies on the next context rotation.
const _brokerCookieFingerprint = new Map();

async function ensureBrokerSession(instanceId, sessionCookies) {
    const fp = sessionCookies || '';
    if (_brokerCookieFingerprint.get(instanceId) === fp) return;
    await flowBroker.ensureSession(instanceId, fp);
    _brokerCookieFingerprint.set(instanceId, fp);
}

/**
 * Mint a fresh reCAPTCHA Enterprise token via the broker. Signature preserved
 * for connector code — sessionCookies is pushed to the broker on first call
 * (or when it changes) via ensureBrokerSession.
 */
async function fetchRecaptchaToken(sessionCookies, action = 'IMAGE_GENERATION', instanceId = 'default') {
    try {
        await ensureBrokerSession(instanceId, sessionCookies);
        const { token, request_count } = await flowBroker.recaptchaToken(instanceId, action);
        if (token && token.length > 50) {
            console.log(`[reCAPTCHA:${instanceId.substring(0, 8)}] ✅ Fresh token (${token.length} chars, ctx=${request_count})`);
            return token;
        }
        console.warn(`[reCAPTCHA:${instanceId.substring(0, 8)}] Token too short or empty:`, token?.substring(0, 50));
        return '';
    } catch (e) {
        // 409 = broker hit signin redirect → cookies stale (CookieHarvester needs to run).
        const isSignin = e instanceof BrokerError && e.status === 409;
        console.error(`[reCAPTCHA:${instanceId.substring(0, 8)}] broker mint failed${isSignin ? ' (signin redirect)' : ''}: ${e.message}`);
        // Invalidate fingerprint so the next attempt re-pushes whatever cookies are current.
        _brokerCookieFingerprint.delete(instanceId);
        return '';
    }
}

/**
 * Browser-side POST inside the broker's Firefox context — carries the right
 * cookies + Origin so Google Flow accepts the reCAPTCHA token.
 * Same return shape as the old Puppeteer version: { status, ok, body }.
 */
async function browserFetch(url, token, body, instanceId = 'default') {
    try {
        const result = await flowBroker.flowFetch(instanceId, url, token, body);
        console.log(`[BrowserFetch:${instanceId.substring(0, 8)}] Response status: ${result.status}`);
        return result;
    } catch (e) {
        // Broker unreachable / crash. Return a 503-shaped result so the caller's
        // retry loop still applies (mirrors the old fallback behaviour without a
        // direct Node fetch — that path used to silently 403 since it carried no
        // browser cookies).
        console.warn(`[BrowserFetch:${instanceId.substring(0, 8)}] broker error: ${e.message}`);
        return { status: 503, ok: false, body: `broker-unreachable: ${e.message}` };
    }
}

/**
 * Reload the broker's Flow page — used for sticky reCAPTCHA SDK state.
 * Phase 0 found context rotation @ 15 is the broader cure (handled inside the
 * broker automatically); this remains for transient SDK errors before the
 * rotation threshold.
 */
async function _reloadRecaptchaPage(instanceId = 'default') {
    try {
        await flowBroker.reload(instanceId);
        console.log(`[reCAPTCHA:${instanceId.substring(0, 8)}] ✅ Broker page reloaded`);
        return true;
    } catch (e) {
        console.warn(`[reCAPTCHA:${instanceId.substring(0, 8)}] Reload failed: ${e.message}`);
        return false;
    }
}

/**
 * Clear a used reCAPTCHA token via Google's CLR endpoint.
 * Matches Google Flow web behavior: Token → API call → CLR → next token.
 */
async function clearRecaptchaToken(usedToken) {
    if (!usedToken) return;
    try {
        const res = await fetch('https://www.google.com/recaptcha/enterprise/clr', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-protobuf',
                'Origin': 'https://labs.google',
                'Referer': 'https://labs.google/',
            },
            body: usedToken,
        });
        console.log(`[reCAPTCHA] CLR sent (status=${res.status})`);
    } catch (e) {
        console.warn('[reCAPTCHA] CLR call failed:', e.message);
    }
}

// Model name mapping (UI label -> API value)
const IMAGE_MODELS = {
    'banana2': 'NARWHAL',              // ✅ Nano Banana 2 — CONFIRMED
    'banana_pro': 'GEM_PIX_2',         // ✅ Nano Banana Pro — CONFIRMED
};

// Aspect ratio enum mapping
const ASPECT_RATIO_MAP = {
    '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
    '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
    '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
    '4:3': 'IMAGE_ASPECT_RATIO_LANDSCAPE_4_3',
    '3:4': 'IMAGE_ASPECT_RATIO_PORTRAIT_3_4',
};

/**
 * Build common auth headers
 */
function buildHeaders(token) {
    return {
        'Content-Type': 'text/plain;charset=UTF-8',
        'Authorization': `Bearer ${token}`,
        'Origin': 'https://labs.google',
        'Referer': 'https://labs.google/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    };
}

/**
 * Step 1: Upload reference image to Google Flow
 * Returns the media UUID assigned by the API.
 */
async function uploadReferenceImage(token, projectId, imageBase64, mimeType = 'image/jpeg') {
    console.log('[FlowImage] Uploading reference image...');

    const body = {
        clientContext: {
            projectId,
            tool: TOOL,
        },
        imageBytes: imageBase64,
    };

    const res = await fetch(`${API_BASE}/v1/flow/uploadImage`, {
        method: 'POST',
        headers: buildHeaders(token),
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const errText = await res.text();
        if (res.status === 401) {
            throw new Error('🔑 Token Google Flow đã hết hạn. Vui lòng vào Credentials và tạo token mới.');
        }
        throw new Error(`Upload failed (${res.status}): ${errText.substring(0, 400)}`);
    }

    const data = await res.json();
    // Response format: { media: { name: "uuid", ... } }
    const mediaId = data.media?.name || data.mediaId || data.name || data.id;
    if (!mediaId) {
        throw new Error(`Upload succeeded but no mediaId returned. Response: ${JSON.stringify(data).substring(0, 200)}`);
    }

    console.log('[FlowImage] Reference image uploaded, mediaId:', mediaId);
    return mediaId;
}

/**
 * Step 2: Generate a SINGLE image via batchGenerateImages API.
 * Caller provides batchId + sessionId to group multiple calls.
 * Returns array of { mediaId, fifeUrl, ... } (usually 1 item).
 */
async function batchGenerateImages(token, projectId, { prompt, modelName, aspectRatio, referenceMediaIds, seed, recaptchaToken, batchId, sessionId, sessionCookies, instanceId }) {
    // Build recaptcha context
    const recaptchaContext = {
        applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
        ...(recaptchaToken && { token: recaptchaToken }),
    };

    // Build single request object — 1 request = 1 image
    const request = {
        clientContext: {
            recaptchaContext,
            projectId,
            tool: TOOL,
            sessionId,
        },
        imageModelName: modelName,
        imageAspectRatio: aspectRatio,
        structuredPrompt: {
            parts: [{ text: prompt }],
        },
        seed: seed || Math.floor(Math.random() * 2147483647),
    };

    // Attach reference images if provided
    if (referenceMediaIds && referenceMediaIds.length > 0) {
        request.imageInputs = referenceMediaIds.map(id => ({
            imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE',
            name: id,
        }));
    }

    const body = {
        clientContext: {
            recaptchaContext,
            projectId,
            tool: TOOL,
            sessionId,
        },
        mediaGenerationContext: { batchId },
        useNewMedia: true,
        requests: [request],  // Always 1 request per API call
    };

    console.log(`[FlowImage] Generating 1 image(s), model=${modelName}, ratio=${aspectRatio}, seed=${request.seed}...`);

    const apiUrl = `${API_BASE}/v1/projects/${projectId}/flowMedia:batchGenerateImages`;
    let result;
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        result = await browserFetch(apiUrl, token, body, instanceId);

        if (result.ok) break;

        console.log(`[FlowImage] Error response (${result.status}): ${result.body.substring(0, 300)}`);

        // Retry on 403 reCAPTCHA — keep Chrome warm (preserves trust score), wait, get fresh token
        // Closing Chrome on every 403 caused a self-reinforcing cold-launch loop → ~78% failure rate
        if (result.status === 403 && result.body.includes('reCAPTCHA') && attempt < MAX_RETRIES) {
            console.log(`[FlowImage] ⚠️ reCAPTCHA 403 — waiting 15s then retrying with fresh token (${attempt + 1}/${MAX_RETRIES})...`);
            await new Promise(r => setTimeout(r, 15000));
            // Reuse warm browser, just fetch a fresh single-use token
            const freshToken = await fetchRecaptchaToken(sessionCookies, 'IMAGE_GENERATION', instanceId);
            body.clientContext.recaptchaContext = {
                token: freshToken,
                applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
            };
            continue;
        }

        // Only retry on 5xx server errors
        if (result.status >= 500 && attempt < MAX_RETRIES) {
            console.log(`[FlowImage] ⚠️ Server error ${result.status}, retrying (${attempt + 1}/${MAX_RETRIES})...`);
            await new Promise(r => setTimeout(r, 3000)); // wait 3s before retry
            continue;
        }
        // Detect content policy violation on input image
        if (result.body.includes('PUBLIC_ERROR_MINOR_INPUT_IMAGE')) {
            throw new Error('⚠️ Ảnh bạn tải lên có nội dung không phù hợp hoặc không được hỗ trợ. Vui lòng thử ảnh khác.');
        }
        if (result.status === 401) {
            throw new Error('🔑 Token Google Flow đã hết hạn. Vui lòng vào Credentials và tạo token mới.');
        }
        throw new Error(`Generation failed (${result.status}): ${result.body.substring(0, 400)}`);
    }

    const data = JSON.parse(result.body);

    // Response: { media: [ { name, image: { generatedImage: { fifeUrl, ... } } } ], workflows: [...] }
    const mediaItems = data.media || [];
    if (!mediaItems.length) {
        throw new Error(`No images returned. Response: ${JSON.stringify(data).substring(0, 300)}`);
    }

    return mediaItems.map(item => ({
        mediaId: item.name,
        fifeUrl: item.image?.generatedImage?.fifeUrl,
        dimensions: item.image?.dimensions,
        seed: item.image?.generatedImage?.seed,
        workflowId: item.workflowId,
    }));
}

/**
 * Download an image from a signed GCS URL and save to disk.
 * Returns the local file path and imageUrl (relative).
 */
async function downloadAndSaveImage(fifeUrl, outputDir, prefix = 'gflow') {
    const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
    const filepath = join(outputDir, filename);

    const imgRes = await fetch(fifeUrl);
    if (!imgRes.ok) {
        throw new Error(`Failed to download image (${imgRes.status})`);
    }

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    await writeFile(filepath, buffer);
    return { filepath, filename };
}

// ─────────────────────────────────────────────────────────
//  GoogleFlowImageConnector
// ─────────────────────────────────────────────────────────

export class GoogleFlowImageConnector extends BaseConnector {
    static get metadata() {
        return {
            name: 'Google Flow — Image',
            description: 'Generate images with Google Flow (ImageFX). Accepts reference image from upstream File Upload.',
            icon: '🎨',
            category: 'ai',
            configSchema: {
                prompt: {
                    type: 'textarea',
                    label: 'Image Prompt',
                    description: 'Use {{nodeId.imagePrompt}} from Text Extractor',
                    required: true,
                },
                model: {
                    type: 'select',
                    label: 'Model',
                    options: [
                        { label: 'Nano Banana 2 (Gemini 2.5 Pro)', value: 'banana2' },
                        { label: 'Nano Banana (Gemini 2.5 Flash)', value: 'banana' },
                        { label: 'Nano Banana Pro (Gemini 3 Pro)', value: 'banana_pro' },
                        { label: 'Imagen 4', value: 'imagen4' },
                        { label: 'Nano (Imagen 3.5)', value: 'nano' },
                    ],
                    default: 'banana2',
                },
                aspectRatio: {
                    type: 'select',
                    label: 'Aspect Ratio',
                    options: ['9:16', '1:1', '16:9', '4:3', '3:4'],
                    default: '9:16',
                },
                count: {
                    type: 'number',
                    label: 'Number of Images',
                    description: '1–4',
                    default: 1,
                },
                useReferenceImage: {
                    type: 'boolean',
                    label: 'Use Reference Image from Upstream',
                    description: 'Send uploaded image as reference (from File Upload node)',
                    default: true,
                },
                resolution: {
                    type: 'select',
                    label: 'Resolution',
                    options: [
                        { label: '1K (Original)', value: '1k' },
                        { label: '2K (Upscaled)', value: '2k' },
                        { label: '4K (Upscaled)', value: '4k' },
                    ],
                    default: '1k',
                },
                projectId: {
                    type: 'text',
                    label: 'Project ID',
                    description: 'Your Google Flow project UUID (found in network requests)',
                    required: true,
                },
                credentialId: {
                    type: 'credential',
                    label: 'Google Auth Token',
                    provider: 'google-flow',
                    required: true,
                },
            },
        };
    }

    async execute(input, credentials, config, context = {}) {
        if (!credentials?.token) {
            throw new Error('Google Flow credentials required (Bearer token).');
        }
        // Auto-refresh token if expired or near expiry
        credentials = await ensureFreshToken(credentials);
        const instanceId = getAccountInstanceId(credentials);
        // Per-account serialization: see _flowQueues comment. Wraps the whole
        // generate→poll→upscale→download pipeline so two workflows on the same
        // Google account never overlap Chrome/reCAPTCHA traffic.
        return withFlowLock(instanceId, () => this._executeLocked(input, credentials, config, context, instanceId));
    }

    async _executeLocked(input, credentials, config, context, instanceId) {
        const token = credentials.token;
        const projectId = config.projectId;
        if (!projectId) {
            throw new Error('Project ID is required. Set it in the Flow Image node config.');
        }

        // Resolve prompt
        const prompt = config.prompt || input.imagePrompt || input.text || '';
        if (!prompt) throw new Error('Image prompt is required.');

        const modelKey = config.model || 'banana2';
        const modelName = IMAGE_MODELS[modelKey] || 'GEM_PIX_2';
        const aspectRatioKey = config.aspectRatio || '9:16';
        const aspectRatio = ASPECT_RATIO_MAP[aspectRatioKey] || 'IMAGE_ASPECT_RATIO_PORTRAIT';
        const count = Math.min(Math.max(parseInt(config.count) || 1, 1), 4);

        // Upload reference images if available
        const referenceMediaIds = [];
        console.log(`[FlowImage] input.images: ${input.images ? input.images.length : 0} image(s), useReferenceImage: ${config.useReferenceImage}`);
        if (config.useReferenceImage !== false) {
            // Multi-image support: check input.images[] array first
            const imageSources = (input.images && input.images.length > 0)
                ? input.images
                : (input.imageData || input.filePath || input.imageUrl)
                    ? [{ imageData: input.imageData, filePath: input.filePath, imageUrl: input.imageUrl }]
                    : [];

            for (const imgSrc of imageSources) {
                let imageBase64 = imgSrc.imageData;

                if (!imageBase64 && (imgSrc.filePath || imgSrc.imageUrl)) {
                    const uploadsDir = process.env.UPLOAD_DIR || './uploads';
                    const imgPath = imgSrc.filePath
                        || join(uploadsDir, (imgSrc.imageUrl || '').replace('/uploads/', ''));
                    try {
                        const buf = await readFile(imgPath);
                        imageBase64 = buf.toString('base64');
                        console.log('[FlowImage] Loaded reference image from:', imgPath);
                    } catch (e) {
                        console.warn('[FlowImage] Could not load reference image:', e.message);
                    }
                }

                if (imageBase64) {
                    try {
                        const mediaId = await uploadReferenceImage(token, projectId, imageBase64);
                        referenceMediaIds.push(mediaId);
                        console.log(`[FlowImage] Uploaded reference image, mediaId: ${mediaId}`);
                    } catch (e) {
                        console.warn('[FlowImage] Upload failed for one image:', e.message);
                    }
                }
            }

            if (referenceMediaIds.length > 0) {
                console.log(`[FlowImage] ${referenceMediaIds.length} reference image(s) uploaded`);
            }
        }

        // ── Batch generation: 1 API call per image, fresh reCAPTCHA each ──
        const sessionCookies = credentials.metadata?.sessionCookies || '';
        const batchId = uuidv4();
        const sessionId = `;${Date.now()}`;
        const allResults = [];

        console.log(`[FlowImage] Starting batch of ${count} image(s), batchId=${batchId}, account=${instanceId}`);

        for (let i = 0; i < count; i++) {
            // Fresh reCAPTCHA token for each API call
            const recaptchaToken = await fetchRecaptchaToken(sessionCookies, 'IMAGE_GENERATION', instanceId);

            const result = await batchGenerateImages(token, projectId, {
                prompt,
                modelName,
                aspectRatio,
                referenceMediaIds,
                recaptchaToken,
                batchId,
                sessionId,
                sessionCookies,
                instanceId,
                seed: Math.floor(Math.random() * 2147483647),
            });
            allResults.push(...result);

            // Clear the used token (matches Google Flow web behavior)
            await clearRecaptchaToken(recaptchaToken);

            // Delay between generations to avoid reCAPTCHA rate limiting
            if (i < count - 1) {
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        const results = allResults;

        // Download and save images to job folder (or fallback)
        const uploadsDir = process.env.UPLOAD_DIR || './uploads';
        const outputDir = context.jobDir || join(uploadsDir, 'generated');
        await mkdir(outputDir, { recursive: true });
        const relativeBase = context.jobDir
            ? outputDir.replace(/^\.\//, '')
            : 'uploads/generated';

        // Upscale if resolution is 2k or 4k
        const resolution = config.resolution || '1k';

        const savedImages = [];
        for (const r of results) {
            if (r.fifeUrl) {
                // Upscale if needed — each upscale also gets a fresh reCAPTCHA token
                if (resolution !== '1k' && r.mediaId) {
                    try {
                        console.log(`[FlowImage] 🔄 Upscaling image to ${resolution.toUpperCase()}...`);
                        // Delay to avoid reCAPTCHA rate limiting between gen and upscale on same profile.
                        await new Promise(r => setTimeout(r, 5000));
                        // No inner lock: outer withFlowLock in execute() already serializes per-account.
                        const upscaleRecaptcha = await fetchRecaptchaToken(sessionCookies, 'IMAGE_GENERATION', instanceId);
                        const upscaleResult = await this._upscaleImage(token, projectId, r.mediaId, resolution, upscaleRecaptcha, instanceId, sessionCookies);
                        await clearRecaptchaToken(upscaleRecaptcha);
                        if (upscaleResult.encodedImage) {
                            const filename = `gflow_${resolution}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
                            const filepath = join(outputDir, filename);
                            await writeFile(filepath, Buffer.from(upscaleResult.encodedImage, 'base64'));
                            console.log(`[FlowImage] ✅ Upscale to ${resolution.toUpperCase()} saved: ${filepath}`);
                            savedImages.push({
                                imageUrl: `/${relativeBase}/${filename}`,
                                imagePath: filepath,
                                mediaId: r.mediaId,
                                dimensions: r.dimensions,
                            });
                            continue;
                        } else {
                            console.warn(`[FlowImage] ⚠️ Upscale returned no encodedImage, downloading original`);
                        }
                    } catch (e) {
                        console.warn(`[FlowImage] ⚠️ Upscale to ${resolution.toUpperCase()} failed: ${e.message}, downloading original`);
                        // If 403 reCAPTCHA, wait before continuing — keep Chrome warm to preserve trust score
                        if (e.message.includes('403') && e.message.includes('reCAPTCHA')) {
                            console.log('[FlowImage] 🔄 reCAPTCHA 403 on upscale — waiting 15s before next request (keeping Chrome warm)...');
                            await new Promise(r => setTimeout(r, 15000));
                        }
                    }
                }

                // Download original (1k or fallback)
                try {
                    const { filepath, filename } = await downloadAndSaveImage(r.fifeUrl, outputDir);
                    savedImages.push({
                        imageUrl: `/${relativeBase}/${filename}`,
                        imagePath: filepath,
                        mediaId: r.mediaId,
                        fifeUrl: r.fifeUrl,
                        dimensions: r.dimensions,
                    });
                } catch (e) {
                    console.warn('[FlowImage] Could not save image:', e.message);
                    savedImages.push({ fifeUrl: r.fifeUrl, mediaId: r.mediaId });
                }
            }
        }

        if (!savedImages.length) {
            throw new Error('No images could be downloaded from Google Flow.');
        }

        const primary = savedImages[0];

        // Read back as base64 for downstream (Flow Video)
        let imageData = null;
        if (primary.imagePath) {
            try {
                const buf = await readFile(primary.imagePath);
                imageData = buf.toString('base64');
            } catch (_) { }
        }

        // Broker keeps the warm Firefox session alive; its own 10-min idle timer
        // closes it automatically. No Node-side idle reset needed.

        return {
            text: prompt,
            imageUrl: primary.imageUrl || primary.fifeUrl,
            imagePath: primary.imagePath,
            imageData,          // base64 for Flow Video start frame
            fifeUrl: primary.fifeUrl,
            mediaId: primary.mediaId,
            allImages: savedImages,
            status: 'generated',
            model: modelName,
        };
    }

    /**
     * Upscale an image to 2K or 4K resolution.
     * POST /v1/flow/upsampleImage
     * Response returns { encodedImage: "<base64 JPEG>" }
     */
    async _upscaleImage(token, projectId, mediaId, resolution, recaptchaToken = '', instanceId = 'default', sessionCookies = '') {
        const targetResolution = resolution === '4k'
            ? 'UPSAMPLE_IMAGE_RESOLUTION_4K'
            : 'UPSAMPLE_IMAGE_RESOLUTION_2K';
        const sessionId = `;${Date.now()}`;

        const body = {
            mediaId,
            targetResolution,
            clientContext: {
                recaptchaContext: {
                    token: recaptchaToken,
                    applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
                },
                projectId,
                tool: TOOL,
                userPaygateTier: 'PAYGATE_TIER_TWO',
                sessionId,
            },
        };

        console.log(`[FlowImage] Upscale request: POST /v1/flow/upsampleImage (${targetResolution})`);
        const endpoint = `${API_BASE}/v1/flow/upsampleImage`;
        let result;
        const MAX_RETRIES = 2;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            result = await browserFetch(endpoint, token, body, instanceId);
            if (result.ok) break;

            if (result.status === 403 && result.body.includes('reCAPTCHA') && attempt < MAX_RETRIES) {
                console.warn(`[FlowImage] ⚠️ Upscale reCAPTCHA 403 — reloading page + retrying (${attempt + 1}/${MAX_RETRIES})...`);
                // Page reload resets the SDK trust-score state — fetchRecaptchaToken alone
                // is not enough once the page lifetime gets flagged (manual UI also fails).
                await _reloadRecaptchaPage(instanceId);
                await new Promise(r => setTimeout(r, 5000));
                const freshToken = await fetchRecaptchaToken(sessionCookies, 'IMAGE_GENERATION', instanceId);
                body.clientContext.recaptchaContext = { token: freshToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' };
                continue;
            }
            if (result.status >= 500 && attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 3000)); continue; }
            if (result.status === 401) {
                throw new Error('🔑 Token Google Flow đã hết hạn. Vui lòng vào Credentials và tạo token mới.');
            }
            throw new Error(`Image upscale failed (${result.status}): ${result.body.substring(0, 300)}`);
        }

        const data = JSON.parse(result.body);
        const hasImage = !!data.encodedImage;
        console.log(`[FlowImage] Upscale response: hasEncodedImage=${hasImage}, keys=${Object.keys(data).join(',')}`);

        return { encodedImage: data.encodedImage || null };
    }

    async testConnection(credentials) {
        if (!credentials?.token) return false;
        try {
            // Lightweight check: try to hit the API base to see if token is accepted
            const res = await fetch(`${API_BASE}/v1/flow/uploadImage`, {
                method: 'POST',
                headers: buildHeaders(credentials.token),
                body: JSON.stringify({ clientContext: { projectId: credentials.metadata?.projectId || 'test', tool: TOOL }, imageBytes: '' }),
            });
            // 400 = bad request (expected since imageBytes is empty) but token accepted
            // 401/403 = token invalid
            return res.status !== 401 && res.status !== 403;
        } catch {
            return false;
        }
    }
}

// ─────────────────────────────────────────────────────────
//  GoogleFlowVideoConnector
// ─────────────────────────────────────────────────────────

// Video model mapping (confirmed from HAR)
const VIDEO_MODELS = {
    'veo3_fast_low': 'veo_3_1_i2v_s_fast_portrait_ultra_relaxed',  // Veo 3.1 Fast (Low Priority) — CONFIRMED
    'veo3_fast': 'veo_3_1_i2v_s_fast_portrait_ultra',              // Veo 3.1 - Fast — CONFIRMED via HAR
    'veo3': 'veo_3_1_i2v_s_portrait',                              // Veo 3.1 - Quality — CONFIRMED via HAR
    'veo3_lite': 'veo_3_1_i2v_lite',                               // Veo 3.1 - Lite
    'veo3_lite_low': 'veo_3_1_i2v_lite_low_priority',              // Veo 3.1 - Lite (Low Priority)
};

// Video aspect ratio enum mapping
const VIDEO_ASPECT_RATIO_MAP = {
    '16:9': 'VIDEO_ASPECT_RATIO_LANDSCAPE',
    '9:16': 'VIDEO_ASPECT_RATIO_PORTRAIT',
    '1:1': 'VIDEO_ASPECT_RATIO_SQUARE',
};

export class GoogleFlowVideoConnector extends BaseConnector {
    static get metadata() {
        return {
            name: 'Google Flow — Video',
            description: 'Generate videos with Google Flow (Veo 3.1). Auto-uses a random generated image as start frame.',
            icon: '🎬',
            category: 'ai',
            configSchema: {
                prompt: {
                    type: 'textarea',
                    label: 'Video Prompt',
                    description: 'Use {{nodeId.videoPrompt}} from Text Extractor',
                    required: true,
                },
                model: {
                    type: 'select',
                    label: 'Model',
                    options: [
                        { label: 'Veo 3.1 Fast (Low Priority)', value: 'veo3_fast_low' },
                        { label: 'Veo 3.1 - Fast', value: 'veo3_fast' },
                        { label: 'Veo 3.1 - Quality', value: 'veo3' },
                    ],
                    default: 'veo3_fast_low',
                },
                aspectRatio: {
                    type: 'select',
                    label: 'Aspect Ratio',
                    options: [
                        { label: 'Portrait (9:16)', value: '9:16' },
                        { label: 'Landscape (16:9)', value: '16:9' },
                        { label: 'Square (1:1)', value: '1:1' },
                    ],
                    default: '9:16',
                },
                useStartFrame: {
                    type: 'boolean',
                    label: 'Use Start Frame from Upstream Image',
                    description: 'Use a generated image from Flow Image as the video start frame',
                    default: true,
                },
                resolution: {
                    type: 'select',
                    label: 'Resolution',
                    options: [
                        { label: '720p (Original)', value: '720p' },
                        { label: '1080p (Upscaled)', value: '1080p' },
                    ],
                    default: '720p',
                },
                projectId: {
                    type: 'text',
                    label: 'Project ID',
                    description: 'Your Google Flow project UUID',
                    required: true,
                },
                credentialId: {
                    type: 'credential',
                    label: 'Google Auth Token',
                    provider: 'google-flow',
                    required: true,
                },
            },
        };
    }

    async execute(input, credentials, config, context = {}) {
        if (!credentials?.token) {
            throw new Error('Google Flow credentials required (Bearer token).');
        }
        // Auto-refresh token if expired or near expiry
        credentials = await ensureFreshToken(credentials);
        const instanceId = getAccountInstanceId(credentials);
        // Per-account serialization — see _flowQueues comment.
        return withFlowLock(instanceId, () => this._executeLocked(input, credentials, config, context, instanceId));
    }

    async _executeLocked(input, credentials, config, context, instanceId) {
        const token = credentials.token;
        const projectId = config.projectId;
        if (!projectId) throw new Error('Project ID is required.');

        const prompt = config.prompt || input.videoPrompt || input.text || '';
        if (!prompt) throw new Error('Video prompt is required.');

        const modelKey = config.model || 'veo3_fast_low';
        const videoModelKey = VIDEO_MODELS[modelKey] || 'veo_3_1_i2v_s_fast_portrait_ultra_relaxed';
        const aspectRatio = VIDEO_ASPECT_RATIO_MAP[config.aspectRatio || '9:16'] || 'VIDEO_ASPECT_RATIO_PORTRAIT';
        const sessionId = `;${Date.now()}`;

        // ─── Get start frame from upstream Flow Image ───
        let startFrameMediaId = null;
        const useStartFrame = config.useStartFrame !== false; // default true

        if (useStartFrame) {
            // Priority 1: Pick random image from Flow Image's allImages (which have mediaId)
            if (input.allImages && input.allImages.length > 0) {
                const randomIdx = Math.floor(Math.random() * input.allImages.length);
                const picked = input.allImages[randomIdx];
                if (picked.mediaId) {
                    startFrameMediaId = picked.mediaId;
                    console.log(`[FlowVideo] Picked random image #${randomIdx + 1}/${input.allImages.length}, mediaId: ${startFrameMediaId}`);
                } else if (picked.imagePath || picked.fifeUrl) {
                    // Upload the image to get mediaId
                    let base64 = null;
                    if (picked.imagePath) {
                        try { base64 = (await readFile(picked.imagePath)).toString('base64'); } catch (_) { }
                    }
                    if (!base64 && picked.fifeUrl) {
                        try {
                            const r = await fetch(picked.fifeUrl);
                            base64 = Buffer.from(await r.arrayBuffer()).toString('base64');
                        } catch (_) { }
                    }
                    if (base64) {
                        startFrameMediaId = await uploadReferenceImage(token, projectId, base64);
                        console.log(`[FlowVideo] Uploaded random image #${randomIdx + 1}, mediaId: ${startFrameMediaId}`);
                    }
                }
            }

            // Priority 2: Single image from upstream (legacy)
            if (!startFrameMediaId && input.mediaId) {
                startFrameMediaId = input.mediaId;
                console.log('[FlowVideo] Using upstream mediaId:', startFrameMediaId);
            }

            if (!startFrameMediaId && input.imageData) {
                startFrameMediaId = await uploadReferenceImage(token, projectId, input.imageData);
                console.log('[FlowVideo] Uploaded upstream base64 as start frame, mediaId:', startFrameMediaId);
            }

            if (!startFrameMediaId) {
                console.log('[FlowVideo] ⚠️ No start frame available — video will be text-only.');
            }
        } else {
            console.log('[FlowVideo] Start frame disabled by config — video will be text-only.');
        }

        // ─── Build request (from HAR capture) ───
        // Delay before video token to avoid rate limiting after image batch
        await new Promise(r => setTimeout(r, 5000));
        const recaptchaToken = await fetchRecaptchaToken(credentials.metadata?.sessionCookies || '', 'VIDEO_GENERATION', instanceId);
        const batchId = uuidv4();

        const request = {
            aspectRatio,
            seed: Math.floor(Math.random() * 100000),
            textInput: {
                structuredPrompt: {
                    parts: [{ text: prompt }],
                },
            },
            videoModelKey,
            metadata: {},
        };

        if (startFrameMediaId) {
            request.startImage = { mediaId: startFrameMediaId };
        }

        const body = {
            // RETURN_SILENCED_VIDEOS: keep the video even if Veo's auto-generated
            // audio fails Google's RAI safety classifier. Default behavior
            // (BLOCK_SILENCED_VIDEOS) nukes the whole video on audio-only false
            // positives, which is what mcp-server hit on cooking-video prompts.
            mediaGenerationContext: { batchId, audioFailurePreference: 'RETURN_SILENCED_VIDEOS' },
            clientContext: {
                projectId,
                tool: TOOL,
                userPaygateTier: 'PAYGATE_TIER_TWO',
                sessionId,
                recaptchaContext: {
                    applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
                    ...(recaptchaToken && { token: recaptchaToken }),
                },
            },
            requests: [request],
            useV2ModelConfig: true,
        };

        console.log(`[FlowVideo] Submitting video generation, model=${videoModelKey}, aspect=${aspectRatio}, startFrame=${!!startFrameMediaId}...`);
        console.log('[FlowVideo] Request body:', JSON.stringify(body, null, 2).substring(0, 1000));

        let result;
        const MAX_RETRIES = 2;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            result = await browserFetch(
                `${API_BASE}/v1/video:batchAsyncGenerateVideoStartImage`,
                token,
                body,
                instanceId
            );

            if (result.ok) break;

            // Retry on 403 reCAPTCHA — keep Chrome warm (preserves trust score), wait, get fresh token
            if (result.status === 403 && result.body.includes('reCAPTCHA') && attempt < MAX_RETRIES) {
                console.log(`[FlowVideo] ⚠️ reCAPTCHA 403 — waiting 15s then retrying with fresh token (${attempt + 1}/${MAX_RETRIES})...`);
                await new Promise(r => setTimeout(r, 15000));
                const freshToken = await fetchRecaptchaToken(credentials.metadata?.sessionCookies || '', 'VIDEO_GENERATION', instanceId);
                body.clientContext.recaptchaContext = {
                    token: freshToken,
                    applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
                };
                continue;
            }

            if (result.status >= 500 && attempt < MAX_RETRIES) {
                console.log(`[FlowVideo] ⚠️ Server error ${result.status}, retrying (${attempt + 1}/${MAX_RETRIES})...`);
                await new Promise(r => setTimeout(r, 3000));
                continue;
            }
            if (result.status === 401) {
                throw new Error('🔑 Token Google Flow đã hết hạn. Vui lòng vào Credentials và tạo token mới.');
            }
            throw new Error(`Video generation failed (${result.status}): ${result.body.substring(0, 400)}`);
        }

        const data = JSON.parse(result.body);
        console.log('[FlowVideo] Response:', JSON.stringify(data).substring(0, 1000));

        // Extract all IDs from response
        const operationName = data.operations?.[0]?.operation?.name
            || data.operations?.[0]?.name
            || data.name || '';
        const mediaId = data.media?.[0]?.name || '';
        const workflowId = data.workflows?.[0]?.name || '';
        const status = data.operations?.[0]?.status || 'SUBMITTED';
        const remainingCredits = data.remainingCredits;

        console.log(`[FlowVideo] Video submitted!`);
        console.log(`[FlowVideo]   Operation: ${operationName}`);
        console.log(`[FlowVideo]   MediaId: ${mediaId}`);
        console.log(`[FlowVideo]   WorkflowId: ${workflowId}`);
        console.log(`[FlowVideo]   Status: ${status}`);
        console.log(`[FlowVideo]   Credits: ${remainingCredits}`);

        if (!operationName && !mediaId && !workflowId) {
            return {
                text: prompt,
                status: 'submitted',
                message: 'Video submitted but no IDs returned. Cannot poll.',
                rawResponse: JSON.stringify(data).substring(0, 500),
            };
        }

        // Poll until video generation is 100% complete
        console.log(`[FlowVideo] Starting polling for completion...`);
        const pollResult = await this._pollVideoOperation(token, projectId, operationName, mediaId, workflowId);

        console.log(`[FlowVideo] ✅ Video generation complete!`);

        // Upscale to 1080p if requested
        let downloadMediaId = mediaId;
        const resolution = config.resolution || '720p';
        if (resolution === '1080p') {
            console.log(`[FlowVideo] 🔄 Upscaling to 1080p...`);
            // Sticky-failure recovery: once the reCAPTCHA SDK on this page lifetime is flagged,
            // submit-time 403s and poll-time PUBLIC_ERROR_UNUSUAL_ACTIVITY come back-to-back until
            // the page is reloaded. Outer retry below does that reload programmatically.
            const MAX_OUTER_RETRIES = 1;
            const upscaleSessionCookies = credentials.metadata?.sessionCookies || '';
            let upsampledMediaId = null;
            // No inner lock: outer withFlowLock in execute() already serializes per-account.
            for (let outerAttempt = 0; outerAttempt <= MAX_OUTER_RETRIES; outerAttempt++) {
                if (outerAttempt > 0) {
                    console.warn(`[FlowVideo] Reloading Chrome page and retrying upscale (attempt ${outerAttempt + 1})...`);
                    await _reloadRecaptchaPage(instanceId);
                    await new Promise(r => setTimeout(r, 5000));
                }
                const upscaleRecaptchaToken = await fetchRecaptchaToken(upscaleSessionCookies, 'VIDEO_GENERATION', instanceId);
                const upsampleResult = await this._upscaleVideo(token, projectId, mediaId, aspectRatio, upscaleRecaptchaToken, instanceId, upscaleSessionCookies);
                if (!upsampleResult.upsampledMediaId) {
                    console.warn(`[FlowVideo] Upscale submit returned null (attempt ${outerAttempt + 1})`);
                    continue;
                }
                console.log(`[FlowVideo] Upscale submitted: ${upsampleResult.upsampledMediaId}`);
                try {
                    await this._pollUpscaleStatus(token, projectId, upsampleResult.upsampledMediaId);
                    upsampledMediaId = upsampleResult.upsampledMediaId;
                    break;
                } catch (e) {
                    const isStickyFailure = /UNUSUAL_ACTIVITY|HIGH_TRAFFIC|reCAPTCHA|UNKNOWN/i.test(e.message);
                    if (outerAttempt >= MAX_OUTER_RETRIES || !isStickyFailure) throw e;
                    console.warn(`[FlowVideo] Poll failed (${e.message}) — will reload page and retry once`);
                }
            }
            if (upsampledMediaId) {
                downloadMediaId = upsampledMediaId;
                console.log(`[FlowVideo] ✅ Upscale to 1080p complete!`);
            } else {
                console.warn(`[FlowVideo] ⚠️ Upscale failed, downloading 720p instead`);
            }
        }

        // Fetch the actual video download URL (poll response doesn't contain it)
        let videoUrl = '';
        const sessionCookies = credentials?.metadata?.sessionCookies || '';
        videoUrl = await this._fetchVideoDownloadUrl(token, projectId, downloadMediaId, sessionCookies, instanceId);

        // Download video to job folder if available
        let videoPath = '';
        if (videoUrl && context.jobDir) {
            try {
                console.log('[FlowVideo] Downloading video to job folder...');
                const videoRes = await fetch(videoUrl);
                if (videoRes.ok) {
                    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
                    const videoFilename = `video_${uuidv4().substring(0, 8)}.mp4`;
                    videoPath = join(context.jobDir, videoFilename);
                    await writeFile(videoPath, videoBuffer);
                    console.log(`[FlowVideo] ✅ Video saved: ${videoPath} (${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB)`);
                } else {
                    console.warn(`[FlowVideo] Video download failed: ${videoRes.status}`);
                }
            } catch (e) {
                console.warn('[FlowVideo] Could not download video:', e.message);
            }
        }

        // Broker keeps the warm Firefox session alive; its own 10-min idle timer
        // closes it automatically. No Node-side idle reset needed.

        return {
            text: prompt,
            status: 'completed',
            operationName,
            mediaId,
            videoUrl,
            videoPath,
            remainingCredits,
            model: videoModelKey,
            startFrameMediaId,
            message: `Video generation completed (${videoModelKey}).`,
        };
    }

    /**
     * Upscale a completed video from 720p to 1080p.
     * POST /v1/video:batchAsyncGenerateVideoUpsampleVideo
     */
    async _upscaleVideo(token, projectId, mediaId, aspectRatio, recaptchaToken = '', instanceId = 'default', sessionCookies = '') {
        const url = `${API_BASE}/v1/video:batchAsyncGenerateVideoUpsampleVideo`;
        const sessionId = `;${Date.now()}`;
        const body = {
            mediaGenerationContext: { batchId: uuidv4() },
            clientContext: {
                projectId,
                tool: TOOL,
                userPaygateTier: 'PAYGATE_TIER_TWO',
                sessionId,
                recaptchaContext: {
                    applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
                    ...(recaptchaToken && { token: recaptchaToken }),
                },
            },
            requests: [{
                resolution: 'VIDEO_RESOLUTION_1080P',
                aspectRatio: aspectRatio || 'VIDEO_ASPECT_RATIO_PORTRAIT',
                seed: Math.floor(Math.random() * 100000),
                videoModelKey: 'veo_3_1_upsampler_1080p',
                metadata: {},
                videoInput: { mediaId },
            }],
            useV2ModelConfig: true,
        };

        console.log(`[FlowVideo] Upscale request: POST ${url}`);
        let result;
        const MAX_RETRIES = 2;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            result = await browserFetch(url, token, body, instanceId);
            if (result.ok) break;

            if (result.status === 403 && result.body.includes('reCAPTCHA') && attempt < MAX_RETRIES) {
                console.warn(`[FlowVideo] ⚠️ Upscale reCAPTCHA 403 — reloading page + retrying (${attempt + 1}/${MAX_RETRIES})...`);
                // Page reload resets the SDK trust-score state — fetchRecaptchaToken alone
                // is not enough once the page lifetime gets flagged (manual UI also fails).
                await _reloadRecaptchaPage(instanceId);
                await new Promise(r => setTimeout(r, 5000));
                const freshToken = await fetchRecaptchaToken(sessionCookies, 'VIDEO_GENERATION', instanceId);
                body.clientContext.recaptchaContext = { token: freshToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' };
                continue;
            }
            if (result.status >= 500 && attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 3000)); continue; }
            console.error(`[FlowVideo] Upscale API error: ${result.status} - ${result.body.substring(0, 300)}`);
            return { upsampledMediaId: null };
        }

        const data = JSON.parse(result.body);
        console.log(`[FlowVideo] Upscale response: ${JSON.stringify(data).substring(0, 500)}`);

        // Extract upsampled media ID (e.g. "{mediaId}_upsampled")
        const upsampledMediaId = data.operations?.[0]?.operation?.name
            || data.media?.[0]?.name
            || `${mediaId}_upsampled`;

        return { upsampledMediaId };
    }

    /**
     * Poll upscale operation until complete.
     * Uses same endpoint as video generation polling.
     */
    async _pollUpscaleStatus(token, projectId, upsampledMediaId, maxAttempts = 60) {
        const POLL_URL = `${API_BASE}/v1/video:batchCheckAsyncVideoGenerationStatus`;
        const pollBody = JSON.stringify({
            media: [{ name: upsampledMediaId, projectId }],
        });

        console.log(`[FlowVideo] Polling upscale status for: ${upsampledMediaId}`);

        // Wait 5s before first poll
        await new Promise(r => setTimeout(r, 5000));

        for (let i = 0; i < maxAttempts; i++) {
            try {
                const res = await fetch(POLL_URL, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'text/plain;charset=UTF-8',
                        'Origin': 'https://labs.google',
                        'Referer': 'https://labs.google/',
                    },
                    body: pollBody,
                });

                if (!res.ok) {
                    console.warn(`[FlowVideo] Upscale poll ${i + 1}: HTTP ${res.status}`);
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                }

                const data = await res.json();
                const status = data.media?.[0]?.mediaMetadata?.mediaStatus?.mediaGenerationStatus || '';
                console.log(`[FlowVideo] Upscale poll ${i + 1}/${maxAttempts}: ${status}`);

                if (status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') {
                    return data;
                }
                if (status === 'MEDIA_GENERATION_STATUS_FAILED') {
                    const mediaStatus = data?.media?.[0]?.mediaMetadata?.mediaStatus;
                    const errCode = mediaStatus?.error?.code;
                    const errMsg = mediaStatus?.error?.message;
                    const reasons = mediaStatus?.failureReasons || [];
                    const reason = errMsg || reasons[0] || 'FAILED';
                    console.error(`[FlowVideo] ❌ Upscale FAILED: ${reason}${errCode ? ` (code=${errCode})` : ''}`);
                    if (!errMsg && !reasons.length) {
                        console.error('[FlowVideo] Full poll response:', JSON.stringify(data, null, 2));
                    }
                    throw new Error(`Video upscale failed: ${reason}`);
                }
            } catch (e) {
                if (e.message.startsWith('Video upscale failed')) throw e;
                console.warn(`[FlowVideo] Upscale poll error: ${e.message}`);
            }

            await new Promise(r => setTimeout(r, 5000));
        }

        throw new Error('Video upscale timed out after 5 minutes');
    }

    /**
     * Fetch the actual video download URL after generation completes.
     * The poll response only contains metadata, not a download URL.
     * Uses the tRPC redirect endpoint to get a signed GCS URL.
     */
    async _fetchVideoDownloadUrl(token, projectId, mediaId, sessionCookies = '', instanceId = 'default') {
        const tRPCUrl = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${mediaId}`;

        // Strategy 0 (browser-context tRPC) removed: broker exposes only POST flow-fetch.
        // Strategies 1-3 (Node-side cookie tRPC + direct GCS + aisandbox fallback) cover
        // the same ground; if signed-URL retrieval starts failing on broker-only setups,
        // add a /sessions/{id}/browser-get endpoint to the broker and re-enable here.

        // Strategy 1: tRPC redirect via Node.js fetch (needs Google session cookie)
        // IMPORTANT: Only send __Secure-next-auth.session-token — sending ALL Google cookies
        // causes 400 Bad Request because the endpoint rejects the bloated cookie header.
        try {
            const fullCookies = sessionCookies || '';
            // Extract only the session token cookie (the only one tRPC needs)
            const sessionTokenCookie = fullCookies.split(';')
                .map(c => c.trim())
                .find(c => c.startsWith('__Secure-next-auth.session-token='));
            const cookieHeader = sessionTokenCookie || fullCookies;
            console.log(`[FlowVideo] Trying tRPC redirect via Node.js (cookie: ${sessionTokenCookie ? 'session-token only' : 'full'}, ${cookieHeader.length} chars)...`);
            const tRPCHeaders = {
                'Referer': 'https://labs.google/',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
            };
            if (cookieHeader) tRPCHeaders['Cookie'] = cookieHeader;
            const res = await fetch(tRPCUrl, {
                redirect: 'manual',
                headers: tRPCHeaders,
            });
            console.log(`[FlowVideo] tRPC status: ${res.status}`);
            if ([301, 302, 307, 308].includes(res.status)) {
                const location = res.headers.get('location');
                if (location) {
                    console.log(`[FlowVideo] ✅ Got signed URL via tRPC redirect`);
                    return location;
                }
            }
            if (res.ok) {
                const text = await res.text();
                console.log(`[FlowVideo] tRPC body: ${text.substring(0, 300)}`);
                const match = text.match(/(https?:\/\/storage\.googleapis\.com\/[^"'\s]+)/);
                if (match) return match[1];
            }
            // Log error body for non-redirect, non-ok responses (e.g. 400)
            if (!res.ok && ![301, 302, 307, 308].includes(res.status)) {
                try {
                    const errBody = await res.text();
                    console.log(`[FlowVideo] tRPC error body: ${errBody.substring(0, 300)}`);
                } catch (_) {}
            }
        } catch (e) {
            console.log(`[FlowVideo] tRPC error: ${e.message}`);
        }

        // Strategy 2: Try direct GCS download (unsigned — may work for public/temp access)
        const directGcsUrl = `https://storage.googleapis.com/ai-sandbox-videofx/video/${mediaId}`;
        try {
            console.log(`[FlowVideo] Trying direct GCS URL (unsigned)...`);
            const res = await fetch(directGcsUrl, { method: 'HEAD' });
            console.log(`[FlowVideo] Direct GCS status: ${res.status}, content-type: ${res.headers.get('content-type')}`);
            if (res.ok) {
                console.log(`[FlowVideo] ✅ Direct GCS URL works without signing!`);
                return directGcsUrl;
            }
        } catch (e) {
            console.log(`[FlowVideo] Direct GCS error: ${e.message}`);
        }

        // Strategy 3: aisandbox API with Bearer token
        const apiEndpoints = [
            { url: `${API_BASE}/v1/video:getSignedUrl`, method: 'POST', body: { name: mediaId, projectId } },
            { url: `${API_BASE}/v1/media:getSignedUrl`, method: 'POST', body: { name: mediaId, projectId } },
        ];
        for (const ep of apiEndpoints) {
            try {
                console.log(`[FlowVideo] Trying ${ep.url}...`);
                const res = await fetch(ep.url, {
                    method: ep.method,
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'text/plain;charset=UTF-8',
                        'Origin': 'https://labs.google',
                        'Referer': 'https://labs.google/',
                    },
                    body: ep.body ? JSON.stringify(ep.body) : undefined,
                    signal: AbortSignal.timeout(10000),
                });
                console.log(`[FlowVideo] API status: ${res.status}`);
                if (res.ok) {
                    const data = await res.json();
                    const dataStr = JSON.stringify(data);
                    console.log(`[FlowVideo] API response: ${dataStr.substring(0, 300)}`);
                    const match = dataStr.match(/(https?:\/\/[^"]+)/);
                    if (match) return match[1];
                }
            } catch (e) {
                console.log(`[FlowVideo] API error: ${e.message}`);
            }
        }

        console.log(`[FlowVideo] ⚠️ Could not get video download URL`);
        return '';
    }

    /**
     * Poll for video generation completion using the real Google Flow endpoint.
     * Uses: POST /v1/video:batchCheckAsyncVideoGenerationStatus
     * Body: {"media":[{"name":"<mediaId>","projectId":"<projectId>"}]}
     * This is exactly what the Google Flow UI polls every ~10s.
     */
    async _pollVideoOperation(token, projectId, operationName, mediaId, workflowId, maxAttempts = 120) {
        const POLL_URL = `${API_BASE}/v1/video:batchCheckAsyncVideoGenerationStatus`;
        const pollBody = JSON.stringify({
            media: [{ name: mediaId, projectId }],
        });

        console.log(`[FlowVideo] Polling endpoint: ${POLL_URL}`);
        console.log(`[FlowVideo] Poll body: ${pollBody}`);

        // Veo render typically takes 30-60s; start polling at 8s to catch the early-finish case.
        await new Promise(r => setTimeout(r, 8000));

        for (let i = 0; i < maxAttempts; i++) {
            try {
                const res = await fetch(POLL_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'text/plain;charset=UTF-8',
                        'Origin': 'https://labs.google',
                        'Referer': 'https://labs.google/',
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                    },
                    body: pollBody,
                });

                if (!res.ok) {
                    // If no auth works, try with Bearer token
                    const resWithAuth = await fetch(POLL_URL, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'text/plain;charset=UTF-8',
                            'Origin': 'https://labs.google',
                            'Referer': 'https://labs.google/',
                            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                        },
                        body: pollBody,
                    });

                    if (!resWithAuth.ok) {
                        if (i % 4 === 0) {
                            console.log(`[FlowVideo] Poll ${i + 1}: status=${res.status}/${resWithAuth.status}`);
                        }
                        await new Promise(r => setTimeout(r, 10000));
                        continue;
                    }

                    // Auth version worked
                    const data = await resWithAuth.json();
                    const result = this._checkBatchStatus(data, mediaId, i);
                    if (result) return result;
                    await new Promise(r => setTimeout(r, 10000));
                    continue;
                }

                const data = await res.json();
                const result = this._checkBatchStatus(data, mediaId, i);
                if (result) return result;

            } catch (e) {
                // Re-throw fatal errors (FAILED/ERROR status from _checkBatchStatus)
                if (e.message.includes('failed with status') || e.message.includes('generation failed')) {
                    throw e;
                }
                if (i % 4 === 0) console.log(`[FlowVideo] Poll ${i + 1}: error: ${e.message}`);
            }

            await new Promise(r => setTimeout(r, 10000)); // poll every 10s
        }

        throw new Error('Video generation timed out after 20 minutes.');
    }

    /**
     * Check batchCheckAsyncVideoGenerationStatus response for completion.
     */
    _checkBatchStatus(data, mediaId, pollIndex) {
        const dataStr = JSON.stringify(data);

        // Log progress on every 4th poll or when status changes
        const statusMatch = dataStr.match(/MEDIA_GENERATION_STATUS_(\w+)/);
        const currentStatus = statusMatch ? statusMatch[1] : 'UNKNOWN';

        // Look for percentage in link_text or in response data
        const pctMatch = dataStr.match(/(\d+)%/) || dataStr.match(/percentComplete[":]*\s*(\d+)/);
        const pct = pctMatch ? pctMatch[1] : '';

        if (pollIndex % 2 === 0 || currentStatus === 'SUCCEEDED' || currentStatus === 'COMPLETE') {
            console.log(`[FlowVideo] Poll ${pollIndex + 1}: status=${currentStatus}${pct ? `, progress=${pct}%` : ''}`);
            if (pollIndex % 8 === 0) {
                console.log(`[FlowVideo]   Response: ${dataStr.substring(0, 500)}`);
            }
        }

        // Check for completion - various patterns
        if (currentStatus === 'SUCCEEDED' || currentStatus === 'SUCCESSFUL' || currentStatus === 'COMPLETE' || currentStatus === 'COMPLETED') {
            console.log(`[FlowVideo] ✅ Video generation COMPLETE! Status: ${currentStatus}`);
            console.log(`[FlowVideo] Full response: ${dataStr.substring(0, 1000)}`);
            return this._extractVideoResult(data);
        }

        // Check for error
        if (currentStatus === 'FAILED' || currentStatus === 'ERROR') {
            const mediaStatus = data?.media?.[0]?.mediaMetadata?.mediaStatus;
            const errCode = mediaStatus?.error?.code;
            const errMsg = mediaStatus?.error?.message;
            const reasons = mediaStatus?.failureReasons || [];
            const reason = errMsg || reasons[0] || currentStatus;
            console.error(`[FlowVideo] ❌ Generation FAILED: ${reason}${errCode ? ` (code=${errCode})` : ''}`);
            if (!errMsg && !reasons.length) {
                console.error('[FlowVideo] Full poll response:', JSON.stringify(data, null, 2));
            }
            throw new Error(`Video generation failed: ${reason}`);
        }

        // Check media array for status
        if (data.media && Array.isArray(data.media)) {
            for (const m of data.media) {
                const mStatus = m.status || m.mediaMetadata?.status || '';
                if (mStatus.includes('SUCCEEDED') || mStatus.includes('SUCCESSFUL') || mStatus.includes('COMPLETE')) {
                    console.log(`[FlowVideo] ✅ Media complete! Status: ${mStatus}`);
                    return this._extractVideoResult(data);
                }
            }
        }

        // Check operations array
        if (data.operations && Array.isArray(data.operations)) {
            for (const op of data.operations) {
                const opStatus = op.status || '';
                if (opStatus.includes('SUCCEEDED') || opStatus.includes('COMPLETE')) {
                    console.log(`[FlowVideo] ✅ Operation complete! Status: ${opStatus}`);
                    return this._extractVideoResult(data);
                }
            }
        }

        // Check if done flag
        if (data.done === true) {
            console.log(`[FlowVideo] ✅ Done flag is true!`);
            return this._extractVideoResult(data);
        }

        return null; // Not done yet
    }

    _extractVideoResult(data) {
        const media = data.response?.generatedMedia
            || data.response?.media
            || data.result?.generatedMedia
            || data.media
            || [];

        // Debug: log structure of first media item
        if (media.length > 0) {
            console.log(`[FlowVideo] Media[0] keys: ${Object.keys(media[0]).join(', ')}`);
            if (media[0].video) {
                console.log(`[FlowVideo] Media[0].video keys: ${Object.keys(media[0].video).join(', ')}`);
                if (media[0].video.generatedVideo) {
                    console.log(`[FlowVideo] generatedVideo keys: ${Object.keys(media[0].video.generatedVideo).join(', ')}`);
                    console.log(`[FlowVideo] generatedVideo JSON: ${JSON.stringify(media[0].video.generatedVideo).substring(0, 800)}`);
                }
            }
        }

        let videoUrl = '';

        // 1. Try known nested paths
        if (media.length > 0) {
            const m = media[0];
            videoUrl = m?.video?.uri
                || m?.video?.generatedVideo?.fifeUrl
                || m?.video?.generatedVideo?.uri
                || m?.video?.generatedVideo?.signedUri
                || m?.video?.generatedVideo?.encodedVideoUri
                || m?.video?.generatedVideo?.videoUrl
                || m?.video?.generatedVideo?.url
                || m?.video?.fifeUrl
                || m?.fifeUrl
                || m?.uri
                || '';
        }

        if (!videoUrl) {
            videoUrl = data.response?.videoUrl || data.result?.videoUrl || '';
        }

        // 2. Regex scan entire JSON for URLs
        if (!videoUrl) {
            const dataStr = JSON.stringify(data);

            // Look for signed GCS URLs (storage.googleapis.com)
            const gcsMatch = dataStr.match(/"(https?:\/\/storage\.googleapis\.com\/[^"]+)"/);
            if (gcsMatch) {
                videoUrl = gcsMatch[1];
                console.log(`[FlowVideo] Found video URL via regex (GCS signed URL)`);
            }

            // Look for fifeUrl
            if (!videoUrl) {
                const fifeMatch = dataStr.match(/"fifeUrl"\s*:\s*"(https?:\/\/[^"]+)"/);
                if (fifeMatch) {
                    videoUrl = fifeMatch[1];
                    console.log(`[FlowVideo] Found video URL via regex (fifeUrl)`);
                }
            }

            // Look for any uri
            if (!videoUrl) {
                const uriMatch = dataStr.match(/"uri"\s*:\s*"(https?:\/\/[^"]+)"/);
                if (uriMatch) {
                    videoUrl = uriMatch[1];
                    console.log(`[FlowVideo] Found video URL via regex (uri)`);
                }
            }

            if (!videoUrl) {
                console.log(`[FlowVideo] Full response: ${dataStr.substring(0, 1000)}`);
            }
        }

        console.log(`[FlowVideo] Extracted video URL: ${videoUrl ? videoUrl.substring(0, 200) + '...' : '(none)'}`);
        return { videoUrl };
    }
}
