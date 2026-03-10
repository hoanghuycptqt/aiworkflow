import { Router } from 'express';
import { randomUUID } from 'crypto';
import { prisma } from '../index.js';
import { generateToken, hashPassword, comparePassword } from '../services/auth.service.js';
import { sendVerificationEmail } from '../services/email.service.js';
import { OAuth2Client } from 'google-auth-library';

const router = Router();
const GOOGLE_CLIENT_ID = '691523742369-iajbsntm2pq5qso2ar37rg11l8m6545p.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

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

        // First user becomes admin + auto-verified
        const userCount = await prisma.user.count();
        const isFirstUser = userCount === 0;
        const role = isFirstUser ? 'admin' : 'user';
        const verificationToken = isFirstUser ? null : randomUUID();

        const user = await prisma.user.create({
            data: {
                email, password: hashedPassword, name, role,
                isVerified: isFirstUser,
                verificationToken,
            },
            select: { id: true, email: true, name: true, role: true, createdAt: true },
        });

        // First user: auto-login. Others: send verification email.
        if (isFirstUser) {
            const token = generateToken(user.id);
            return res.status(201).json({ user, token });
        }

        // Send verification email
        await sendVerificationEmail(email, verificationToken);

        res.status(201).json({
            message: 'Registration successful! Please check your email to verify your account.',
            requireVerification: true,
        });
    } catch (err) {
        if (err.code === 'P2002') {
            return res.status(409).json({ error: 'Email already exists' });
        }
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
            select: { id: true, email: true, name: true, password: true, role: true, isActive: true, isVerified: true },
        });
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (!user.isActive) {
            return res.status(403).json({ error: 'Account is disabled. Contact admin.' });
        }

        if (!user.isVerified) {
            return res.status(403).json({
                error: 'Please verify your email before logging in.',
                needVerification: true,
                email: user.email,
            });
        }

        // Google-only users have no password
        if (!user.password) {
            return res.status(401).json({ error: 'This account uses Google login. Please sign in with Google.' });
        }

        const isValid = await comparePassword(password, user.password);
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Update last login (non-blocking)
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

// GET /api/auth/verify?token=xxx
router.get('/verify', async (req, res, next) => {
    try {
        const { token } = req.query;
        if (!token) {
            return res.status(400).json({ error: 'Verification token is required' });
        }

        const user = await prisma.user.findUnique({
            where: { verificationToken: token },
            select: { id: true, isVerified: true },
        });

        if (!user) {
            return res.status(400).json({ error: 'Invalid or expired verification token' });
        }

        if (user.isVerified) {
            return res.json({ message: 'Email already verified', alreadyVerified: true });
        }

        await prisma.user.update({
            where: { id: user.id },
            data: { isVerified: true, verificationToken: null },
        });

        res.json({ message: 'Email verified successfully! You can now log in.', verified: true });
    } catch (err) {
        next(err);
    }
});

// POST /api/auth/resend-verification
router.post('/resend-verification', async (req, res, next) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const user = await prisma.user.findUnique({
            where: { email },
            select: { id: true, isVerified: true },
        });

        if (!user) {
            return res.json({ message: 'If this email exists, a verification link has been sent.' });
        }

        if (user.isVerified) {
            return res.json({ message: 'Email is already verified.' });
        }

        const newToken = randomUUID();
        await prisma.user.update({
            where: { id: user.id },
            data: { verificationToken: newToken },
        });

        await sendVerificationEmail(email, newToken);

        res.json({ message: 'Verification email sent! Please check your inbox.' });
    } catch (err) {
        next(err);
    }
});

// POST /api/auth/google — Sign in with Google
router.post('/google', async (req, res, next) => {
    try {
        const { credential } = req.body;
        if (!credential) {
            return res.status(400).json({ error: 'Google credential is required' });
        }

        // Verify Google ID token
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        const { sub: googleId, email, name, picture } = payload;

        if (!email) {
            return res.status(400).json({ error: 'Google account has no email' });
        }

        // Find existing user by googleId or email
        let user = await prisma.user.findFirst({
            where: { OR: [{ googleId }, { email }] },
            select: { id: true, email: true, name: true, role: true, isActive: true, googleId: true },
        });

        if (user) {
            // Existing user — check if active
            if (!user.isActive) {
                return res.status(403).json({ error: 'Account is disabled. Contact admin.' });
            }

            // Link Google ID if not yet linked
            if (!user.googleId) {
                await prisma.user.update({
                    where: { id: user.id },
                    data: { googleId, avatarUrl: picture, isVerified: true },
                });
            }

            // Update last login
            prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }).catch(() => { });
        } else {
            // New user — auto-create
            const userCount = await prisma.user.count();
            const role = userCount === 0 ? 'admin' : 'user';

            user = await prisma.user.create({
                data: {
                    email,
                    name: name || email.split('@')[0],
                    googleId,
                    avatarUrl: picture,
                    role,
                    isVerified: true, // Google-verified, no email check needed
                    lastLoginAt: new Date(),
                },
                select: { id: true, email: true, name: true, role: true },
            });
            console.log(`[Auth] New Google user created: ${email} (${role})`);
        }

        const token = generateToken(user.id);

        res.json({
            user: { id: user.id, email: user.email, name: user.name, role: user.role },
            token,
        });
    } catch (err) {
        console.error('[Auth] Google login error:', err.message);
        res.status(401).json({ error: 'Google login failed: ' + err.message });
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
