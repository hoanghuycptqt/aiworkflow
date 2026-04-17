import { useState, useEffect } from 'react';
import { api } from '../../../services/api.js';
import Icon from '../../../services/icons.jsx';

const HOUR_RANGES = [
    { label: '6h', value: 6 },
    { label: '12h', value: 12 },
    { label: '24h', value: 24 },
    { label: '3d', value: 72 },
    { label: '7d', value: 168 },
];

function formatTime(ts, long = false) {
    const d = new Date(ts);
    if (long) return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ConcurrencyMonitor() {
    const [data, setData] = useState(null);
    const [hours, setHours] = useState(24);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadData();
    }, [hours]);

    async function loadData() {
        setLoading(true);
        try {
            const result = await api.request(`/admin/analytics/concurrency?hours=${hours}`);
            setData(result);
        } catch (err) {
            console.error('Concurrency error:', err);
        }
        setLoading(false);
    }

    if (loading) return <div className="analytics-card analytics-loading"><div className="analytics-spinner" /></div>;
    if (!data) return <div className="analytics-card analytics-error">Failed to load concurrency data</div>;

    const { series, peak, currentRunning, average } = data;

    // Chart dimensions
    const chartWidth = 700;
    const chartHeight = 180;
    const padding = { top: 20, right: 20, bottom: 30, left: 40 };
    const innerW = chartWidth - padding.left - padding.right;
    const innerH = chartHeight - padding.top - padding.bottom;

    // Compute scales
    const maxConcurrent = Math.max(peak, 1);
    const yScale = (v) => padding.top + innerH - (v / maxConcurrent) * innerH;

    let xMin, xMax;
    if (series.length > 0) {
        xMin = series[0].time;
        xMax = series[series.length - 1].time;
    } else {
        xMin = Date.now() - hours * 3600000;
        xMax = Date.now();
    }
    const xRange = xMax - xMin || 1;
    const xScale = (t) => padding.left + ((t - xMin) / xRange) * innerW;

    // Build area path
    let areaPath = '';
    let linePath = '';
    if (series.length > 0) {
        const points = series.map(p => ({ x: xScale(p.time), y: yScale(p.concurrent) }));
        linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
        areaPath = linePath + ` L${points[points.length - 1].x},${yScale(0)} L${points[0].x},${yScale(0)} Z`;
    }

    // Y-axis ticks
    const yTicks = [];
    const yStep = Math.max(1, Math.ceil(maxConcurrent / 5));
    for (let v = 0; v <= maxConcurrent; v += yStep) {
        yTicks.push(v);
    }
    if (yTicks[yTicks.length - 1] < maxConcurrent) yTicks.push(maxConcurrent);

    // X-axis ticks
    const xTickCount = Math.min(6, hours);
    const xTicks = Array.from({ length: xTickCount }, (_, i) => {
        const t = xMin + (xRange * i) / (xTickCount - 1);
        return t;
    });

    return (
        <div className="analytics-card">
            <div className="analytics-card-header">
                <h3>
                    <Icon name="activity" size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                    Concurrency Monitor
                </h3>
                <div className="analytics-controls">
                    <div className="concurrency-stats-inline">
                        <span className="conc-stat">
                            <span className="conc-stat-label">Now</span>
                            <span className={`conc-stat-value ${currentRunning > 0 ? 'active' : ''}`}>
                                {currentRunning}
                            </span>
                        </span>
                        <span className="conc-stat">
                            <span className="conc-stat-label">Peak</span>
                            <span className="conc-stat-value peak">{peak}</span>
                        </span>
                        <span className="conc-stat">
                            <span className="conc-stat-label">Avg</span>
                            <span className="conc-stat-value">{average}</span>
                        </span>
                    </div>
                    <div className="analytics-range-btns">
                        {HOUR_RANGES.map(r => (
                            <button key={r.value} className={`analytics-range-btn ${hours === r.value ? 'active' : ''}`}
                                onClick={() => setHours(r.value)}>{r.label}</button>
                        ))}
                    </div>
                </div>
            </div>

            <div className="concurrency-chart-container">
                <svg width={chartWidth} height={chartHeight} className="concurrency-svg">
                    <defs>
                        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#6366f1" stopOpacity="0.4" />
                            <stop offset="100%" stopColor="#6366f1" stopOpacity="0.02" />
                        </linearGradient>
                    </defs>

                    {/* Grid lines + Y axis labels */}
                    {yTicks.map(v => (
                        <g key={v}>
                            <line x1={padding.left} y1={yScale(v)} x2={padding.left + innerW} y2={yScale(v)}
                                stroke="var(--border)" strokeWidth="0.5" strokeDasharray="3 3" opacity="0.4" />
                            <text x={padding.left - 8} y={yScale(v) + 4} textAnchor="end"
                                className="concurrency-axis-label">{v}</text>
                        </g>
                    ))}

                    {/* X axis labels */}
                    {xTicks.map((t, i) => (
                        <text key={i} x={xScale(t)} y={chartHeight - 6} textAnchor="middle"
                            className="concurrency-axis-label">
                            {hours <= 24 ? formatTime(t) : formatTime(t, true)}
                        </text>
                    ))}

                    {/* Area */}
                    {areaPath && <path d={areaPath} fill="url(#areaGrad)" />}

                    {/* Line */}
                    {linePath && <path d={linePath} fill="none" stroke="#6366f1" strokeWidth="2" />}

                    {/* Peak marker */}
                    {series.length > 0 && (() => {
                        const peakPoint = series.reduce((max, p) => p.concurrent > max.concurrent ? p : max, series[0]);
                        return (
                            <g>
                                <circle cx={xScale(peakPoint.time)} cy={yScale(peakPoint.concurrent)} r={4}
                                    fill="#6366f1" stroke="white" strokeWidth="2" />
                                <text x={xScale(peakPoint.time)} y={yScale(peakPoint.concurrent) - 10}
                                    textAnchor="middle" className="concurrency-peak-label">
                                    Peak: {peakPoint.concurrent}
                                </text>
                            </g>
                        );
                    })()}

                    {/* Axes */}
                    <line x1={padding.left} y1={padding.top} x2={padding.left} y2={padding.top + innerH}
                        stroke="var(--border)" strokeWidth="1" />
                    <line x1={padding.left} y1={padding.top + innerH}
                        x2={padding.left + innerW} y2={padding.top + innerH}
                        stroke="var(--border)" strokeWidth="1" />
                </svg>
            </div>

            {series.length === 0 && (
                <div className="analytics-empty">No concurrency data for this time range</div>
            )}
        </div>
    );
}
