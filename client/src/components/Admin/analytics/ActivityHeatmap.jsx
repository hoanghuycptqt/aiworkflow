import { useState, useEffect, useRef } from 'react';
import { api } from '../../../services/api.js';
import Icon from '../../../services/icons.jsx';

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

function formatDateShort(date) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function getDayLabel(date) {
    return date.toLocaleDateString([], { weekday: 'short' });
}

export default function ActivityHeatmap() {
    const [data, setData] = useState(null);
    const [days, setDays] = useState(30);
    const [loading, setLoading] = useState(true);
    const [tooltip, setTooltip] = useState(null);
    const containerRef = useRef(null);

    useEffect(() => {
        loadData(days);
    }, [days]);

    async function loadData(daysParam) {
        setLoading(true);
        setData(null);
        try {
            const result = await api.request(`/admin/analytics/heatmap?days=${daysParam}`);
            setData(result);
        } catch (err) {
            console.error('Heatmap error:', err);
        }
        setLoading(false);
    }

    if (loading) return <div className="analytics-card analytics-loading"><div className="analytics-spinner" /></div>;
    if (!data) return <div className="analytics-card analytics-error">Failed to load heatmap</div>;

    const { dateGrid, totalExecutions, dateRange } = data;

    // dateGrid: array of { date: "2026-04-17", hours: [count0, count1, ..., count23], statusHours: [...] }
    if (!dateGrid || dateGrid.length === 0) {
        return (
            <div className="analytics-card" ref={containerRef}>
                <div className="analytics-card-header">
                    <h3>
                        <Icon name="calendar" size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                        Activity Heatmap
                    </h3>
                    <div className="analytics-controls">
                        <span className="analytics-total">0 executions</span>
                        <div className="analytics-range-btns">
                            {RANGES.map(r => (
                                <button key={r.value}
                                    className={`analytics-range-btn ${days === r.value ? 'active' : ''}`}
                                    onClick={() => setDays(r.value)}>{r.label}</button>
                            ))}
                        </div>
                    </div>
                </div>
                <div className="analytics-empty">No executions in this time range</div>
            </div>
        );
    }

    // Compute max for color scale
    const allCounts = dateGrid.flatMap(d => d.hours);
    const maxVal = Math.max(...allCounts, 1);

    // Layout
    const cellSize = days <= 14 ? 24 : days <= 30 ? 16 : days <= 90 ? 8 : 4;
    const cellGap = days <= 14 ? 2 : days <= 30 ? 2 : 1;
    const hourLabelWidth = 36;
    const topLabelHeight = days <= 30 ? 50 : 30;
    const numHours = 24;
    const numDates = dateGrid.length;

    // For large ranges, group by showing fewer hour rows
    let hourStep = 1;
    let displayHours = Array.from({ length: 24 }, (_, i) => i);
    if (days > 90) {
        // Show 6-hour blocks for very large ranges
        hourStep = 6;
        displayHours = [0, 6, 12, 18];
    } else if (days > 30) {
        // Show 3-hour blocks
        hourStep = 3;
        displayHours = [0, 3, 6, 9, 12, 15, 18, 21];
    }

    const numDisplayRows = displayHours.length;
    const svgWidth = hourLabelWidth + numDates * (cellSize + cellGap) + 10;
    const svgHeight = topLabelHeight + numDisplayRows * (cellSize + cellGap) + 10;

    // Aggregate hours into blocks if needed
    function getBlockValue(dateIdx, hourIdx) {
        const d = dateGrid[dateIdx];
        if (hourStep === 1) return d.hours[hourIdx];
        let sum = 0;
        for (let h = hourIdx; h < Math.min(hourIdx + hourStep, 24); h++) {
            sum += d.hours[h];
        }
        return sum;
    }

    function getBlockStatus(dateIdx, hourIdx) {
        const d = dateGrid[dateIdx];
        if (hourStep === 1) return d.statusHours[hourIdx];
        let completed = 0, failed = 0, total = 0;
        for (let h = hourIdx; h < Math.min(hourIdx + hourStep, 24); h++) {
            completed += d.statusHours[h].completed;
            failed += d.statusHours[h].failed;
            total += d.statusHours[h].total;
        }
        return { completed, failed, total };
    }

    // Compute max for the block view
    const blockMax = hourStep === 1 ? maxVal : Math.max(
        ...dateGrid.flatMap((d, di) => displayHours.map(h => getBlockValue(di, h))), 1
    );

    // Date labels on top — show every Nth date to avoid crowding
    const dateLabelStep = days <= 14 ? 1 : days <= 30 ? 3 : days <= 90 ? 7 : 30;

    function handleMouseEnter(dateIdx, hour, e) {
        const d = dateGrid[dateIdx];
        const status = getBlockStatus(dateIdx, hour);
        const rect = e.target.getBoundingClientRect();
        const containerRect = containerRef.current.getBoundingClientRect();
        const dateObj = new Date(d.date + 'T00:00:00');
        setTooltip({
            x: rect.left - containerRect.left + cellSize / 2,
            y: rect.top - containerRect.top - 8,
            date: formatDateShort(dateObj),
            dayName: getDayLabel(dateObj),
            hour: hourStep === 1
                ? `${String(hour).padStart(2, '0')}:00`
                : `${String(hour).padStart(2, '0')}:00–${String(hour + hourStep).padStart(2, '0')}:00`,
            total: status.total,
            completed: status.completed,
            failed: status.failed,
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
                    {/* Date labels (top) — rotated for readability */}
                    {dateGrid.map((d, di) => {
                        if (di % dateLabelStep !== 0) return null;
                        const x = hourLabelWidth + di * (cellSize + cellGap) + cellSize / 2;
                        const dateObj = new Date(d.date + 'T00:00:00');
                        return (
                            <text
                                key={`dl-${di}`}
                                x={x}
                                y={topLabelHeight - 6}
                                textAnchor={days <= 30 ? 'end' : 'middle'}
                                className="heatmap-label"
                                transform={days <= 30 ? `rotate(-45, ${x}, ${topLabelHeight - 6})` : ''}
                            >
                                {days <= 30
                                    ? `${dateObj.toLocaleDateString([], { month: 'short', day: 'numeric' })}`
                                    : `${dateObj.toLocaleDateString([], { month: 'short' })}`
                                }
                            </text>
                        );
                    })}

                    {/* Hour labels (left) + Data cells */}
                    {displayHours.map((hour, rowIdx) => (
                        <g key={`row-${hour}`}>
                            <text
                                x={hourLabelWidth - 6}
                                y={topLabelHeight + rowIdx * (cellSize + cellGap) + cellSize / 2 + 4}
                                textAnchor="end"
                                className="heatmap-label"
                            >
                                {String(hour).padStart(2, '0')}h
                            </text>
                            {dateGrid.map((d, di) => {
                                const val = getBlockValue(di, hour);
                                return (
                                    <rect
                                        key={`${di}-${hour}`}
                                        x={hourLabelWidth + di * (cellSize + cellGap)}
                                        y={topLabelHeight + rowIdx * (cellSize + cellGap)}
                                        width={cellSize}
                                        height={cellSize}
                                        rx={cellSize > 8 ? 3 : 1}
                                        fill={getColor(val, blockMax)}
                                        className="heatmap-cell"
                                        onMouseEnter={(e) => handleMouseEnter(di, hour, e)}
                                        onMouseLeave={() => setTooltip(null)}
                                    />
                                );
                            })}
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
                        <strong>{tooltip.dayName}, {tooltip.date}</strong>
                        <div className="heatmap-tooltip-time">{tooltip.hour}</div>
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
