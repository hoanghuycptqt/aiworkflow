import { verifyToken } from '../services/auth.service.js';
import { prisma } from '../index.js';

export async function authMiddleware(req, res, next) {
    try {
        let token;
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
            token = authHeader.split(' ')[1];
        } else if (req.query.token) {
            // Support ?token= for download routes (window.open can't send headers)
            token = req.query.token;
        }

        if (!token) {
            return res.status(401).json({ error: 'Access token required' });
        }
        const payload = verifyToken(token);

        const user = await prisma.user.findUnique({
            where: { id: payload.userId },
            select: { id: true, email: true, name: true },
        });

        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }

        req.user = user;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}
