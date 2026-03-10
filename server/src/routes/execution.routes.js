import { Router } from 'express';
import { prisma } from '../index.js';
import { executeWorkflow } from '../services/workflow-engine.js';
import { runJobBatch, pauseBatch, resumeBatch, cancelBatch } from '../services/job-runner.js';
import archiver from 'archiver';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { join, basename } from 'path';

const router = Router();

// POST /api/executions/:workflowId/run — execute a workflow (legacy)
router.post('/:workflowId/run', async (req, res, next) => {
    try {
        const { instanceCount = 1, inputData } = req.body;

        const workflow = await prisma.workflow.findFirst({
            where: { id: req.params.workflowId, userId: req.user.id },
        });

        if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

        const executions = [];

        for (let i = 0; i < Math.min(instanceCount, 50); i++) {
            const execution = await prisma.workflowExecution.create({
                data: {
                    workflowId: workflow.id,
                    instanceIndex: i,
                    status: 'pending',
                    inputData: inputData?.[i] ? JSON.stringify(inputData[i]) : null,
                },
            });
            executions.push(execution);
        }

        // Trigger background execution for each instance
        for (const execution of executions) {
            executeWorkflow(execution.id, req.user.id).catch((err) => {
                console.error(`Execution ${execution.id} failed:`, err);
            });
        }

        res.status(202).json({
            message: `Started ${executions.length} workflow instance(s)`,
            executions: executions.map((e) => ({
                id: e.id,
                instanceIndex: e.instanceIndex,
                status: e.status,
            })),
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/executions/:workflowId/run-jobs — run selected jobs as a batch
router.post('/:workflowId/run-jobs', async (req, res, next) => {
    try {
        const { jobIds, mode = 'parallel', concurrency = 3 } = req.body;

        if (!Array.isArray(jobIds) || jobIds.length === 0) {
            return res.status(400).json({ error: 'jobIds array is required' });
        }

        const workflow = await prisma.workflow.findFirst({
            where: { id: req.params.workflowId, userId: req.user.id },
        });
        if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

        const result = await runJobBatch(
            req.params.workflowId,
            jobIds,
            req.user.id,
            mode,
            Math.min(concurrency, 10),
        );

        res.status(202).json({
            message: `Started ${result.executions.length} job(s) in ${mode} mode`,
            batchId: result.batchId,
            executions: result.executions,
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/executions/batch/:batchId — get batch status with job details
router.get('/batch/:batchId', async (req, res, next) => {
    try {
        const batch = await prisma.jobBatch.findUnique({
            where: { id: req.params.batchId },
            include: {
                workflow: { select: { userId: true } },
                executions: {
                    include: {
                        nodeExecutions: {
                            select: {
                                id: true,
                                nodeId: true,
                                nodeType: true,
                                status: true,
                                startedAt: true,
                                completedAt: true,
                                error: true,
                                outputData: true,
                            },
                        },
                    },
                    orderBy: { instanceIndex: 'asc' },
                },
            },
        });

        if (!batch || batch.workflow.userId !== req.user.id) {
            return res.status(404).json({ error: 'Batch not found' });
        }

        // Enrich executions with job info
        const jobIds = batch.executions.map(e => e.jobId).filter(Boolean);
        const jobs = jobIds.length > 0
            ? await prisma.job.findMany({ where: { id: { in: jobIds } } })
            : [];
        const jobMap = new Map(jobs.map(j => [j.id, j]));

        res.json({
            batch: {
                id: batch.id,
                mode: batch.mode,
                concurrency: batch.concurrency,
                status: batch.status,
                totalJobs: batch.totalJobs,
                completedJobs: batch.completedJobs,
                failedJobs: batch.failedJobs,
                startedAt: batch.startedAt,
                completedAt: batch.completedAt,
            },
            executions: batch.executions.map(e => {
                const job = e.jobId ? jobMap.get(e.jobId) : null;
                return {
                    id: e.id,
                    jobId: e.jobId,
                    jobName: job?.name || `Instance ${e.instanceIndex}`,
                    status: e.status,
                    startedAt: e.startedAt,
                    completedAt: e.completedAt,
                    error: e.error,
                    nodeExecutions: e.nodeExecutions.map(ne => ({
                        ...ne,
                        outputData: ne.outputData ? JSON.parse(ne.outputData) : null,
                    })),
                };
            }),
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/executions/batch/:batchId/pause
router.post('/batch/:batchId/pause', async (req, res, next) => {
    try {
        const batch = await prisma.jobBatch.findUnique({
            where: { id: req.params.batchId },
            include: { workflow: { select: { userId: true } } },
        });
        if (!batch || batch.workflow.userId !== req.user.id) {
            return res.status(404).json({ error: 'Batch not found' });
        }
        await pauseBatch(req.params.batchId);
        res.json({ message: 'Batch paused' });
    } catch (err) {
        next(err);
    }
});

// POST /api/executions/batch/:batchId/resume
router.post('/batch/:batchId/resume', async (req, res, next) => {
    try {
        const batch = await prisma.jobBatch.findUnique({
            where: { id: req.params.batchId },
            include: { workflow: { select: { userId: true } } },
        });
        if (!batch || batch.workflow.userId !== req.user.id) {
            return res.status(404).json({ error: 'Batch not found' });
        }
        await resumeBatch(req.params.batchId);
        res.json({ message: 'Batch resumed' });
    } catch (err) {
        next(err);
    }
});

// POST /api/executions/batch/:batchId/cancel
router.post('/batch/:batchId/cancel', async (req, res, next) => {
    try {
        const batch = await prisma.jobBatch.findUnique({
            where: { id: req.params.batchId },
            include: { workflow: { select: { userId: true } } },
        });
        if (!batch || batch.workflow.userId !== req.user.id) {
            return res.status(404).json({ error: 'Batch not found' });
        }
        await cancelBatch(req.params.batchId);
        res.json({ message: 'Batch cancelled' });
    } catch (err) {
        next(err);
    }
});

// GET /api/executions/:workflowId/job-history — flat list of all job executions (paginated)
router.get('/:workflowId/job-history', async (req, res, next) => {
    try {
        const workflow = await prisma.workflow.findFirst({
            where: { id: req.params.workflowId, userId: req.user.id },
        });
        if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

        const limit = Math.min(parseInt(req.query.limit) || 10, 50);
        const offset = parseInt(req.query.offset) || 0;

        // Get total count for hasMore
        const total = await prisma.workflowExecution.count({
            where: {
                workflowId: req.params.workflowId,
                jobId: { not: null },
            },
        });

        // Light query — NO outputData (the heavy field)
        const executions = await prisma.workflowExecution.findMany({
            where: {
                workflowId: req.params.workflowId,
                jobId: { not: null },
            },
            orderBy: { startedAt: 'desc' },
            take: limit,
            skip: offset,
            include: {
                nodeExecutions: {
                    select: {
                        id: true, nodeId: true, nodeType: true,
                        status: true, startedAt: true, completedAt: true,
                        error: true,
                        // outputData intentionally excluded — too heavy for list view
                    },
                },
            },
        });

        // Separate lightweight query: only fetch outputData for media-producing nodes
        const execIds = executions.map(e => e.id);
        const MEDIA_NODE_TYPES = ['google-flow-image', 'google-flow-video'];
        const mediaNodes = execIds.length > 0
            ? await prisma.nodeExecution.findMany({
                where: {
                    executionId: { in: execIds },
                    nodeType: { in: MEDIA_NODE_TYPES },
                    status: 'completed',
                },
                select: { executionId: true, nodeType: true, outputData: true },
            })
            : [];

        // Extract thumbnail URLs per execution
        const thumbnailMap = new Map(); // executionId -> { thumbnailUrl, mediaCount }
        for (const mn of mediaNodes) {
            let output;
            try { output = typeof mn.outputData === 'string' ? JSON.parse(mn.outputData) : mn.outputData; } catch { continue; }
            if (!output) continue;

            if (!thumbnailMap.has(mn.executionId)) {
                thumbnailMap.set(mn.executionId, { urls: [], types: [] });
            }
            const entry = thumbnailMap.get(mn.executionId);

            if (output.imageUrl) entry.urls.push({ url: output.imageUrl, type: 'image' });
            if (output.videoUrl) entry.urls.push({ url: output.videoUrl, type: 'video' });
            if (output.fileUrl && !output.imageUrl && !output.videoUrl) {
                const ext = (output.fileName || output.fileUrl || '').split('.').pop()?.toLowerCase();
                const isVideo = ['mp4', 'webm', 'mov'].includes(ext);
                const isImage = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext);
                if (isVideo || isImage) entry.urls.push({ url: output.fileUrl, type: isVideo ? 'video' : 'image' });
            }
            for (const arrKey of ['allImages', 'savedImages']) {
                if (Array.isArray(output[arrKey])) {
                    for (const item of output[arrKey]) {
                        if (item.imageUrl) entry.urls.push({ url: item.imageUrl, type: 'image' });
                    }
                }
            }
        }

        // Get job names
        const jobIds = [...new Set(executions.map(e => e.jobId).filter(Boolean))];
        const jobs = jobIds.length > 0
            ? await prisma.job.findMany({ where: { id: { in: jobIds } } })
            : [];
        const jobMap = new Map(jobs.map(j => [j.id, j]));

        // Get batch info
        const batchIds = [...new Set(executions.map(e => e.jobBatchId).filter(Boolean))];
        const batches = batchIds.length > 0
            ? await prisma.jobBatch.findMany({ where: { id: { in: batchIds } } })
            : [];
        const batchMap = new Map(batches.map(b => [b.id, b]));

        res.json({
            total,
            hasMore: offset + limit < total,
            executions: executions.map(e => {
                const job = e.jobId ? jobMap.get(e.jobId) : null;
                const batch = e.jobBatchId ? batchMap.get(e.jobBatchId) : null;
                const media = thumbnailMap.get(e.id);
                return {
                    id: e.id,
                    jobId: e.jobId,
                    jobName: job?.name || `Job`,
                    batchId: e.jobBatchId,
                    batchStatus: batch?.status,
                    batchMode: batch?.mode,
                    status: e.status,
                    startedAt: e.startedAt,
                    completedAt: e.completedAt,
                    error: e.error,
                    // Lightweight: only media URLs, no full outputData
                    mediaItems: media?.urls || [],
                    nodeExecutions: e.nodeExecutions.map(ne => ({
                        id: ne.id,
                        nodeId: ne.nodeId,
                        nodeType: ne.nodeType,
                        status: ne.status,
                        startedAt: ne.startedAt,
                        completedAt: ne.completedAt,
                        error: ne.error,
                        // outputData omitted — load on demand via detail endpoint
                    })),
                };
            }),
        });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/executions/:executionId — delete a single execution from history
router.delete('/:executionId', async (req, res, next) => {
    try {
        const execution = await prisma.workflowExecution.findUnique({
            where: { id: req.params.executionId },
            include: {
                workflow: { select: { userId: true } },
                nodeExecutions: { select: { outputData: true } },
            },
        });
        if (!execution || execution.workflow.userId !== req.user.id) {
            return res.status(404).json({ error: 'Execution not found' });
        }

        // Collect output file paths and delete their parent folders
        const foldersToDelete = new Set();
        for (const ne of execution.nodeExecutions) {
            let output;
            try { output = typeof ne.outputData === 'string' ? JSON.parse(ne.outputData) : ne.outputData; } catch { continue; }
            if (!output) continue;

            // Collect all file paths from output
            for (const key of ['videoPath', 'imagePath', 'filePath']) {
                if (output[key]) foldersToDelete.add(path.dirname(path.resolve(output[key])));
            }
            for (const key of ['videoUrl', 'imageUrl', 'fileUrl']) {
                if (output[key] && !output[key].startsWith('http')) {
                    const relPath = output[key].replace(/^\//, '');
                    foldersToDelete.add(path.dirname(path.resolve(relPath)));
                }
            }
            for (const arrKey of ['allImages', 'savedImages']) {
                if (Array.isArray(output[arrKey])) {
                    for (const item of output[arrKey]) {
                        if (item.imagePath) foldersToDelete.add(path.dirname(path.resolve(item.imagePath)));
                        else if (item.imageUrl && !item.imageUrl.startsWith('http')) {
                            foldersToDelete.add(path.dirname(path.resolve(item.imageUrl.replace(/^\//, ''))));
                        }
                    }
                }
            }
        }

        // Delete folders from disk
        for (const folder of foldersToDelete) {
            try {
                // Safety: only delete folders under uploads/jobs/
                if (folder.includes(path.join('uploads', 'jobs'))) {
                    await fs.rm(folder, { recursive: true, force: true });
                    console.log(`[Delete] Removed folder: ${folder}`);
                }
            } catch (e) {
                console.warn(`[Delete] Failed to remove ${folder}:`, e.message);
            }
        }

        // Delete node executions first, then the execution
        await prisma.nodeExecution.deleteMany({ where: { executionId: req.params.executionId } });
        await prisma.workflowExecution.delete({ where: { id: req.params.executionId } });

        res.json({ message: 'Execution deleted' });
    } catch (err) {
        next(err);
    }
});

// GET /api/executions/batch/:batchId/download — download all outputs as ZIP
router.get('/batch/:batchId/download', async (req, res, next) => {
    try {
        const batch = await prisma.jobBatch.findUnique({
            where: { id: req.params.batchId },
            include: {
                workflow: { select: { userId: true, name: true } },
                executions: {
                    include: {
                        nodeExecutions: { select: { outputData: true, nodeType: true, nodeId: true } },
                    },
                },
            },
        });

        if (!batch || batch.workflow.userId !== req.user.id) {
            return res.status(404).json({ error: 'Batch not found' });
        }

        const files = collectOutputFiles(batch.executions);
        if (files.length === 0) {
            return res.status(404).json({ error: 'No output files found' });
        }

        const safeName = (batch.workflow.name || 'batch').replace(/[^\w.-]/g, '_');
        const zipName = `${safeName}_${batch.id.slice(0, 8)}.zip`;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

        const archive = archiver('zip', { zlib: { level: 5 } });
        archive.pipe(res);

        for (const f of files) {
            archive.file(f.absolutePath, { name: f.archiveName });
        }

        await archive.finalize();
    } catch (err) {
        next(err);
    }
});

// GET /api/executions/batch/:batchId/download/:executionId — download one job's outputs
router.get('/batch/:batchId/download/:executionId', async (req, res, next) => {
    try {
        const execution = await prisma.workflowExecution.findUnique({
            where: { id: req.params.executionId },
            include: {
                workflow: { select: { userId: true, name: true } },
                nodeExecutions: { select: { outputData: true, nodeType: true, nodeId: true } },
            },
        });

        if (!execution || execution.workflow.userId !== req.user.id || execution.jobBatchId !== req.params.batchId) {
            return res.status(404).json({ error: 'Execution not found' });
        }

        const files = collectOutputFiles([execution]);
        if (files.length === 0) {
            return res.status(404).json({ error: 'No output files found' });
        }

        const zipName = `job_${req.params.executionId.slice(0, 8)}.zip`;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

        const archive = archiver('zip', { zlib: { level: 5 } });
        archive.pipe(res);

        for (const f of files) {
            archive.file(f.absolutePath, { name: f.archiveName });
        }

        await archive.finalize();
    } catch (err) {
        next(err);
    }
});

/**
 * Extract downloadable file paths from node execution outputs
 */
function collectOutputFiles(executions) {
    const uploadsDir = process.env.UPLOAD_DIR || './uploads';
    const files = [];
    const seen = new Set();

    for (const exec of executions) {
        const jobLabel = exec.instanceIndex != null ? `job_${exec.instanceIndex + 1}` : 'output';

        for (const ne of exec.nodeExecutions || []) {
            let output;
            try { output = typeof ne.outputData === 'string' ? JSON.parse(ne.outputData) : ne.outputData; } catch { continue; }
            if (!output) continue;

            // Collect file paths from various output formats
            const candidates = [];

            // Single file outputs: imageUrl, videoUrl, fileUrl, videoPath, imagePath, filePath
            for (const key of ['videoPath', 'imagePath', 'filePath']) {
                if (output[key]) candidates.push(output[key]);
            }
            for (const key of ['videoUrl', 'imageUrl', 'fileUrl']) {
                if (output[key] && !output[key].startsWith('http')) {
                    // Convert relative URL to file path
                    const relPath = output[key].replace(/^\//, '');
                    candidates.push(relPath);
                }
            }

            // Array outputs: allImages, savedImages
            for (const arrKey of ['allImages', 'savedImages', 'images']) {
                if (Array.isArray(output[arrKey])) {
                    for (const item of output[arrKey]) {
                        if (item.imagePath) candidates.push(item.imagePath);
                        else if (item.imageUrl && !item.imageUrl.startsWith('http')) {
                            candidates.push(item.imageUrl.replace(/^\//, ''));
                        }
                    }
                }
            }

            for (const candidate of candidates) {
                const absPath = candidate.startsWith('/') || candidate.startsWith('.') ? candidate : join('.', candidate);
                if (seen.has(absPath)) continue;
                if (!existsSync(absPath)) continue;
                seen.add(absPath);

                files.push({
                    absolutePath: absPath,
                    archiveName: `${jobLabel}/${basename(absPath)}`,
                });
            }
        }
    }

    return files;
}

// GET /api/executions/:workflowId — list executions for a workflow
router.get('/:workflowId', async (req, res, next) => {
    try {
        const workflow = await prisma.workflow.findFirst({
            where: { id: req.params.workflowId, userId: req.user.id },
        });

        if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

        const executions = await prisma.workflowExecution.findMany({
            where: { workflowId: req.params.workflowId },
            orderBy: { startedAt: 'desc' },
            take: 50,
            include: {
                nodeExecutions: {
                    select: {
                        id: true,
                        nodeId: true,
                        nodeType: true,
                        status: true,
                        startedAt: true,
                        completedAt: true,
                        error: true,
                    },
                },
            },
        });

        res.json({ executions });
    } catch (err) {
        next(err);
    }
});

// GET /api/executions/detail/:executionId — get execution detail
router.get('/detail/:executionId', async (req, res, next) => {
    try {
        const execution = await prisma.workflowExecution.findUnique({
            where: { id: req.params.executionId },
            include: {
                nodeExecutions: true,
                workflow: {
                    select: { userId: true },
                },
            },
        });

        if (!execution || execution.workflow.userId !== req.user.id) {
            return res.status(404).json({ error: 'Execution not found' });
        }

        const nodeExecutions = execution.nodeExecutions.map((ne) => ({
            ...ne,
            inputData: ne.inputData ? JSON.parse(ne.inputData) : null,
            outputData: ne.outputData ? JSON.parse(ne.outputData) : null,
            logs: ne.logs ? JSON.parse(ne.logs) : [],
        }));

        res.json({
            execution: {
                ...execution,
                inputData: execution.inputData ? JSON.parse(execution.inputData) : null,
                nodeExecutions,
            },
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/executions/cancel/:executionId
router.post('/cancel/:executionId', async (req, res, next) => {
    try {
        const execution = await prisma.workflowExecution.findUnique({
            where: { id: req.params.executionId },
            include: { workflow: { select: { userId: true } } },
        });

        if (!execution || execution.workflow.userId !== req.user.id) {
            return res.status(404).json({ error: 'Execution not found' });
        }

        if (execution.status !== 'running' && execution.status !== 'pending') {
            return res.status(400).json({ error: 'Execution is not running' });
        }

        await prisma.workflowExecution.update({
            where: { id: req.params.executionId },
            data: { status: 'cancelled', completedAt: new Date() },
        });

        res.json({ message: 'Execution cancelled' });
    } catch (err) {
        next(err);
    }
});

export default router;

