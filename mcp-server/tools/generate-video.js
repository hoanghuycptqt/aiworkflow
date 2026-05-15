/**
 * Tool: generate_google_flow_video
 * Generate video using Google Flow Veo 3.1.
 * Supports: text-only, start frame, start+end frame, or reference images.
 * Model key depends on mode (t2v/i2v/i2v_se/r2v), NOT aspect ratio.
 */

import { z } from 'zod';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import { getCredential } from '../lib/db.js';
import { createProgress } from '../lib/progress.js';
import {
    uploadReferenceImage,
    submitVideoGeneration, submitVideoGenerationStartEnd, submitVideoGenerationReference,
    pollVideoCompletion,
    submitVideoUpscale, pollUpscaleCompletion,
    fetchVideoDownloadUrl,
    calculateCropCoordinates,
    getVideoModelKey, VIDEO_ASPECT_RATIO_MAP,
    getAccountInstanceId, fetchRecaptchaToken, clearRecaptchaToken,
} from '../lib/google-flow-api.js';
import { uploadOrReuse, saveMediaId } from '../lib/media-cache.js';

export const name = 'generate_google_flow_video';
export const description = `Generate a video using Google Flow Veo 3.1. Takes 1-3 minutes per video.

MODES (choose one):
1. TEXT-ONLY: Just provide prompt. No images needed.
2. START FRAME: Set start_frame_path — video begins from that image.
3. START+END FRAME: Set start_frame_path AND end_frame_path — video transitions between two images.
4. REFERENCE IMAGES: Set reference_image_paths (1-3 images) — video is INSPIRED by these images (style/subject transfer, NOT used as start/end frames).

MODELS (2 tiers):
- veo3_lite_low (default): Supports ALL 4 modes.
- veo3_quality: Highest quality. Supports text-only, start frame, start+end frame ONLY. Does NOT support reference images.

CONSTRAINTS:
- reference_image_paths and start_frame_path/end_frame_path are mutually exclusive.
- end_frame_path requires start_frame_path.
- veo3_quality + reference_image_paths will error.
- Max 3 reference images.

ASPECT RATIO: Explicit aspect_ratio param overrides auto-detection from image. When image ratio differs from video ratio, center-crop is applied automatically.

⚠️ CRITICAL — SEQUENTIAL ONLY: All Google Flow tools (generate_google_flow_image, generate_google_flow_video, upscale_google_flow_image, upscale_google_flow_video) share a SINGLE browser session. You MUST call them ONE AT A TIME, waiting for each call to fully complete before making the next. If you call multiple Google Flow tools in parallel, ALL calls WILL FAIL with timeouts and NO images/videos will be created. This is not a suggestion — it is a hard technical constraint.

RETRY GUIDANCE — when this tool fails:
- "PUBLIC_ERROR_HIGH_TRAFFIC" → Veo cluster is overloaded. RETRY WITH THE SAME PROMPT after a short wait (5-15s). DO NOT change the prompt — this is transient capacity, not a content issue.
- "PUBLIC_ERROR_UNUSUAL_ACTIVITY" / reCAPTCHA 403 → trust-score blip. Retry once with the same prompt; if it persists, stop and report.
- Anything mentioning "safety", "policy", "violation", "blocked", "filtered" → real content filter. Adjust the prompt.
- Any other error → retry once with the same prompt; if it still fails, report the exact error to the user instead of guessing.`;

