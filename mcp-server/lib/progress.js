/**
 * Progress notification helper for MCP tools.
 * Sends notifications/progress to keep the connection alive during long operations.
 */

/**
 * Create a progress reporter from MCP extra context.
 * Usage:
 *   const progress = createProgress(extra);
 *   await progress('Launching Chrome...');
 *   await progress('Generating image 1/4...');
 */
export function createProgress(extra) {
    let step = 0;

    return async (message, total = undefined) => {
        step++;
        console.error(`[Progress] ${message}`);

        // Try to send MCP progress notification
        try {
            if (extra?.sendNotification) {
                await extra.sendNotification({
                    method: 'notifications/progress',
                    params: {
                        progressToken: extra?._meta?.progressToken || `progress-${Date.now()}`,
                        progress: step,
                        total: total || undefined,
                        message,
                    },
                });
            }
        } catch {
            // Notification not supported by client — that's OK
        }
    };
}
