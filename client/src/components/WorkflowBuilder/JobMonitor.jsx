import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../../services/api.js';
import { onJobUpdate, onExecutionUpdate } from '../../services/socket.js';
import Icon from '../../services/icons.jsx';
import toast from 'react-hot-toast';

const SERVER = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';
// Only these node types produce output media for display
const OUTPUT_NODE_TYPES = ['google-flow-image', 'google-flow-video'];

// Pastel waterfall + thumb tint per node type (matches the design tokens)
const NODE_TYPE_COLOR = {
    'file-upload': 'var(--node-file)',
    'file-download': 'var(--sage)',
    'ai-text': 'var(--node-ai-text)',
    'google-flow-image': 'var(--node-flow-image)',
    'google-flow-video': 'var(--node-flow-video)',
    'chatgpt-note': 'var(--node-chatgpt-note)',
    'text-template': 'var(--node-utility)',
    'text-extractor': 'var(--node-utility)',
    'delay': 'var(--node-utility)',
};

const NODE_TYPE_ICON = {
    'file-upload': 'upload',
    'file-download': 'download',
    'ai-text': 'shuffle',
    'google-flow-image': 'palette',
    'google-flow-video': 'clapperboard',
    'chatgpt-note': 'message-square',
    'text-template': 'file-edit',
    'text-extractor': 'scissors',
    'delay': 'timer',
};

function nodeColor(type) {
    return NODE_TYPE_COLOR[type] || 'var(--node-utility)';
}

function nodeIconName(type) {
    return NODE_TYPE_ICON[type] || 'circle';
}

function kindFromStatus(status) {
    if (status === 'running') return 'running';
    if (status === 'failed' || status === 'cancelled') return 'failed';
    return 'done';
}

function statusLabel(status) {
    if (status === 'completed') return 'Done';
    if (status === 'running') return 'Running';
    if (status === 'failed') return 'Failed';
    if (status === 'cancelled') return 'Cancelled';
    if (status === 'partial') return 'Partial';
    if (status === 'pending') return 'Pending';
    return status;
}

function statusToken(status) {
    if (status === 'completed' || status === 'partial') return 'success';
    if (status === 'running' || status === 'pending') return 'warning';
    return 'error';
}

function formatSeconds(s) {
    if (s == null || isNaN(s)) return '—';
    if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
    const m = Math.floor(s / 60);
    const r = Math.round(s - m * 60);
    return `${m}m ${r}s`;
}

function execTotalDuration(exec) {
    if (!exec.startedAt) return null;
    const end = exec.completedAt ? new Date(exec.completedAt) : new Date();
    return (end - new Date(exec.startedAt)) / 1000;
}

function shortExecId(id) {
    if (!id) return 'job-—';
    const tail = String(id).slice(-4);
    return `exec-${tail}`;
}

function timeLabel(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'today';
    if (d.toDateString() === yesterday.toDateString()) return 'yesterday';
    return d.toLocaleDateString([], { day: '2-digit', month: 'short' }).toLowerCase();
}

function computeWaterfallBars(exec) {
    const nodes = (exec.nodeExecutions || [])
        .slice()
        .sort((a, b) => {
            if (!a.startedAt) return 1;
            if (!b.startedAt) return -1;
            return new Date(a.startedAt) - new Date(b.startedAt);
        });
    if (nodes.length === 0) return [];
    const bars = [];
    for (const n of nodes) {
        const start = n.startedAt ? new Date(n.startedAt) : null;
        const end = n.completedAt ? new Date(n.completedAt) : (start ? new Date() : null);
        const dur = start && end ? (end - start) / 1000 : 0;
        const isFailed = n.status === 'failed';
        bars.push({
            label: (n.nodeType || '').replace('google-flow-', '').replace('-', ' '),
            seconds: dur,
            color: isFailed ? 'var(--error)' : nodeColor(n.nodeType),
            status: n.status,
            node: n,
        });
    }
    return bars;
}

/**
 * Merged History + Monitor component.
 * Shows a flat list of all job executions for a workflow.
 * Receives `workflowId` instead of `batchId`.
 */
