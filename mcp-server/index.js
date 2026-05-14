#!/usr/bin/env node

/**
 * Google Flow MCP Server
 *
 * Exposes Google Flow image/video generation and upscaling as MCP tools.
 * Communicates via stdio transport (JSON-RPC over stdin/stdout).
 *
 * All logging uses console.error (stdout is reserved for MCP protocol).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Import tools
import * as listCredentials from './tools/list-credentials.js';
import * as generateImage from './tools/generate-image.js';
import * as generateVideo from './tools/generate-video.js';
import * as upscaleImage from './tools/upscale-image.js';
import * as upscaleVideo from './tools/upscale-video.js';

// Create MCP server
const server = new McpServer({
    name: 'google-flow',
    version: '1.0.0',
});

// Register all tools — pass the `extra` context (with sendNotification) to handlers
const tools = [listCredentials, generateImage, generateVideo, upscaleImage, upscaleVideo];

for (const tool of tools) {
    server.tool(
        tool.name,
        tool.description,
        tool.schema,
        async (params, extra) => {
            try {
                return await tool.handler(params, extra);
            } catch (error) {
                console.error(`[MCP] Tool "${tool.name}" error:`, error.message);
                return {
                    content: [{ type: 'text', text: `❌ Error: ${error.message}` }],
                    isError: true,
                };
            }
        }
    );
}

// Start server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('🚀 Google Flow MCP Server running on stdio');
    console.error(`📋 Registered ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
