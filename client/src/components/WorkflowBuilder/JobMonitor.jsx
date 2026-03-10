import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../../services/api.js';
import { onJobUpdate, onExecutionUpdate } from '../../services/socket.js';
import toast from 'react-hot-toast';

const SERVER = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';
// Only these node types produce output media for display
const OUTPUT_NODE_TYPES = ['google-flow-image', 'google-flow-video'];

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
                    const emoji = data.status === 'completed' ? '🎉' : data.status === 'partial' ? '⚠️' : '❌';
                    toast(`${emoji} Batch ${data.status}: ${data.completedJobs}/${data.totalJobs} completed`, { duration: 5000 });
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
                <div style={{ fontSize: 48, marginBottom: 12 }}>📂</div>
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
            background: 'var(--bg-primary)',
        }}>
            {/* Header */}
            <div style={{
                padding: '10px 20px',
                borderBottom: '1px solid var(--border-primary)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                background: 'var(--bg-tertiary)',
            }}>
                <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
                    📜 Job History
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {executions.length} execution{executions.length !== 1 ? 's' : ''}
                </span>
                {runningCount > 0 && (
                    <span style={{
                        fontSize: 11, padding: '2px 8px', borderRadius: 4,
                        background: 'rgba(99,102,241,0.15)', color: '#818cf8', fontWeight: 500,
                    }}>⚡ {runningCount} running</span>
                )}
                <div style={{ flex: 1 }} />
                <button className="btn btn-sm" onClick={loadHistory}
                    style={{ fontSize: 11, padding: '4px 10px' }}>🔄 Refresh</button>
            </div>

            {/* Job Cards */}
            <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {executions.map((exec) => {
                        const isExpanded = expandedJob === exec.id;
                        // Use server-provided media items (lightweight, no outputData parsing)
                        const outputMedia = (exec.mediaItems || []).map(m => ({
                            ...m,
                            url: m.url.startsWith('http') ? m.url : `${SERVER}${m.url}`,
                        }));
                        const totalMedia = outputMedia.length;

                        const sortedNodes = [...(exec.nodeExecutions || [])].sort((a, b) => {
                            if (!a.startedAt) return 1;
                            if (!b.startedAt) return -1;
                            return new Date(a.startedAt) - new Date(b.startedAt);
                        });

                        return (
                            <div key={exec.id} style={{
                                border: '1px solid var(--border-primary)',
                                borderRadius: 'var(--radius-md)',
                                background: 'var(--bg-secondary)',
                                overflow: 'hidden',
                            }}>
                                {/* Job Card Header */}
                                <div
                                    onClick={() => toggleExpand(exec.id)}
                                    style={{
                                        padding: '12px 16px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 10,
                                        cursor: 'pointer',
                                    }}
                                >
                                    {/* Thumbnail */}
                                    {outputMedia.length > 0 ? (
                                        outputMedia[0].type === 'video' ? (
                                            <div style={{
                                                width: 56, height: 56, borderRadius: 6,
                                                background: '#111', flexShrink: 0,
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                fontSize: 22, border: '1px solid var(--border-primary)',
                                            }}>🎬</div>
                                        ) : (
                                            <img src={outputMedia[0].url} alt="" loading="lazy" style={{
                                                width: 56, height: 56, borderRadius: 6,
                                                objectFit: 'cover', flexShrink: 0,
                                                border: '1px solid var(--border-primary)',
                                            }} />
                                        )
                                    ) : (
                                        <div style={{
                                            width: 56, height: 56, borderRadius: 6,
                                            background: 'var(--bg-tertiary)', flexShrink: 0,
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            fontSize: 20, border: '1px solid var(--border-primary)',
                                            color: 'var(--text-muted)',
                                        }}>{exec.status === 'running' ? '⚡' : '📄'}</div>
                                    )}

                                    <StatusBadge status={exec.status} />

                                    <span style={{
                                        fontSize: 13, fontWeight: 500,
                                        color: 'var(--text-primary)',
                                    }}>{exec.jobName}</span>

                                    {exec.status === 'running' && exec.currentNode && (
                                        <span style={{
                                            fontSize: 11, color: 'var(--accent)',
                                            background: 'rgba(99,102,241,0.1)',
                                            padding: '2px 8px', borderRadius: 4,
                                        }}>🔄 {exec.currentNode}</span>
                                    )}

                                    <div style={{ flex: 1 }} />

                                    {exec.startedAt && (
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                            {new Date(exec.startedAt).toLocaleString()}
                                        </span>
                                    )}

                                    {exec.startedAt && (
                                        <DurationTimer startedAt={exec.startedAt} completedAt={exec.completedAt} />
                                    )}

                                    {totalMedia > 0 && (
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                            📎 {totalMedia}
                                        </span>
                                    )}

                                    {exec.error && (
                                        <span style={{
                                            fontSize: 11, color: '#ef4444',
                                            maxWidth: 200, overflow: 'hidden',
                                            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                        }} title={exec.error}>{exec.error}</span>
                                    )}

                                    {exec.status === 'running' && exec.batchId && (
                                        <button
                                            onClick={(e) => { e.stopPropagation(); stopBatch(exec.batchId); }}
                                            title="Stop"
                                            className="btn btn-sm"
                                            style={{
                                                fontSize: 11, padding: '2px 8px',
                                                background: 'rgba(239,68,68,0.15)', color: '#ef4444',
                                                border: '1px solid rgba(239,68,68,0.3)',
                                            }}
                                        >⏹ Stop</button>
                                    )}

                                    <button
                                        onClick={(e) => { e.stopPropagation(); setConfirmDelete(exec.id); }}
                                        title="Delete"
                                        style={{
                                            background: 'none', border: 'none',
                                            color: 'var(--text-muted)', cursor: 'pointer',
                                            fontSize: 13, padding: '2px 4px',
                                            opacity: 0.5, transition: 'opacity 0.15s',
                                        }}
                                        onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
                                        onMouseLeave={(e) => e.currentTarget.style.opacity = '0.5'}
                                    >🗑️</button>

                                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                        {isExpanded ? '▼' : '▶'}
                                    </span>
                                </div>

                                {/* Expanded detail */}
                                {isExpanded && (
                                    <div style={{ borderTop: '1px solid var(--border-primary)' }}>

                                        {/* Output Media */}
                                        {outputMedia.length > 0 && (
                                            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-primary)' }}>
                                                <div style={{
                                                    display: 'flex', alignItems: 'center',
                                                    justifyContent: 'space-between', marginBottom: 10,
                                                }}>
                                                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                                                        📤 Output Media ({outputMedia.length})
                                                    </span>
                                                    {exec.batchId && (
                                                        <button
                                                            className="btn btn-sm"
                                                            onClick={(e) => { e.stopPropagation(); downloadJob(exec.batchId, exec.id); }}
                                                            style={{ fontSize: 11, padding: '2px 8px' }}
                                                        >📥 Download</button>
                                                    )}
                                                </div>
                                                <div style={{
                                                    display: 'grid',
                                                    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                                                    gap: 10,
                                                }}>
                                                    {outputMedia.map((media, mi) => (
                                                        <MediaPreview
                                                            key={mi}
                                                            media={media}
                                                            onClick={() => openGallery(outputMedia, mi)}
                                                        />
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {/* Node Pipeline */}
                                        <div style={{ padding: '0 16px 12px' }}>
                                            <div style={{
                                                fontSize: 12, fontWeight: 600,
                                                color: 'var(--text-muted)',
                                                padding: '10px 0 6px',
                                                textTransform: 'uppercase',
                                                letterSpacing: '0.05em',
                                            }}>Node Pipeline</div>

                                            {loadingDetail === exec.id ? (
                                                <div style={{ padding: '12px 0', fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
                                                    <div className="loading-spinner" style={{ width: 16, height: 16 }} />
                                                    Loading node details...
                                                </div>
                                            ) : sortedNodes.length === 0 ? (
                                                <div style={{ padding: '12px 0', fontSize: 12, color: 'var(--text-muted)' }}>
                                                    No node data yet...
                                                </div>
                                            ) : (
                                                <div>
                                                    {sortedNodes.map((ne, i) => {
                                                        const nodeKey = `${exec.id}:${ne.nodeId}`;
                                                        const isNodeExpanded = expandedNode === nodeKey;
                                                        const hasOutput = ne.outputData && Object.keys(ne.outputData).length > 0;

                                                        return (
                                                            <div key={ne.id || i} style={{
                                                                borderBottom: i < sortedNodes.length - 1
                                                                    ? '1px solid rgba(255,255,255,0.05)' : 'none',
                                                            }}>
                                                                <div
                                                                    onClick={() => setExpandedNode(isNodeExpanded ? null : nodeKey)}
                                                                    style={{
                                                                        display: 'flex', alignItems: 'center',
                                                                        gap: 8, padding: '8px 0', fontSize: 12,
                                                                        cursor: hasOutput ? 'pointer' : 'default',
                                                                    }}
                                                                >
                                                                    <span style={{
                                                                        fontSize: 10, fontWeight: 600,
                                                                        color: 'var(--text-muted)',
                                                                        minWidth: 20, textAlign: 'center',
                                                                    }}>{i + 1}</span>

                                                                    <StatusIcon status={ne.status} />

                                                                    <span style={{
                                                                        color: 'var(--text-secondary)',
                                                                        fontWeight: 500, minWidth: 100,
                                                                    }}>{ne.nodeType}</span>

                                                                    <span style={{
                                                                        color: 'var(--text-muted)', flex: 1,
                                                                        fontSize: 11,
                                                                    }}>{ne.nodeId}</span>

                                                                    {ne.error && (
                                                                        <span style={{ color: '#ef4444', fontSize: 11 }}>
                                                                            {ne.error}
                                                                        </span>
                                                                    )}

                                                                    {hasOutput && (
                                                                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                                                                            {isNodeExpanded ? '▼' : '▶'}
                                                                        </span>
                                                                    )}
                                                                </div>

                                                                {isNodeExpanded && hasOutput && (
                                                                    <NodeOutputViewer output={ne.outputData} />
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>

                {/* Load More Button */}
                {hasMore && (
                    <div style={{ textAlign: 'center', padding: '12px 0' }}>
                        <button
                            className="btn btn-sm"
                            onClick={() => loadHistory(true)}
                            disabled={loadingMore}
                            style={{
                                padding: '8px 24px', fontSize: 13,
                                background: 'var(--bg-tertiary)',
                                border: '1px solid var(--border-primary)',
                                opacity: loadingMore ? 0.6 : 1,
                            }}
                        >
                            {loadingMore ? '⏳ Loading...' : `📜 Load More (${executions.length}/${totalCount})`}
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
                        <div style={{ fontSize: 32, marginBottom: 12 }}>🗑️</div>
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
                                }}>🎬</div>
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
            }}>{media.type === 'video' ? '🎬' : '🖼️'}</div>
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
                }}>🎬 {media.nodeType}</span>
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
            }}>🖼️ {media.nodeType}</span>
        </div>
    );
}

// ─── Shared UI Components ──────────────────────────────────────
function StatusBadge({ status }) {
    const styles = {
        pending: { bg: 'rgba(156,163,175,0.15)', color: '#9ca3af', icon: '⏳' },
        running: { bg: 'rgba(99,102,241,0.15)', color: '#818cf8', icon: '⚡' },
        completed: { bg: 'rgba(34,197,94,0.15)', color: '#22c55e', icon: '✅' },
        failed: { bg: 'rgba(239,68,68,0.15)', color: '#ef4444', icon: '❌' },
        cancelled: { bg: 'rgba(234,179,8,0.15)', color: '#eab308', icon: '⛔' },
        paused: { bg: 'rgba(234,179,8,0.15)', color: '#eab308', icon: '⏸️' },
        partial: { bg: 'rgba(234,179,8,0.15)', color: '#eab308', icon: '⚠️' },
    };
    const s = styles[status] || styles.pending;

    return (
        <span style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 4,
            background: s.bg, color: s.color, fontWeight: 500,
        }}>{s.icon} {status}</span>
    );
}

function StatusIcon({ status }) {
    if (status === 'running') {
        return (
            <span style={{
                fontSize: 13,
                display: 'inline-block',
                animation: 'spin 1s linear infinite',
            }}>
                🔄
                <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
            </span>
        );
    }
    const icons = { pending: '⏳', completed: '✅', failed: '❌', skipped: '⏭️' };
    return <span style={{ fontSize: 13 }}>{icons[status] || '⏳'}</span>;
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
