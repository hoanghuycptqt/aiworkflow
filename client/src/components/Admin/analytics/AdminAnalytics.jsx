import { useState } from 'react';
import ActivityHeatmap from './ActivityHeatmap.jsx';
import ExecutionTimeline from './ExecutionTimeline.jsx';
import NodeWaterfall from './NodeWaterfall.jsx';
import ConnectorStats from './ConnectorStats.jsx';
import ConcurrencyMonitor from './ConcurrencyMonitor.jsx';
import Icon from '../../../services/icons.jsx';

export default function AdminAnalytics() {
    const [waterfallExecId, setWaterfallExecId] = useState(null);
    const [waterfallVisible, setWaterfallVisible] = useState(false);

    function openWaterfall(executionId) {
        setWaterfallExecId(executionId);
        setWaterfallVisible(true);
    }

    return (
        <div className="admin-analytics">
            {/* Section 1: Activity Heatmap */}
            <section className="analytics-section">
                <ActivityHeatmap />
            </section>

            {/* Section 2: Concurrency Monitor */}
            <section className="analytics-section">
                <ConcurrencyMonitor />
            </section>

            {/* Section 3: Execution Timeline */}
            <section className="analytics-section">
                <ExecutionTimeline />
            </section>

            {/* Section 4: Connector Performance */}
            <section className="analytics-section">
                <ConnectorStats />
            </section>

            {/* Section 5: Node Waterfall (expandable) */}
            <section className="analytics-section">
                <div className="analytics-card">
                    <div className="analytics-card-header">
                        <h3>
                            <Icon name="waves" size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                            Node Waterfall Inspector
                        </h3>
                    </div>
                    <div className="waterfall-input-section">
                        <p className="waterfall-hint">
                            Paste an execution ID to inspect its node-level performance waterfall.
                        </p>
                        <div className="waterfall-input-row">
                            <input
                                type="text"
                                placeholder="Execution ID (e.g. a1b2c3d4-...)"
                                className="waterfall-input"
                                value={waterfallExecId || ''}
                                onChange={e => setWaterfallExecId(e.target.value || null)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter' && waterfallExecId) setWaterfallVisible(true);
                                }}
                            />
                            <button
                                className="waterfall-inspect-btn"
                                onClick={() => waterfallExecId && setWaterfallVisible(true)}
                                disabled={!waterfallExecId}
                            >
                                <Icon name="search" size={14} style={{ marginRight: 4 }} />
                                Inspect
                            </button>
                        </div>
                    </div>
                </div>
                {waterfallVisible && waterfallExecId && (
                    <NodeWaterfall
                        executionId={waterfallExecId}
                        onClose={() => setWaterfallVisible(false)}
                    />
                )}
            </section>
        </div>
    );
}
