/**
 * Workflow Engine — Core execution logic
 * 
 * Parses workflow graph (nodes + edges), builds execution order via
 * topological sort, then executes nodes sequentially, passing outputs
 * from previous nodes as inputs to subsequent nodes.
 */

import { prisma, io } from '../index.js';
import { getConnector } from '../connectors/registry.js';
import { mkdir } from 'fs/promises';
import { join } from 'path';

/**
 * Execute a workflow instance
 */
export async function executeWorkflow(executionId, userId) {
    const execution = await prisma.workflowExecution.findUnique({
        where: { id: executionId },
        include: { workflow: true },
    });

    if (!execution) throw new Error('Execution not found');

    // Mark as running
    await prisma.workflowExecution.update({
        where: { id: executionId },
        data: { status: 'running', startedAt: new Date() },
    });

    emitUpdate(userId, executionId, { status: 'running' });

    try {
        const nodes = JSON.parse(execution.workflow.nodesData || '[]');
        const edges = JSON.parse(execution.workflow.edgesData || '[]');
        const initialInput = execution.inputData ? JSON.parse(execution.inputData) : {};

        // Build adjacency & dependency maps
        const { sortedNodes, nodeMap, incomingEdges } = buildExecutionGraph(nodes, edges);

        // Create per-job download folder
        const workflowName = (execution.workflow.name || 'workflow')
            .replace(/[^a-zA-Z0-9_\-\s]/g, '')
            .replace(/\s+/g, '_')
            .substring(0, 50);
        const timestamp = new Date().toISOString()
            .replace(/T/, '_')
            .replace(/:/g, '-')
            .replace(/\..*$/, '');
        const uploadsDir = process.env.UPLOAD_DIR || './uploads';
        const jobDir = join(uploadsDir, 'jobs', `${workflowName}_${timestamp}`);
        await mkdir(jobDir, { recursive: true });
        console.log(`[Engine] Job folder created: ${jobDir}`);

        // Context holds outputs from all executed nodes
        const context = { _input: initialInput, _jobDir: jobDir };

        // Create node execution records
        for (const node of sortedNodes) {
            await prisma.nodeExecution.create({
                data: {
                    executionId,
                    nodeId: node.id,
                    nodeType: node.data?.type || node.type || 'unknown',
                    status: 'pending',
                },
            });
        }

        // Execute nodes in topological order
        for (const node of sortedNodes) {
            // Check if execution was cancelled
            const currentExec = await prisma.workflowExecution.findUnique({
                where: { id: executionId },
            });
            if (currentExec.status === 'cancelled') {
                throw new Error('Execution cancelled by user');
            }

            await executeNode(node, context, incomingEdges, executionId, userId);
        }

        // Mark as completed
        await prisma.workflowExecution.update({
            where: { id: executionId },
            data: { status: 'completed', completedAt: new Date() },
        });

        emitUpdate(userId, executionId, { status: 'completed' });

    } catch (err) {
        await prisma.workflowExecution.update({
            where: { id: executionId },
            data: {
                status: 'failed',
                completedAt: new Date(),
                error: err.message,
            },
        });

        emitUpdate(userId, executionId, { status: 'failed', error: err.message });
        throw err;
    }
}

/**
 * Build execution graph and return topologically sorted nodes.
 * Only includes nodes that are part of the connected graph (have at least one edge).
 * Isolated nodes (no incoming AND no outgoing edges) are skipped.
 */
function buildExecutionGraph(nodes, edges) {
    const nodeMap = new Map();
    nodes.forEach((n) => nodeMap.set(n.id, n));

    // Build adjacency list and incoming edge map
    const adjacency = new Map(); // nodeId -> [targetNodeIds]
    const inDegree = new Map();
    const incomingEdges = new Map(); // nodeId -> [sourceNodeIds]
    const outDegree = new Map(); // nodeId -> number of outgoing edges

    nodes.forEach((n) => {
        adjacency.set(n.id, []);
        inDegree.set(n.id, 0);
        outDegree.set(n.id, 0);
        incomingEdges.set(n.id, []);
    });

    edges.forEach((edge) => {
        const source = edge.source;
        const target = edge.target;
        if (adjacency.has(source) && inDegree.has(target)) {
            adjacency.get(source).push(target);
            inDegree.set(target, inDegree.get(target) + 1);
            outDegree.set(source, outDegree.get(source) + 1);
            incomingEdges.get(target).push(source);
        }
    });

    // Filter: only include nodes that are connected (have at least one edge)
    const connectedNodeIds = new Set();
    nodes.forEach((n) => {
        if (inDegree.get(n.id) > 0 || outDegree.get(n.id) > 0) {
            connectedNodeIds.add(n.id);
        }
    });

    // If no edges at all (single node or all isolated), fall back to running all nodes
    if (connectedNodeIds.size === 0) {
        nodes.forEach((n) => connectedNodeIds.add(n.id));
    }

    // Kahn's algorithm for topological sort (only connected nodes)
    const queue = [];
    connectedNodeIds.forEach((nodeId) => {
        if (inDegree.get(nodeId) === 0) queue.push(nodeId);
    });

    const sortedIds = [];
    while (queue.length > 0) {
        const current = queue.shift();
        sortedIds.push(current);

        for (const neighbor of adjacency.get(current) || []) {
            if (!connectedNodeIds.has(neighbor)) continue;
            inDegree.set(neighbor, inDegree.get(neighbor) - 1);
            if (inDegree.get(neighbor) === 0) {
                queue.push(neighbor);
            }
        }
    }

    if (sortedIds.length !== connectedNodeIds.size) {
        throw new Error('Workflow contains a cycle — cannot execute');
    }

    const sortedNodes = sortedIds.map((id) => nodeMap.get(id));

    // Log skipped nodes
    const skippedCount = nodes.length - connectedNodeIds.size;
    if (skippedCount > 0) {
        console.log(`[Engine] Skipping ${skippedCount} disconnected node(s)`);
    }

    return { sortedNodes, nodeMap, incomingEdges };
}

