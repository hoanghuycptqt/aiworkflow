/**
 * Reusable skeleton loading components.
 */

export function SkeletonCard({ count = 3 }) {
    return (
        <div className="skeleton-grid">
            {Array.from({ length: count }).map((_, i) => (
                <div key={i} className="skeleton skeleton-card" />
            ))}
        </div>
    );
}

export function SkeletonStat({ count = 4 }) {
    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16 }}>
            {Array.from({ length: count }).map((_, i) => (
                <div key={i} className="skeleton skeleton-stat" />
            ))}
        </div>
    );
}

export function SkeletonText({ lines = 3, style }) {
    const widths = ['long', '', 'short'];
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, ...style }}>
            {Array.from({ length: lines }).map((_, i) => (
                <div key={i} className={`skeleton skeleton-text ${widths[i % 3] || ''}`} />
            ))}
        </div>
    );
}
