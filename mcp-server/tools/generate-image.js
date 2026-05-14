/**
 * Tool: generate_google_flow_image
 * Generate ONE image using Google Flow ImageFX.
 *
 * Design: Always generates 1 image per call to stay within Claude Desktop's 60s timeout.
 * For multiple images, Claude should call this tool multiple times.
 * For upscaling, use the separate upscale_google_flow_image tool.
 */

import { z } from 'zod';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getCredential } from '../lib/db.js';
import { createProgress } from '../lib/progress.js';
import {
    uploadReferenceImage, batchGenerateImages,
    downloadAndSaveImage,
    IMAGE_MODELS, ASPECT_RATIO_MAP,
    getAccountInstanceId, fetchRecaptchaToken, clearRecaptchaToken,
} from '../lib/google-flow-api.js';
import { uploadOrReuse, saveMediaId } from '../lib/media-cache.js';

export const name = 'generate_google_flow_image';
export const description = `Generate ONE image using Google Flow ImageFX. Supports using REFERENCE IMAGES (up to 10) by providing local file paths — the generated image will be inspired by these references for style/subject transfer. For multiple images, call this tool multiple times. For 2K/4K, generate at 1k first then use upscale_google_flow_image separately.

⚠️ CRITICAL — SEQUENTIAL ONLY: All Google Flow tools (generate_google_flow_image, generate_google_flow_video, upscale_google_flow_image, upscale_google_flow_video) share a SINGLE browser session. You MUST call them ONE AT A TIME, waiting for each call to fully complete before making the next. If you call multiple Google Flow tools in parallel, ALL calls WILL FAIL with timeouts and NO images/videos will be created. This is not a suggestion — it is a hard technical constraint.`;

export const schema = {
    prompt: z.string().describe('Image generation prompt'),
    model: z.enum(['banana2', 'banana_pro']).default('banana_pro').describe('Image model: banana2 or banana_pro (default)'),
    aspect_ratio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4']).default('9:16').describe('Aspect ratio'),
    reference_image_path: z.string().optional().describe('Absolute local file path to a single reference image. Use reference_image_paths for multiple references.'),
    reference_image_paths: z.array(z.string()).optional().describe('Array of 1-10 absolute paths to reference images for style/subject transfer. The generated image will be inspired by all references. Max 10 images.'),
    output_dir: z.string().optional().describe('Directory to save the image. Defaults to uploads/mcp-generated/'),
};

export async function handler(params, extra) {
    const progress = createProgress(extra);
    await progress('Loading credentials...');

    const cred = getCredential();
    const token = cred.token;
    const projectId = cred.metadata.projectId;
    if (!projectId) throw new Error('GOOGLE_FLOW_PROJECT_ID is not set in .env file.');

    const modelName = IMAGE_MODELS[params.model] || 'NARWHAL';
    const aspectRatio = ASPECT_RATIO_MAP[params.aspect_ratio] || 'IMAGE_ASPECT_RATIO_PORTRAIT';
    const sessionCookies = cred.metadata.sessionCookies || '';
    const instanceId = getAccountInstanceId(cred);

    // Collect reference image paths (support both single and array)
    const refPaths = [];
    if (params.reference_image_paths && params.reference_image_paths.length > 0) {
        refPaths.push(...params.reference_image_paths.slice(0, 10));
    } else if (params.reference_image_path) {
        refPaths.push(params.reference_image_path);
    }

    // Upload reference images (with cache — avoids re-uploading same file)
    const referenceMediaIds = [];
    for (let i = 0; i < refPaths.length; i++) {
        try {
            await progress(`Uploading reference image ${i + 1}/${refPaths.length}...`);
            const mediaId = await uploadOrReuse(refPaths[i], (base64) => uploadReferenceImage(token, projectId, base64));
            referenceMediaIds.push(mediaId);
        } catch (e) {
            console.error(`[MCP] Failed to upload reference image ${i + 1}: ${e.message}`);
        }
    }

    // Generate 1 image
    await progress('Getting reCAPTCHA token...');
    const recaptchaToken = await fetchRecaptchaToken(sessionCookies, 'IMAGE_GENERATION', instanceId);

    await progress('Generating image...');
    const batchId = uuidv4();
    const result = await batchGenerateImages(token, projectId, {
        prompt: params.prompt, modelName, aspectRatio,
        referenceMediaIds, recaptchaToken, batchId,
        sessionId: `;${Date.now()}`,
        sessionCookies, instanceId,
        seed: Math.floor(Math.random() * 2147483647),
    });
    await clearRecaptchaToken(recaptchaToken);

    if (!result.length || !result[0].fifeUrl) {
        return { content: [{ type: 'text', text: '⚠️ No image returned from Google Flow.' }] };
    }

    // Save image
    const uploadDir = process.env.UPLOAD_DIR || './uploads';
    const outputDir = params.output_dir || join(uploadDir, 'mcp-generated');
    await mkdir(outputDir, { recursive: true });

    await progress('Downloading image...');
    const r = result[0];
    try {
        const { filepath } = await downloadAndSaveImage(r.fifeUrl, outputDir);
        // Cache the generated image's mediaId so it can be reused as reference/frame later
        if (r.mediaId && filepath) {
            await saveMediaId(filepath, r.mediaId);
        }
        return {
            content: [{ type: 'text', text: `✅ Image generated!\n\n**File**: ${filepath}\n**Media ID**: ${r.mediaId}\n**Dimensions**: ${r.dimensions?.width || '?'}x${r.dimensions?.height || '?'}\n\nUse the media ID with \`upscale_google_flow_image\` for 2K/4K, or with \`generate_google_flow_video\` as a start frame.` }],
        };
    } catch (e) {
        return {
            content: [{ type: 'text', text: `✅ Image generated but download failed.\n\n**FIFE URL**: ${r.fifeUrl}\n**Media ID**: ${r.mediaId}\n**Error**: ${e.message}` }],
        };
    }
}