export default function JobMonitor({ workflowId }) {
    const [executions, setExecutions] = useState([]);
    const [expandedJob, setExpandedJob] = useState(null);
    const [expandedNode, setExpandedNode] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [totalCount, setTotalCount] = useState(0);
    const [loadingDetail, setLoadingDetail] = useState(null); // executionId currently loading
    const [gallery, setGallery] = useState(null);
    const [confirmDelete, setConfirmDelete] = useState(null);
    const notifiedRef = useRef(new Set());

    // Load all job executions
    useEffect(() => {
        if (!workflowId) return;
        loadHistory();
    }, [workflowId]);

    // Socket.IO listeners for real-time updates
    useEffect(() => {
        const unsubJob = onJobUpdate((data) => {
            // Update execution status when a job completes/fails
            if (data.executionId && data.jobStatus) {
                setExecutions(prev => prev.map(e =>
                    e.id === data.executionId
                        ? { ...e, status: data.jobStatus, error: data.error || e.error }
                        : e
                ));

                // Reload on completion to get output data (no toast here — batch toast handles it)
                if (data.jobStatus === 'completed' || data.jobStatus === 'failed') {
                    loadHistory();
                }
            }

            // Batch completion notification (single toast for the whole batch)
            if (data.status && ['completed', 'partial', 'failed'].includes(data.status)) {
                const key = `batch:${data.batchId}:${data.status}`;
                if (!notifiedRef.current.has(key)) {
                    notifiedRef.current.add(key);
                    const label = data.status === 'completed' ? 'Batch completed' : data.status === 'partial' ? 'Batch partial' : 'Batch failed';
                    toast(`${label}: ${data.completedJobs}/${data.totalJobs} completed`, { duration: 5000 });
                }
                loadHistory();
            }
        });

        const unsubExec = onExecutionUpdate((data) => {
            if (data.nodeId && data.nodeStatus) {
                setExecutions(prev => prev.map(e => {
                    if (e.id !== data.executionId) return e;
                    return {
                        ...e,
                        nodeExecutions: (e.nodeExecutions || []).map(ne =>
                            ne.nodeId === data.nodeId
                                ? { ...ne, status: data.nodeStatus, error: data.error }
                                : ne
                        ),
                        currentNode: data.nodeId,
                        currentNodeStatus: data.nodeStatus,
                    };
                }));
            }

            if (data.status && data.executionId) {
                setExecutions(prev => prev.map(e =>
                    e.id === data.executionId
                        ? { ...e, status: data.status, error: data.error || e.error }
                        : e
                ));
            }
        });

        return () => { unsubJob(); unsubExec(); };
    }, [workflowId]);

    async function loadHistory(append = false) {
        try {
            const offset = append ? executions.length : 0;
            if (append) setLoadingMore(true);
            const data = await api.getJobHistory(workflowId, 10, offset);
            if (append) {
                setExecutions(prev => [...prev, ...(data.executions || [])]);
            } else {
                setExecutions(data.executions || []);
            }
            setHasMore(data.hasMore || false);
            setTotalCount(data.total || 0);
        } catch (err) {
            toast.error('Failed to load job history');
        }
        setLoading(false);
        setLoadingMore(false);
    }

    async function stopBatch(batchId) {
        try {
            await api.cancelBatch(batchId);
            toast.success('Batch stopped');
            loadHistory();
        } catch (err) {
            toast.error(err.message);
        }
    }

    function downloadAll(batchId) {
        const token = localStorage.getItem('vcw_token');
        window.open(`${SERVER}/api/executions/batch/${batchId}/download?token=${token}`, '_blank');
    }

    function downloadJob(batchId, executionId) {
        const token = localStorage.getItem('vcw_token');
        window.open(`${SERVER}/api/executions/batch/${batchId}/download/${executionId}?token=${token}`, '_blank');
    }

    async function deleteExecution(executionId) {
        try {
            await api.deleteExecution(executionId);
            setExecutions(prev => prev.filter(e => e.id !== executionId));
            toast.success('Execution deleted');
        } catch (err) {
            toast.error(err.message);
        }
        setConfirmDelete(null);
    }

    const openGallery = useCallback((items, index) => {
        setGallery({ items, index });
    }, []);

    // Lazy load full node details (with outputData) when expanding a job
    async function toggleExpand(execId) {
        if (expandedJob === execId) {
            setExpandedJob(null);
            return;
        }
        setExpandedJob(execId);

        // Check if outputData is already loaded
        const exec = executions.find(e => e.id === execId);
        const hasOutputData = exec?.nodeExecutions?.some(ne => ne.outputData !== undefined);
        if (hasOutputData) return;

        // Fetch full detail with outputData
        setLoadingDetail(execId);
        try {
            const detail = await api.getExecutionDetail(execId);
            if (detail.execution) {
                setExecutions(prev => prev.map(e => {
                    if (e.id !== execId) return e;
                    return {
                        ...e,
                        nodeExecutions: e.nodeExecutions.map(ne => {
                            const detailNode = detail.execution.nodeExecutions.find(dn => dn.nodeId === ne.nodeId);
                            return detailNode ? { ...ne, outputData: detailNode.outputData } : ne;
                        }),
                    };
                }));
            }
        } catch (err) {
            console.warn('Failed to load execution detail:', err);
        }
        setLoadingDetail(null);
    }

    if (loading) {
        return (
            <div style={{ padding: 40, textAlign: 'center' }}>
                <div className="loading-spinner" style={{ margin: '0 auto' }} />
            </div>
        );
    }

    if (executions.length === 0) {
        return (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}><Icon name="folder-open" size={48} color="var(--text-muted)" /></div>
                <div style={{ fontSize: 14 }}>No execution history yet. Run some jobs first!</div>
            </div>
        );
    }

    // Count running jobs
    const runningCount = executions.filter(e => e.status === 'running').length;

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            background: 'var(--cream-100)',
        }}>
            {/* Hero band */}
            <div className="wb-hero-band">
                <span className="eyebrow">JOB HISTORY · {executions.length} EXECUTIONS{runningCount ? ` · ${runningCount} RUNNING` : ''}</span>
                <h2>The <em>diary</em> of every run.</h2>
                <p>One row per execution. Click a completed row to inspect outputs and node timings.</p>
            </div>

            {/* Job rows */}
            <div style={{ flex: 1, overflow: 'auto', padding: '20px 28px 28px' }}>
                <div className="wbh-list">
                    {executions.map((exec) => (
                        <ExecRow
                            key={exec.id}
                            exec={exec}
                            expanded={expandedJob === exec.id}
                            loadingDetail={loadingDetail === exec.id}
                            expandedNode={expandedNode}
                            onToggleExpand={() => toggleExpand(exec.id)}
                            onToggleNode={(nodeKey) => setExpandedNode(expandedNode === nodeKey ? null : nodeKey)}
                            onStop={() => stopBatch(exec.batchId)}
                            onDownload={() => downloadJob(exec.batchId, exec.id)}
                            onRetry={() => toast('Retry not yet implemented — re-run the batch from Jobs tab')}
                            onDelete={() => setConfirmDelete(exec.id)}
                            onOpenGallery={(items, idx) => openGallery(items, idx)}
                        />
                    ))}
                </div>

                {/* Load More */}
                {hasMore && (
                    <div style={{ textAlign: 'center', padding: '16px 0 0' }}>
                        <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => loadHistory(true)}
                            disabled={loadingMore}
                        >
                            {loadingMore ? <span className="loading-spinner" /> : <Icon name="chevron-down" size={12} />}
                            {loadingMore ? ' Loading…' : ` Load more (${executions.length} / ${totalCount})`}
                        </button>
                    </div>
                )}
            </div>

            {/* Gallery Lightbox */}
            {gallery && (
                <GalleryLightbox
                    items={gallery.items}
                    initialIndex={gallery.index}
                    onClose={() => setGallery(null)}
                />
            )}

            {/* Confirm Delete Modal */}
            {confirmDelete && (
                <div
                    onClick={() => setConfirmDelete(null)}
                    style={{
                        position: 'fixed', inset: 0, zIndex: 10000,
                        background: 'rgba(0,0,0,0.6)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            background: 'var(--bg-secondary)',
                            border: '1px solid var(--border-primary)',
                            borderRadius: 'var(--radius-lg)',
                            padding: '24px 28px',
                            minWidth: 320,
                            textAlign: 'center',
                        }}
                    >
                        <div style={{ fontSize: 32, marginBottom: 12 }}><Icon name="trash" size={32} color="#ef4444" /></div>
                        <div style={{ fontSize: 14, color: 'var(--text-primary)', marginBottom: 6, fontWeight: 600 }}>
                            Delete this execution?
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20 }}>
                            This will permanently remove it from history.
                        </div>
                        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                            <button
                                className="btn btn-sm"
                                onClick={() => setConfirmDelete(null)}
                                style={{ padding: '6px 20px', fontSize: 13 }}
                            >No</button>
                            <button
                                className="btn btn-sm btn-danger"
                                onClick={() => deleteExecution(confirmDelete)}
                                style={{ padding: '6px 20px', fontSize: 13, background: '#ef4444', color: '#fff', border: 'none' }}
                            >Yes, Delete</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── History row ──────────────────────────────────────────────
