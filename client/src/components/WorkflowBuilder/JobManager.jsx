import { useState, useEffect, useCallback } from 'react';
import { api } from '../../services/api.js';
import Icon from '../../services/icons.jsx';
import toast from 'react-hot-toast';

const SERVER = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i;
const VIDEO_EXT = /\.(mp4|webm|mov|avi|mkv)(\?|$)/i;
const CSV_EXT = /\.(csv|tsv|txt|json|md|yaml|yml)(\?|$)/i;

function classifyPath(p) {
    if (!p) return 'empty';
    if (IMAGE_EXT.test(p)) return 'image';
    if (VIDEO_EXT.test(p)) return 'video';
    if (CSV_EXT.test(p)) return 'csv';
    return 'image'; // sensible default for unknown extensions
}

function shortJobId(idx) {
    return `job-${String(1000 + idx).padStart(4, '0')}`;
}

function JobThumb({ paths }) {
    const count = (paths || []).length;
    if (count === 0) {
        return (
            <div className="job-thumb kind-empty" title="No inputs">
                empty
            </div>
        );
    }
    const first = paths[0];
    const url = first.startsWith('http') ? first : `${SERVER}${first}`;
    const kind = classifyPath(first);
    return (
        <div className={`job-thumb kind-${kind}`} title={first.split('/').pop()}>
            {kind === 'image' && <img src={url} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
            {kind === 'video' && (
                <span className="play-circle"><Icon name="play" size={10} /></span>
            )}
            {kind === 'csv' && (
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 15, color: 'var(--ink)' }}>{'{ }'}</span>
            )}
            {count > 1 && <span className="count-badge">+{count - 1}</span>}
        </div>
    );
}

