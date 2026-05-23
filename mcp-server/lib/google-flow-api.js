/**
 * Google Flow API — Pure functions extracted from connector.js
 * No BaseConnector dependency, no Express/Prisma imports.
 */

import fetch from 'node-fetch';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
    fetchRecaptchaToken, clearRecaptchaToken, browserFetch,
    closeRecaptchaBrowser, deleteChromePoolEntry, getAccountInstanceId,
    buildHeaders, getChromePoolInstance, reloadRecaptchaPage,
} from './recaptcha.js';
import { refreshToken } from './token-refresh.js';

const API_BASE = 'https://aisandbox-pa.googleapis.com';
const TOOL = 'PINHOLE';

/**
 * Handle 401 by auto-refreshing token from Chrome page.
 * Returns fresh token if successful, throws otherwise.
 */
async function handle401(instanceId) {
    console.error('[FlowAPI] 🔑 Token expired — attempting auto-refresh...');
    const newToken = await refreshToken(instanceId);
    if (newToken) {
        console.error('[FlowAPI] 🔑 Token refreshed successfully!');
        return newToken;
    }
    throw new Error('🔑 Token expired and auto-refresh failed. Please update GOOGLE_FLOW_TOKEN in .env manually.');
}

// Model mappings
export const IMAGE_MODELS = {
    'banana2': 'NARWHAL',
    'banana_pro': 'GEM_PIX_2',
};

export const ASPECT_RATIO_MAP = {
    '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
    '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
    '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
    '4:3': 'IMAGE_ASPECT_RATIO_LANDSCAPE_4_3',
    '3:4': 'IMAGE_ASPECT_RATIO_PORTRAIT_3_4',
};

// Video model keys: keyed by [model][mode][duration]. Default duration is 8s.
// All entries below were verified by network capture from labs.google/fx/tools/flow
// (Flow UI) on 2026-05-19.
// Quality at 9:16 (portrait): 8s splits into landscape/portrait keys; 4s/6s share a unified key.
// r2v silently downgrades for 4s/6s — only 8s supported.
export const VIDEO_MODELS = {
    'veo3_lite_low': {
        t2v: {
            8: 'veo_3_1_t2v_lite_low_priority',
            6: 'veo_3_1_t2v_lite_6s_low_priority',
            4: 'veo_3_1_t2v_lite_4s_low_priority',
        },
        i2v: {
            8: 'veo_3_1_i2v_lite_low_priority',
            6: 'veo_3_1_i2v_s_lite_6s_low_priority',
            4: 'veo_3_1_i2v_s_lite_4s_low_priority',
        },
        i2v_se: {
            8: 'veo_3_1_interpolation_lite_low_priority',
            6: 'veo_3_1_i2v_s_lite_6s_fl_low_priority',
            4: 'veo_3_1_i2v_s_lite_4s_fl_low_priority',
        },
        r2v: { 8: 'veo_3_1_r2v_lite_low_priority' },
    },
    'veo3_quality': {
        t2v: {
            8: 'veo_3_1_t2v',
            6: 'veo_3_1_t2v_quality_6s',
            4: 'veo_3_1_t2v_quality_4s',
        },
        i2v: {
            8: 'veo_3_1_i2v_s',
            6: 'veo_3_1_i2v_s_quality_6s',
            4: 'veo_3_1_i2v_s_quality_4s',
        },
        i2v_portrait: { 8: 'veo_3_1_i2v_s_portrait' },
        i2v_se: {
            8: 'veo_3_1_i2v_s_fl',
            6: 'veo_3_1_i2v_s_quality_6s_fl',
            4: 'veo_3_1_i2v_s_quality_4s_fl',
        },
        i2v_se_portrait: { 8: 'veo_3_1_i2v_s_portrait_fl' },
        // r2v: NOT SUPPORTED for quality model
    },
    // Omni Flash: a separate model family using 'abra_' prefix. Supports t2v and r2v.
    // i2v / i2v_se are silently downgraded to t2v by Veo even if start/end frame
    // images are attached in the UI — so we refuse those combinations upfront.
    'omni_flash': {
        t2v: {
            10: 'abra_t2v_10s',
            8:  'abra_t2v_8s',
            6:  'abra_t2v_6s',
            4:  'abra_t2v_4s',
        },
        r2v: {
            10: 'abra_r2v_10s',
            8:  'abra_r2v_8s',
            6:  'abra_r2v_6s',
            4:  'abra_r2v_4s',
        },
        // i2v / i2v_se: NOT SUPPORTED
    },
};

