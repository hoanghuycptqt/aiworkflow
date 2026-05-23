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
export const description = `Generate a video using Google Flow (Veo 3.1 family + Gemini Omni Flash). Takes 1-3 minutes per video.

MODEL SELECTION GUIDE — pick by use case:
- veo3_lite_low (default): Versatile, cheap. Image-driven workflows (start frame for continuity, start+end for transitions), text-to-video, reference images (8s only). Best for character continuity across cuts, scene-to-scene morphs, or when you need 1080p upscale.
- veo3_quality: Premium visual fidelity. Same image-driven modes (t2v / start frame / start+end) but NO reference images. Pick when output quality matters more than cost (e.g. hero shots, final renders).
- omni_flash: NEW "Gemini Omni Flash". Fast text-to-video and reference-image r2v. Supports DURATIONS 4s / 6s / 8s / 10s (all four — 10s is unique to this model; 4/6/8 also work). THREE features unique to this model vs. veo3_*:
  (1) 10-second clips (other models cap at 8s);
  (2) Up to 7 reference images (vs. 3 on veo3_lite_low);
  (3) Inline @-references — anchor a specific image to a specific position in the prompt via @LABEL syntax (see inline_references param).
  Use omni_flash for: multi-character scenes, longer clips, prompts where you want to say "the @Hero meets @Villain in @Cyberpunk_alley" rather than dumping all reference images as undifferentiated style hints. Does NOT support start/end frames — for those, use veo3_*.

MODES (choose one):
1. TEXT-ONLY (t2v): Just provide prompt. No images.
2. START FRAME (i2v): set start_frame_path — video begins from that image.
3. START+END FRAME (i2v_se): set start_frame_path AND end_frame_path — video transitions between two images.
4. REFERENCE IMAGES (r2v): set reference_image_paths (1-3 images for veo3_lite_low, 1-7 for omni_flash) — video is INSPIRED by these images. Veo treats all references as undifferentiated style/subject hints.
5. INLINE @-REFERENCES (omni_flash only): write @LABEL inside the prompt + pass inline_references=[{path, label}, ...]. Each LABEL gets anchored to the image at its exact position in the prompt. Use this instead of r2v when you want POSITIONAL control — e.g. specify which character goes where, or which reference image governs which part of the scene. Internally this still hits the r2v endpoint with the same model key, but the structuredPrompt has interleaved reference parts.

SUPPORT MATRIX (mode × duration × model) — verified by network capture:
| mode                | veo3_lite_low | veo3_quality   | omni_flash       |
|---------------------|---------------|----------------|------------------|
| t2v                 | 4/6/8s        | 4/6/8s         | 4/6/8/10s        |
| i2v                 | 4/6/8s        | 4/6/8s         | NOT SUPPORTED    |
| i2v_se              | 4/6/8s        | 4/6/8s         | NOT SUPPORTED    |
| r2v                 | 8s only       | NOT SUPPORTED  | 4/6/8/10s        |
| inline @-references | N/A           | N/A            | 4/6/8/10s        |

CONSTRAINTS:
- reference_image_paths and start_frame_path/end_frame_path are mutually exclusive.
- end_frame_path requires start_frame_path.
- inline_references is omni_flash-only; mutually exclusive with reference_image_paths; every label must literally appear as @LABEL in the prompt; labels must be unique.
- veo3_quality + reference_image_paths → error (Quality has no r2v model).
- veo3_lite_low + reference_image_paths + duration ∈ {4, 6} → error (Veo silently downgrades; we refuse instead).
- omni_flash + start_frame_path / end_frame_path → error (silent t2v downgrade; refuse).
- duration='10' is only valid with omni_flash.
- Max reference images: 3 for veo3_lite_low, 7 for omni_flash.

INLINE @-REFERENCE EXAMPLE:
{
  "model": "omni_flash",
  "prompt": "The @Charlie waves at @Bob across a busy night market under neon lights",
  "inline_references": [
    { "path": "/abs/charlie.png", "label": "Charlie" },
    { "path": "/abs/bob.png",     "label": "Bob"     }
  ],
  "duration": "8"
}
→ structuredPrompt sent to Veo:
   [text:"The ", ref:Charlie, text:" waves at ", ref:Bob, text:" across a busy night market under neon lights"]
→ Both images are also added to the referenceImages[] array (Veo expects both). The tool handles all of this automatically.

WHEN TO USE WHICH REFERENCE MECHANISM:
- start_frame_path: you want the video to literally OPEN on a specific image.
- start_frame_path + end_frame_path: morph/transition between two specific images.
- reference_image_paths: style transfer — "make a video that looks/feels like these". The references are anonymous; Veo treats them as undifferentiated style/subject hints. Use when the prompt has no names for the references (e.g. "a moody noir scene inspired by these").
- inline_references (omni_flash): named characters/places/objects you want to control by position in the prompt. Use when the prompt names specific entities (e.g. "Chef meets Astronaut on Mars") — give each entity a label, write @label in the prompt, and the image is anchored to that exact spot.

DECISION RULE for omni_flash r2v — does the prompt contain @LABEL tokens?
- YES (e.g. "@Chef walks toward @Astronaut") → use inline_references=[{path,label},...]. Match each @LABEL in the prompt to a {label} entry. The tool will refuse the call if any label is missing from the prompt or any @LABEL in the prompt lacks a matching entry.
- NO (e.g. "A cinematic chase scene inspired by these visuals") → use reference_image_paths=[...] (plain paths, no labels). All references contribute as bulk style hints.
NEVER pass both; they are mutually exclusive. If you want named control, you MUST use inline_references and write @label tokens in the prompt.

ASPECT RATIO: Explicit aspect_ratio param overrides auto-detection from image. When image ratio differs from video ratio, center-crop is applied automatically.

⚠️ CRITICAL — SEQUENTIAL ONLY: All Google Flow tools (generate_google_flow_image, generate_google_flow_video, upscale_google_flow_image, upscale_google_flow_video) share a SINGLE browser session. You MUST call them ONE AT A TIME, waiting for each call to fully complete before making the next. If you call multiple Google Flow tools in parallel, ALL calls WILL FAIL with timeouts and NO images/videos will be created. This is not a suggestion — it is a hard technical constraint.

RETRY GUIDANCE — when this tool fails:
- "PUBLIC_ERROR_HIGH_TRAFFIC" → Veo cluster is overloaded. RETRY WITH THE SAME PROMPT after a short wait (5-15s). DO NOT change the prompt — this is transient capacity, not a content issue.
- "PUBLIC_ERROR_UNUSUAL_ACTIVITY" / reCAPTCHA 403 → trust-score blip. Retry once with the same prompt; if it persists, stop and report.
- Anything mentioning "safety", "policy", "violation", "blocked", "filtered" → real content filter. Adjust the prompt.
- Any other error → retry once with the same prompt; if it still fails, report the exact error to the user instead of guessing.`;