export default function JobManager({ workflowId, onRunBatch }) {
    const [jobs, setJobs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedJob, setSelectedJob] = useState(null);
    const [selectedJobIds, setSelectedJobIds] = useState(new Set());
    const [mode, setMode] = useState('parallel');
    const [concurrency, setConcurrency] = useState(3);
    const [uploading, setUploading] = useState(false);

    useEffect(() => {
        loadJobs();
    }, [workflowId]);

    async function loadJobs() {
        try {
            const data = await api.getJobs(workflowId);
            setJobs(data.jobs);
            // Auto-select all jobs
            setSelectedJobIds(new Set(data.jobs.map(j => j.id)));
        } catch (err) {
            toast.error('Failed to load jobs');
        }
        setLoading(false);
    }

    async function createJob() {
        try {
            const data = await api.createJob(workflowId, {
                name: `Job ${jobs.length + 1}`,
                inputData: { filePaths: [] },
            });
            setJobs(prev => [...prev, data.job]);
            setSelectedJob(data.job);
            setSelectedJobIds(prev => new Set([...prev, data.job.id]));
            toast.success('Job created');
        } catch (err) {
            toast.error(err.message);
        }
    }

    async function deleteJob(jobId) {
        try {
            await api.deleteJob(jobId);
            setJobs(prev => prev.filter(j => j.id !== jobId));
            if (selectedJob?.id === jobId) setSelectedJob(null);
            setSelectedJobIds(prev => {
                const next = new Set(prev);
                next.delete(jobId);
                return next;
            });
            toast.success('Job deleted');
        } catch (err) {
            toast.error(err.message);
        }
    }

    async function duplicateJob(jobId) {
        try {
            const data = await api.duplicateJob(jobId);
            setJobs(prev => [...prev, data.job]);
            setSelectedJobIds(prev => new Set([...prev, data.job.id]));
            toast.success('Job duplicated');
        } catch (err) {
            toast.error(err.message);
        }
    }

    async function updateJobName(jobId, name) {
        try {
            await api.updateJob(jobId, { name });
            setJobs(prev => prev.map(j => j.id === jobId ? { ...j, name } : j));
            if (selectedJob?.id === jobId) {
                setSelectedJob(prev => ({ ...prev, name }));
            }
        } catch (err) {
            toast.error(err.message);
        }
    }

    async function uploadImages(jobId, files) {
        if (!files || files.length === 0) return;
        setUploading(true);
        try {
            const formData = new FormData();
            for (const file of files) {
                formData.append('files', file);
            }

            const token = localStorage.getItem('vcw_token');
            const res = await fetch(`${SERVER}/api/upload/batch`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData,
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Upload failed');
            }

            const data = await res.json();
            const newPaths = data.files.map(f => f.fileUrl);

            // Get existing paths for this job
            const job = jobs.find(j => j.id === jobId);
            const existingPaths = job?.inputData?.filePaths || [];
            const allPaths = [...existingPaths, ...newPaths];

            // Update job
            await api.updateJob(jobId, { inputData: { filePaths: allPaths } });
            setJobs(prev => prev.map(j =>
                j.id === jobId ? { ...j, inputData: { ...j.inputData, filePaths: allPaths } } : j
            ));
            if (selectedJob?.id === jobId) {
                setSelectedJob(prev => ({
                    ...prev,
                    inputData: { ...prev.inputData, filePaths: allPaths },
                }));
            }
            toast.success(`Uploaded ${newPaths.length} image(s)`);
        } catch (err) {
            toast.error(`Upload failed: ${err.message}`);
        }
        setUploading(false);
    }

    async function removeImage(jobId, index) {
        const job = jobs.find(j => j.id === jobId);
        const paths = [...(job?.inputData?.filePaths || [])];
        paths.splice(index, 1);

        try {
            await api.updateJob(jobId, { inputData: { filePaths: paths } });
            setJobs(prev => prev.map(j =>
                j.id === jobId ? { ...j, inputData: { ...j.inputData, filePaths: paths } } : j
            ));
            if (selectedJob?.id === jobId) {
                setSelectedJob(prev => ({
                    ...prev,
                    inputData: { ...prev.inputData, filePaths: paths },
                }));
            }
        } catch (err) {
            toast.error(err.message);
        }
    }

    function toggleJobSelection(jobId) {
        setSelectedJobIds(prev => {
            const next = new Set(prev);
            if (next.has(jobId)) next.delete(jobId);
            else next.add(jobId);
            return next;
        });
    }

    function selectAll() {
        setSelectedJobIds(new Set(jobs.map(j => j.id)));
    }

    function deselectAll() {
        setSelectedJobIds(new Set());
    }

    function handleRun() {
        const ids = [...selectedJobIds];
        if (ids.length === 0) {
            toast.error('Select at least one job to run');
            return;
        }
        onRunBatch(ids, mode, concurrency);
    }

    // Clipboard paste handler
    useEffect(() => {
        function handlePaste(e) {
            if (!selectedJob) return;
            const items = e.clipboardData?.items;
            if (!items) return;
            const imageFiles = [];
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    const file = item.getAsFile();
                    if (file) imageFiles.push(file);
                }
            }
            if (imageFiles.length > 0) {
                e.preventDefault();
                uploadImages(selectedJob.id, imageFiles);
            }
        }
        document.addEventListener('paste', handlePaste);
        return () => document.removeEventListener('paste', handlePaste);
    }, [selectedJob, jobs]);

    if (loading) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
                <div className="loading-spinner" />
            </div>
        );
    }

    const selectedCount = selectedJobIds.size;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Job List + Editor */}
            <div className="job-manager-layout" style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                {/* Job List (left) */}
                <div className="job-list-panel" style={{
                    width: 320,
                    borderRight: '1px solid var(--border-primary)',
                    display: 'flex',
                    flexDirection: 'column',
                    background: 'var(--bg-primary)',
                }}>
                    <div style={{
                        padding: '12px 16px',
                        borderBottom: '1px solid var(--border-primary)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                    }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                            <Icon name="list-ordered" size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Jobs ({jobs.length})
                        </span>
                        <div style={{ display: 'flex', gap: 6 }}>
                            <button className="btn btn-sm" onClick={selectAll} title="Select All"
                                style={{ fontSize: 11, padding: '2px 8px' }}>All</button>
                            <button className="btn btn-sm" onClick={deselectAll} title="Deselect All"
                                style={{ fontSize: 11, padding: '2px 8px' }}>None</button>
                            <button className="btn btn-sm btn-primary" onClick={createJob}
                                style={{ fontSize: 11, padding: '2px 8px' }}>+ Add</button>
                        </div>
                    </div>

                    <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
                        {jobs.length === 0 ? (
                            <div style={{
                                textAlign: 'center',
                                padding: '40px 20px',
                                color: 'var(--text-muted)',
                                fontSize: 13,
                            }}>
                                <div style={{ fontSize: 32, marginBottom: 12 }}><Icon name="package" size={32} color="var(--text-muted)" /></div>
                                No jobs yet. Click <strong>+ Add</strong> to create one.
                            </div>
                        ) : (
                            jobs.map((job, idx) => {
                                const paths = job.inputData?.filePaths || [];
                                const isSelected = selectedJob?.id === job.id;
                                const isChecked = selectedJobIds.has(job.id);

                                return (
                                    <div
                                        key={job.id}
                                        onClick={() => setSelectedJob(job)}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 12,
                                            padding: '10px 12px',
                                            borderRadius: 'var(--r-md)',
                                            cursor: 'pointer',
                                            marginBottom: 4,
                                            background: isSelected ? 'var(--paper)' : 'transparent',
                                            border: isSelected ? '1px solid var(--ink-faint)' : '1px solid transparent',
                                            boxShadow: isSelected ? 'var(--sh-sm)' : 'none',
                                            transition: 'background-color 150ms, border-color 150ms, box-shadow 150ms',
                                        }}
                                    >
                                        {/* Checkbox */}
                                        <input
                                            type="checkbox"
                                            checked={isChecked}
                                            onChange={(e) => {
                                                e.stopPropagation();
                                                toggleJobSelection(job.id);
                                            }}
                                            style={{ cursor: 'pointer', accentColor: 'var(--peach)', flexShrink: 0 }}
                                        />

                                        {/* Thumb cell */}
                                        <div className="job-thumb-cell">
                                            <JobThumb paths={paths} />
                                        </div>

                                        {/* Info */}
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{
                                                fontFamily: 'var(--font-serif)',
                                                fontStyle: 'italic',
                                                fontSize: 17,
                                                fontWeight: 400,
                                                letterSpacing: '-0.005em',
                                                color: 'var(--ink)',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                            }}>{job.name}</div>
                                            <div style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: 8,
                                                marginTop: 4,
                                            }}>
                                                <span className="job-id-chip">{shortJobId(idx)}</span>
                                                <span style={{
                                                    fontFamily: 'var(--font-mono)',
                                                    fontSize: 10.5,
                                                    color: 'var(--ink-muted)',
                                                    letterSpacing: '0.04em',
                                                    textTransform: 'uppercase',
                                                }}>
                                                    {paths.length} {paths.length === 1 ? 'INPUT' : 'INPUTS'}
                                                </span>
                                            </div>
                                        </div>

                                        {/* Actions */}
                                        <div style={{ display: 'flex', gap: 2 }} onClick={(e) => e.stopPropagation()}>
                                            <button className="btn btn-ghost btn-sm btn-icon"
                                                onClick={() => duplicateJob(job.id)}
                                                title="Duplicate"><Icon name="copy" size={12} /></button>
                                            <button className="btn btn-ghost btn-sm btn-icon"
                                                onClick={() => deleteJob(job.id)}
                                                title="Delete"><Icon name="trash" size={12} /></button>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>

                {/* Job Editor (right) */}
                <div className="job-editor-panel" style={{ flex: 1, overflow: 'auto', padding: 20, background: 'var(--bg-secondary)' }}>
                    {!selectedJob ? (
                        <div style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            height: '100%',
                            color: 'var(--text-muted)',
                        }}>
                            <div style={{ fontSize: 48, marginBottom: 12 }}><Icon name="arrow-left" size={48} color="var(--text-muted)" /></div>
                            <div style={{ fontSize: 14 }}>Select a job to configure</div>
                        </div>
                    ) : (
                        <div style={{ maxWidth: 600 }}>
                            <h3 style={{ margin: '0 0 16px', color: 'var(--text-primary)', fontSize: 16 }}>
                                <Icon name="pencil" size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} /> Edit Job
                            </h3>

                            {/* Job Name */}
                            <div className="form-group" style={{ marginBottom: 20 }}>
                                <label className="form-label">Job Name</label>
                                <input
                                    className="input"
                                    type="text"
                                    value={selectedJob.name}
                                    onChange={(e) => {
                                        const name = e.target.value;
                                        setSelectedJob(prev => ({ ...prev, name }));
                                    }}
                                    onBlur={(e) => updateJobName(selectedJob.id, e.target.value)}
                                />
                            </div>

                            {/* Image Upload Zone */}
                            <div className="form-group">
                                <label className="form-label">Input Images</label>
                                <div
                                    style={{
                                        border: '2px dashed var(--border-primary)',
                                        borderRadius: 'var(--radius-md)',
                                        padding: '24px 16px',
                                        textAlign: 'center',
                                        cursor: uploading ? 'wait' : 'pointer',
                                        background: 'var(--bg-primary)',
                                        transition: 'border-color 0.2s, background 0.2s',
                                    }}
                                    onClick={() => {
                                        if (!uploading) {
                                            const input = document.createElement('input');
                                            input.type = 'file';
                                            input.accept = 'image/*';
                                            input.multiple = true;
                                            input.onchange = (e) => {
                                                if (e.target.files.length > 0) uploadImages(selectedJob.id, e.target.files);
                                            };
                                            input.click();
                                        }
                                    }}
                                    onDragOver={(e) => {
                                        e.preventDefault();
                                        e.currentTarget.style.borderColor = 'var(--accent)';
                                        e.currentTarget.style.background = 'rgba(99,102,241,0.05)';
                                    }}
                                    onDragLeave={(e) => {
                                        e.currentTarget.style.borderColor = 'var(--border-primary)';
                                        e.currentTarget.style.background = 'var(--bg-primary)';
                                    }}
                                    onDrop={(e) => {
                                        e.preventDefault();
                                        e.currentTarget.style.borderColor = 'var(--border-primary)';
                                        e.currentTarget.style.background = 'var(--bg-primary)';
                                        if (e.dataTransfer.files.length > 0) uploadImages(selectedJob.id, e.dataTransfer.files);
                                    }}
                                >
                                    {uploading ? (
                                        <div>
                                            <span className="loading-spinner" style={{ width: 24, height: 24, margin: '0 auto 8px' }} />
                                            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Uploading...</div>
                                        </div>
                                    ) : (
                                        <div>
                                            <div style={{ fontSize: 28, marginBottom: 6 }}><Icon name="folder-open" size={28} color="var(--text-muted)" /></div>
                                            <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>
                                                Click to browse or drag & drop
                                            </div>
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                                                Multiple images · Drag & drop · Ctrl+V to paste
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Image Grid Preview */}
                                {(selectedJob.inputData?.filePaths || []).length > 0 && (
                                    <div style={{ marginTop: 12 }}>
                                        <div style={{
                                            display: 'grid',
                                            gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))',
                                            gap: 8,
                                        }}>
                                            {(selectedJob.inputData?.filePaths || []).map((path, idx) => (
                                                <div key={idx} style={{ position: 'relative' }}>
                                                    <img
                                                        src={`${SERVER}${path}`}
                                                        alt={`Image ${idx + 1}`}
                                                        style={{
                                                            width: '100%',
                                                            height: 90,
                                                            objectFit: 'cover',
                                                            borderRadius: 'var(--radius-sm)',
                                                            border: '1px solid var(--border-primary)',
                                                        }}
                                                    />
                                                    <button
                                                        className="btn btn-sm"
                                                        onClick={() => removeImage(selectedJob.id, idx)}
                                                        style={{
                                                            position: 'absolute',
                                                            top: 3,
                                                            right: 3,
                                                            padding: '0 4px',
                                                            fontSize: 10,
                                                            lineHeight: '18px',
                                                            background: 'rgba(0,0,0,0.7)',
                                                            color: '#fff',
                                                            borderRadius: 3,
                                                            minWidth: 'unset',
                                                        }}
                                                    >✕</button>
                                                </div>
                                            ))}
                                        </div>
                                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                                            <Icon name="paperclip" size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} /> {(selectedJob.inputData?.filePaths || []).length} image(s) attached
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Run Controls (bottom bar) */}
            <div className="job-run-bar" style={{
                padding: '12px 20px',
                borderTop: '2px solid var(--border-primary)',
                background: 'var(--bg-tertiary)',
                display: 'flex',
                alignItems: 'center',
                gap: 16,
            }}>
                {/* Mode Toggle */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Mode:</span>
                    <button
                        className={`btn btn-sm ${mode === 'parallel' ? 'btn-primary' : ''}`}
                        onClick={() => setMode('parallel')}
                        style={{ fontSize: 12, padding: '4px 10px' }}
                    ><Icon name="zap" size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Parallel</button>
                    <button
                        className={`btn btn-sm ${mode === 'sequential' ? 'btn-primary' : ''}`}
                        onClick={() => setMode('sequential')}
                        style={{ fontSize: 12, padding: '4px 10px' }}
                    ><Icon name="list-ordered" size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Sequential</button>
                </div>

                {/* Concurrency (only for parallel) */}
                {mode === 'parallel' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Concurrency:</span>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>1</span>
                        <input
                            className="input"
                            type="range"
                            min="1" max="10"
                            value={concurrency}
                            onChange={(e) => setConcurrency(parseInt(e.target.value))}
                            style={{ width: 80, accentColor: 'var(--accent)' }}
                        />
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>10</span>
                        <span style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, minWidth: 20 }}>
                            {concurrency}
                        </span>
                    </div>
                )}

                <div style={{ flex: 1 }} />

                {/* Job count */}
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {selectedCount}/{jobs.length} selected
                </span>

                {/* Run buttons */}
                <button
                    className="btn btn-primary"
                    onClick={handleRun}
                    disabled={selectedCount === 0}
                    style={{ fontSize: 13, padding: '6px 16px' }}
                >
                    <Icon name="play" size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Run {selectedCount > 0 ? `${selectedCount} Job${selectedCount > 1 ? 's' : ''}` : 'Jobs'}
                </button>
            </div>
        </div>
    );
}