export const schema = {
    prompt: z.string().describe('Video generation prompt describing the scene, motion, or style'),
    model: z.enum(['veo3_lite_low', 'veo3_quality']).default('veo3_lite_low').describe('Model tier. veo3_lite_low=default, supports all 4 modes. veo3_quality=highest quality, NO reference images support.'),
    aspect_ratio: z.enum(['9:16', '16:9', '1:1']).optional().describe('Video aspect ratio. Auto-detected from start frame if omitted. Explicit value overrides auto-detection. Default: 9:16.'),
    resolution: z.enum(['720p', '1080p']).default('720p').describe('720p default. 1080p adds an upscale pass (slower).'),
    start_frame_path: z.string().optional().describe('Absolute path to JPEG/PNG for FIRST FRAME. Mutually exclusive with reference_image_paths.'),
    end_frame_path: z.string().optional().describe('Absolute path to JPEG/PNG for LAST FRAME. Requires start_frame_path. Mutually exclusive with reference_image_paths.'),
    reference_image_paths: z.array(z.string()).optional().describe('1-3 absolute paths to JPEG/PNG reference images for style/subject transfer. Mutually exclusive with start/end frame paths. NOT supported with veo3_quality.'),
    start_frame_media_id: z.string().optional().describe('Pre-uploaded Google Flow media ID for start frame (alternative to start_frame_path).'),
    end_frame_media_id: z.string().optional().describe('Pre-uploaded Google Flow media ID for end frame (alternative to end_frame_path).'),
    output_dir: z.string().optional().describe('Directory to save video. Defaults to uploads/mcp-generated/.'),
};

/**
 * Detect image dimensions from a JPEG/PNG buffer.
 */
function getImageDimensions(buffer) {
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
        let offset = 2;
        while (offset < buffer.length - 9) {
            if (buffer[offset] !== 0xFF) { offset++; continue; }
            const marker = buffer[offset + 1];
            if (marker === 0xC0 || marker === 0xC2) {
                return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
            }
            offset += 2 + buffer.readUInt16BE(offset + 2);
        }
    }
    if (buffer[0] === 0x89 && buffer[1] === 0x50) {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    return null;
}

function detectAspectRatio(width, height) {
    const ratio = width / height;
    if (ratio > 1.3) return '16:9';
    if (ratio < 0.77) return '9:16';
    return '1:1';
}

