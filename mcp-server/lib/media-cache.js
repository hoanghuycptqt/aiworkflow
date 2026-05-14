/**
 * Media Cache — Avoids re-uploading the same image to Google Flow.
 *
 * Maps file paths to their Google Flow mediaIds.
 * Cache key: filepath + file size + mtime (detects file changes).
 * Persists to disk as JSON for reuse across MCP sessions.
 */

import { readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';

const CACHE_FILENAME = '.media-cache.json';
let _cache = null;
let _cacheDir = null;

/**
 * Get the cache file path.
 */
function _getCachePath() {
    if (!_cacheDir) {
        _cacheDir = process.env.UPLOAD_DIR || './uploads';
    }
    return join(_cacheDir, CACHE_FILENAME);
}

/**
 * Load cache from disk (lazy, once).
 */
async function _loadCache() {
    if (_cache) return _cache;
    try {
        const raw = await readFile(_getCachePath(), 'utf-8');
        _cache = JSON.parse(raw);
        console.error(`[MediaCache] Loaded ${Object.keys(_cache).length} entries`);
    } catch {
        _cache = {};
    }
    return _cache;
}

/**
 * Save cache to disk.
 */
async function _saveCache() {
    if (!_cache) return;
    try {
        await writeFile(_getCachePath(), JSON.stringify(_cache, null, 2));
    } catch (e) {
        console.error(`[MediaCache] Failed to save cache: ${e.message}`);
    }
}

/**
 * Build a cache key from file metadata (path + size + mtime).
 */
async function _buildKey(filePath) {
    try {
        const s = await stat(filePath);
        return `${filePath}|${s.size}|${s.mtimeMs}`;
    } catch {
        return null;
    }
}

/**
 * Lookup a file's mediaId from cache.
 * Returns mediaId if found and file hasn't changed, null otherwise.
 */
export async function lookupMediaId(filePath) {
    const cache = await _loadCache();
    const key = await _buildKey(filePath);
    if (!key) return null;

    const entry = cache[key];
    if (entry?.mediaId) {
        console.error(`[MediaCache] HIT: ${filePath} → ${entry.mediaId}`);
        return entry.mediaId;
    }
    return null;
}

/**
 * Save a file's mediaId to cache.
 */
export async function saveMediaId(filePath, mediaId) {
    const cache = await _loadCache();
    const key = await _buildKey(filePath);
    if (!key || !mediaId) return;

    cache[key] = { mediaId, cachedAt: Date.now() };
    console.error(`[MediaCache] SAVE: ${filePath} → ${mediaId}`);
    await _saveCache();
}

/**
 * Upload a file to Google Flow, using cache to avoid re-uploads.
 * Returns the mediaId (from cache or fresh upload).
 */
export async function uploadOrReuse(filePath, uploadFn) {
    // Check cache first
    const cached = await lookupMediaId(filePath);
    if (cached) return cached;

    // Upload and cache
    const { readFile: readFileFn } = await import('fs/promises');
    const buf = await readFileFn(filePath);
    const mediaId = await uploadFn(buf.toString('base64'));

    // Save to cache
    await saveMediaId(filePath, mediaId);
    return mediaId;
}