/**
 * Get the correct video model key for a given model name, generation mode, aspect ratio, and duration.
 * Quality 4s/6s for image modes use unified keys (no portrait variant) — only 8s
 * has portrait-specific keys.
 * @param {string} model - User-facing model name (e.g. 'veo3_lite_low', 'veo3_quality')
 * @param {'t2v'|'i2v'|'i2v_se'|'r2v'} mode - Generation mode
 * @param {string} [aspectRatio] - Target aspect ratio (e.g. '9:16', '16:9')
 * @param {number} [duration=8] - Video length in seconds (4, 6, or 8)
 * @returns {string|null} Model key, or null if mode not supported for this (model, duration)
 */
export function getVideoModelKey(model, mode, aspectRatio, duration = 8) {
    const tier = VIDEO_MODELS[model] || VIDEO_MODELS['veo3_lite_low'];
    const dur = Number(duration) || 8;

    // Quality 8s portrait split: only at 8s does i2v / i2v_se have separate portrait keys.
    // 4s/6s use the unified i2v / i2v_se key for both aspect ratios.
    const isPortraitImageMode = model === 'veo3_quality' && aspectRatio === '9:16' && dur === 8 && (mode === 'i2v' || mode === 'i2v_se');
    const modeKey = isPortraitImageMode ? `${mode}_portrait` : mode;
    const modeMap = tier[modeKey];
    if (!modeMap) return null;

    return modeMap[dur] || null;
}

/**
 * Build structuredPrompt parts for inline @-references. Mirrors what Google Flow's UI sends
 * when the user types `@` and picks a media item. Each @LABEL in the prompt is replaced with
 * a reference part `{ reference: { media: { handle, mediaId } } }`. The surrounding text
 * becomes regular `{ text: '...' }` parts.
 *
 * Labels are matched literally with a leading `@`; matching is greedy on the label string,
 * so longer labels take precedence over shorter prefixes.
 *
 * @param {string} prompt - User prompt that may contain `@LABEL` markers.
 * @param {Array<{mediaId: string, label: string}>} inlineRefs - Resolved references.
 * @returns {Array<object>} structuredPrompt.parts array.
 */
export function buildInlineReferenceParts(prompt, inlineRefs) {
    if (!inlineRefs?.length) return [{ text: prompt }];

    // Match longest labels first to avoid prefix collisions.
    const sortedRefs = [...inlineRefs].sort((a, b) => b.label.length - a.label.length);
    const parts = [];
    let cursor = 0;

    while (cursor < prompt.length) {
        let matched = null;
        if (prompt[cursor] === '@') {
            for (const ref of sortedRefs) {
                if (prompt.startsWith('@' + ref.label, cursor)) {
                    matched = ref;
                    break;
                }
            }
        }
        if (matched) {
            parts.push({
                reference: { media: { handle: matched.label, mediaId: matched.mediaId } },
            });
            cursor += 1 + matched.label.length;
        } else {
            // Accumulate text until the next @LABEL or end of string.
            let nextAt = prompt.indexOf('@', cursor + 1);
            if (nextAt < 0) nextAt = prompt.length;
            const chunk = prompt.slice(cursor, nextAt);
            const last = parts[parts.length - 1];
            if (last && last.text !== undefined) {
                last.text += chunk;
            } else {
                parts.push({ text: chunk });
            }
            cursor = nextAt;
        }
    }

    return parts.length ? parts : [{ text: prompt }];
}

export const VIDEO_ASPECT_RATIO_MAP = {
    '16:9': 'VIDEO_ASPECT_RATIO_LANDSCAPE',
    '9:16': 'VIDEO_ASPECT_RATIO_PORTRAIT',
    '1:1': 'VIDEO_ASPECT_RATIO_SQUARE',
};

/**
 * Auto-refresh token if expired or near expiry.
 */
