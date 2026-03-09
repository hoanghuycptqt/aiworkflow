/**
 * Admin Routes — Dashboard, User Management
 * All routes require admin role (mounted with requireAdmin in index.js).
 */

import { Router } from 'express';
import { prisma } from '../index.js';
import { hashPassword } from '../services/auth.service.js';

const router = Router();

// ─── Dashboard Stats ─────────────────────────────────────
router.get('/dashboard', async (req, res, next) => {
    try {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        const [totalUsers, activeUsers, totalWorkflows, jobsToday, jobsCompleted, jobsFailed] = await Promise.all([
            prisma.user.count(),
            prisma.user.count({ where: { isActive: true } }),
            prisma.workflow.count(),
            prisma.workflowExecution.count({ where: { startedAt: { gte: todayStart } } }),
            prisma.workflowExecution.count({ where: { startedAt: { gte: todayStart }, status: 'completed' } }),
            prisma.workflowExecution.count({ where: { startedAt: { gte: todayStart }, status: 'failed' } }),
        ]);

        // Jobs per day (last 7 days)
        const days = [];
        for (let i = 6; i >= 0; i--) {
            const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
            const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i + 1);
            const count = await prisma.workflowExecution.count({
                where: { startedAt: { gte: dayStart, lt: dayEnd } },
            });
            days.push({
                date: dayStart.toISOString().split('T')[0],
                count,
            });
        }

        // Recent activity
        const recentExecutions = await prisma.workflowExecution.findMany({
            take: 10,
            orderBy: { startedAt: 'desc' },
            where: { startedAt: { not: null } },
            select: {
                id: true,
                status: true,
                startedAt: true,
                workflow: { select: { name: true, user: { select: { name: true } } } },
            },
        });

        const recentUsers = await prisma.user.findMany({
            take: 5,
            orderBy: { createdAt: 'desc' },
            select: { id: true, name: true, email: true, role: true, createdAt: true },
        });

        res.json({
            stats: {
                totalUsers,
                activeUsers,
                totalWorkflows,
                jobsToday,
                jobsCompleted,
                jobsFailed,
                successRate: jobsToday > 0 ? Math.round((jobsCompleted / jobsToday) * 100) : 0,
            },
            chart: days,
            recentExecutions,
            recentUsers,
        });
    } catch (err) {
        next(err);
    }
});

// ─── List Users ──────────────────────────────────────────
router.get('/users', async (req, res, next) => {
    try {
        const { search, role, status, page = 1, limit = 20 } = req.query;

        const where = {};
        if (search) {
            where.OR = [
                { name: { contains: search } },
                { email: { contains: search } },
            ];
        }
        if (role) where.role = role;
        if (status === 'active') where.isActive = true;
        if (status === 'disabled') where.isActive = false;

        const [users, total] = await Promise.all([
            prisma.user.findMany({
                where,
                select: {
                    id: true,
                    email: true,
                    name: true,
                    role: true,
                    isActive: true,
                    lastLoginAt: true,
                    createdAt: true,
                    _count: { select: { workflows: true, telegramLinks: true } },
                },
                orderBy: { createdAt: 'desc' },
                skip: (Number(page) - 1) * Number(limit),
                take: Number(limit),
            }),
            prisma.user.count({ where }),
        ]);

        res.json({ users, total, page: Number(page), limit: Number(limit) });
    } catch (err) {
        next(err);
    }
});

// ─── Create User ─────────────────────────────────────────
router.post('/users', async (req, res, next) => {
    try {
        const { email, password, name, role = 'user' } = req.body;

        if (!email || !password || !name) {
            return res.status(400).json({ error: 'Email, password, and name are required' });
        }
        if (!['admin', 'user', 'viewer'].includes(role)) {
            return res.status(400).json({ error: 'Invalid role' });
        }

        const hashedPassword = await hashPassword(password);

        const user = await prisma.user.create({
            data: { email, password: hashedPassword, name, role },
            select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
        });

        res.status(201).json({ user });
    } catch (err) {
        if (err.code === 'P2002') {
            return res.status(409).json({ error: 'Email already exists' });
        }
        next(err);
    }
});

// ─── Update User ─────────────────────────────────────────
router.put('/users/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { name, email, role, isActive } = req.body;

        // Prevent admin from disabling themselves
        if (id === req.user.id && isActive === false) {
            return res.status(400).json({ error: 'Cannot disable your own account' });
        }
        // Prevent admin from removing their own admin role
        if (id === req.user.id && role && role !== 'admin') {
            return res.status(400).json({ error: 'Cannot remove your own admin role' });
        }

        const data = {};
        if (name !== undefined) data.name = name;
        if (email !== undefined) data.email = email;
        if (role !== undefined) {
            if (!['admin', 'user', 'viewer'].includes(role)) {
                return res.status(400).json({ error: 'Invalid role' });
            }
            data.role = role;
        }
        if (isActive !== undefined) data.isActive = isActive;

        const user = await prisma.user.update({
            where: { id },
            data,
            select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
        });

        res.json({ user });
    } catch (err) {
        if (err.code === 'P2025') {
            return res.status(404).json({ error: 'User not found' });
        }
        next(err);
    }
});

// ─── Reset Password ──────────────────────────────────────
router.put('/users/:id/reset-password', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { password } = req.body;

        if (!password || password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const hashedPassword = await hashPassword(password);
        await prisma.user.update({ where: { id }, data: { password: hashedPassword } });

        res.json({ message: 'Password reset successfully' });
    } catch (err) {
        if (err.code === 'P2025') {
            return res.status(404).json({ error: 'User not found' });
        }
        next(err);
    }
});

// ─── Delete User ─────────────────────────────────────────
router.delete('/users/:id', async (req, res, next) => {
    try {
        const { id } = req.params;

        if (id === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }

        await prisma.user.delete({ where: { id } });
        res.json({ message: 'User deleted' });
    } catch (err) {
        if (err.code === 'P2025') {
            return res.status(404).json({ error: 'User not found' });
        }
        next(err);
    }
});

export default router;
