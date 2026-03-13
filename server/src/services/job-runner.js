/**
 * Job Runner — Orchestrates parallel/sequential execution of job batches
 * 
 * Creates a JobBatch record, then fires WorkflowExecutions for each job
 * either in parallel (with concurrency limit) or sequentially.
 */

import { prisma, io } from '../index.js';
import { executeWorkflow } from './workflow-engine.js';

/**
 * Run a batch of jobs for a workflow.
 * 
 * @param {string} workflowId - The workflow to execute
 * @param {string[]} jobIds - Array of job IDs to run
 * @param {string} userId - The user running the jobs
 * @param {'parallel'|'sequential'} mode - Execution mode
 * @param {number} concurrency - Max parallel jobs (for parallel mode)
 * @returns {Promise<{batchId: string, executions: object[]}>}
 */
export async function runJobBatch(workflowId, jobIds, userId, mode = 'parallel', concurrency = 3) {
    // Load jobs in order
    const jobs = await prisma.job.findMany({
        where: { id: { in: jobIds }, workflowId },
        orderBy: { order: 'asc' },
    });

    if (jobs.length === 0) {
        throw new Error('No valid jobs found');
    }

    // Create batch record
    const batch = await prisma.jobBatch.create({
        data: {
            workflowId,
            mode,
            concurrency,
            status: 'pending',
            totalJobs: jobs.length,
        },
    });

    // Create WorkflowExecution for each job
    const executions = [];
    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const jobInput = job.inputData ? JSON.parse(job.inputData) : {};

        const execution = await prisma.workflowExecution.create({
            data: {
                workflowId,
                instanceIndex: i,
                status: 'pending',
                inputData: JSON.stringify(jobInput),
                jobId: job.id,
                jobBatchId: batch.id,
            },
        });
        executions.push({ execution, job });
    }

    // Mark batch as running
    await prisma.jobBatch.update({
        where: { id: batch.id },
        data: { status: 'running', startedAt: new Date() },
    });

    emitBatchUpdate(userId, batch.id, {
        batchId: batch.id,
        status: 'running',
        totalJobs: jobs.length,
        completedJobs: 0,
        failedJobs: 0,
    });

    // Fire execution based on mode
    if (mode === 'sequential') {
        runSequential(batch.id, executions, userId);
    } else {
        runParallel(batch.id, executions, userId, concurrency);
    }

    return {
        batchId: batch.id,
        executions: executions.map(({ execution, job }) => ({
            id: execution.id,
            jobId: job.id,
            jobName: job.name,
            instanceIndex: execution.instanceIndex,
            status: execution.status,
        })),
    };
}

/**
 * Run jobs sequentially, one after another.
 */
async function runSequential(batchId, executions, userId) {
    let completed = 0;
    let failed = 0;

    for (const { execution, job } of executions) {
        // Check if batch was cancelled/paused
        const batch = await prisma.jobBatch.findUnique({ where: { id: batchId } });
        if (!batch || batch.status === 'cancelled') {
            console.log(`[JobRunner] Batch ${batchId} cancelled, stopping sequential execution`);
            break;
        }
        if (batch.status === 'paused') {
            console.log(`[JobRunner] Batch ${batchId} paused, waiting...`);
            // Poll for resume
            let paused = true;
            while (paused) {
                await new Promise(r => setTimeout(r, 2000));
                const b = await prisma.jobBatch.findUnique({ where: { id: batchId } });
                if (!b || b.status === 'cancelled') {
                    console.log(`[JobRunner] Batch ${batchId} cancelled while paused`);
                    return finalizeBatch(batchId, userId, completed, failed, executions.length);
                }
                if (b.status === 'running') {
                    paused = false;
                }
            }
        }

        emitBatchUpdate(userId, batchId, {
            batchId,
            jobId: job.id,
            jobName: job.name,
            executionId: execution.id,
            jobStatus: 'running',
        });

        try {
            await executeWorkflow(execution.id, userId);
            completed++;
            emitBatchUpdate(userId, batchId, {
                batchId,
                jobId: job.id,
                jobName: job.name,
                executionId: execution.id,
                jobStatus: 'completed',
                completedJobs: completed,
                failedJobs: failed,
                totalJobs: executions.length,
            });
        } catch (err) {
            failed++;
            console.error(`[JobRunner] Job ${job.name} failed:`, err.message);
            emitBatchUpdate(userId, batchId, {
                batchId,
                jobId: job.id,
                jobName: job.name,
                executionId: execution.id,
                jobStatus: 'failed',
                error: err.message,
                completedJobs: completed,
                failedJobs: failed,
                totalJobs: executions.length,
            });
        }
    }

    await finalizeBatch(batchId, userId, completed, failed, executions.length);
}