export async function ensureFreshToken(credentials, prisma) {
    if (!credentials?.token || !credentials?.metadata?.sessionCookies) {
        return credentials;
    }
    const meta = credentials.metadata || {};
    let needsRefresh = false;

    if (meta.tokenExpiresAt) {
        const remainingMs = new Date(meta.tokenExpiresAt).getTime() - Date.now();
        if (remainingMs <= 5 * 60 * 1000) {
            console.error(`[GoogleFlow] Token expires in ${Math.floor(remainingMs / 60000)}m — refreshing...`);
            needsRefresh = true;
        }
    } else if (meta.lastRefreshed) {
        const elapsed = Date.now() - new Date(meta.lastRefreshed).getTime();
        if (elapsed > 55 * 60 * 1000) {
            console.error(`[GoogleFlow] Token refreshed ${Math.round(elapsed / 60000)}m ago — refreshing...`);
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

        if (!sessionRes.ok) return credentials;
        const sessionData = await sessionRes.json();
        if (!sessionData.access_token) return credentials;

        const newToken = sessionData.access_token;
        const expiresAt = sessionData.expires || null;
        console.error('[GoogleFlow] ✅ Auto-refreshed token!');

        const newMeta = {
            ...meta,
            lastRefreshed: new Date().toISOString(),
            tokenExpiresAt: expiresAt,
            userName: sessionData.user?.name || meta.userName,
            userEmail: sessionData.user?.email || meta.userEmail,
        };

        await prisma.credential.update({
            where: { id: credentials.id },
            data: { token: newToken, metadata: JSON.stringify(newMeta) },
        });

        return { ...credentials, token: newToken, metadata: newMeta };
    } catch (e) {
        console.error('[GoogleFlow] Auto-refresh failed:', e.message);
        return credentials;
    }
}

/**
 * Upload reference image to Google Flow. Returns mediaId.
 */
export async function uploadReferenceImage(token, projectId, imageBase64) {
    console.error('[FlowImage] Uploading reference image...');
    const body = {
        clientContext: { projectId, tool: TOOL },
        imageBytes: imageBase64,
    };

    let currentToken = token;
    for (let attempt = 0; attempt <= 1; attempt++) {
        const res = await fetch(`${API_BASE}/v1/flow/uploadImage`, {
            method: 'POST',
            headers: buildHeaders(currentToken),
            body: JSON.stringify(body),
        });

        if (res.ok) {
            const data = await res.json();
            const mediaId = data.media?.name || data.mediaId || data.name || data.id;
            if (!mediaId) throw new Error('Upload succeeded but no mediaId returned.');
            console.error('[FlowImage] Reference image uploaded, mediaId:', mediaId);
            return mediaId;
        }

        const errText = await res.text();
        if (res.status === 401 && attempt === 0) {
            currentToken = await handle401();
            continue;
        }
        throw new Error(`Upload failed (${res.status}): ${errText.substring(0, 400)}`);
    }
}

/**
 * Generate a single image via batchGenerateImages.
 */
export async function batchGenerateImages(token, projectId, opts) {
    const { prompt, modelName, aspectRatio, referenceMediaIds, seed, recaptchaToken, batchId, sessionId, sessionCookies, instanceId } = opts;

    const recaptchaContext = {
        applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
        ...(recaptchaToken && { token: recaptchaToken }),
    };

    const request = {
        clientContext: { recaptchaContext, projectId, tool: TOOL, sessionId },
        imageModelName: modelName,
        imageAspectRatio: aspectRatio,
        structuredPrompt: { parts: [{ text: prompt }] },
        seed: seed || Math.floor(Math.random() * 2147483647),
    };

    if (referenceMediaIds?.length > 0) {
        request.imageInputs = referenceMediaIds.map(id => ({
            imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE',
            name: id,
        }));
    }

    const body = {
        clientContext: { recaptchaContext, projectId, tool: TOOL, sessionId },
        mediaGenerationContext: { batchId },
        useNewMedia: true,
        requests: [request],
    };

    console.error(`[FlowImage] Generating image, model=${modelName}, ratio=${aspectRatio}...`);

    const apiUrl = `${API_BASE}/v1/projects/${projectId}/flowMedia:batchGenerateImages`;
    let result;
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        result = await browserFetch(apiUrl, token, body, instanceId);
        if (result.ok) break;

        if (result.status === 403 && result.body.includes('reCAPTCHA') && attempt < MAX_RETRIES) {
            console.error(`[FlowImage] ⚠️ reCAPTCHA 403 — retrying (${attempt + 1}/${MAX_RETRIES})...`);
            // Don't close Chrome — warm browser preserves trust score (commit 6f03021).
            // Gesture sim on next token fetch already boosts score; 15s is enough cooldown.
            await new Promise(r => setTimeout(r, 15000));
            const freshToken = await fetchRecaptchaToken(sessionCookies, 'IMAGE_GENERATION', instanceId);
            body.clientContext.recaptchaContext = { token: freshToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' };
            continue;
        }
        if (result.status >= 500 && attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, 3000));
            continue;
        }
        if (result.body.includes('PUBLIC_ERROR_MINOR_INPUT_IMAGE')) {
            throw new Error('⚠️ Reference image content is not supported. Try a different image.');
        }
        if (result.status === 401 && attempt < MAX_RETRIES) { token = await handle401(instanceId); continue; }
        throw new Error(`Generation failed (${result.status}): ${result.body.substring(0, 400)}`);
    }

    const data = JSON.parse(result.body);
    const mediaItems = data.media || [];
    if (!mediaItems.length) throw new Error('No images returned.');

    return mediaItems.map(item => ({
        mediaId: item.name,
        fifeUrl: item.image?.generatedImage?.fifeUrl,
        dimensions: item.image?.dimensions,
        seed: item.image?.generatedImage?.seed,
    }));
}