function ExecRow({
    exec,
    expanded,
    loadingDetail,
    expandedNode,
    onToggleExpand,
    onToggleNode,
    onStop,
    onDownload,
    onRetry,
    onDelete,
    onOpenGallery,
}) {
    const kind = kindFromStatus(exec.status);
    const isRunning = kind === 'running';
    const isDone = kind === 'done';
    const isFailed = kind === 'failed';

    const mediaItems = (exec.mediaItems || []).map(m => ({
        ...m,
        url: m.url?.startsWith('http') ? m.url : `${SERVER}${m.url || ''}`,
    }));
    const totalMedia = mediaItems.length;
    const firstMedia = mediaItems[0];

    const totalDuration = execTotalDuration(exec);
    const bars = computeWaterfallBars(exec);
    const elapsedSec = totalDuration ? Math.round(totalDuration) : 0;

    return (
        <>
            <div className={`wbh-row${expanded ? ' expanded' : ''} ${kind}`} onClick={onToggleExpand}>
                {/* Col 1 — hero thumb */}
                <div className="wbh-hero">
                    {isRunning && (
                        <>
                            <div className="live-pulse" />
                            <span className="duration-badge">live · {elapsedSec}s</span>
                        </>
                    )}
                    {isDone && firstMedia && firstMedia.type === 'video' && (
                        <>
                            {firstMedia.url
                                ? <img src={firstMedia.url} alt="" loading="lazy" />
                                : <div style={{ width: '100%', height: '100%', background: 'var(--node-flow-video)' }} />
                            }
                            <span className="play"><span className="play-circle"><Icon name="play" size={10} /></span></span>
                            {totalMedia > 1 && <span className="count-badge">+{totalMedia - 1}</span>}
                        </>
                    )}
                    {isDone && firstMedia && firstMedia.type === 'image' && (
                        <>
                            <img src={firstMedia.url} alt="" loading="lazy" />
                            {totalMedia > 1 && <span className="count-badge">+{totalMedia - 1}</span>}
                        </>
                    )}
                    {isDone && !firstMedia && (
                        <Icon name="check-circle" size={20} color="var(--ink-faint)" />
                    )}
                    {isFailed && (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--peach-soft)', color: 'var(--error)' }}>
                            <Icon name="alert-triangle" size={18} color="currentColor" />
                        </div>
                    )}
                </div>

                {/* Col 2 — title + id */}
                <div>
                    <div className="wbh-row-title" title={exec.jobName}>{exec.jobName || 'Untitled execution'}</div>
                    <div className="wbh-row-id">{shortExecId(exec.id)}</div>
                </div>

                {/* Col 3 — time */}
                <div className="wbh-time">
                    {isRunning ? (
                        <span style={{ color: 'var(--warning)' }}>started {timeLabel(exec.startedAt)}</span>
                    ) : (
                        <>
                            {timeLabel(exec.startedAt)}
                            <div className="wbh-time-sub">{dayLabel(exec.startedAt)}</div>
                        </>
                    )}
                </div>

                {/* Col 4 — middle (running pill + bar, OR waterfall) */}
                <div>
                    {isRunning ? (
                        <>
                            <div className="wbh-current-node">
                                <span className="status-dot status-dot--running" />
                                {exec.currentNode ? exec.currentNode : 'starting…'}
                            </div>
                            <div className="wbh-running-bar"><span /></div>
                            <div className="wbh-time-sub" style={{ marginTop: 6, fontFamily: 'var(--font-mono)' }}>
                                running for {formatSeconds(elapsedSec)}
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="wbh-waterfall">
                                {bars.length === 0 && (
                                    <span className="wbh-time-sub" style={{ marginTop: 0 }}>
                                        No node timing
                                    </span>
                                )}
                                {bars.map((b, j) => (
                                    <div
                                        key={j}
                                        className="wbh-waterfall-bar"
                                        style={{
                                            width: `${Math.max(b.seconds * 4, 24)}px`,
                                            background: b.color,
                                        }}
                                        title={`${b.label} · ${formatSeconds(b.seconds)}`}
                                    >
                                        {b.seconds >= 6 ? b.label : ''}
                                    </div>
                                ))}
                            </div>
                            {isFailed ? (
                                <div className="wbh-error-line" title={exec.error || ''}>
                                    <Icon name="alert-triangle" size={11} color="currentColor" /> {exec.error || 'Execution failed'}
                                </div>
                            ) : (
                                <div className="wbh-time-sub" style={{ marginTop: 4, fontFamily: 'var(--font-mono)' }}>
                                    total {formatSeconds(totalDuration)}
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* Col 5 — status */}
                <div className="wbh-status-block">
                    <span className={`status-dot status-dot--${statusToken(exec.status)}`} />
                    <div>
                        <div className="wbh-status-label" style={{
                            color: isRunning ? 'var(--warning)' : isFailed ? 'var(--error)' : 'var(--success)',
                        }}>{statusLabel(exec.status)}</div>
                        {isDone && totalMedia > 0 && (
                            <div className="wbh-status-sub">{totalMedia} {totalMedia === 1 ? 'asset' : 'assets'}</div>
                        )}
                        {isRunning && (
                            <div className="wbh-status-sub">
                                step {(exec.nodeExecutions || []).filter(n => n.status === 'completed').length + 1} of {(exec.nodeExecutions || []).length || '?'}
                            </div>
                        )}
                    </div>
                </div>

                {/* Col 6 — actions */}
                <div className="wbh-row-actions" onClick={(e) => e.stopPropagation()}>
                    {isRunning && exec.batchId && (
                        <button className="btn btn-ghost btn-sm btn-icon" title="Stop" onClick={onStop}>
                            <Icon name="x" size={12} />
                        </button>
                    )}
                    {isDone && exec.batchId && (
                        <button className="btn btn-ghost btn-sm btn-icon" title="Download" onClick={onDownload}>
                            <Icon name="download" size={12} />
                        </button>
                    )}
                    {isFailed && (
                        <button className="btn btn-ghost btn-sm btn-icon" title="Retry" onClick={onRetry}>
                            <Icon name="play" size={12} />
                        </button>
                    )}
                    <button className="btn btn-ghost btn-sm btn-icon" title="Delete" onClick={onDelete}>
                        <Icon name="trash" size={12} />
                    </button>
                    <button className="btn btn-ghost btn-sm btn-icon" title={expanded ? 'Collapse' : 'Expand'}>
                        <Icon name="chevron-down" size={12} style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }} />
                    </button>
                </div>
            </div>

            {/* Expanded section */}
            {expanded && (
                <div className="wbh-expanded">
                    {loadingDetail && (
                        <div style={{ padding: '8px 0', fontSize: 12, color: 'var(--ink-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div className="loading-spinner" style={{ width: 14, height: 14 }} />
                            Loading node details…
                        </div>
                    )}

                    {/* Media gallery */}
                    {isDone && totalMedia > 0 && (
                        <>
                            <div className="wbh-exp-head">
                                <h4>Output media · {totalMedia} {totalMedia === 1 ? 'item' : 'items'}</h4>
                                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-muted)' }}>
                                    {formatSeconds(totalDuration)} total · {(exec.nodeExecutions || []).length} nodes
                                </div>
                            </div>
                            <div className="wbh-thumbs">
                                {mediaItems.map((m, i) => (
                                    <div
                                        key={i}
                                        className="wbh-thumb"
                                        onClick={() => onOpenGallery(mediaItems, i)}
                                    >
                                        {m.url && m.type === 'image' && <img src={m.url} alt="" loading="lazy" />}
                                        {m.url && m.type === 'video' && (
                                            <>
                                                <img src={m.url} alt="" loading="lazy"
                                                    onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                                                <div style={{ position: 'absolute', inset: 0, background: 'rgba(42,37,32,0.2)' }} />
                                                <span className="play"><span className="play-circle"><Icon name="play" size={12} /></span></span>
                                            </>
                                        )}
                                        <span className="thumb-caption">
                                            {m.type === 'video' ? 'video' : 'frame'} · {String(i + 1).padStart(2, '0')}
                                        </span>
                                    </div>
                                ))}
                                {exec.batchId && (
                                    <button
                                        className="btn btn-ghost btn-sm"
                                        style={{ marginLeft: 'auto', alignSelf: 'flex-start' }}
                                        onClick={onDownload}
                                    >
                                        <Icon name="download" size={12} /> Download all
                                    </button>
                                )}
                            </div>
                        </>
                    )}

                    {/* Node waterfall list */}
                    {(exec.nodeExecutions || []).length > 0 && (
                        <>
                            <div className="wbh-exp-head">
                                <h4>Node waterfall</h4>
                            </div>
                            <div className="wbh-node-list">
                                {bars.map((b, i) => {
                                    const n = b.node;
                                    const nodeKey = `${exec.id}:${n.nodeId}`;
                                    const hasOutput = n.outputData && Object.keys(n.outputData).length > 0;
                                    const isNodeExp = expandedNode === nodeKey;
                                    return (
                                        <div key={n.id || i} style={{ display: 'flex', flexDirection: 'column' }}>
                                            <div className="wbh-node">
                                                <span className="wbh-node-icon" style={{ background: nodeColor(n.nodeType) }}>
                                                    <Icon name={nodeIconName(n.nodeType)} size={13} />
                                                </span>
                                                <div>
                                                    <div className="wbh-node-title">{(n.nodeType || '').replace(/-/g, ' ')}</div>
                                                    <div className="wbh-node-sub">{n.nodeId}{n.error ? ` · ${n.error}` : ''}</div>
                                                </div>
                                                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                                                    <span className={`status-dot status-dot--${statusToken(n.status)}`} />
                                                    {statusLabel(n.status).toLowerCase()}
                                                </div>
                                                <div className="wbh-node-duration">{formatSeconds(b.seconds)}</div>
                                                {hasOutput ? (
                                                    <button
                                                        className="btn btn-ghost btn-sm"
                                                        style={{ fontSize: 11, padding: '0 10px', height: 28 }}
                                                        onClick={() => onToggleNode(nodeKey)}
                                                    >
                                                        {isNodeExp ? 'Hide' : 'Inspect'}
                                                    </button>
                                                ) : <span />}
                                            </div>
                                            {isNodeExp && hasOutput && (
                                                <NodeOutputViewer output={n.outputData} />
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </div>
            )}
        </>
    );
}

// ─── Node Output Viewer ────────────────────────────────────────
function NodeOutputViewer({ output }) {
    if (!output) return null;

    const entries = Object.entries(output).filter(([k]) =>
        !['imageData', 'base64', 'encodedImage'].includes(k)
    );

    return (
        <div style={{
            margin: '0 0 8px 28px',
            padding: '10px 12px',
            background: 'var(--bg-primary)',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-primary)',
            fontSize: 12,
        }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                    {entries.map(([key, value]) => (
                        <tr key={key} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                            <td style={{
                                padding: '4px 8px 4px 0',
                                color: 'var(--accent)',
                                fontWeight: 500,
                                whiteSpace: 'nowrap',
                                verticalAlign: 'top',
                                width: 120,
                            }}>{key}</td>
                            <td style={{
                                padding: '4px 0',
                                color: 'var(--text-secondary)',
                                wordBreak: 'break-all',
                            }}>{formatValue(key, value)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function formatValue(key, value) {
    if (value === null || value === undefined) return <span style={{ color: 'var(--text-muted)' }}>null</span>;

    if (typeof value === 'string' && (value.startsWith('http') || value.startsWith('/'))) {
        const isMedia = /\.(jpg|jpeg|png|webp|gif|mp4|webm|mov)(\?|$)/i.test(value);
        const displayUrl = value.length > 80 ? value.substring(0, 80) + '...' : value;

        if (isMedia && !value.startsWith('http')) {
            return (
                <div>
                    <a href={`${SERVER}${value}`} target="_blank" rel="noreferrer"
                        style={{ color: '#60a5fa', textDecoration: 'none' }}>{displayUrl}</a>
                    {/\.(jpg|jpeg|png|webp|gif)/i.test(value) && (
                        <img src={`${SERVER}${value}`} alt="" loading="lazy" style={{
                            display: 'block', marginTop: 4,
                            maxWidth: 120, maxHeight: 80,
                            borderRadius: 4, border: '1px solid var(--border-primary)',
                        }} />
                    )}
                </div>
            );
        }

        return (
            <a href={value.startsWith('/') ? `${SERVER}${value}` : value}
                target="_blank" rel="noreferrer"
                style={{ color: '#60a5fa', textDecoration: 'none' }}>{displayUrl}</a>
        );
    }

    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        if (value.length <= 3 && value.every(v => typeof v === 'string' || typeof v === 'number')) {
            return `[${value.join(', ')}]`;
        }
        return (
            <details style={{ cursor: 'pointer' }}>
                <summary style={{ color: 'var(--text-muted)' }}>Array ({value.length} items)</summary>
                <pre style={{
                    margin: '4px 0', padding: 6,
                    background: 'rgba(0,0,0,0.2)', borderRadius: 4,
                    fontSize: 11, overflow: 'auto', maxHeight: 200,
                    color: 'var(--text-secondary)',
                }}>{JSON.stringify(value, null, 2)}</pre>
            </details>
        );
    }

    if (typeof value === 'object') {
        return (
            <details style={{ cursor: 'pointer' }}>
                <summary style={{ color: 'var(--text-muted)' }}>Object ({Object.keys(value).length} keys)</summary>
                <pre style={{
                    margin: '4px 0', padding: 6,
                    background: 'rgba(0,0,0,0.2)', borderRadius: 4,
                    fontSize: 11, overflow: 'auto', maxHeight: 200,
                    color: 'var(--text-secondary)',
                }}>{JSON.stringify(value, null, 2)}</pre>
            </details>
        );
    }

    if (typeof value === 'string' && value.length > 200) {
        return (
            <details style={{ cursor: 'pointer' }}>
                <summary style={{ color: 'var(--text-secondary)' }}>{value.substring(0, 200)}...</summary>
                <pre style={{
                    margin: '4px 0', padding: 6,
                    background: 'rgba(0,0,0,0.2)', borderRadius: 4,
                    fontSize: 11, overflow: 'auto', maxHeight: 200,
                    whiteSpace: 'pre-wrap', color: 'var(--text-secondary)',
                }}>{value}</pre>
            </details>
        );
    }

    if (typeof value === 'boolean') return <span style={{ color: value ? '#22c55e' : '#ef4444' }}>{String(value)}</span>;
    if (typeof value === 'number') return <span style={{ color: '#f59e0b' }}>{value.toLocaleString()}</span>;
    return String(value);
}

// ─── Gallery Lightbox ──────────────────────────────────────────
function GalleryLightbox({ items, initialIndex, onClose }) {
    const [index, setIndex] = useState(initialIndex);

    useEffect(() => {
        function handleKey(e) {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowLeft') setIndex(i => Math.max(0, i - 1));
            if (e.key === 'ArrowRight') setIndex(i => Math.min(items.length - 1, i + 1));
        }
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [items.length, onClose]);

    const current = items[index];
    if (!current) return null;

    return (
        <div
            onClick={onClose}
            style={{
                position: 'fixed', inset: 0, zIndex: 10000,
                background: 'rgba(0,0,0,0.92)',
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
            }}
        >
            <button onClick={onClose} style={{
                position: 'absolute', top: 16, right: 16,
                background: 'rgba(255,255,255,0.1)', border: 'none',
                color: '#fff', fontSize: 20, width: 40, height: 40,
                borderRadius: '50%', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>✕</button>

            <div style={{
                position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)',
                color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: 500,
            }}>
                {index + 1} / {items.length}
                <span style={{ marginLeft: 8, fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
                    {current.nodeType}
                </span>
            </div>

            {index > 0 && (
                <button
                    onClick={(e) => { e.stopPropagation(); setIndex(index - 1); }}
                    style={{
                        position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)',
                        background: 'rgba(255,255,255,0.1)', border: 'none',
                        color: '#fff', fontSize: 24, width: 48, height: 48,
                        borderRadius: '50%', cursor: 'pointer',
                    }}
                >‹</button>
            )}
            {index < items.length - 1 && (
                <button
                    onClick={(e) => { e.stopPropagation(); setIndex(index + 1); }}
                    style={{
                        position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)',
                        background: 'rgba(255,255,255,0.1)', border: 'none',
                        color: '#fff', fontSize: 24, width: 48, height: 48,
                        borderRadius: '50%', cursor: 'pointer',
                    }}
                >›</button>
            )}

            <div onClick={(e) => e.stopPropagation()} style={{
                maxWidth: '90vw', maxHeight: '80vh',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
                {current.type === 'video' ? (
                    <video key={current.url} src={current.url} controls autoPlay
                        style={{ maxWidth: '90vw', maxHeight: '80vh', borderRadius: 8 }}
                    />
                ) : (
                    <img key={current.url} src={current.url} alt=""
                        style={{ maxWidth: '90vw', maxHeight: '80vh', borderRadius: 8, objectFit: 'contain' }}
                    />
                )}
            </div>

            {items.length > 1 && (
                <div style={{
                    display: 'flex', gap: 6, marginTop: 16,
                    maxWidth: '90vw', overflow: 'auto', padding: '4px 0',
                }}>
                    {items.map((item, i) => (
                        <div
                            key={i}
                            onClick={(e) => { e.stopPropagation(); setIndex(i); }}
                            style={{
                                width: 56, height: 40, flexShrink: 0,
                                borderRadius: 4, overflow: 'hidden',
                                border: i === index ? '2px solid var(--accent)' : '2px solid transparent',
                                opacity: i === index ? 1 : 0.5,
                                cursor: 'pointer', transition: 'opacity 0.15s',
                            }}
                        >
                            {item.type === 'video' ? (
                                <div style={{
                                    width: '100%', height: '100%',
                                    background: '#111', display: 'flex',
                                    alignItems: 'center', justifyContent: 'center', fontSize: 16,
                                }}>▶</div>
                            ) : (
                                <img src={item.url} alt=""
                                    style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── Media Extraction (excluding file upload nodes) ────────────
function extractMediaFromExecution(exec) {
    const output = [];

    for (const ne of exec.nodeExecutions || []) {
        const data = ne.outputData;
        if (!data) continue;
        // Only include media from AI generator nodes
        if (!OUTPUT_NODE_TYPES.includes(ne.nodeType)) continue;

        if (data.imageUrl) {
            output.push({
                type: 'image',
                url: data.imageUrl.startsWith('http') ? data.imageUrl : `${SERVER}${data.imageUrl}`,
                nodeType: ne.nodeType,
            });
        }

        if (data.videoUrl) {
            output.push({
                type: 'video',
                url: data.videoUrl.startsWith('http') ? data.videoUrl : `${SERVER}${data.videoUrl}`,
                nodeType: ne.nodeType,
            });
        }

        if (data.fileUrl && !data.imageUrl && !data.videoUrl) {
            const ext = (data.fileName || data.fileUrl || '').split('.').pop()?.toLowerCase();
            const isVideo = ['mp4', 'webm', 'mov', 'avi'].includes(ext);
            const isImage = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext);
            if (isVideo || isImage) {
                output.push({
                    type: isVideo ? 'video' : 'image',
                    url: data.fileUrl.startsWith('http') ? data.fileUrl : `${SERVER}${data.fileUrl}`,
                    nodeType: ne.nodeType,
                });
            }
        }

        for (const arrKey of ['allImages', 'savedImages']) {
            if (Array.isArray(data[arrKey])) {
                for (const item of data[arrKey]) {
                    if (item.imageUrl) {
                        output.push({
                            type: 'image',
                            url: item.imageUrl.startsWith('http') ? item.imageUrl : `${SERVER}${item.imageUrl}`,
                            nodeType: ne.nodeType,
                        });
                    }
                }
            }
        }
    }

    const seen = new Set();
    const deduped = output.filter(m => {
        if (seen.has(m.url)) return false;
        seen.add(m.url);
        return true;
    });

    return { input: [], output: deduped };
}

// ─── Media Preview Thumbnail ───────────────────────────────────
function MediaPreview({ media, onClick }) {
    const [error, setError] = useState(false);

    if (error) {
        return (
            <div onClick={onClick} style={{
                width: '100%', height: 120,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)',
                fontSize: 24, border: '1px solid var(--border-primary)', cursor: 'pointer',
            }}><Icon name={media.type === 'video' ? 'clapperboard' : 'image'} size={24} color="var(--text-muted)" /></div>
        );
    }

    if (media.type === 'video') {
        return (
            <div style={{ position: 'relative', cursor: 'pointer' }} onClick={onClick}>
                <video src={media.url} preload="metadata" onError={() => setError(true)}
                    style={{
                        width: '100%', maxHeight: 200,
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border-primary)', background: '#000',
                    }}
                />
                <div style={{
                    position: 'absolute', inset: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(0,0,0,0.3)', borderRadius: 'var(--radius-sm)',
                }}><span style={{ fontSize: 32 }}>▶️</span></div>
                <span style={{
                    position: 'absolute', top: 4, left: 4,
                    fontSize: 9, padding: '1px 5px', borderRadius: 3,
                    background: 'rgba(0,0,0,0.7)', color: '#fff',
                }}><Icon name="clapperboard" size={9} style={{ marginRight: 2 }} /> {media.nodeType}</span>
            </div>
        );
    }

    return (
        <div style={{ position: 'relative', cursor: 'pointer' }} onClick={onClick}>
            <img src={media.url} alt="" loading="lazy" onError={() => setError(true)}
                style={{
                    width: '100%', height: 160, objectFit: 'cover',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-primary)',
                }}
            />
            <span style={{
                position: 'absolute', top: 4, left: 4,
                fontSize: 9, padding: '1px 5px', borderRadius: 3,
                background: 'rgba(0,0,0,0.7)', color: '#fff',
            }}><Icon name="image" size={9} style={{ marginRight: 2 }} /> {media.nodeType}</span>
        </div>
    );
}

// ─── Shared UI Components ──────────────────────────────────────
function StatusBadge({ status }) {
    const styles = {
        pending: { bg: 'rgba(156,163,175,0.15)', color: '#9ca3af', iconName: 'clock' },
        running: { bg: 'rgba(99,102,241,0.15)', color: '#818cf8', iconName: 'zap' },
        completed: { bg: 'rgba(34,197,94,0.15)', color: '#22c55e', iconName: 'check-circle' },
        failed: { bg: 'rgba(239,68,68,0.15)', color: '#ef4444', iconName: 'circle-x' },
        cancelled: { bg: 'rgba(234,179,8,0.15)', color: '#eab308', iconName: 'ban' },
        paused: { bg: 'rgba(234,179,8,0.15)', color: '#eab308', iconName: 'circle-pause' },
        partial: { bg: 'rgba(234,179,8,0.15)', color: '#eab308', iconName: 'circle-alert' },
    };
    const s = styles[status] || styles.pending;

    return (
        <span style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 4,
            background: s.bg, color: s.color, fontWeight: 500,
        }}><Icon name={s.iconName} size={11} style={{ marginRight: 4, verticalAlign: 'middle' }} /> {status}</span>
    );
}

function StatusIcon({ status }) {
    if (status === 'running') {
        return <Icon name="refresh" size={13} className="loading-spinner" style={{ color: 'var(--accent)' }} />;
    }
    const iconNames = { pending: 'clock', completed: 'check-circle', failed: 'circle-x', skipped: 'skip-forward' };
    const name = iconNames[status] || 'clock';
    const colors = { completed: '#22c55e', failed: '#ef4444', skipped: '#eab308' };
    return <Icon name={name} size={13} color={colors[status] || 'var(--text-muted)'} />;
}

function DurationTimer({ startedAt, completedAt }) {
    const [elapsed, setElapsed] = useState(0);

    useEffect(() => {
        if (completedAt) {
            setElapsed(Math.round((new Date(completedAt) - new Date(startedAt)) / 1000));
            return;
        }
        const interval = setInterval(() => {
            setElapsed(Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
        }, 1000);
        return () => clearInterval(interval);
    }, [startedAt, completedAt]);

    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;

    return (
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
            {mins > 0 ? `${mins}m ` : ''}{secs}s
        </span>
    );
}
