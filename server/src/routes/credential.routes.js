import { Router } from 'express';
import { prisma } from '../index.js';

const router = Router();

// GET /api/credentials — list user's credentials
router.get('/', async (req, res, next) => {
    try {
        const credentials = await prisma.credential.findMany({
            where: { userId: req.user.id },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                provider: true,
                label: true,
                token: true,
                metadata: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        res.json({
            credentials: credentials.map((c) => ({
                ...c,
                metadata: c.metadata ? JSON.parse(c.metadata) : null,
            })),
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/credentials — create credential
router.post('/', async (req, res, next) => {
    try {
        const { provider, label, token, metadata } = req.body;

        if (!provider || !label || !token) {
            return res.status(400).json({ error: 'Provider, label, and token are required' });
        }

        const credential = await prisma.credential.create({
            data: {
                userId: req.user.id,
                provider,
                label,
                token, // TODO: encrypt in production
                metadata: metadata ? JSON.stringify(metadata) : null,
            },
            select: {
                id: true,
                provider: true,
                label: true,
                metadata: true,
                createdAt: true,
            },
        });

        res.status(201).json({
            credential: {
                ...credential,
                metadata: credential.metadata ? JSON.parse(credential.metadata) : null,
            },
        });
    } catch (err) {
        next(err);
    }
});

// PUT /api/credentials/:id — update credential
router.put('/:id', async (req, res, next) => {
    try {
        const existing = await prisma.credential.findFirst({
            where: { id: req.params.id, userId: req.user.id },
        });

        if (!existing) return res.status(404).json({ error: 'Credential not found' });

        const { label, token, metadata } = req.body;

        const credential = await prisma.credential.update({
            where: { id: req.params.id },
            data: {
                ...(label !== undefined && { label }),
                ...(token !== undefined && { token }),
                ...(metadata !== undefined && { metadata: JSON.stringify(metadata) }),
            },
            select: {
                id: true,
                provider: true,
                label: true,
                metadata: true,
                updatedAt: true,
            },
        });

        res.json({
            credential: {
                ...credential,
                metadata: credential.metadata ? JSON.parse(credential.metadata) : null,
            },
        });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/credentials/:id
router.delete('/:id', async (req, res, next) => {
    try {
        const existing = await prisma.credential.findFirst({
            where: { id: req.params.id, userId: req.user.id },
        });

        if (!existing) return res.status(404).json({ error: 'Credential not found' });

        await prisma.credential.delete({ where: { id: req.params.id } });

        res.json({ message: 'Credential deleted' });
    } catch (err) {
        next(err);
    }
});

export default router;
