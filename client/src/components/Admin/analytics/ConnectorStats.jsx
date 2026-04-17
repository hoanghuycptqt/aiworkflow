import { useState, useEffect } from 'react';
import { api } from '../../../services/api.js';
import Icon from '../../../services/icons.jsx';

const DAY_RANGES = [
    { label: '7 Days', value: 7 },
    { label: '14 Days', value: 14 },
    { label: '30 Days', value: 30 },
    { label: '90 Days', value: 90 },
    { label: '1 Year', value: 365 },
];

const NODE_TYPE_ICONS = {
    'chatgpt': '💬',
    'chatgpt-note': '📝',
    'google-flow-image': '🖼️',
    'google-flow-video': '🎬',
    'text-extractor': '📄',
    'file-handler': '📁',
    'gemini': '✨',
    'openrouter': '🔀',
    'ai-text': '🤖',
    'delay': '⏱️',
};

function formatDuration(ms) {
    if (ms === 0) return '—';
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${Math.floor(s % 60)}s`;
}

function SparklineBar({ data, maxVal, color = '#6366f1' }) {
    if (!data || data.length === 0) return <span className="sparkline-empty">—</span>;
    const max = maxVal || Math.max(...data.map(d => d.total), 1);
    const w = 80;
    const h = 20;
    const barW = Math.max(Math.floor(w / data.length) - 1, 2);

    return (
        <svg width={w} height={h} className="sparkline-svg">
            {data.map((d, i) => {
                const barH = Math.max((d.total / max) * h, 1);
                const failH = d.failed > 0 ? Math.max((d.failed / max) * h, 1) : 0;
                return (
                    <g key={i}>
                        <rect
                            x={i * (barW + 1)}
                            y={h - barH}
                            width={barW}
                            height={barH}
                            fill={color}
                            opacity={0.6}
                            rx={1}
                        />
                        {failH > 0 && (
                            <rect
                                x={i * (barW + 1)}
                                y={h - failH}
                                width={barW}
                                height={failH}
                                fill="#ef4444"
                                opacity={0.8}
                                rx={1}
                            />
                        )}
                    </g>
                );
            })}
        </svg>
    );
}

export default function ConnectorStats() {
    const [data, setData] = useState(null);
    const [days, setDays] = useState(30);
    const [loading, setLoading] = useState(true);
    const [sortBy, setSortBy] = useState('total');
    const [sortDir, setSortDir] = useState('desc');

    useEffect(() => {
        loadData();
    }, [days]);

    async function loadData() {
        setLoading(true);
        try {
            const result = await api.request(`/admin/analytics/connector-stats?days=${days}`);
            setData(result);
        } catch (err) {
            console.error('Connector stats error:', err);
        }
        setLoading(false);
    }

    function handleSort(col) {
        if (sortBy === col) {
            setSortDir(d => d === 'desc' ? 'asc' : 'desc');
        } else {
            setSortBy(col);
            setSortDir('desc');
        }
    }

    if (loading) return <div className="analytics-card analytics-loading"><div className="analytics-spinner" /></div>;
    if (!data || data.stats.length === 0) {
        return (
            <div className="analytics-card">
                <div className="analytics-card-header">
                    <h3><Icon name="cpu" size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />Connector Performance</h3>
                </div>
                <div className="analytics-empty">No connector data available</div>
            </div>
        );
    }

    // Sort stats
    const sorted = [...data.stats].sort((a, b) => {
        const mul = sortDir === 'desc' ? -1 : 1;
        return (a[sortBy] - b[sortBy]) * mul;
    });

    const maxDuration = Math.max(...sorted.map(s => s.p95Duration), 1);
    const globalMaxDailyTotal = Math.max(...sorted.flatMap(s => s.dailyTrend.map(d => d.total)), 1);

    return (
        <div className="analytics-card">
            <div className="analytics-card-header">
                <h3>
                    <Icon name="cpu" size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                    Connector Performance
                </h3>
                <div className="analytics-controls">
                    <div className="analytics-range-btns">
                        {DAY_RANGES.map(r => (
                            <button key={r.value} className={`analytics-range-btn ${days === r.value ? 'active' : ''}`}
                                onClick={() => setDays(r.value)}>{r.label}</button>
                        ))}
                    </div>
                </div>
            </div>

            <div className="connector-table-container">
                <table className="connector-table">
                    <thead>
                        <tr>
                            <th>Connector</th>
                            <th className="sortable" onClick={() => handleSort('total')}>
                                Runs {sortBy === 'total' && (sortDir === 'desc' ? '↓' : '↑')}
                            </th>
                            <th className="sortable" onClick={() => handleSort('avgDuration')}>
                                Avg {sortBy === 'avgDuration' && (sortDir === 'desc' ? '↓' : '↑')}
                            </th>
                            <th className="sortable" onClick={() => handleSort('p50Duration')}>
                                P50 {sortBy === 'p50Duration' && (sortDir === 'desc' ? '↓' : '↑')}
                            </th>
                            <th className="sortable" onClick={() => handleSort('p95Duration')}>
                                P95 {sortBy === 'p95Duration' && (sortDir === 'desc' ? '↓' : '↑')}
                            </th>
                            <th className="sortable" onClick={() => handleSort('successRate')}>
                                Success {sortBy === 'successRate' && (sortDir === 'desc' ? '↓' : '↑')}
                            </th>
                            <th>Trend (14d)</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.map(stat => {
                            const rateColor = stat.successRate >= 95 ? '#22c55e'
                                : stat.successRate >= 80 ? '#f59e0b' : '#ef4444';
                            return (
                                <tr key={stat.nodeType}>
                                    <td className="connector-name">
                                        <span className="connector-icon">{NODE_TYPE_ICONS[stat.nodeType] || '⚙️'}</span>
                                        {stat.nodeType}
                                    </td>
                                    <td className="num-cell">
                                        <span className="connector-runs">{stat.total.toLocaleString()}</span>
                                        {stat.failed > 0 && (
                                            <span className="connector-fails">({stat.failed} ✗)</span>
                                        )}
                                    </td>
                                    <td className="num-cell">
                                        <div className="duration-bar-container">
                                            <span>{formatDuration(stat.avgDuration)}</span>
                                            <div className="duration-bar">
                                                <div className="duration-bar-fill"
                                                    style={{ width: `${(stat.avgDuration / maxDuration) * 100}%` }} />
                                            </div>
                                        </div>
                                    </td>
                                    <td className="num-cell mono">{formatDuration(stat.p50Duration)}</td>
                                    <td className="num-cell mono">{formatDuration(stat.p95Duration)}</td>
                                    <td className="num-cell">
                                        <span className="success-rate" style={{ color: rateColor }}>
                                            {stat.successRate}%
                                        </span>
                                    </td>
                                    <td>
                                        <SparklineBar data={stat.dailyTrend} maxVal={globalMaxDailyTotal} />
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
