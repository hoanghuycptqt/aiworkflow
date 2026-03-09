/**
 * Role-based access control middleware.
 * Usage: requireRole('admin') or requireRole('admin', 'user')
 * Must be used AFTER authMiddleware (needs req.user).
 */
export function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        next();
    };
}

/**
 * Block viewer from write operations.
 * Allows admin and user, blocks viewer.
 */
export const requireWriter = requireRole('admin', 'user');

/**
 * Require admin role.
 */
export const requireAdmin = requireRole('admin');
