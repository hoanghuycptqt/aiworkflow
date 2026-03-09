import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const JWT_SECRET = process.env.JWT_SECRET || 'vcw-secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

export function generateToken(userId) {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token) {
    return jwt.verify(token, JWT_SECRET);
}

export async function hashPassword(password) {
    return bcrypt.hash(password, 12);
}

export async function comparePassword(password, hash) {
    return bcrypt.compare(password, hash);
}