/**
 * Execute a single node
 */
async function executeNode(node, context, incomingEdges, executionId, userId) {
    const nodeType = node.data?.type || node.type || 'unknown';
    const nodeConfig = node.data?.config || {};
    const nodeId = node.id;

    // Build input from connected upstream nodes
    const sources = incomingEdges.get(nodeId) || [];
    const input = {};

    for (const sourceId of sources) {
        if (context[sourceId]) {
            Object.assign(input, context[sourceId]);
        }
    }

    // Also merge initial execution input
    if (sources.length === 0 && context._input) {
        Object.assign(input, context._input);
    }

    // Resolve template variables in config: {{nodeId.field}}
    const resolvedConfig = resolveTemplates(nodeConfig, context);

    // Mark node as running
    await prisma.nodeExecution.updateMany({
        where: { executionId, nodeId },
        data: {
            status: 'running',
            startedAt: new Date(),
            inputData: JSON.stringify(input),
        },
    });

    emitUpdate(userId, executionId, {
        nodeId,
        nodeStatus: 'running',
    });

    try {
        // Get connector and execute
        const connector = getConnector(nodeType);
        if (!connector) {
            throw new Error(`No connector found for node type: ${nodeType}`);
        }

        // Load credentials if needed
        let credentials = null;
        if (nodeConfig.credentialId) {
            const rawCred = await prisma.credential.findUnique({
                where: { id: nodeConfig.credentialId },
            });
            if (rawCred) {
                credentials = {
                    ...rawCred,
                    metadata: rawCred.metadata ? JSON.parse(rawCred.metadata) : {},
                };
            }
        }

        const output = await connector.execute(input, credentials, resolvedConfig, { jobDir: context._jobDir });

        // Store output in context
        context[nodeId] = output;

        // Mark node as completed
        await prisma.nodeExecution.updateMany({
            where: { executionId, nodeId },
            data: {
                status: 'completed',
                completedAt: new Date(),
                outputData: JSON.stringify(output),
            },
        });

        emitUpdate(userId, executionId, {
            nodeId,
            nodeStatus: 'completed',
            output,
        });

    } catch (err) {
        await prisma.nodeExecution.updateMany({
            where: { executionId, nodeId },
            data: {
                status: 'failed',
                completedAt: new Date(),
                error: err.message,
            },
        });

        emitUpdate(userId, executionId, {
            nodeId,
            nodeStatus: 'failed',
            error: err.message,
        });

        throw new Error(`Node "${node.data?.label || nodeId}" failed: ${err.message}`);
    }
}

/**
 * Resolve {{nodeId.field}} templates in config values
 */
function resolveTemplates(config, context) {
    // Handle arrays: resolve templates inside each element but keep as array
    if (Array.isArray(config)) {
        return config.map(item => {
            if (typeof item === 'string') {
                return item.replace(/\{\{(\w+)\.(\w+)\}\}/g, (match, nodeId, field) => {
                    return context[nodeId]?.[field] ?? match;
                });
            } else if (typeof item === 'object' && item !== null) {
                return resolveTemplates(item, context);
            }
            return item;
        });
    }

    const resolved = {};

    for (const [key, value] of Object.entries(config)) {
        if (typeof value === 'string') {
            resolved[key] = value.replace(/\{\{(\w+)\.(\w+)\}\}/g, (match, nodeId, field) => {
                return context[nodeId]?.[field] ?? match;
            });
        } else if (Array.isArray(value)) {
            resolved[key] = resolveTemplates(value, context);
        } else if (typeof value === 'object' && value !== null) {
            resolved[key] = resolveTemplates(value, context);
        } else {
            resolved[key] = value;
        }
    }

    return resolved;
}

/**
 * Emit real-time update via Socket.IO
 */
function emitUpdate(userId, executionId, data) {
    try {
        io.to(`user:${userId}`).emit('execution:update', {
            executionId,
            ...data,
            timestamp: new Date().toISOString(),
        });
    } catch {
        // Socket.IO not ready yet — ignore
    }
}
