import { useState, useEffect } from 'react';
import { api } from '../../../services/api.js';
import Icon from '../../../services/icons.jsx';

const NODE_TYPE_COLORS = {
    'chatgpt': '#10b981',
    'chatgpt-note': '#34d399',
    'google-flow-image': '#f59e0b',
    'google-flow-video': '#ef4444',
    'text-extractor': '#6366f1',
    'file-handler': '#8b5cf6',
    'gemini': '#3b82f6',
    'openrouter': '#ec4899',
    'ai-text': '#14b8a6',
    'delay': '#6b7280',
};

function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${Math.floor(s % 60)}s`;
}

export default function NodeWaterfall({ executionId, onClose }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (executionId) loadData();
    }, [executionId]);

    async function loadData() {
        setLoading(true);
        try {
            const result = await api.request(`/executions/detail/${executionId}`);
            setData(result.execution);
        } catch (err) {
            console.error('Waterfall error:', err);
        }
        setLoading(false);
    }

    if (!executionId) return null;
    if (loading) return <div className="analytics-card analytics-loading"><div className="analytics-spinner" /></div>;
    if (!data) return <div className="analytics-card analytics-error">Failed to load execution detail</div>;

    const nodes = (data.nodeExecutions || []).filter(n => n.startedAt);
    if (nodes.length === 0) return <div className="analytics-card analytics-empty">No node execution data</div>;

    // Compute relative timestamps
    const execStart = new Date(data.startedAt).getTime();
    const execEnd = data.completedAt ? new Date(data.completedAt).getTime() : Date.now();
    const totalDuration = execEnd - execStart || 1;

    const chartWidth = 500;
    const labelWidth = 160;
    const barHeight = 26;
    const barGap = 6;
    const headerHeight = 36;

    return (
        <div className="analytics-card waterfall-card">
            <div className="analytics-card-header">
                <h3>
                    <Icon name="waves" size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                    Node Waterfall
                    <span className="waterfall-duration">Total: {formatDuration(totalDuration)}</span>
                </h3>
                {onClose && (
                    <button className="analytics-close-btn" onClick={onClose}>
                        <Icon name="x" size={16} />
                    </button>
                )}
            </div>

            <div className="waterfall-container">
                <svg
                    width={labelWidth + chartWidth + 80}
                    height={headerHeight + nodes.length * (barHeight + barGap)}
                    className="waterfall-svg"
                >
                    {/* Time markers */}
                    {[0, 0.25, 0.5, 0.75, 1].map((frac, i) => {
                        const x = labelWidth + frac * chartWidth;
                        const t = execStart + frac * totalDuration;
                        return (
                            <g key={i}>
                                <text x={x} y={headerHeight - 10} textAnchor="middle" className="waterfall-time-label">
                                    {formatDuration(frac * totalDuration)}
                                </text>
                                <line x1={x} y1={headerHeight - 4} x2={x}
                                    y2={headerHeight + nodes.length * (barHeight + barGap)}
                                    stroke="var(--border)" strokeWidth="0.5" strokeDasharray="3 3" opacity="0.4" />
                            </g>
                        );
                    })}

                    {/* Node bars */}
                    {nodes.map((node, i) => {
                        const nodeStart = new Date(node.startedAt).getTime();
                        const nodeEnd = node.completedAt ? new Date(node.completedAt).getTime() : execEnd;
                        const waitMs = nodeStart - execStart;
                        const activeMs = nodeEnd - nodeStart;

                        const waitWidth = (waitMs / totalDuration) * chartWidth;
                        const activeWidth = Math.max((activeMs / totalDuration) * chartWidth, 3);
                        const barX = labelWidth + waitWidth;
                        const barY = headerHeight + i * (barHeight + barGap);
                        const color = NODE_TYPE_COLORS[node.nodeType] || '#6b7280';

                        return (
                            <g key={node.id || i}>
                                {/* Node type label */}
                                <text x={labelWidth - 8} y={barY + barHeight / 2 + 4}
                                    textAnchor="end" className="waterfall-label">
                                    {node.nodeType}
                                </text>

                                {/* Wait segment (faded) */}
                                {waitWidth > 2 && (
                                    <rect x={labelWidth} y={barY + barHeight / 2 - 1} width={waitWidth} height={2}
                                        fill={color} opacity={0.2} rx={1} />
                                )}

                                {/* Active segment */}
                                <rect x={barX} y={barY + 2} width={activeWidth} height={barHeight - 4}
                                    rx={4} fill={color}
                                    opacity={node.status === 'failed' ? 0.6 : 0.85} />

                                {/* Status icon */}
                                {node.status === 'failed' && activeWidth > 20 && (
                                    <text x={barX + 4} y={barY + barHeight / 2 + 3}
                                        className="waterfall-bar-icon" fill="white" fontSize="10">✗</text>
                                )}

                                {/* Duration label */}
                                <text x={barX + activeWidth + 6} y={barY + barHeight / 2 + 4}
                                    className="waterfall-dur-label">
                                    {formatDuration(activeMs)}
                                </text>
                            </g>
                        );
                    })}
                </svg>
            </div>

            {/* Color legend */}
            <div className="waterfall-legend">
                {nodes.map(n => n.nodeType).filter((v, i, a) => a.indexOf(v) === i).map(type => (
                    <span key={type} className="waterfall-legend-item">
                        <span className="waterfall-legend-dot"
                            style={{ backgroundColor: NODE_TYPE_COLORS[type] || '#6b7280' }} />
                        {type}
                    </span>
                ))}
            </div>
        </div>
    );
}