/**
 * Download image from URL and save to disk.
 */
export async function downloadAndSaveImage(fifeUrl, outputDir, prefix = 'gflow') {
    const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
    const filepath = join(outputDir, filename);
    const imgRes = await fetch(fifeUrl);
    if (!imgRes.ok) throw new Error(`Failed to download image (${imgRes.status})`);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    await writeFile(filepath, buffer);
    return { filepath, filename };
}

/**
 * Upscale an image to 2K or 4K.
 */
export async function upscaleImage(token, projectId, mediaId, resolution, recaptchaToken = '', instanceId = 'default', sessionCookies = '') {
    const targetResolution = resolution === '4k' ? 'UPSAMPLE_IMAGE_RESOLUTION_4K' : 'UPSAMPLE_IMAGE_RESOLUTION_2K';
    const body = {
        mediaId,
        targetResolution,
        clientContext: {
            recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
            projectId, tool: TOOL,
            userPaygateTier: 'PAYGATE_TIER_TWO',
            sessionId: `;${Date.now()}`,
        },
    };

    console.error(`[FlowImage] Upscale request: ${targetResolution}`);
    const endpoint = `${API_BASE}/v1/flow/upsampleImage`;
    let result;
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        result = await browserFetch(endpoint, token, body, instanceId);
        if (result.ok) break;

        if (result.status === 403 && result.body.includes('reCAPTCHA') && attempt < MAX_RETRIES) {
            console.error(`[FlowImage] ⚠️ Upscale reCAPTCHA 403 — reloading page + retrying (${attempt + 1}/${MAX_RETRIES})...`);
            // Page reload resets the SDK trust-score state — fetchRecaptchaToken alone
            // is not enough once the page lifetime gets flagged (manual UI also fails).
            await reloadRecaptchaPage(instanceId);
            await new Promise(r => setTimeout(r, 5000));
            const freshToken = await fetchRecaptchaToken(sessionCookies, 'IMAGE_GENERATION', instanceId);
            body.clientContext.recaptchaContext = { token: freshToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' };
            continue;
        }
        if (result.status >= 500 && attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 3000)); continue; }
        if (result.status === 401 && attempt < MAX_RETRIES) { token = await handle401(instanceId); continue; }
        throw new Error(`Image upscale failed (${result.status}): ${result.body.substring(0, 300)}`);
    }

    const data = JSON.parse(result.body);
    return { encodedImage: data.encodedImage || null };
}

/**
 * Calculate crop coordinates to fit an image into a target video aspect ratio.
 * Centers the crop on the image.
 */
export function calculateCropCoordinates(imgWidth, imgHeight, targetRatio) {
    // targetRatio: '16:9' => 16/9, '9:16' => 9/16, '1:1' => 1
    const [rw, rh] = targetRatio.split(':').map(Number);
    const targetAR = rw / rh;
    const imgAR = imgWidth / imgHeight;

    if (Math.abs(imgAR - targetAR) < 0.05) {
        // Already matching — no crop needed
        return { top: 0, left: 0, bottom: 1, right: 1 };
    }

    if (imgAR > targetAR) {
        // Image is wider than target — crop left/right
        const cropWidth = (imgHeight * targetAR) / imgWidth;
        const margin = (1 - cropWidth) / 2;
        return { top: 0, left: margin, bottom: 1, right: 1 - margin };
    } else {
        // Image is taller than target — crop top/bottom
        const cropHeight = (imgWidth / targetAR) / imgHeight;
        const margin = (1 - cropHeight) / 2;
        return { top: margin, left: 0, bottom: 1 - margin, right: 1 };
    }
}

/**
 * Submit video generation — handles both text-only and start-frame modes.
 * Uses different endpoint and model key depending on whether startFrameMediaId is provided.
 */