export const schema = {
    prompt: z.string().describe('Video generation prompt describing the scene, motion, or style'),
    model: z.enum(['veo3_lite_low', 'veo3_quality', 'omni_flash']).default('veo3_lite_low').describe('Pick by use case (see MODEL SELECTION GUIDE in tool description). veo3_lite_low = versatile default, all 4 modes (t2v/i2v/i2v_se/r2v) at 4/6/8s — r2v locked to 8s. veo3_quality = premium fidelity, NO r2v. omni_flash = Gemini Omni Flash, t2v+r2v at 4/6/8/10s, supports 10-second clips, up to 7 reference images, and inline @-references — but NO start/end frames.'),
    aspect_ratio: z.enum(['9:16', '16:9', '1:1']).optional().describe('Video aspect ratio. Auto-detected from start frame if omitted. Explicit value overrides auto-detection. Default: 9:16.'),
    duration: z.enum(['4', '6', '8', '10']).default('8').describe('Video length in seconds. See SUPPORT MATRIX in tool description. Short version: t2v/i2v/i2v_se → 4/6/8s on veo3_*; r2v on veo3_lite_low → 8s only; omni_flash (t2v and r2v) → 4/6/8/10s. duration=10 requires model=omni_flash.'),
    resolution: z.enum(['720p', '1080p']).default('720p').describe('720p default. 1080p adds an upscale pass (slower).'),
    start_frame_path: z.string().optional().describe('Absolute path to JPEG/PNG for FIRST FRAME. Mutually exclusive with reference_image_paths.'),
    end_frame_path: z.string().optional().describe('Absolute path to JPEG/PNG for LAST FRAME. Requires start_frame_path. Mutually exclusive with reference_image_paths.'),
    reference_image_paths: z.array(z.string()).optional().describe('Absolute paths to JPEG/PNG reference images for style/subject transfer — anonymous, undifferentiated hints. PICK THIS when the prompt does NOT contain @LABEL tokens (e.g. "a noir chase scene inspired by these visuals"). For named entities anchored to specific positions in the prompt (e.g. "@Chef meets @Astronaut"), use inline_references instead. Mutually exclusive with start/end frame paths and with inline_references. NOT supported with veo3_quality. Limit: 3 images for veo3_lite_low, 7 images for omni_flash.'),
    inline_references: z.array(z.object({
        path: z.string().describe('Absolute path to JPEG/PNG reference image.'),
        label: z.string().describe('Token name. Write @LABEL in the prompt to anchor this image; label is matched literally (case-sensitive, no spaces recommended).'),
    })).optional().describe('Inline @-references (omni_flash only). PICK THIS when the prompt contains @LABEL tokens for specific named entities — Veo will anchor each image to the @LABEL position in the prompt instead of treating it as a bulk style hint. Example: prompt="The @Charlie waves" with inline_references=[{path:"/charlie.png", label:"Charlie"}]. Every label MUST appear as @label in the prompt (call will be refused otherwise). Mutually exclusive with reference_image_paths and start/end frame paths. Limit: 7 images.'),
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
    const hasInlineRefs = params.inline_references && params.inline_references.length > 0;
    if (hasRefPaths && hasInlineRefs) {
        throw new Error('Cannot use reference_image_paths and inline_references together. Pick one mechanism.');
    }
    if ((hasRefPaths || hasInlineRefs) && (params.start_frame_path || params.end_frame_path)) {
        throw new Error('Cannot use reference_image_paths / inline_references together with start_frame_path/end_frame_path. Use one mode or the other.');
    }
    if ((hasRefPaths || hasInlineRefs) && params.model === 'veo3_quality') {
        throw new Error('veo3_quality model does NOT support reference images mode. Use veo3_lite_low or omni_flash instead.');
    }
    if (hasInlineRefs && params.model !== 'omni_flash') {
        throw new Error(`inline_references (@LABEL syntax) is only supported by model='omni_flash'. You requested model='${params.model}'. Either switch model or use plain reference_image_paths.`);
    }
    // veo3_lite_low r2v: only 8s. Veo silently downgrades 4s/6s r2v → t2v.
    if (hasRefPaths && params.model === 'veo3_lite_low' && params.duration !== '8') {
        throw new Error(`reference_image_paths with model='veo3_lite_low' only supports duration=8s. You requested ${params.duration}s. Veo silently downgrades 4s/6s r2v back to t2v on this tier. Either set duration='8' or switch to model='omni_flash' (which supports r2v at 4/6/8/10s).`);
    }
    // omni_flash: t2v + r2v only. Veo silently downgrades start/end frames to t2v.
    if (params.model === 'omni_flash' && (params.start_frame_path || params.end_frame_path || params.start_frame_media_id || params.end_frame_media_id)) {
        throw new Error(`omni_flash does not support start/end frames (silent t2v downgrade). Drop start_frame_path / end_frame_path, or switch to model='veo3_lite_low' or 'veo3_quality' for image-driven modes. omni_flash DOES support reference_image_paths (r2v).`);
    }
    if (params.duration === '10' && params.model !== 'omni_flash') {
        throw new Error(`duration='10' is only supported by model='omni_flash'. You requested model='${params.model}'. Either switch model or pick duration ∈ {4, 6, 8}.`);
    }
    if (hasRefPaths || hasInlineRefs) {
        const refLimit = params.model === 'omni_flash' ? 7 : 3;
        const refCount = hasRefPaths ? params.reference_image_paths.length : params.inline_references.length;
        if (refCount > refLimit) {
            throw new Error(`Too many reference images: ${refCount}. Limit for model='${params.model}' is ${refLimit}.`);
        }
    }
    if (hasInlineRefs) {
        const seen = new Set();
        for (const r of params.inline_references) {
            if (!r.label) throw new Error(`inline_references[*].label is required.`);
            if (seen.has(r.label)) throw new Error(`Duplicate inline_references label: "${r.label}". Each label must be unique.`);
            seen.add(r.label);
            if (!params.prompt.includes('@' + r.label)) {
                throw new Error(`Prompt does not reference "@${r.label}". Either add @${r.label} to the prompt or remove this entry from inline_references.`);
            }
        }
    }

    // --- Mode: Reference Images (plain r2v) ---
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
        const duration = Number(params.duration) || 8;
        const videoModelKey = getVideoModelKey(params.model, 'r2v', finalRatio, duration);
        if (!videoModelKey) {
            throw new Error(`Model '${params.model}' does not support reference images at ${duration}s. Only 8s is supported for r2v.`);
        }

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

    // --- Mode: Inline @-References (omni_flash only) ---
    if (hasInlineRefs) {
        await progress(`Uploading ${params.inline_references.length} inline reference(s)...`);
        const inlineRefs = [];
        const referenceMediaIds = [];
        for (let i = 0; i < params.inline_references.length; i++) {
            const { path, label } = params.inline_references[i];
            const mediaId = await uploadOrReuse(path, (base64) => uploadReferenceImage(token, projectId, base64));
            inlineRefs.push({ mediaId, label });
            referenceMediaIds.push(mediaId);
            await progress(`Inline reference "@${label}" (${i + 1}/${params.inline_references.length}) uploaded`);
        }

        const finalRatio = params.aspect_ratio || '9:16';
        const aspectRatio = VIDEO_ASPECT_RATIO_MAP[finalRatio] || 'VIDEO_ASPECT_RATIO_PORTRAIT';
        const duration = Number(params.duration) || 8;
        const videoModelKey = getVideoModelKey(params.model, 'r2v', finalRatio, duration);
        if (!videoModelKey) {
            throw new Error(`Model '${params.model}' does not support reference images at ${duration}s.`);
        }

        await progress('Launching reCAPTCHA browser...');
        await new Promise(r => setTimeout(r, 5000));
        const recaptchaToken = await fetchRecaptchaToken(sessionCookies, 'VIDEO_GENERATION', instanceId);

        await progress(`Submitting inline-reference video (${params.model}, ${inlineRefs.length} @-refs)...`);
        const submitResult = await submitVideoGenerationReference(token, projectId, {
            prompt: params.prompt, videoModelKey, aspectRatio,
            referenceMediaIds, inlineRefs,
            recaptchaToken, instanceId, sessionCookies,
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
    const duration = Number(params.duration) || 8;
    const videoModelKey = getVideoModelKey(params.model, mode, finalRatio, duration);
    if (!videoModelKey) {
        throw new Error(`Model '${params.model}' does not support '${mode}' mode at ${duration}s.`);
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
        content: [{ type: 'text', text: `✅ Video generation complete!\n\n**File**: ${videoPath || 'N/A'}\n**Download URL**: ${videoUrl || 'N/A'}\n**Media ID**: ${submitResult.mediaId}\n**Mode**: ${modeNames[mode]}\n**Model**: ${params.model} (${videoModelKey})\n**Aspect Ratio**: ${finalRatio}\n**Duration**: ${params.duration}s\n**Resolution**: ${params.resolution}\n**Credits**: ${submitResult.remainingCredits ?? 'unknown'}` }],
    };
}