/**
 * Run jobs in parallel with concurrency limit.
 */
async function runParallel(batchId, executions, userId, concurrency) {
    let completed = 0;
    let failed = 0;
    let index = 0;
    const total = executions.length;

    async function runNext() {
        while (index < total) {
            // Check if batch was cancelled
            const batch = await prisma.jobBatch.findUnique({ where: { id: batchId } });
            if (!batch || batch.status === 'cancelled') {
                return;
            }

            const current = index++;
            const { execution, job } = executions[current];

            emitBatchUpdate(userId, batchId, {
                batchId,
                jobId: job.id,
                jobName: job.name,
                executionId: execution.id,
                jobStatus: 'running',
            });

            try {
                await executeWorkflow(execution.id, userId);
                completed++;
                emitBatchUpdate(userId, batchId, {
                    batchId,
                    jobId: job.id,
                    jobName: job.name,
                    executionId: execution.id,
                    jobStatus: 'completed',
                    completedJobs: completed,
                    failedJobs: failed,
                    totalJobs: total,
                });
            } catch (err) {
                failed++;
                console.error(`[JobRunner] Job ${job.name} failed:`, err.message);
                emitBatchUpdate(userId, batchId, {
                    batchId,
                    jobId: job.id,
                    jobName: job.name,
                    executionId: execution.id,
                    jobStatus: 'failed',
                    error: err.message,
                    completedJobs: completed,
                    failedJobs: failed,
                    totalJobs: total,
                });
            }
        }
    }

    // Launch `concurrency` workers
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, total); i++) {
        workers.push(runNext());
    }
    await Promise.all(workers);

    await finalizeBatch(batchId, userId, completed, failed, total);
}

/**
 * Finalize batch — mark as completed/failed/partial
 */
