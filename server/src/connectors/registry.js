/**
 * Connector Registry
 * 
 * Central registry for all workflow node connectors.
 * Each connector handles a specific node type (gemini, google-flow, file-upload, etc.)
 */

import { GeminiConnector } from './gemini/connector.js';
import { GoogleFlowImageConnector, GoogleFlowVideoConnector } from './google-flow/connector.js';
import { FileUploadConnector, FileDownloadConnector } from './file-handler/connector.js';
import { DelayConnector, TextTemplateConnector } from './utilities/connector.js';
import { TextExtractorConnector } from './text-extractor/connector.js';
import { ChatGPTNoteConnector } from './chatgpt-note/connector.js';

const connectors = {};

function register(type, instance) {
    connectors[type] = instance;
}

export function getConnector(type) {
    return connectors[type] || null;
}

export function getAllConnectorMetadata() {
    return Object.entries(connectors).map(([type, connector]) => ({
        type,
        ...connector.constructor.metadata,
    }));
}

// Register all built-in connectors
register('gemini', new GeminiConnector());
register('google-flow-image', new GoogleFlowImageConnector());
register('google-flow-video', new GoogleFlowVideoConnector());
register('chatgpt-note', new ChatGPTNoteConnector());
register('file-upload', new FileUploadConnector());
register('file-download', new FileDownloadConnector());
register('delay', new DelayConnector());
register('text-template', new TextTemplateConnector());
register('text-extractor', new TextExtractorConnector());
