/**
 * Bridge API — Communication between Chrome Extension and Workflow Server
 * 
 * The Chrome Extension polls /api/bridge/poll for pending ChatGPT requests.
 * After processing, it posts results to /api/bridge/result/:id.
 * 
 * The ChatGPT connector creates requests and waits for results.
 */

import { Router } from 'express';

const router = Router();

// In-memory request queue
const pendingRequests = new Map();  // id -> { request, resolve, reject, createdAt }

/**
 * POST /api/bridge/poll
 * Extension polls this to get pending requests
 */
router.post('/poll', (req, res) => {
    // Find the oldest pending request
    let oldest = null;
    for (const [id, entry] of pendingRequests) {
        if (!entry.pickedUp) {
            oldest = entry;
            break;
        }
    }

    if (oldest) {
        oldest.pickedUp = true;
        console.log(`[Bridge] Extension picked up request: ${oldest.request.id}`);
        res.json({ request: oldest.request });
    } else {
        res.json({ request: null });
    }
});

// Also support GET for easy testing
router.get('/poll', (req, res) => {
    res.json({ pending: pendingRequests.size, message: 'Use POST to poll' });
});

/**
 * POST /api/bridge/result/:id
 * Extension posts results here
 */
router.post('/result/:id', (req, res) => {
    const { id } = req.params;
    const entry = pendingRequests.get(id);

    if (!entry) {
        return res.status(404).json({ error: 'Request not found' });
    }

    const result = req.body;
    pendingRequests.delete(id);

    if (result.error) {
        entry.reject(new Error(result.error));
    } else {
        entry.resolve(result);
    }

    res.json({ ok: true });
});

/**
 * GET /api/bridge/status
 * Check bridge status
 */
router.get('/status', (req, res) => {
    res.json({
        pendingCount: pendingRequests.size,
        requests: Array.from(pendingRequests.entries()).map(([id, e]) => ({
            id,
            pickedUp: e.pickedUp || false,
            age: Date.now() - e.createdAt,
        })),
    });
});

/**
 * Create a pending request and wait for the extension to process it.
 * Called by the ChatGPT connector.
 */
export function createBridgeRequest(requestData, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const id = 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

        const entry = {
            request: { id, ...requestData },
            resolve,
            reject,
            createdAt: Date.now(),
            pickedUp: false,
        };

        pendingRequests.set(id, entry);

        // Timeout
        setTimeout(() => {
            if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                reject(new Error(
                    'Timeout: Extension did not respond within 2 minutes.\n' +
                    'Make sure the VCW ChatGPT Bridge extension is installed and enabled in Chrome,\n' +
                    'and you have a chatgpt.com tab open.'
                ));
            }
        }, timeoutMs);

        console.log(`[Bridge] Request ${id} queued. Waiting for extension...`);
    });
}

export default router;
