import { useState, useEffect, useRef } from 'react';
import { api } from '../../../services/api.js';
import Icon from '../../../services/icons.jsx';

const STATUS_COLORS = {
    completed: '#22c55e',
    failed: '#ef4444',
    running: '#3b82f6',
    cancelled: '#6b7280',
    pending: '#a3a3a3',
    partial: '#f59e0b',
};

const HOUR_RANGES = [
    { label: '1h', value: 1 },
    { label: '6h', value: 6 },
    { label: '24h', value: 24 },
    { label: '3d', value: 72 },
    { label: '7d', value: 168 },
];

function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const rs = Math.floor(s % 60);
    if (m < 60) return `${m}m ${rs}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}

function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + formatTime(ts);
}

export default function ExecutionTimeline() {
    const [data, setData] = useState(null);
    const [hours, setHours] = useState(24);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState(new Set());
    const [hoveredExec, setHoveredExec] = useState(null);
    const containerRef = useRef(null);

    useEffect(() => {
        loadData();
    }, [hours]);

    async function loadData() {
        setLoading(true);
        try {
            const result = await api.request(`/admin/analytics/timeline?hours=${hours}`);
            setData(result);
        } catch (err) {
            console.error('Timeline error:', err);
        }
        setLoading(false);
    }

    function toggleExpand(id) {
        setExpanded(prev => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    }

    if (loading) return <div className="analytics-card analytics-loading"><div className="analytics-spinner" /></div>;
    if (!data || data.executions.length === 0) {
        return (
            <div className="analytics-card">
                <div className="analytics-card-header">
                    <h3><Icon name="gantt-chart" size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />Execution Timeline</h3>
                    <div className="analytics-controls">
                        <div className="analytics-range-btns">
                            {HOUR_RANGES.map(r => (
                                <button key={r.value} className={`analytics-range-btn ${hours === r.value ? 'active' : ''}`}
                                    onClick={() => setHours(r.value)}>{r.label}</button>
                            ))}
                        </div>
                    </div>
                </div>
                <div className="analytics-empty">No executions in this time range</div>
            </div>
        );
    }

    const execs = data.executions;

    // Compute time range
    const allTimes = execs.flatMap(e => [
        new Date(e.startedAt).getTime(),
        new Date(e.completedAt).getTime(),
    ]);
    const minTime = Math.min(...allTimes);
    const maxTime = Math.max(...allTimes, Date.now());
    const totalDuration = maxTime - minTime || 1;

    // Layout constants
    const barHeight = 28;
    const barGap = 4;
    const nodeBarHeight = 18;
    const nodeBarGap = 2;
    const labelWidth = 180;
    const chartWidth = 600;
    const timeAxisHeight = 30;

    // Compute row heights (expanded rows are taller)
    let rows = [];
    for (const exec of execs) {
        const isExpanded = expanded.has(exec.id);
        const nodeCount = isExpanded ? (exec.nodeExecutions?.length || 0) : 0;
        const rowHeight = barHeight + barGap + nodeCount * (nodeBarHeight + nodeBarGap);
        rows.push({ exec, rowHeight, isExpanded, nodeCount });
    }

    const totalHeight = timeAxisHeight + rows.reduce((s, r) => s + r.rowHeight, 0);

    // Time axis ticks
    const tickCount = Math.min(8, Math.max(4, Math.floor(chartWidth / 80)));
    const ticks = Array.from({ length: tickCount }, (_, i) => {
        const t = minTime + (totalDuration * i) / (tickCount - 1);
        return { time: t, x: labelWidth + (chartWidth * i) / (tickCount - 1) };
    });

    function getBarX(ts) {
        return labelWidth + ((new Date(ts).getTime() - minTime) / totalDuration) * chartWidth;
    }
    function getBarWidth(start, end) {
        const w = ((new Date(end).getTime() - new Date(start).getTime()) / totalDuration) * chartWidth;
        return Math.max(w, 3); // minimum visible width
    }

    let yOffset = timeAxisHeight;

    return (
        <div className="analytics-card" ref={containerRef}>
            <div className="analytics-card-header">
                <h3>
                    <Icon name="gantt-chart" size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                    Execution Timeline
                </h3>
                <div className="analytics-controls">
                    <span className="analytics-total">{execs.length} execution{execs.length !== 1 ? 's' : ''}</span>
                    <div className="analytics-range-btns">
                        {HOUR_RANGES.map(r => (
                            <button key={r.value} className={`analytics-range-btn ${hours === r.value ? 'active' : ''}`}
                                onClick={() => setHours(r.value)}>{r.label}</button>
                        ))}
                    </div>
                </div>
            </div>

            <div className="timeline-scroll-container">
                <svg width={labelWidth + chartWidth + 20} height={totalHeight} className="timeline-svg">
                    {/* Time axis */}
                    <line x1={labelWidth} y1={timeAxisHeight - 4} x2={labelWidth + chartWidth} y2={timeAxisHeight - 4}
                        stroke="var(--border)" strokeWidth="1" />
                    {ticks.map((t, i) => (
                        <g key={i}>
                            <line x1={t.x} y1={timeAxisHeight - 8} x2={t.x} y2={timeAxisHeight - 4}
                                stroke="var(--text-secondary)" strokeWidth="1" />
                            <text x={t.x} y={timeAxisHeight - 12} textAnchor="middle" className="timeline-tick-label">
                                {hours <= 24 ? formatTime(t.time) : formatDate(t.time)}
                            </text>
                            {/* Grid line */}
                            <line x1={t.x} y1={timeAxisHeight} x2={t.x} y2={totalHeight}
                                stroke="var(--border)" strokeWidth="0.5" strokeDasharray="4 4" opacity="0.4" />
                        </g>
                    ))}

                    {/* Execution rows */}
                    {rows.map((row, idx) => {
                        const y = yOffset;
                        yOffset += row.rowHeight;
                        const { exec, isExpanded } = row;
                        const barX = getBarX(exec.startedAt);
                        const barW = getBarWidth(exec.startedAt, exec.completedAt);
                        const dur = new Date(exec.completedAt).getTime() - new Date(exec.startedAt).getTime();
                        const isHovered = hoveredExec === exec.id;

                        return (
                            <g key={exec.id}
                                onMouseEnter={() => setHoveredExec(exec.id)}
                                onMouseLeave={() => setHoveredExec(null)}
                                onClick={() => toggleExpand(exec.id)}
                                style={{ cursor: 'pointer' }}
                            >
                                {/* Row background */}
                                <rect x={0} y={y} width={labelWidth + chartWidth + 20} height={row.rowHeight}
                                    fill={isHovered ? 'rgba(99,102,241,0.05)' : (idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)')}
                                    rx={0} />

                                {/* Label */}
                                <text x={8} y={y + barHeight / 2 + 4} className="timeline-label" fill="var(--text-primary)">
                                    {isExpanded ? '▾' : '▸'} {exec.jobName}
                                </text>
                                <text x={labelWidth - 8} y={y + barHeight / 2 + 4} className="timeline-sublabel"
                                    textAnchor="end" fill="var(--text-secondary)">
                                    {formatDuration(dur)}
                                </text>

                                {/* Execution bar */}
                                <rect x={barX} y={y + 4} width={barW} height={barHeight - 8}
                                    rx={4} fill={STATUS_COLORS[exec.status] || '#6b7280'}
                                    opacity={isHovered ? 1 : 0.85} />

                                {/* Status indicator */}
                                {barW > 30 && (
                                    <text x={barX + 6} y={y + barHeight / 2 + 3}
                                        className="timeline-bar-text" fill="white" fontSize="10">
                                        {exec.status === 'running' ? '⦿' : exec.status === 'completed' ? '✓' : exec.status === 'failed' ? '✗' : ''}
                                    </text>
                                )}

                                {/* Expanded node executions */}
                                {isExpanded && exec.nodeExecutions?.map((ne, ni) => {
                                    const neY = y + barHeight + barGap + ni * (nodeBarHeight + nodeBarGap);
                                    if (!ne.startedAt) return null;
                                    const neX = getBarX(ne.startedAt);
                                    const neEnd = ne.completedAt || exec.completedAt;
                                    const neW = getBarWidth(ne.startedAt, neEnd);
                                    return (
                                        <g key={ne.id}>
                                            <text x={labelWidth - 8} y={neY + nodeBarHeight / 2 + 3}
                                                textAnchor="end" className="timeline-node-label" fill="var(--text-secondary)">
                                                {ne.nodeType}
                                            </text>
                                            <rect x={neX} y={neY + 2} width={neW} height={nodeBarHeight - 4}
                                                rx={3} fill={STATUS_COLORS[ne.status] || '#6b7280'} opacity={0.6} />
                                        </g>
                                    );
                                })}
                            </g>
                        );
                    })}
                </svg>
            </div>

            {/* Status legend */}
            <div className="timeline-legend">
                {Object.entries(STATUS_COLORS).slice(0, 4).map(([status, color]) => (
                    <span key={status} className="timeline-legend-item">
                        <span className="timeline-legend-dot" style={{ backgroundColor: color }} />
                        {status}
                    </span>
                ))}
                <span className="timeline-legend-hint">Click a row to expand nodes</span>
            </div>
        </div>
    );
}
