import { useState, useEffect, useRef } from 'react';
import { api } from '../../../services/api.js';
import Icon from '../../../services/icons.jsx';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOUR_LABELS = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
const RANGES = [
    { label: '7 Days', value: 7 },
    { label: '14 Days', value: 14 },
    { label: '30 Days', value: 30 },
    { label: '90 Days', value: 90 },
    { label: '1 Year', value: 365 },
];

// Color scale: transparent → low → medium → high
const COLORS = [
    'rgba(99, 102, 241, 0.05)',   // 0 - almost invisible
    'rgba(99, 102, 241, 0.15)',   // very low
    'rgba(99, 102, 241, 0.30)',   // low
    'rgba(99, 102, 241, 0.50)',   // medium-low
    'rgba(99, 102, 241, 0.65)',   // medium
    'rgba(99, 102, 241, 0.80)',   // high
    'rgba(99, 102, 241, 0.95)',   // very high
];

function getColor(value, max) {
    if (value === 0) return COLORS[0];
    const ratio = value / max;
    const idx = Math.min(Math.floor(ratio * (COLORS.length - 1)) + 1, COLORS.length - 1);
    return COLORS[idx];
}

export default function ActivityHeatmap() {
    const [data, setData] = useState(null);
    const [days, setDays] = useState(30);
    const [loading, setLoading] = useState(true);
    const [tooltip, setTooltip] = useState(null);
    const containerRef = useRef(null);

    useEffect(() => {
        loadData();
    }, [days]);

    async function loadData() {
        setLoading(true);
        try {
            const result = await api.request(`/admin/analytics/heatmap?days=${days}`);
            setData(result);
        } catch (err) {
            console.error('Heatmap error:', err);
        }
        setLoading(false);
    }

    if (loading) return <div className="analytics-card analytics-loading"><div className="analytics-spinner" /></div>;
    if (!data) return <div className="analytics-card analytics-error">Failed to load heatmap</div>;

    const { matrix, statusMatrix, totalExecutions } = data;
    const maxVal = Math.max(...matrix.flat(), 1);

    const cellSize = 28;
    const gap = 3;
    const labelWidth = 42;
    const topLabelHeight = 28;
    const svgWidth = labelWidth + 24 * (cellSize + gap);
    const svgHeight = topLabelHeight + 7 * (cellSize + gap);

    function handleMouseEnter(day, hour, e) {
        const cell = statusMatrix[day][hour];
        const rect = e.target.getBoundingClientRect();
        const containerRect = containerRef.current.getBoundingClientRect();
        setTooltip({
            x: rect.left - containerRect.left + cellSize / 2,
            y: rect.top - containerRect.top - 8,
            day: DAY_LABELS[day],
            hour: HOUR_LABELS[hour],
            total: cell.total,
            completed: cell.completed,
            failed: cell.failed,
        });
    }

    return (
        <div className="analytics-card" ref={containerRef}>
            <div className="analytics-card-header">
                <h3>
                    <Icon name="calendar" size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                    Activity Heatmap
                </h3>
                <div className="analytics-controls">
                    <span className="analytics-total">{totalExecutions.toLocaleString()} executions</span>
                    <div className="analytics-range-btns">
                        {RANGES.map(r => (
                            <button
                                key={r.value}
                                className={`analytics-range-btn ${days === r.value ? 'active' : ''}`}
                                onClick={() => setDays(r.value)}
                            >
                                {r.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            <div className="heatmap-container">
                <svg width={svgWidth} height={svgHeight} style={{ display: 'block' }}>
                    {/* Hour labels (top) */}
                    {Array.from({ length: 24 }, (_, h) => (
                        h % 3 === 0 && (
                            <text
                                key={`h-${h}`}
                                x={labelWidth + h * (cellSize + gap) + cellSize / 2}
                                y={topLabelHeight - 8}
                                textAnchor="middle"
                                className="heatmap-label"
                            >
                                {String(h).padStart(2, '0')}h
                            </text>
                        )
                    ))}

                    {/* Day labels (left) + Cells */}
                    {DAY_LABELS.map((dayLabel, d) => (
                        <g key={d}>
                            <text
                                x={labelWidth - 8}
                                y={topLabelHeight + d * (cellSize + gap) + cellSize / 2 + 4}
                                textAnchor="end"
                                className="heatmap-label"
                            >
                                {dayLabel}
                            </text>
                            {Array.from({ length: 24 }, (_, h) => (
                                <rect
                                    key={`${d}-${h}`}
                                    x={labelWidth + h * (cellSize + gap)}
                                    y={topLabelHeight + d * (cellSize + gap)}
                                    width={cellSize}
                                    height={cellSize}
                                    rx={4}
                                    fill={getColor(matrix[d][h], maxVal)}
                                    className="heatmap-cell"
                                    onMouseEnter={(e) => handleMouseEnter(d, h, e)}
                                    onMouseLeave={() => setTooltip(null)}
                                />
                            ))}
                        </g>
                    ))}
                </svg>

                {/* Color legend */}
                <div className="heatmap-legend">
                    <span>Less</span>
                    {COLORS.map((c, i) => (
                        <div key={i} className="heatmap-legend-cell" style={{ backgroundColor: c }} />
                    ))}
                    <span>More</span>
                </div>

                {/* Tooltip */}
                {tooltip && (
                    <div
                        className="heatmap-tooltip"
                        style={{ left: tooltip.x, top: tooltip.y, transform: 'translate(-50%, -100%)' }}
                    >
                        <strong>{tooltip.day} {tooltip.hour}</strong>
                        <div>{tooltip.total} job{tooltip.total !== 1 ? 's' : ''}</div>
                        {tooltip.total > 0 && (
                            <div className="heatmap-tooltip-stats">
                                <span className="tt-completed">✓{tooltip.completed}</span>
                                {tooltip.failed > 0 && <span className="tt-failed">✗{tooltip.failed}</span>}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
