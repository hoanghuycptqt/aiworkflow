/**
 * Job Routes — CRUD for workflow jobs
 * 
 * GET    /api/jobs/:workflowId        — list jobs for a workflow
 * POST   /api/jobs/:workflowId        — create job
 * PUT    /api/jobs/:id                — update job
 * DELETE /api/jobs/:id                — delete job
 * POST   /api/jobs/:id/duplicate      — clone/duplicate a job
 * POST   /api/jobs/:workflowId/reorder — bulk reorder jobs
 */

import { Router } from 'express';
import { prisma } from '../index.js';

const router = Router();

// GET /api/jobs/:workflowId — list all jobs for a workflow
router.get('/:workflowId', async (req, res, next) => {
    try {
        const workflow = await prisma.workflow.findFirst({
            where: { id: req.params.workflowId, userId: req.user.id },
        });
        if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

        const jobs = await prisma.job.findMany({
            where: { workflowId: req.params.workflowId },
            orderBy: { order: 'asc' },
        });

        res.json({
            jobs: jobs.map(j => ({
                ...j,
                inputData: j.inputData ? JSON.parse(j.inputData) : null,
            })),
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/jobs/:workflowId — create a job
router.post('/:workflowId', async (req, res, next) => {
    try {
        const workflow = await prisma.workflow.findFirst({
            where: { id: req.params.workflowId, userId: req.user.id },
        });
        if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

        const { name, inputData } = req.body;
        if (!name) return res.status(400).json({ error: 'Job name is required' });

        // Get next order number
        const maxOrder = await prisma.job.aggregate({
            where: { workflowId: req.params.workflowId },
            _max: { order: true },
        });
        const nextOrder = (maxOrder._max.order ?? -1) + 1;

        const job = await prisma.job.create({
            data: {
                workflowId: req.params.workflowId,
                name,
                order: nextOrder,
                inputData: inputData ? JSON.stringify(inputData) : null,
            },
        });

        res.status(201).json({
            job: {
                ...job,
                inputData: job.inputData ? JSON.parse(job.inputData) : null,
            },
        });
    } catch (err) {
        next(err);
    }
});

// PUT /api/jobs/:id — update a job
router.put('/:id', async (req, res, next) => {
    try {
        const existing = await prisma.job.findUnique({
            where: { id: req.params.id },
            include: { workflow: { select: { userId: true } } },
        });
        if (!existing || existing.workflow.userId !== req.user.id) {
            return res.status(404).json({ error: 'Job not found' });
        }

        const { name, inputData, order } = req.body;

        const job = await prisma.job.update({
            where: { id: req.params.id },
            data: {
                ...(name !== undefined && { name }),
                ...(inputData !== undefined && { inputData: JSON.stringify(inputData) }),
                ...(order !== undefined && { order }),
            },
        });

        res.json({
            job: {
                ...job,
                inputData: job.inputData ? JSON.parse(job.inputData) : null,
            },
        });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/jobs/:id — delete a job
router.delete('/:id', async (req, res, next) => {
    try {
        const existing = await prisma.job.findUnique({
            where: { id: req.params.id },
            include: { workflow: { select: { userId: true } } },
        });
        if (!existing || existing.workflow.userId !== req.user.id) {
            return res.status(404).json({ error: 'Job not found' });
        }

        await prisma.job.delete({ where: { id: req.params.id } });
        res.json({ message: 'Job deleted' });
    } catch (err) {
        next(err);
    }
});

// POST /api/jobs/:id/duplicate — clone a job
router.post('/:id/duplicate', async (req, res, next) => {
    try {
        const source = await prisma.job.findUnique({
            where: { id: req.params.id },
            include: { workflow: { select: { userId: true } } },
        });
        if (!source || source.workflow.userId !== req.user.id) {
            return res.status(404).json({ error: 'Job not found' });
        }

        const maxOrder = await prisma.job.aggregate({
            where: { workflowId: source.workflowId },
            _max: { order: true },
        });

        const job = await prisma.job.create({
            data: {
                workflowId: source.workflowId,
                name: `${source.name} (Copy)`,
                order: (maxOrder._max.order ?? 0) + 1,
                inputData: source.inputData,
            },
        });

        res.status(201).json({
            job: {
                ...job,
                inputData: job.inputData ? JSON.parse(job.inputData) : null,
            },
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/jobs/:workflowId/reorder — bulk reorder jobs
router.post('/:workflowId/reorder', async (req, res, next) => {
    try {
        const workflow = await prisma.workflow.findFirst({
            where: { id: req.params.workflowId, userId: req.user.id },
        });
        if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

        const { jobIds } = req.body; // ordered array of job IDs
        if (!Array.isArray(jobIds)) {
            return res.status(400).json({ error: 'jobIds array is required' });
        }

        // Update each job's order
        const updates = jobIds.map((id, index) =>
            prisma.job.updateMany({
                where: { id, workflowId: req.params.workflowId },
                data: { order: index },
            })
        );

        await prisma.$transaction(updates);

        res.json({ message: 'Jobs reordered' });
    } catch (err) {
        next(err);
    }
});

export default router;
