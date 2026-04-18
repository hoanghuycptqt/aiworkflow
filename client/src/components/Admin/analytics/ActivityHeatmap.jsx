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

// Color scale
const COLORS = [
    'rgba(99, 102, 241, 0.06)',
    'rgba(99, 102, 241, 0.20)',
    'rgba(99, 102, 241, 0.35)',
    'rgba(99, 102, 241, 0.50)',
    'rgba(99, 102, 241, 0.65)',
    'rgba(99, 102, 241, 0.80)',
    'rgba(99, 102, 241, 0.95)',
];

function getColor(value, max) {
    if (value === 0) return COLORS[0];
    const ratio = value / max;
    const idx = Math.min(Math.floor(ratio * (COLORS.length - 1)) + 1, COLORS.length - 1);
    return COLORS[idx];
}

function formatDateShort(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function getDayLabel(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString([], { weekday: 'short' });
}

const DAY_LABELS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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
    if (!data || !data.dateGrid || data.dateGrid.length === 0) {
        return (
            <div className="analytics-card" ref={containerRef}>
                <HeatmapHeader days={days} setDays={setDays} totalExecutions={0} />
                <div className="analytics-empty">No executions in this time range</div>
            </div>
        );
    }

    const { dateGrid, totalExecutions } = data;
    const useContributionView = days > 30;

    return (
        <div className="analytics-card" ref={containerRef}>
            <HeatmapHeader days={days} setDays={setDays} totalExecutions={totalExecutions} />
            <div className="heatmap-container">
                {useContributionView
                    ? <ContributionGraph dateGrid={dateGrid} days={days} containerRef={containerRef}
                        tooltip={tooltip} setTooltip={setTooltip} />
                    : <HourlyGrid dateGrid={dateGrid} days={days} containerRef={containerRef}
                        tooltip={tooltip} setTooltip={setTooltip} />
                }

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
                    <div className="heatmap-tooltip"
                        style={{ left: tooltip.x, top: tooltip.y, transform: 'translate(-50%, -100%)' }}>
                        <strong>{tooltip.title}</strong>
                        {tooltip.subtitle && <div className="heatmap-tooltip-time">{tooltip.subtitle}</div>}
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

// ─── Header ──────────────────────────────────
function HeatmapHeader({ days, setDays, totalExecutions }) {
    return (
        <div className="analytics-card-header">
            <h3>
                <Icon name="calendar" size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                Activity Heatmap
            </h3>
            <div className="analytics-controls">
                <span className="analytics-total">{totalExecutions.toLocaleString()} executions</span>
                <div className="analytics-range-btns">
                    {RANGES.map(r => (
                        <button key={r.value}
                            className={`analytics-range-btn ${days === r.value ? 'active' : ''}`}
                            onClick={() => setDays(r.value)}>
                            {r.label}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}

// ─── Hourly Grid (7d / 14d / 30d) ───────────
// X = dates, Y = hours (every hour)
function HourlyGrid({ dateGrid, days, containerRef, tooltip, setTooltip }) {
    const cellSize = days <= 7 ? 28 : days <= 14 ? 22 : 18;
    const cellGap = 2;
    const hourLabelWidth = 40;
    const topLabelHeight = 54;
    const numDates = dateGrid.length;

    // Show every Nth hour label to reduce clutter
    const hourStep = 1;
    const displayHours = Array.from({ length: 24 }, (_, i) => i);
    // Show every Nth date label
    const dateLabelStep = days <= 7 ? 1 : days <= 14 ? 2 : 3;

    const svgWidth = hourLabelWidth + numDates * (cellSize + cellGap) + 10;
    const svgHeight = topLabelHeight + 24 * (cellSize + cellGap) + 10;

    const allCounts = dateGrid.flatMap(d => d.hours);
    const maxVal = Math.max(...allCounts, 1);

    function showTooltip(di, h, e) {
        const d = dateGrid[di];
        const rect = e.target.getBoundingClientRect();
        const cr = containerRef.current.getBoundingClientRect();
        setTooltip({
            x: rect.left - cr.left + cellSize / 2,
            y: rect.top - cr.top - 8,
            title: `${getDayLabel(d.date)}, ${formatDateShort(d.date)}`,
            subtitle: `${String(h).padStart(2, '0')}:00`,
            total: d.statusHours[h].total,
            completed: d.statusHours[h].completed,
            failed: d.statusHours[h].failed,
        });
    }

    return (
        <svg width={svgWidth} height={svgHeight} style={{ display: 'block' }}>
            {/* Date labels (top, rotated) */}
            {dateGrid.map((d, di) => {
                if (di % dateLabelStep !== 0) return null;
                const x = hourLabelWidth + di * (cellSize + cellGap) + cellSize / 2;
                return (
                    <text key={`dl-${di}`} x={x} y={topLabelHeight - 8}
                        textAnchor="end" className="heatmap-label"
                        transform={`rotate(-50, ${x}, ${topLabelHeight - 8})`}>
                        {formatDateShort(d.date)}
                    </text>
                );
            })}

            {/* Hour labels (left) + cells */}
            {displayHours.map((hour, rowIdx) => (
                <g key={`row-${hour}`}>
                    {hour % 2 === 0 && (
                        <text x={hourLabelWidth - 6}
                            y={topLabelHeight + rowIdx * (cellSize + cellGap) + cellSize / 2 + 4}
                            textAnchor="end" className="heatmap-label">
                            {String(hour).padStart(2, '0')}h
                        </text>
                    )}
                    {dateGrid.map((d, di) => (
                        <rect key={`${di}-${hour}`}
                            x={hourLabelWidth + di * (cellSize + cellGap)}
                            y={topLabelHeight + rowIdx * (cellSize + cellGap)}
                            width={cellSize} height={cellSize} rx={3}
                            fill={getColor(d.hours[hour], maxVal)}
                            className="heatmap-cell"
                            onMouseEnter={(e) => showTooltip(di, hour, e)}
                            onMouseLeave={() => setTooltip(null)}
                        />
                    ))}
                </g>
            ))}
        </svg>
    );
}

// ─── GitHub-style Contribution Graph (90d / 1y) ───
// X = weeks, Y = day-of-week (Mon–Sun, 7 rows)
// Each cell = total jobs for that specific calendar date
function ContributionGraph({ dateGrid, days, containerRef, tooltip, setTooltip }) {
    const cellSize = days <= 90 ? 14 : 12;
    const cellGap = 2;
    const dayLabelWidth = 36;
    const topLabelHeight = 24;

    // Build week-based grid from dateGrid
    // Each entry in dateGrid has a date string "YYYY-MM-DD"
    // Group into weeks (columns), with day-of-week as rows
    const weeks = [];
    let currentWeek = [];

    for (const entry of dateGrid) {
        const d = new Date(entry.date + 'T00:00:00');
        const dow = d.getDay(); // 0=Sun

        // Start a new week on Sunday
        if (dow === 0 && currentWeek.length > 0) {
            weeks.push(currentWeek);
            currentWeek = [];
        }

        // For partial first week, pad with nulls
        if (weeks.length === 0 && currentWeek.length === 0 && dow > 0) {
            for (let i = 0; i < dow; i++) {
                currentWeek.push(null);
            }
        }

        const dayTotal = entry.hours.reduce((a, b) => a + b, 0);
        const dayCompleted = entry.statusHours.reduce((a, s) => a + s.completed, 0);
        const dayFailed = entry.statusHours.reduce((a, s) => a + s.failed, 0);
        currentWeek.push({
            date: entry.date,
            total: dayTotal,
            completed: dayCompleted,
            failed: dayFailed,
        });
    }
    if (currentWeek.length > 0) {
        // Pad last week
        while (currentWeek.length < 7) currentWeek.push(null);
        weeks.push(currentWeek);
    }

    const numWeeks = weeks.length;
    const svgWidth = dayLabelWidth + numWeeks * (cellSize + cellGap) + 10;
    const svgHeight = topLabelHeight + 7 * (cellSize + cellGap) + 10;

    // Max for color scale
    const allDayTotals = weeks.flat().filter(Boolean).map(d => d.total);
    const maxVal = Math.max(...allDayTotals, 1);

    // Month labels on top
    const monthLabels = [];
    let lastMonth = '';
    for (let wi = 0; wi < numWeeks; wi++) {
        // Use the first non-null day in the week to determine the month
        const firstDay = weeks[wi].find(d => d !== null);
        if (firstDay) {
            const d = new Date(firstDay.date + 'T00:00:00');
            const monthStr = d.toLocaleDateString([], { month: 'short' });
            if (monthStr !== lastMonth) {
                monthLabels.push({ weekIdx: wi, label: monthStr });
                lastMonth = monthStr;
            }
        }
    }

    function showTooltip(weekIdx, dayIdx, cell, e) {
        const rect = e.target.getBoundingClientRect();
        const cr = containerRef.current.getBoundingClientRect();
        setTooltip({
            x: rect.left - cr.left + cellSize / 2,
            y: rect.top - cr.top - 8,
            title: `${getDayLabel(cell.date)}, ${formatDateShort(cell.date)}`,
            subtitle: null,
            total: cell.total,
            completed: cell.completed,
            failed: cell.failed,
        });
    }

    return (
        <svg width={svgWidth} height={svgHeight} style={{ display: 'block' }}>
            {/* Month labels */}
            {monthLabels.map((ml, i) => (
                <text key={i}
                    x={dayLabelWidth + ml.weekIdx * (cellSize + cellGap) + cellSize / 2}
                    y={topLabelHeight - 6}
                    textAnchor="start" className="heatmap-label">
                    {ml.label}
                </text>
            ))}

            {/* Day-of-week labels (left) */}
            {[1, 3, 5].map(dow => (
                <text key={dow}
                    x={dayLabelWidth - 6}
                    y={topLabelHeight + dow * (cellSize + cellGap) + cellSize / 2 + 4}
                    textAnchor="end" className="heatmap-label">
                    {DAY_LABELS_SHORT[dow]}
                </text>
            ))}

            {/* Week columns × day rows */}
            {weeks.map((week, wi) => (
                <g key={`w-${wi}`}>
                    {week.map((cell, di) => {
                        if (!cell) return null;
                        return (
                            <rect key={`${wi}-${di}`}
                                x={dayLabelWidth + wi * (cellSize + cellGap)}
                                y={topLabelHeight + di * (cellSize + cellGap)}
                                width={cellSize} height={cellSize} rx={2}
                                fill={getColor(cell.total, maxVal)}
                                className="heatmap-cell"
                                onMouseEnter={(e) => showTooltip(wi, di, cell, e)}
                                onMouseLeave={() => setTooltip(null)}
                            />
                        );
                    })}
                </g>
            ))}
        </svg>
    );
}
