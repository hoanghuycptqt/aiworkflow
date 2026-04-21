import { useState, useEffect } from 'react';
import { api } from '../../services/api.js';
import Icon from '../../services/icons.jsx';
import { SkeletonStat } from '../Shared/SkeletonLoader.jsx';

export default function AdminDashboard() {
    const [data, setData] = useState(null);
    const [systemInfo, setSystemInfo] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadDashboard();
        loadSystemInfo();
    }, []);

    async function loadDashboard() {
        try {
            const result = await api.request('/admin/dashboard');
            setData(result);
        } catch (err) {
            console.error('Dashboard error:', err);
        }
        setLoading(false);
    }

    async function loadSystemInfo() {
        try {
            const result = await api.request('/admin/system-info');
            setSystemInfo(result);
        } catch (err) {
            console.error('SystemInfo error:', err);
        }
    }

    if (loading) return <div className="admin-dashboard" style={{ padding: 24 }}><SkeletonStat count={4} /></div>;
    if (!data) return <div className="admin-error">Failed to load dashboard</div>;

    const { stats, chart, recentExecutions, recentUsers } = data;
    const maxCount = Math.max(...chart.map(d => d.count), 1);

    return (
        <div className="admin-dashboard">
            {/* Stat Cards */}
            <div className="stat-cards">
                <StatCard label="Total Users" value={stats.totalUsers} icon="users" color="#6366f1" />
                <StatCard label="Active Users" value={stats.activeUsers} icon="check-circle" color="#22c55e" />
                <StatCard label="Workflows" value={stats.totalWorkflows} icon="zap" color="#f59e0b" />
                <StatCard label="Jobs Today" value={stats.jobsToday} icon="clapperboard" color="#3b82f6" />
                <StatCard label="Completed" value={stats.jobsCompleted} icon="circle-check" color="#10b981" />
                <StatCard label="Success Rate" value={`${stats.successRate}%`} icon="trending-up" color="#8b5cf6" />
            </div>

            {/* System Info */}
            {systemInfo && <SystemInfoCard info={systemInfo} onRefresh={loadSystemInfo} />}

            {/* Jobs Chart */}
            <div className="admin-card">
                <h3><Icon name="bar-chart" size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} /> Jobs (Last 7 Days)</h3>
                <div className="chart-container">
                    {chart.map((day, i) => (
                        <div key={i} className="chart-bar-wrapper">
                            <div className="chart-bar-value">{day.count}</div>
                            <div
                                className="chart-bar"
                                style={{ height: `${Math.max((day.count / maxCount) * 100, 4)}%` }}
                            />
                            <div className="chart-bar-label">{day.date.slice(5)}</div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Two columns: Recent Activity + New Users */}
            <div className="admin-grid-2">
                <div className="admin-card">
                    <h3><Icon name="clock" size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} /> Recent Activity</h3>
                    <div className="activity-list">
                        {recentExecutions.length === 0 && <p className="empty-text">No recent activity</p>}
                        {recentExecutions.map(exec => (
                            <div key={exec.id} className="activity-item">
                                <span className={`status-dot status-${exec.status}`} />
                                <div className="activity-info">
                                    <strong>{exec.workflow?.name || 'Unknown'}</strong>
                                    <span className="activity-meta">
                                        by {exec.workflow?.user?.name || '?'} • {timeAgo(exec.startedAt)}
                                    </span>
                                </div>
                                <span className={`status-badge status-${exec.status}`}>{exec.status}</span>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="admin-card">
                    <h3><Icon name="user-plus" size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} /> New Users</h3>
                    <div className="activity-list">
                        {recentUsers.map(user => (
                            <div key={user.id} className="activity-item">
                                <div className="user-avatar-sm">{user.name?.[0]?.toUpperCase() || 'U'}</div>
                                <div className="activity-info">
                                    <strong>{user.name}</strong>
                                    <span className="activity-meta">{user.email}</span>
                                </div>
                                <span className={`role-badge role-${user.role}`}>{user.role}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Helper: Format bytes ──────────────────────────────────
function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

// ─── Helper: Format uptime ─────────────────────────────────
function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

// ─── Helper: Get color by percent ──────────────────────────
function getUsageColor(percent) {
    if (percent >= 90) return '#ef4444';
    if (percent >= 75) return '#f59e0b';
    if (percent >= 50) return '#3b82f6';
    return '#22c55e';
}

// ─── System Info Card ──────────────────────────────────────
function SystemInfoCard({ info, onRefresh }) {
    const { disk, breakdown, ram, cpu, uptime } = info;
    const diskColor = getUsageColor(disk.percent);

    return (
        <div className="admin-card system-info-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <h3 style={{ margin: 0 }}>
                    <Icon name="hard-drive" size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                    System Monitor
                </h3>
                <button
                    onClick={onRefresh}
                    style={{
                        background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                        padding: '4px 10px', cursor: 'pointer', color: 'var(--text-secondary)',
                        fontSize: 12, display: 'flex', alignItems: 'center', gap: 4,
                    }}
                >
                    <Icon name="refresh-cw" size={12} /> Refresh
                </button>
            </div>

            <div className="system-info-grid">
                {/* Disk Gauge */}
                <div className="system-gauge-card">
                    <div className="gauge-ring" style={{ '--gauge-color': diskColor, '--gauge-percent': disk.percent }}>
                        <svg viewBox="0 0 120 120" className="gauge-svg">
                            <circle cx="60" cy="60" r="52" className="gauge-bg" />
                            <circle cx="60" cy="60" r="52" className="gauge-fill"
                                strokeDasharray={`${(disk.percent / 100) * 327} 327`} stroke={diskColor} />
                        </svg>
                        <div className="gauge-center">
                            <span className="gauge-value" style={{ color: diskColor }}>{disk.percent}%</span>
                            <span className="gauge-label">Disk</span>
                        </div>
                    </div>
                    <div className="gauge-detail">
                        <span>{formatBytes(disk.used)} / {formatBytes(disk.total)}</span>
                        <span style={{ color: diskColor, fontWeight: 600 }}>{formatBytes(disk.free)} free</span>
                    </div>
                </div>

                {/* RAM + CPU + Uptime bars */}
                <div className="system-bars-card">
                    <div className="system-bar-item">
                        <div className="system-bar-header">
                            <span>RAM</span>
                            <span>{formatBytes(ram.used)} / {formatBytes(ram.total)}</span>
                        </div>
                        <div className="system-bar-track">
                            <div className="system-bar-fill" style={{ width: `${ram.percent}%`, background: getUsageColor(ram.percent) }} />
                        </div>
                    </div>
                    <div className="system-bar-item">
                        <div className="system-bar-header">
                            <span>CPU ({cpu.cores} cores)</span>
                            <span>{cpu.load1m.toFixed(2)} / {cpu.cores}</span>
                        </div>
                        <div className="system-bar-track">
                            <div className="system-bar-fill" style={{ width: `${cpu.percent}%`, background: getUsageColor(cpu.percent) }} />
                        </div>
                    </div>
                    <div className="system-bar-item">
                        <div className="system-bar-header">
                            <span>Uptime</span>
                            <span>{formatUptime(uptime)}</span>
                        </div>
                    </div>
                </div>

                {/* Disk Breakdown */}
                <div className="system-breakdown-card">
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: 'var(--text-primary)' }}>
                        Disk Breakdown
                    </div>
                    {breakdown.length === 0 && <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>No data</div>}
                    {breakdown.map((item, i) => {
                        const pct = disk.used > 0 ? Math.max((item.size / disk.used) * 100, 0.5) : 0;
                        const colors = ['#6366f1', '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
                        const color = colors[i % colors.length];
                        return (
                            <div key={i} className="breakdown-row">
                                <div className="breakdown-info">
                                    <span className="breakdown-color" style={{ background: color }} />
                                    <span className="breakdown-label">{item.label}</span>
                                    <span className="breakdown-size">{formatBytes(item.size)}</span>
                                </div>
                                <div className="breakdown-bar-track">
                                    <div className="breakdown-bar-fill" style={{ width: `${Math.min(pct, 100)}%`, background: color }} />
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

function StatCard({ label, value, icon, color }) {
    return (
        <div className="stat-card" style={{ borderTop: `3px solid ${color}` }}>
            <div className="stat-icon"><Icon name={icon} size={24} color={color} /></div>
            <div className="stat-value">{value}</div>
            <div className="stat-label">{label}</div>
        </div>
    );
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