export async function handler(params, extra) {
    const progress = createProgress(extra);
    await progress('Loading credentials...');

    const cred = getCredential();
    const token = cred.token;
    const projectId = cred.metadata.projectId;
    if (!projectId) throw new Error('GOOGLE_FLOW_PROJECT_ID is not set in .env file.');

    const sessionCookies = cred.metadata.sessionCookies || '';
    const instanceId = getAccountInstanceId(cred);

    // Validate: reference images and start/end frame are mutually exclusive
    const hasRefPaths = params.reference_image_paths && params.reference_image_paths.length > 0;
    if (hasRefPaths && (params.start_frame_path || params.end_frame_path)) {
        throw new Error('Cannot use reference_image_paths together with start_frame_path/end_frame_path. Use one mode or the other.');
    }
    if (hasRefPaths && params.model === 'veo3_quality') {
        throw new Error('veo3_quality model does NOT support reference images mode. Use veo3_lite_low or veo3_fast_low instead.');
    }

    // --- Mode: Reference Images ---
    if (hasRefPaths) {
        await progress(`Uploading ${params.reference_image_paths.length} reference image(s)...`);
        const referenceMediaIds = [];
        for (let i = 0; i < params.reference_image_paths.length; i++) {
            const mediaId = await uploadOrReuse(params.reference_image_paths[i], (base64) => uploadReferenceImage(token, projectId, base64));
            referenceMediaIds.push(mediaId);
            await progress(`Reference image ${i + 1}/${params.reference_image_paths.length} uploaded`);
        }

        const finalRatio = params.aspect_ratio || '9:16';
        const aspectRatio = VIDEO_ASPECT_RATIO_MAP[finalRatio] || 'VIDEO_ASPECT_RATIO_PORTRAIT';
        const videoModelKey = getVideoModelKey(params.model, 'r2v');

        await progress('Launching reCAPTCHA browser...');
        await new Promise(r => setTimeout(r, 5000));
        const recaptchaToken = await fetchRecaptchaToken(sessionCookies, 'VIDEO_GENERATION', instanceId);

        await progress(`Submitting reference video (${params.model}, ${referenceMediaIds.length} refs)...`);
        const submitResult = await submitVideoGenerationReference(token, projectId, {
            prompt: params.prompt, videoModelKey, aspectRatio,
            referenceMediaIds, recaptchaToken, instanceId, sessionCookies,
        });
        await clearRecaptchaToken(recaptchaToken);

        return await pollAndDownload(params, extra, progress, token, projectId, submitResult, 'r2v', videoModelKey, finalRatio, sessionCookies, instanceId);
    }

    // --- Mode: Start frame / Start+End frame / Text-only ---
    let startFrameMediaId = params.start_frame_media_id || null;
    let detectedRatio = null;
    let startDims = null;

    if (!startFrameMediaId && params.start_frame_path) {
        await progress('Uploading start frame...');
        const buf = await readFile(params.start_frame_path);
        startDims = getImageDimensions(buf);
        if (startDims) {
            detectedRatio = detectAspectRatio(startDims.width, startDims.height);
            await progress(`Start frame: ${startDims.width}x${startDims.height} → auto-detected ${detectedRatio}`);
        }
        startFrameMediaId = await uploadOrReuse(params.start_frame_path, (base64) => uploadReferenceImage(token, projectId, base64));
    }

    // Explicit aspect_ratio > auto-detected > default
    const finalRatio = params.aspect_ratio || detectedRatio || '9:16';

    // Upload end frame
    let endFrameMediaId = params.end_frame_media_id || null;
    let endDims = null;

    if (!endFrameMediaId && params.end_frame_path) {
        if (!startFrameMediaId) throw new Error('end_frame_path requires start_frame_path to also be set.');
        await progress('Uploading end frame...');
        const buf = await readFile(params.end_frame_path);
        endDims = getImageDimensions(buf);
        if (endDims) {
            await progress(`End frame: ${endDims.width}x${endDims.height}`);
        }
        endFrameMediaId = await uploadOrReuse(params.end_frame_path, (base64) => uploadReferenceImage(token, projectId, base64));
    }

    const aspectRatio = VIDEO_ASPECT_RATIO_MAP[finalRatio] || 'VIDEO_ASPECT_RATIO_PORTRAIT';
    const hasStartFrame = !!startFrameMediaId;
    const hasEndFrame = !!endFrameMediaId;

    // Determine generation mode and get correct model key
    const mode = hasEndFrame ? 'i2v_se' : (hasStartFrame ? 'i2v' : 't2v');
    const videoModelKey = getVideoModelKey(params.model, mode, finalRatio);
    if (!videoModelKey) {
        throw new Error(`Model '${params.model}' does not support '${mode}' mode.`);
    }

    // Calculate crop coordinates for image modes
    let startFrameCrop = null;
    let endFrameCrop = null;
    if (hasStartFrame && startDims) {
        startFrameCrop = calculateCropCoordinates(startDims.width, startDims.height, finalRatio);
    }
    if (hasEndFrame && endDims) {
        endFrameCrop = calculateCropCoordinates(endDims.width, endDims.height, finalRatio);
    }

    // Submit video generation
    await progress('Launching reCAPTCHA browser...');
    await new Promise(r => setTimeout(r, 5000));
    const recaptchaToken = await fetchRecaptchaToken(sessionCookies, 'VIDEO_GENERATION', instanceId);

    let submitResult;
    if (hasEndFrame) {
        await progress(`Submitting start+end frame video (${params.model})...`);
        submitResult = await submitVideoGenerationStartEnd(token, projectId, {
            prompt: params.prompt, videoModelKey, aspectRatio,
            startFrameMediaId, endFrameMediaId,
            startFrameCrop, endFrameCrop,
            recaptchaToken, instanceId, sessionCookies,
        });
    } else {
        const modeLabel = hasStartFrame ? 'start frame' : 'text-only';
        await progress(`Submitting ${modeLabel} video (${params.model})...`);
        submitResult = await submitVideoGeneration(token, projectId, {
            prompt: params.prompt, videoModelKey, aspectRatio,
            startFrameMediaId, startFrameCrop,
            recaptchaToken, instanceId, sessionCookies,
        });
    }
    await clearRecaptchaToken(recaptchaToken);

    return await pollAndDownload(params, extra, progress, token, projectId, submitResult, mode, videoModelKey, finalRatio, sessionCookies, instanceId);
}