async function finalizeBatch(batchId, userId, completed, failed, total) {
    let status = 'completed';
    if (failed > 0 && completed === 0) status = 'failed';
    else if (failed > 0) status = 'partial';

    // Check if it was cancelled
    const batch = await prisma.jobBatch.findUnique({ where: { id: batchId } });
    if (batch?.status === 'cancelled') status = 'cancelled';

    await prisma.jobBatch.update({
        where: { id: batchId },
        data: {
            status,
            completedJobs: completed,
            failedJobs: failed,
            completedAt: new Date(),
        },
    });

    emitBatchUpdate(userId, batchId, {
        batchId,
        status,
        completedJobs: completed,
        failedJobs: failed,
        totalJobs: total,
    });

    // Notify linked Telegram accounts
    try {
        const { notifyTelegramUser } = await import('./telegram-bot.js');
        if (status === 'completed' || status === 'partial') {
            // Collect output media files
            const executions = await prisma.workflowExecution.findMany({
                where: { jobBatchId: batchId },
                include: { nodeExecutions: { select: { outputData: true, nodeType: true } } },
            });

            const mediaFiles = [];
            const outputNodeTypes = ['google-flow-image', 'google-flow-video'];
            for (const exec of executions) {
                for (const ne of exec.nodeExecutions) {
                    if (!outputNodeTypes.includes(ne.nodeType)) continue;
                    let data;
                    try { data = typeof ne.outputData === 'string' ? JSON.parse(ne.outputData) : ne.outputData; } catch { continue; }
                    if (!data) continue;

                    // Collect images: prefer array (allImages/savedImages) over single imagePath to avoid duplicates
                    let foundImageArray = false;
                    for (const arrKey of ['allImages', 'savedImages']) {
                        if (Array.isArray(data[arrKey]) && data[arrKey].length > 0) {
                            foundImageArray = true;
                            for (const item of data[arrKey]) {
                                if (item.imagePath) mediaFiles.push({ type: 'image', path: item.imagePath, url: item.imageUrl });
                            }
                        }
                    }
                    // Fallback: use single imagePath only if no array was found
                    if (!foundImageArray && data.imagePath) {
                        mediaFiles.push({ type: 'image', path: data.imagePath, url: data.imageUrl });
                    }
                    if (data.videoPath) mediaFiles.push({ type: 'video', path: data.videoPath, url: data.videoUrl });
                }
            }

            const msg = status === 'completed'
                ? `✅ *Batch hoàn thành!*\n📊 ${completed}/${total} jobs thành công\n📸 ${mediaFiles.length} media files`
                : `⚠️ *Batch hoàn thành một phần*\n✅ ${completed} thành công, ❌ ${failed} thất bại`;

            await notifyTelegramUser(userId, msg, mediaFiles);
        } else if (status === 'failed') {
            // Collect error details from failed executions
            const failedExecs = await prisma.workflowExecution.findMany({
                where: { jobBatchId: batchId, status: 'failed' },
                select: { error: true },
                take: 3,
            });
            const errorDetails = failedExecs
                .map(e => e.error)
                .filter(Boolean)
                .map(e => {
                    // Extract the connector-level message from "Node X failed: <message>"
                    const match = e.match(/failed:\s*(.+)$/);
                    return match ? match[1] : e;
                });
            const uniqueErrors = [...new Set(errorDetails)];
            const errorMsg = uniqueErrors.length > 0
                ? `\n\n💬 ${uniqueErrors.join('\n💬 ')}`
                : '';
            await notifyTelegramUser(userId, `❌ *Batch thất bại*\n${failed}/${total} jobs lỗi.${errorMsg}`);
        }
    } catch (err) {
        // Telegram notification is best-effort, don't fail the batch
        console.warn('[JobRunner] Telegram notify error:', err.message);
    }

    console.log(`[JobRunner] Batch ${batchId} finalized: ${status} (${completed}/${total} completed, ${failed} failed)`);
}

/**
 * Emit Socket.IO event for batch/job updates
 */
function emitBatchUpdate(userId, batchId, data) {
    if (!io) return;
    io.to(`user:${userId}`).emit('job:update', data);
}

/**
 * Pause a running batch (sequential mode only)
 */
export async function pauseBatch(batchId) {
    const batch = await prisma.jobBatch.findUnique({ where: { id: batchId } });
    if (!batch || batch.status !== 'running') {
        throw new Error('Batch is not running');
    }
    await prisma.jobBatch.update({
        where: { id: batchId },
        data: { status: 'paused' },
    });
}

/**
 * Resume a paused batch
 */
export async function resumeBatch(batchId) {
    const batch = await prisma.jobBatch.findUnique({ where: { id: batchId } });
    if (!batch || batch.status !== 'paused') {
        throw new Error('Batch is not paused');
    }
    await prisma.jobBatch.update({
        where: { id: batchId },
        data: { status: 'running' },
    });
}

/**
 * Cancel a running/paused batch
 */
export async function cancelBatch(batchId) {
    const batch = await prisma.jobBatch.findUnique({ where: { id: batchId } });
    if (!batch) {
        throw new Error('Batch not found');
    }
    // If batch is already done, just return silently
    if (['completed', 'failed', 'partial', 'cancelled'].includes(batch.status)) {
        return;
    }

    await prisma.jobBatch.update({
        where: { id: batchId },
        data: { status: 'cancelled', completedAt: new Date() },
    });

    // Cancel all pending AND running executions in this batch
    const cancelledExecs = await prisma.workflowExecution.findMany({
        where: {
            jobBatchId: batchId,
            status: { in: ['pending', 'running'] },
        },
        select: { id: true },
    });
    const execIds = cancelledExecs.map(e => e.id);

    await prisma.workflowExecution.updateMany({
        where: { id: { in: execIds } },
        data: { status: 'cancelled', completedAt: new Date() },
    });

    // Also cancel running/pending node executions
    if (execIds.length > 0) {
        await prisma.nodeExecution.updateMany({
            where: {
                executionId: { in: execIds },
                status: { in: ['pending', 'running'] },
            },
            data: { status: 'cancelled', completedAt: new Date() },
        });
    }
}