export async function submitVideoGeneration(token, projectId, opts) {
    const { prompt, videoModelKey, aspectRatio, startFrameMediaId, recaptchaToken, instanceId, sessionCookies, startFrameCrop } = opts;
    const batchId = uuidv4();
    const sessionId = `;${Date.now()}`;
    const hasStartFrame = !!startFrameMediaId;

    // Choose endpoint based on mode
    const endpoint = hasStartFrame
        ? `${API_BASE}/v1/video:batchAsyncGenerateVideoStartImage`
        : `${API_BASE}/v1/video:batchAsyncGenerateVideoText`;

    const request = {
        aspectRatio,
        seed: Math.floor(Math.random() * 100000),
        textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
        videoModelKey,
        metadata: {},
    };

    if (hasStartFrame) {
        request.startImage = {
            mediaId: startFrameMediaId,
            ...(startFrameCrop && { cropCoordinates: startFrameCrop }),
        };
    }

    const body = {
        mediaGenerationContext: {
            batchId,
            audioFailurePreference: 'RETURN_SILENCED_VIDEOS',
        },
        clientContext: {
            projectId, tool: TOOL,
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

    const mode = hasStartFrame ? 'i2v' : 't2v';
    console.error(`[FlowVideo] Submitting ${mode} video, model=${videoModelKey}, aspect=${aspectRatio}, endpoint=${hasStartFrame ? 'StartImage' : 'Text'}...`);

    let result;
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        result = await browserFetch(endpoint, token, body, instanceId);
        if (result.ok) break;

        if (result.status === 403 && result.body.includes('reCAPTCHA') && attempt < MAX_RETRIES) {
            console.error(`[FlowVideo] ⚠️ reCAPTCHA 403 — retrying...`);
            // Don't close Chrome — warm browser preserves trust score (commit 6f03021).
            // Gesture sim on next token fetch already boosts score; 15s is enough cooldown.
            await new Promise(r => setTimeout(r, 15000));
            const freshToken = await fetchRecaptchaToken(sessionCookies, 'VIDEO_GENERATION', instanceId);
            body.clientContext.recaptchaContext = { token: freshToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' };
            continue;
        }
        if (result.status >= 500 && attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 3000)); continue; }
        if (result.status === 401 && attempt < MAX_RETRIES) { token = await handle401(instanceId); continue; }
        throw new Error(`Video generation failed (${result.status}): ${result.body.substring(0, 400)}`);
    }

    const data = JSON.parse(result.body);
    return {
        operationName: data.operations?.[0]?.operation?.name || data.operations?.[0]?.name || data.name || '',
        mediaId: data.media?.[0]?.name || '',
        workflowId: data.workflows?.[0]?.name || '',
        status: data.operations?.[0]?.status || 'SUBMITTED',
        remainingCredits: data.remainingCredits,
    };
}

/**
 * Submit video generation with start AND end frame. Uses a different endpoint and model.
 */
export async function submitVideoGenerationStartEnd(token, projectId, opts) {
    const { prompt, videoModelKey, aspectRatio, startFrameMediaId, endFrameMediaId,
            startFrameCrop, endFrameCrop, recaptchaToken, instanceId, sessionCookies } = opts;
    const batchId = uuidv4();
    const sessionId = `;${Date.now()}`;

    const request = {
        aspectRatio,
        seed: Math.floor(Math.random() * 100000),
        textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
        videoModelKey,
        metadata: {},
        startImage: {
            mediaId: startFrameMediaId,
            ...(startFrameCrop && { cropCoordinates: startFrameCrop }),
        },
        endImage: {
            mediaId: endFrameMediaId,
            ...(endFrameCrop && { cropCoordinates: endFrameCrop }),
        },
    };

    const body = {
        mediaGenerationContext: {
            batchId,
            audioFailurePreference: 'RETURN_SILENCED_VIDEOS',
        },
        clientContext: {
            projectId, tool: TOOL,
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

    console.error(`[FlowVideo] Submitting start+end frame video, model=${videoModelKey}...`);

    let result;
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        result = await browserFetch(`${API_BASE}/v1/video:batchAsyncGenerateVideoStartAndEndImage`, token, body, instanceId);
        if (result.ok) break;

        if (result.status === 403 && result.body.includes('reCAPTCHA') && attempt < MAX_RETRIES) {
            console.error(`[FlowVideo] ⚠️ reCAPTCHA 403 — retrying...`);
            // Don't close Chrome — warm browser preserves trust score (commit 6f03021).
            // Gesture sim on next token fetch already boosts score; 15s is enough cooldown.
            await new Promise(r => setTimeout(r, 15000));
            const freshToken = await fetchRecaptchaToken(sessionCookies, 'VIDEO_GENERATION', instanceId);
            body.clientContext.recaptchaContext = { token: freshToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' };
            continue;
        }
        if (result.status >= 500 && attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 3000)); continue; }
        if (result.status === 401 && attempt < MAX_RETRIES) { token = await handle401(instanceId); continue; }
        throw new Error(`Video generation failed (${result.status}): ${result.body.substring(0, 400)}`);
    }

    const data = JSON.parse(result.body);
    return {
        operationName: data.operations?.[0]?.operation?.name || data.operations?.[0]?.name || data.name || '',
        mediaId: data.media?.[0]?.name || '',
        workflowId: data.workflows?.[0]?.name || '',
        status: data.operations?.[0]?.status || 'SUBMITTED',
        remainingCredits: data.remainingCredits,
    };
}

/**
 * Submit video generation with reference images. The video is inspired by the reference images.
 */
