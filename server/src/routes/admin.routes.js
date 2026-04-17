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

// ─── Gemini Model Catalog ────────────────────────────────
const GEMINI_MODELS = [
    { group: 'Gemini 3 (Latest)', models: [
        { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', desc: 'Advanced reasoning, coding, agentic' },
        { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', desc: 'Frontier-class, cost-effective' },
        { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash-Lite', desc: 'Lightweight, fast' },
    ]},
    { group: 'Gemini 2.5', models: [
        { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', desc: 'Low-latency, high-volume, reasoning' },
        { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', desc: 'Fastest, cost-efficient' },
        { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', desc: 'Most advanced, deep reasoning' },
    ]},
    { group: 'Gemini 2.0 (Deprecated)', models: [
        { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', desc: 'Previous gen workhorse' },
        { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash-Lite', desc: 'Previous gen lightweight' },
    ]},
];

// ─── Get Settings ────────────────────────────────────────
router.get('/settings', async (req, res, next) => {
    try {
        const settings = await prisma.systemSetting.findMany();
        const settingsMap = Object.fromEntries(settings.map(s => [s.key, s.value]));
        res.json({ settings: settingsMap, geminiModels: GEMINI_MODELS });
    } catch (err) {
        next(err);
    }
});

// ─── Update Settings ─────────────────────────────────────
router.put('/settings', async (req, res, next) => {
    try {
        const { settings } = req.body;
        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({ error: 'Settings object required' });
        }

        for (const [key, value] of Object.entries(settings)) {
            await prisma.systemSetting.upsert({
                where: { key },
                update: { value: String(value) },
                create: { key, value: String(value) },
            });
        }

        res.json({ message: 'Settings saved' });
    } catch (err) {
        next(err);
    }
});

// ═══════════════════════════════════════════════════════════
// ─── Analytics Endpoints ─────────────────────────────────
// ═══════════════════════════════════════════════════════════

// ─── Activity Heatmap (day-of-week × hour-of-day) ────────
router.get('/analytics/heatmap', async (req, res, next) => {
    try {
        const days = Math.min(parseInt(req.query.days) || 30, 365);
        const since = new Date(Date.now() - days * 86400000);

        const executions = await prisma.workflowExecution.findMany({
            where: { startedAt: { gte: since } },
            select: { startedAt: true, status: true },
        });

        // Build 7×24 matrix (day 0=Sun … 6=Sat, hour 0–23)
        const matrix = Array.from({ length: 7 }, () => Array(24).fill(0));
        const statusMatrix = Array.from({ length: 7 }, () =>
            Array.from({ length: 24 }, () => ({ completed: 0, failed: 0, total: 0 }))
        );

        for (const exec of executions) {
            const d = new Date(exec.startedAt);
            const day = d.getDay();
            const hour = d.getHours();
            matrix[day][hour]++;
            statusMatrix[day][hour].total++;
            if (exec.status === 'completed') statusMatrix[day][hour].completed++;
            if (exec.status === 'failed') statusMatrix[day][hour].failed++;
        }

        res.json({
            matrix,
            statusMatrix,
            totalExecutions: executions.length,
            days,
        });
    } catch (err) {
        next(err);
    }
});

// ─── Execution Timeline (Gantt data) ─────────────────────
router.get('/analytics/timeline', async (req, res, next) => {
    try {
        const hoursBack = Math.min(parseInt(req.query.hours) || 24, 24 * 365);
        const since = new Date(Date.now() - hoursBack * 3600000);
        const batchId = req.query.batchId;

        const where = { startedAt: { gte: since } };
        if (batchId) where.jobBatchId = batchId;

        const executions = await prisma.workflowExecution.findMany({
            where,
            orderBy: { startedAt: 'asc' },
            take: 200,
            select: {
                id: true,
                status: true,
                startedAt: true,
                completedAt: true,
                jobId: true,
                jobBatchId: true,
                instanceIndex: true,
                error: true,
                workflow: { select: { name: true, user: { select: { name: true } } } },
                nodeExecutions: {
                    select: {
                        id: true,
                        nodeId: true,
                        nodeType: true,
                        status: true,
                        startedAt: true,
                        completedAt: true,
                    },
                    orderBy: { startedAt: 'asc' },
                },
            },
        });

        // Enrich with job names
        const jobIds = [...new Set(executions.map(e => e.jobId).filter(Boolean))];
        const jobs = jobIds.length > 0
            ? await prisma.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, name: true } })
            : [];
        const jobMap = new Map(jobs.map(j => [j.id, j.name]));

        // Batch info
        const batchIds = [...new Set(executions.map(e => e.jobBatchId).filter(Boolean))];
        const batches = batchIds.length > 0
            ? await prisma.jobBatch.findMany({
                where: { id: { in: batchIds } },
                select: { id: true, mode: true, concurrency: true, status: true, startedAt: true, completedAt: true },
            })
            : [];
        const batchMap = new Map(batches.map(b => [b.id, b]));

        res.json({
            executions: executions.map(e => ({
                id: e.id,
                status: e.status,
                startedAt: e.startedAt,
                completedAt: e.completedAt || (e.status === 'running' ? new Date().toISOString() : e.startedAt),
                jobName: e.jobId ? jobMap.get(e.jobId) || `Job ${e.instanceIndex + 1}` : `Exec ${e.instanceIndex + 1}`,
                workflowName: e.workflow?.name || 'Unknown',
                userName: e.workflow?.user?.name || 'Unknown',
                batchId: e.jobBatchId,
                error: e.error,
                nodeExecutions: e.nodeExecutions,
            })),
            batches: batches.map(b => ({
                id: b.id,
                mode: b.mode,
                concurrency: b.concurrency,
                status: b.status,
                startedAt: b.startedAt,
                completedAt: b.completedAt,
            })),
        });
    } catch (err) {
        next(err);
    }
});

// ─── Connector Performance Stats ─────────────────────────
router.get('/analytics/connector-stats', async (req, res, next) => {
    try {
        const days = Math.min(parseInt(req.query.days) || 30, 365);
        const since = new Date(Date.now() - days * 86400000);

        const nodeExecs = await prisma.nodeExecution.findMany({
            where: { startedAt: { gte: since } },
            select: {
                nodeType: true,
                status: true,
                startedAt: true,
                completedAt: true,
            },
        });

        // Group by nodeType
        const groups = {};
        for (const ne of nodeExecs) {
            if (!groups[ne.nodeType]) {
                groups[ne.nodeType] = { durations: [], completed: 0, failed: 0, total: 0, dailyCounts: {} };
            }
            const g = groups[ne.nodeType];
            g.total++;
            if (ne.status === 'completed') g.completed++;
            if (ne.status === 'failed') g.failed++;

            if (ne.startedAt && ne.completedAt) {
                const dur = new Date(ne.completedAt) - new Date(ne.startedAt);
                if (dur >= 0) g.durations.push(dur);
            }

            // Daily trend data
            if (ne.startedAt) {
                const dayKey = new Date(ne.startedAt).toISOString().split('T')[0];
                if (!g.dailyCounts[dayKey]) g.dailyCounts[dayKey] = { total: 0, completed: 0, failed: 0 };
                g.dailyCounts[dayKey].total++;
                if (ne.status === 'completed') g.dailyCounts[dayKey].completed++;
                if (ne.status === 'failed') g.dailyCounts[dayKey].failed++;
            }
        }

        // Compute percentiles
        function percentile(arr, p) {
            if (arr.length === 0) return 0;
            const sorted = [...arr].sort((a, b) => a - b);
            const idx = Math.ceil((p / 100) * sorted.length) - 1;
            return sorted[Math.max(0, idx)];
        }

        const stats = Object.entries(groups).map(([nodeType, g]) => ({
            nodeType,
            total: g.total,
            completed: g.completed,
            failed: g.failed,
            successRate: g.total > 0 ? Math.round((g.completed / g.total) * 100) : 0,
            avgDuration: g.durations.length > 0 ? Math.round(g.durations.reduce((a, b) => a + b, 0) / g.durations.length) : 0,
            p50Duration: percentile(g.durations, 50),
            p95Duration: percentile(g.durations, 95),
            p99Duration: percentile(g.durations, 99),
            dailyTrend: Object.entries(g.dailyCounts)
                .sort(([a], [b]) => a.localeCompare(b))
                .slice(-14) // last 14 days
                .map(([date, counts]) => ({ date, ...counts })),
        }));

        // Sort by total runs descending
        stats.sort((a, b) => b.total - a.total);

        res.json({ stats, days });
    } catch (err) {
        next(err);
    }
});

// ─── Concurrency Monitor ─────────────────────────────────
router.get('/analytics/concurrency', async (req, res, next) => {
    try {
        const hours = Math.min(parseInt(req.query.hours) || 24, 24 * 365);
        const since = new Date(Date.now() - hours * 3600000);

        // Get all executions that were active during the time window
        const executions = await prisma.workflowExecution.findMany({
            where: {
                OR: [
                    { startedAt: { gte: since } },
                    { completedAt: { gte: since } },
                    { status: 'running' },
                ],
            },
            select: { startedAt: true, completedAt: true, status: true },
        });

        // Sweep-line algorithm to compute concurrent count at each event
        const events = [];
        for (const exec of executions) {
            if (!exec.startedAt) continue;
            const start = new Date(exec.startedAt).getTime();
            const end = exec.completedAt
                ? new Date(exec.completedAt).getTime()
                : Date.now(); // running jobs count as active until now
            events.push({ time: start, delta: 1 });
            events.push({ time: end, delta: -1 });
        }
        events.sort((a, b) => a.time - b.time || a.delta - b.delta);

        // Build time series
        let current = 0;
        let peak = 0;
        const series = [];
        const sinceMs = since.getTime();

        for (const evt of events) {
            if (evt.time < sinceMs) {
                current += evt.delta;
                continue;
            }
            current += evt.delta;
            if (current > peak) peak = current;
            series.push({ time: evt.time, concurrent: current });
        }

        // Downsample to max ~200 points for chart rendering
        let downsampled = series;
        if (series.length > 200) {
            const step = Math.ceil(series.length / 200);
            downsampled = series.filter((_, i) => i % step === 0);
            // Always include the last point
            if (downsampled[downsampled.length - 1] !== series[series.length - 1]) {
                downsampled.push(series[series.length - 1]);
            }
        }

        // Current running count
        const currentRunning = await prisma.workflowExecution.count({
            where: { status: 'running' },
        });

        // Average computed from series
        const avg = series.length > 0
            ? (series.reduce((s, p) => s + p.concurrent, 0) / series.length).toFixed(1)
            : '0';

        res.json({
            series: downsampled,
            peak,
            currentRunning,
            average: parseFloat(avg),
            hours,
        });
    } catch (err) {
        next(err);
    }
});

export default router;
