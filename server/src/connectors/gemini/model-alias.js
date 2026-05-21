/**
 * Backwards-compat aliasing for Gemini model IDs.
 *
 * When Google moves a preview model to GA they discontinue the `-preview` ID;
 * existing workflow node configs that still reference the old ID would 404.
 * Map them to the GA equivalent here so the rename is invisible to users.
 *
 * Update entries here when more preview→GA migrations land.
 */

const GEMINI_MODEL_ALIASES = {
    // 2026-05-25: flash-lite GA migration (email from Google AI Studio).
    'gemini-3.1-flash-lite-preview': 'gemini-3.1-flash-lite',
};

export function normalizeGeminiModel(model) {
    if (!model) return model;
    return GEMINI_MODEL_ALIASES[model] || model;
}