export async function submitVideoGenerationReference(token, projectId, opts) {
    const { prompt, videoModelKey, aspectRatio, referenceMediaIds, inlineRefs, recaptchaToken, instanceId, sessionCookies } = opts;
    const batchId = uuidv4();
    const sessionId = `;${Date.now()}`;

    const referenceImages = referenceMediaIds.map(mediaId => ({
        mediaId,
        imageUsageType: 'IMAGE_USAGE_TYPE_ASSET',
    }));

    // Build structuredPrompt parts. If inlineRefs provided (Flow's @-mention feature),
    // split the prompt on @label markers and interleave reference parts with text parts.
    let parts;
    if (inlineRefs && inlineRefs.length > 0) {
        parts = buildInlineReferenceParts(prompt, inlineRefs);
    } else {
        parts = [{ text: prompt }];
    }

    const request = {
        aspectRatio,
        seed: Math.floor(Math.random() * 100000),
        textInput: { structuredPrompt: { parts } },
        videoModelKey,
        metadata: {},
        referenceImages,
    };

    const body = {
        mediaGenerationContext: {
            batchId,
            audioFailurePreference: 'RETURN_SILENCED_VIDEOS',
        },
        clientContext: {
            projectId, tool: TOOL,
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

    console.error(`[FlowVideo] Submitting r2v video, model=${videoModelKey}, refs=${referenceMediaIds.length}...`);

    let result;
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        result = await browserFetch(`${API_BASE}/v1/video:batchAsyncGenerateVideoReferenceImages`, token, body, instanceId);
        if (result.ok) break;

        if (result.status === 403 && result.body.includes('reCAPTCHA') && attempt < MAX_RETRIES) {
            console.error(`[FlowVideo] ⚠️ reCAPTCHA 403 — retrying...`);
            // Don't close Chrome — warm browser preserves trust score (commit 6f03021).
            // Gesture sim on next token fetch already boosts score; 15s is enough cooldown.
            await new Promise(r => setTimeout(r, 15000));
            const freshToken = await fetchRecaptchaToken(sessionCookies, 'VIDEO_GENERATION', instanceId);
            body.clientContext.recaptchaContext = { token: freshToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' };
            continue;
        }
        if (result.status >= 500 && attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 3000)); continue; }
        if (result.status === 401 && attempt < MAX_RETRIES) { token = await handle401(instanceId); continue; }
        throw new Error(`Video generation failed (${result.status}): ${result.body.substring(0, 400)}`);
    }

    const data = JSON.parse(result.body);
    return {
        operationName: data.operations?.[0]?.operation?.name || data.operations?.[0]?.name || data.name || '',
        mediaId: data.media?.[0]?.name || '',
        workflowId: data.workflows?.[0]?.name || '',
        status: data.operations?.[0]?.status || 'SUBMITTED',
        remainingCredits: data.remainingCredits,
    };
}

/**
 * Poll video generation until complete.
 */
export async function pollVideoCompletion(token, projectId, mediaId, maxAttempts = 120, onProgress = null) {
    const POLL_URL = `${API_BASE}/v1/video:batchCheckAsyncVideoGenerationStatus`;
    const pollBody = JSON.stringify({ media: [{ name: mediaId, projectId }] });

    // Veo render typically takes 30-60s; start polling at 8s to catch the early-finish case.
    await new Promise(r => setTimeout(r, 8000));

    for (let i = 0; i < maxAttempts; i++) {
        try {
            let res = await fetch(POLL_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Origin': 'https://labs.google', 'Referer': 'https://labs.google/' },
                body: pollBody,
            });

            if (!res.ok) {
                res = await fetch(POLL_URL, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain;charset=UTF-8', 'Origin': 'https://labs.google', 'Referer': 'https://labs.google/' },
                    body: pollBody,
                });
            }

            if (res.ok) {
                const data = await res.json();
                const dataStr = JSON.stringify(data);
                const statusMatch = dataStr.match(/MEDIA_GENERATION_STATUS_(\w+)/);
                const currentStatus = statusMatch ? statusMatch[1] : 'UNKNOWN';
                const pctMatch = dataStr.match(/(\d+)%/);

                if (i % 3 === 0 || ['SUCCEEDED', 'SUCCESSFUL', 'COMPLETE', 'COMPLETED'].includes(currentStatus)) {
                    const msg = `Poll ${i + 1}: ${currentStatus}${pctMatch ? ` (${pctMatch[1]}%)` : ''}`;
                    console.error(`[FlowVideo] ${msg}`);
                    if (onProgress) onProgress(msg);
                }

                if (['SUCCEEDED', 'SUCCESSFUL', 'COMPLETE', 'COMPLETED'].includes(currentStatus) || data.done === true) {
                    console.error('[FlowVideo] ✅ Video generation complete!');
                    return data;
                }
                if (['FAILED', 'ERROR'].includes(currentStatus)) {
                    // Surface the real reason from the payload — Veo returns this in
                    // mediaStatus.error.message and/or mediaStatus.failureReasons[].
                    const mediaStatus = data?.media?.[0]?.mediaMetadata?.mediaStatus;
                    const errCode = mediaStatus?.error?.code;
                    const errMsg = mediaStatus?.error?.message;
                    const reasons = mediaStatus?.failureReasons || [];
                    const reason = errMsg || reasons[0] || currentStatus;
                    console.error(`[FlowVideo] ❌ Generation FAILED: ${reason}${errCode ? ` (code=${errCode})` : ''}`);
                    if (!errMsg && !reasons.length) {
                        // Couldn't extract a reason — dump full payload for inspection
                        console.error('[FlowVideo] Full poll response:', JSON.stringify(data, null, 2));
                    }
                    throw new Error(`Video generation failed: ${reason}`);
                }
            }
        } catch (e) {
            if (e.message.includes('failed')) throw e;
            if (i % 4 === 0) console.error(`[FlowVideo] Poll error: ${e.message}`);
        }

        await new Promise(r => setTimeout(r, 10000));
    }

    throw new Error('Video generation timed out after 20 minutes.');
}

