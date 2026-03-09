/**
 * Base Connector — Abstract class all connectors must extend
 */
export class BaseConnector {
    /**
     * Metadata about this connector (override in subclass)
     */
    static get metadata() {
        return {
            name: 'Base Connector',
            description: '',
            icon: '⚙️',
            category: 'general',
            configSchema: {},
        };
    }

    /**
     * Execute the connector's action
     * @param {Object} input - Data from upstream nodes
     * @param {Object|null} credentials - User credentials for this service
     * @param {Object} config - Node configuration
     * @param {Object} [context] - Execution context (jobDir, executionId, etc.)
     * @returns {Object} Output data to pass to downstream nodes
     */
    async execute(input, credentials, config, context = {}) {
        throw new Error('execute() must be implemented by subclass');
    }

    /**
     * Test if credentials are valid
     * @param {Object} credentials
     * @returns {boolean}
     */
    async testConnection(credentials) {
        return true;
    }
}
