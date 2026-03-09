import { useState, useEffect } from 'react';
import { api } from '../../services/api.js';

export default function AdminDashboard() {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadDashboard();
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

    if (loading) return <div className="admin-loading"><div className="loading-spinner" /></div>;
    if (!data) return <div className="admin-error">Failed to load dashboard</div>;

    const { stats, chart, recentExecutions, recentUsers } = data;
    const maxCount = Math.max(...chart.map(d => d.count), 1);

    return (
        <div className="admin-dashboard">
            {/* Stat Cards */}
            <div className="stat-cards">
                <StatCard label="Total Users" value={stats.totalUsers} icon="👥" color="#6366f1" />
                <StatCard label="Active Users" value={stats.activeUsers} icon="✅" color="#22c55e" />
                <StatCard label="Workflows" value={stats.totalWorkflows} icon="⚡" color="#f59e0b" />
                <StatCard label="Jobs Today" value={stats.jobsToday} icon="🎬" color="#3b82f6" />
                <StatCard label="Completed" value={stats.jobsCompleted} icon="✔️" color="#10b981" />
                <StatCard label="Success Rate" value={`${stats.successRate}%`} icon="📈" color="#8b5cf6" />
            </div>

            {/* Jobs Chart */}
            <div className="admin-card">
                <h3>📊 Jobs (Last 7 Days)</h3>
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
                    <h3>🕐 Recent Activity</h3>
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
                    <h3>🆕 New Users</h3>
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

function StatCard({ label, value, icon, color }) {
    return (
        <div className="stat-card" style={{ borderTop: `3px solid ${color}` }}>
            <div className="stat-icon">{icon}</div>
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
