import { Router } from 'express';
import { prisma } from '../index.js';

const router = Router();

// GET /api/workflows — list user's workflows
router.get('/', async (req, res, next) => {
    try {
        const workflows = await prisma.workflow.findMany({
            where: { userId: req.user.id },
            orderBy: { updatedAt: 'desc' },
            select: {
                id: true,
                name: true,
                description: true,
                isActive: true,
                createdAt: true,
                updatedAt: true,
                _count: { select: { executions: true } },
            },
        });
        res.json({ workflows });
    } catch (err) {
        next(err);
    }
});

// GET /api/workflows/:id — get workflow detail
router.get('/:id', async (req, res, next) => {
    try {
        const workflow = await prisma.workflow.findFirst({
            where: { id: req.params.id, userId: req.user.id },
        });

        if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

        res.json({
            workflow: {
                ...workflow,
                nodesData: JSON.parse(workflow.nodesData || '[]'),
                edgesData: JSON.parse(workflow.edgesData || '[]'),
            },
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/workflows — create workflow
router.post('/', async (req, res, next) => {
    try {
        const { name, description, nodesData, edgesData } = req.body;

        if (!name) return res.status(400).json({ error: 'Workflow name is required' });

        const workflow = await prisma.workflow.create({
            data: {
                userId: req.user.id,
                name,
                description: description || '',
                nodesData: JSON.stringify(nodesData || []),
                edgesData: JSON.stringify(edgesData || []),
            },
        });

        res.status(201).json({
            workflow: {
                ...workflow,
                nodesData: JSON.parse(workflow.nodesData),
                edgesData: JSON.parse(workflow.edgesData),
            },
        });
    } catch (err) {
        next(err);
    }
});

// PUT /api/workflows/:id — update workflow
router.put('/:id', async (req, res, next) => {
    try {
        const existing = await prisma.workflow.findFirst({
            where: { id: req.params.id, userId: req.user.id },
        });

        if (!existing) return res.status(404).json({ error: 'Workflow not found' });

        const { name, description, nodesData, edgesData, isActive } = req.body;

        const workflow = await prisma.workflow.update({
            where: { id: req.params.id },
            data: {
                ...(name !== undefined && { name }),
                ...(description !== undefined && { description }),
                ...(nodesData !== undefined && { nodesData: JSON.stringify(nodesData) }),
                ...(edgesData !== undefined && { edgesData: JSON.stringify(edgesData) }),
                ...(isActive !== undefined && { isActive }),
            },
        });

        res.json({
            workflow: {
                ...workflow,
                nodesData: JSON.parse(workflow.nodesData),
                edgesData: JSON.parse(workflow.edgesData),
            },
        });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/workflows/:id
router.delete('/:id', async (req, res, next) => {
    try {
        const existing = await prisma.workflow.findFirst({
            where: { id: req.params.id, userId: req.user.id },
        });

        if (!existing) return res.status(404).json({ error: 'Workflow not found' });

        await prisma.workflow.delete({ where: { id: req.params.id } });

        res.json({ message: 'Workflow deleted' });
    } catch (err) {
        next(err);
    }
});

// POST /api/workflows/:id/duplicate
router.post('/:id/duplicate', async (req, res, next) => {
    try {
        const source = await prisma.workflow.findFirst({
            where: { id: req.params.id, userId: req.user.id },
        });

        if (!source) return res.status(404).json({ error: 'Workflow not found' });

        const workflow = await prisma.workflow.create({
            data: {
                userId: req.user.id,
                name: `${source.name} (Copy)`,
                description: source.description,
                nodesData: source.nodesData,
                edgesData: source.edgesData,
            },
        });

        res.status(201).json({
            workflow: {
                ...workflow,
                nodesData: JSON.parse(workflow.nodesData),
                edgesData: JSON.parse(workflow.edgesData),
            },
        });
    } catch (err) {
        next(err);
    }
});

export default router;