/**
 * Shared polling + download logic for all video modes.
 */
async function pollAndDownload(params, extra, progress, token, projectId, submitResult, mode, videoModelKey, finalRatio, sessionCookies, instanceId) {
    if (!submitResult.operationName && !submitResult.mediaId) {
        return { content: [{ type: 'text', text: '⚠️ Video submitted but no tracking IDs returned.' }] };
    }

    await progress(`Video submitted! Media ID: ${submitResult.mediaId}. Polling...`);

    // Poll for completion
    await pollVideoCompletion(token, projectId, submitResult.mediaId, 120, async (msg) => {
        await progress(msg);
    });

    await progress('Video generation complete! Preparing download...');

    // Upscale to 1080p if requested
    let downloadMediaId = submitResult.mediaId;
    if (params.resolution === '1080p') {
        const aspectRatio = VIDEO_ASPECT_RATIO_MAP[finalRatio] || 'VIDEO_ASPECT_RATIO_PORTRAIT';
        await progress('Upscaling video to 1080p...');
        const upRecaptcha = await fetchRecaptchaToken(sessionCookies, 'VIDEO_GENERATION', instanceId);
        const upResult = await submitVideoUpscale(token, projectId, submitResult.mediaId, aspectRatio, upRecaptcha, instanceId);
        if (upResult.upsampledMediaId) {
            await progress('Polling video upscale...');
            await pollUpscaleCompletion(token, projectId, upResult.upsampledMediaId);
            downloadMediaId = upResult.upsampledMediaId;
            await progress('Video upscaled to 1080p!');
        }
    }

    // Download video
    await progress('Fetching download URL...');
    const videoUrl = await fetchVideoDownloadUrl(token, projectId, downloadMediaId, sessionCookies, instanceId);
    const uploadDir = process.env.UPLOAD_DIR || './uploads';
    const outputDir = params.output_dir || join(uploadDir, 'mcp-generated');
    await mkdir(outputDir, { recursive: true });

    let videoPath = '';
    if (videoUrl) {
        try {
            await progress('Downloading video...');
            const videoRes = await fetch(videoUrl);
            if (videoRes.ok) {
                const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
                const videoFilename = `video_${uuidv4().substring(0, 8)}.mp4`;
                videoPath = join(outputDir, videoFilename);
                await writeFile(videoPath, videoBuffer);
                await progress(`Video saved! (${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB)`);
                // Cache video mediaId for upscale lookup by file_path
                if (submitResult.mediaId) {
                    await saveMediaId(videoPath, submitResult.mediaId);
                }
            }
        } catch (e) {
            console.error(`[MCP] Video download failed: ${e.message}`);
        }
    }

    const modeNames = { t2v: 'Text-only', i2v: 'Start Frame', i2v_se: 'Start+End Frame', r2v: 'Reference Images' };

    return {
        content: [{ type: 'text', text: `✅ Video generation complete!\n\n**File**: ${videoPath || 'N/A'}\n**Download URL**: ${videoUrl || 'N/A'}\n**Media ID**: ${submitResult.mediaId}\n**Mode**: ${modeNames[mode]}\n**Model**: ${params.model} (${videoModelKey})\n**Aspect Ratio**: ${finalRatio}\n**Resolution**: ${params.resolution}\n**Credits**: ${submitResult.remainingCredits ?? 'unknown'}` }],
    };
}
