/**
 * Ollama routes — model discovery for the local LLM.
 * Mounted under authMiddleware (any logged-in user) at /api/ollama.
 * The AI Text node config panel and the admin settings page both use this to
 * populate their model dropdowns from whatever is actually pulled on the box.
 */

import { Router } from 'express';
import { fetchOllamaModels, getOllamaBaseUrl } from '../services/ollama.js';

const router = Router();

// GET /api/ollama/models — live list of pulled models (cached 60s)
router.get('/models', async (req, res, next) => {
    try {
        const models = await fetchOllamaModels({ force: req.query.force === '1' });
        res.json({ models, baseUrl: getOllamaBaseUrl(), reachable: models.length > 0 });
    } catch (err) {
        next(err);
    }
});

export default router;
