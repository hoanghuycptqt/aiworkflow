import { Router } from 'express';
import { prisma } from '../index.js';
import { generateToken, hashPassword, comparePassword } from '../services/auth.service.js';

const router = Router();

// POST /api/auth/register
router.post('/register', async (req, res, next) => {
    try {
        const { email, password, name } = req.body;

        if (!email || !password || !name) {
            return res.status(400).json({ error: 'Email, password, and name are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const hashedPassword = await hashPassword(password);

        // First user becomes admin
        const userCount = await prisma.user.count();
        const role = userCount === 0 ? 'admin' : 'user';

        const user = await prisma.user.create({
            data: { email, password: hashedPassword, name, role },
            select: { id: true, email: true, name: true, role: true, createdAt: true },
        });

        const token = generateToken(user.id);

        res.status(201).json({ user, token });
    } catch (err) {
        next(err);
    }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const user = await prisma.user.findUnique({
            where: { email },
            select: { id: true, email: true, name: true, password: true, role: true, isActive: true },
        });
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (!user.isActive) {
            return res.status(403).json({ error: 'Account is disabled. Contact admin.' });
        }

        const isValid = await comparePassword(password, user.password);
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Update last login (non-blocking, don't fail login if this errors)
        prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }).catch(() => { });

        const token = generateToken(user.id);

        res.json({
            user: { id: user.id, email: user.email, name: user.name, role: user.role },
            token,
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/auth/me
router.get('/me', async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Token required' });
        }

        const { verifyToken } = await import('../services/auth.service.js');
        const payload = verifyToken(authHeader.split(' ')[1]);

        const user = await prisma.user.findUnique({
            where: { id: payload.userId },
            select: { id: true, email: true, name: true, role: true, createdAt: true },
        });

        if (!user) return res.status(404).json({ error: 'User not found' });

        res.json({ user });
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
    }
});

export default router;