/**
 * Submit video upscale to 1080p.
 */
export async function submitVideoUpscale(token, projectId, mediaId, aspectRatio, recaptchaToken = '', instanceId = 'default', sessionCookies = '') {
    const body = {
        mediaGenerationContext: { batchId: uuidv4() },
        clientContext: {
            projectId, tool: TOOL,
            userPaygateTier: 'PAYGATE_TIER_TWO',
            sessionId: `;${Date.now()}`,
            recaptchaContext: { applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB', ...(recaptchaToken && { token: recaptchaToken }) },
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

    const endpoint = `${API_BASE}/v1/video:batchAsyncGenerateVideoUpsampleVideo`;
    let result;
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        result = await browserFetch(endpoint, token, body, instanceId);
        if (result.ok) break;

        if (result.status === 403 && result.body.includes('reCAPTCHA') && attempt < MAX_RETRIES) {
            console.error(`[FlowVideo] ⚠️ Upscale reCAPTCHA 403 — reloading page + retrying (${attempt + 1}/${MAX_RETRIES})...`);
            // Page reload resets the SDK trust-score state — fetchRecaptchaToken alone
            // is not enough once the page lifetime gets flagged (manual UI also fails).
            await reloadRecaptchaPage(instanceId);
            await new Promise(r => setTimeout(r, 5000));
            const freshToken = await fetchRecaptchaToken(sessionCookies, 'VIDEO_GENERATION', instanceId);
            body.clientContext.recaptchaContext = { token: freshToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' };
            continue;
        }
        if (result.status >= 500 && attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 3000)); continue; }
        if (result.status === 401 && attempt < MAX_RETRIES) { token = await handle401(instanceId); continue; }
        console.error(`[FlowVideo] Upscale API error: ${result.status} - ${result.body.substring(0, 300)}`);
        return { upsampledMediaId: null };
    }

    const data = JSON.parse(result.body);
    return {
        upsampledMediaId: data.operations?.[0]?.operation?.name || data.media?.[0]?.name || `${mediaId}_upsampled`,
    };
}

/**
 * Poll upscale until complete.
 */
export async function pollUpscaleCompletion(token, projectId, upsampledMediaId, maxAttempts = 60) {
    const POLL_URL = `${API_BASE}/v1/video:batchCheckAsyncVideoGenerationStatus`;
    const pollBody = JSON.stringify({ media: [{ name: upsampledMediaId, projectId }] });

    await new Promise(r => setTimeout(r, 5000));

    for (let i = 0; i < maxAttempts; i++) {
        try {
            const res = await fetch(POLL_URL, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain;charset=UTF-8', 'Origin': 'https://labs.google', 'Referer': 'https://labs.google/' },
                body: pollBody,
            });
            if (res.ok) {
                const data = await res.json();
                const status = data.media?.[0]?.mediaMetadata?.mediaStatus?.mediaGenerationStatus || '';
                console.error(`[FlowVideo] Upscale poll ${i + 1}: ${status}`);
                if (status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') return data;
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
            }
        } catch (e) {
            if (e.message.startsWith('Video upscale failed')) throw e;
        }
        await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error('Video upscale timed out');
}

/**
 * Fetch video download URL via tRPC redirect or fallback strategies.
 */
export async function fetchVideoDownloadUrl(token, projectId, mediaId, sessionCookies = '', instanceId = 'default') {
    const tRPCUrl = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${mediaId}`;
    console.error(`[FlowVideo] Fetching download URL for mediaId=${mediaId}`);

    // Strategy 0: Use Chrome page to navigate to tRPC URL and capture redirect
    const inst = getChromePoolInstance(instanceId);
    if (inst?.page && inst?.browser?.isConnected() && inst?.ready) {
        try {
            // Use a new page to avoid disrupting the reCAPTCHA page
            const newPage = await inst.browser.newPage();
            try {
                // Set cookies from the main page
                const cookies = await inst.page.cookies('https://labs.google');
                if (cookies.length > 0) {
                    await newPage.setCookie(...cookies);
                }
                
                // Intercept the redirect — don't follow it
                await newPage.setRequestInterception(true);
                
                let signedUrl = '';
                newPage.on('request', (req) => {
                    const reqUrl = req.url();
                    // If this is a redirect to the video CDN, capture it
                    if (reqUrl.includes('flow-content.google') || reqUrl.includes('storage.googleapis.com')) {
                        signedUrl = reqUrl;
                        req.abort();
                    } else {
                        req.continue();
                    }
                });
                
                // Navigate — this should trigger a 307 redirect to the signed URL
                await newPage.goto(tRPCUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                
                await newPage.close();
                
                if (signedUrl) {
                    console.error('[FlowVideo] ✅ Got signed URL via browser redirect intercept');
                    return signedUrl;
                }
                console.error('[FlowVideo] Strategy 0: no redirect captured');
            } catch (e) {
                console.error(`[FlowVideo] Strategy 0 inner error: ${e.message}`);
                try { await newPage.close(); } catch {}
            }
        } catch (e) { console.error(`[FlowVideo] Browser tRPC error: ${e.message}`); }
    } else {
        console.error('[FlowVideo] Strategy 0 skipped — no browser page available');
    }

    // Strategy 1: tRPC via Node.js fetch (needs session cookies from Chrome)
    // If .env cookies are empty, try extracting from Chrome
    let effectiveCookies = sessionCookies;
    if ((!effectiveCookies || effectiveCookies === 'INVALID_COOKIES_xxx') && inst?.page) {
        try {
            const chromeCookies = await inst.page.cookies('https://labs.google');
            const sessionToken = chromeCookies.find(c => c.name === '__Secure-next-auth.session-token');
            if (sessionToken) {
                effectiveCookies = `__Secure-next-auth.session-token=${sessionToken.value}`;
                console.error('[FlowVideo] Strategy 1: extracted cookies from Chrome');
            }
        } catch {}
    }
    try {
        const sessionTokenCookie = (effectiveCookies || '').split(';').map(c => c.trim()).find(c => c.startsWith('__Secure-next-auth.session-token='));
        const cookieHeader = sessionTokenCookie || effectiveCookies;
        const tRPCHeaders = { 'Referer': 'https://labs.google/', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };
        if (cookieHeader) tRPCHeaders['Cookie'] = cookieHeader;
        console.error(`[FlowVideo] Strategy 1: cookies=${cookieHeader ? 'present' : 'EMPTY'}`);
        const res = await fetch(tRPCUrl, { redirect: 'manual', headers: tRPCHeaders });
        console.error(`[FlowVideo] Strategy 1 response: status=${res.status}`);
        if ([301, 302, 307, 308].includes(res.status)) {
            const location = res.headers.get('location');
            if (location) { console.error('[FlowVideo] ✅ Got signed URL via tRPC redirect'); return location; }
        }
    } catch (e) { console.error(`[FlowVideo] tRPC error: ${e.message}`); }

    // Strategy 2: Direct CDN (flow-content.google)
    const cdnUrl = `https://flow-content.google/video/${mediaId}`;
    try {
        const res = await fetch(cdnUrl, { method: 'HEAD' });
        console.error(`[FlowVideo] Strategy 2 (CDN): status=${res.status}`);
        if (res.ok) return cdnUrl;
    } catch { /* skip */ }

    // Strategy 3: Direct GCS (legacy)
    const directGcsUrl = `https://storage.googleapis.com/ai-sandbox-videofx/video/${mediaId}`;
    try {
        const res = await fetch(directGcsUrl, { method: 'HEAD' });
        console.error(`[FlowVideo] Strategy 3 (GCS): status=${res.status}`);
        if (res.ok) return directGcsUrl;
    } catch { /* skip */ }

    console.error('[FlowVideo] ⚠️ Could not get video download URL — all strategies failed');
    return '';
}

// Re-export for convenience
export { getAccountInstanceId, fetchRecaptchaToken, clearRecaptchaToken, closeRecaptchaBrowser, deleteChromePoolEntry, reloadRecaptchaPage };
