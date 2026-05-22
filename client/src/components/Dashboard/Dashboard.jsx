import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api.js';
import Icon from '../../services/icons.jsx';
import ConfirmModal from '../Shared/ConfirmModal.jsx';
import { SkeletonCard } from '../Shared/SkeletonLoader.jsx';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut.js';
import toast from 'react-hot-toast';

const FILTERS = ['All', 'Recent', 'Starred', 'Archived'];

function greetingFor(date = new Date()) {
    const h = date.getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
}

function weekdayLabel(date = new Date()) {
    return date.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
}

function formatDuration(seconds) {
    if (!seconds) return '—';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    return `${(seconds / 60).toFixed(1)}m`;
}

export default function Dashboard() {
    const [me, setMe] = useState(null);
    const [workflows, setWorkflows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState(null);
    const [newName, setNewName] = useState('');
    const [filter, setFilter] = useState('All');
    const [search, setSearch] = useState('');
    const navigate = useNavigate();

    useEffect(() => {
        loadWorkflows();
        api.getMe().then((data) => setMe(data.user)).catch(() => { });
    }, []);

    // CommandPalette can fire this event to open the create-workflow modal
    useEffect(() => {
        function onCreate() { setShowCreateModal(true); }
        window.addEventListener('vcw:create-workflow', onCreate);
        return () => window.removeEventListener('vcw:create-workflow', onCreate);
    }, []);

    // Press N anywhere on the Dashboard to start a new flow
    useKeyboardShortcut('n', () => setShowCreateModal(true));

    async function loadWorkflows() {
        try {
            const data = await api.getWorkflows();
            setWorkflows(data.workflows);
        } catch (err) {
            toast.error('Failed to load workflows');
        }
        setLoading(false);
    }

    async function createWorkflow() {
        if (!newName.trim()) return;
        try {
            const data = await api.createWorkflow({
                name: newName.trim(),
                description: '',
                nodesData: [],
                edgesData: [],
            });
            toast.success('Workflow created!');
            setShowCreateModal(false);
            setNewName('');
            navigate(`/workflow/${data.workflow.id}`);
        } catch (err) {
            toast.error(err.message);
        }
    }

    async function deleteWorkflow(e, id) {
        e.stopPropagation();
        setDeleteTarget(id);
    }

    async function confirmDelete() {
        if (!deleteTarget) return;
        try {
            await api.deleteWorkflow(deleteTarget);
            setWorkflows((w) => w.filter((wf) => wf.id !== deleteTarget));
            toast.success('Workflow deleted');
        } catch (err) {
            toast.error(err.message);
        }
        setDeleteTarget(null);
    }

    async function duplicateWorkflow(e, id) {
        e.stopPropagation();
        try {
            const data = await api.duplicateWorkflow(id);
            setWorkflows((w) => [data.workflow, ...w]);
            toast.success('Workflow duplicated');
        } catch (err) {
            toast.error(err.message);
        }
    }

    function formatDate(dateStr) {
        return new Date(dateStr).toLocaleDateString('vi-VN', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    const stats = useMemo(() => {
        const totalRuns = workflows.reduce((sum, wf) => sum + (wf._count?.executions || 0), 0);
        return {
            total: workflows.length,
            runs: totalRuns,
            avgDuration: formatDuration(0), // placeholder until backend supplies it
            credits: '—',
        };
    }, [workflows]);

    const visibleWorkflows = useMemo(() => {
        let list = workflows;
        if (filter === 'Recent') {
            const recentCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
            list = list.filter((wf) => new Date(wf.updatedAt).getTime() > recentCutoff);
        }
        // 'Starred' / 'Archived' filters are no-ops until backend support lands
        if (search.trim()) {
            const q = search.trim().toLowerCase();
            list = list.filter(
                (wf) =>
                    wf.name.toLowerCase().includes(q) ||
                    (wf.description || '').toLowerCase().includes(q)
            );
        }
        return list;
    }, [workflows, filter, search]);

    if (loading) {
        return (
            <div className="dashboard">
                <div className="dashboard-header">
                    <div className="dashboard-header-body">
                        <span className="dashboard-eyebrow">{weekdayLabel()} · THE STUDIO</span>
                        <h1>{greetingFor()}.</h1>
                    </div>
                </div>
                <SkeletonCard count={4} />
            </div>
        );
    }

    const firstName = (me?.name || '').split(' ')[0] || 'there';

    return (
        <div className="dashboard">
            {/* Editorial header */}
            <header className="dashboard-header">
                <div className="dashboard-header-body">
                    <span className="dashboard-eyebrow">{weekdayLabel()} · THE STUDIO</span>
                    <h1>
                        {greetingFor()}, <em>{firstName}.</em>
                    </h1>
                    <p>
                        Pick up a draft, queue another batch, or wire something brand-new from
                        scratch. The canvas is right where you left it.
                    </p>
                </div>
                <div className="dashboard-header-actions">
                    <button className="btn btn-ghost">
                        <Icon name="file-edit" size={14} /> Templates
                    </button>
                    <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
                        <Icon name="plus" size={14} /> New flow
                    </button>
                </div>
            </header>

            {/* Stats row */}
            <section className="dashboard-stats">
                <div className="dashboard-stat">
                    <span className="dashboard-stat-label">Total flows</span>
                    <span className="dashboard-stat-value">{stats.total}</span>
                    <span className="dashboard-stat-trend dashboard-stat-trend--up">↗ Active</span>
                </div>
                <div className="dashboard-stat">
                    <span className="dashboard-stat-label">Runs · 30d</span>
                    <span className="dashboard-stat-value">{stats.runs}</span>
                    <span className="dashboard-stat-trend">All executions</span>
                </div>
                <div className="dashboard-stat">
                    <span className="dashboard-stat-label">Avg. duration</span>
                    <span className="dashboard-stat-value dashboard-stat-value--mono">{stats.avgDuration}</span>
                    <span className="dashboard-stat-trend">Per execution</span>
                </div>
                <div className="dashboard-stat">
                    <span className="dashboard-stat-label">Credit balance</span>
                    <span className="dashboard-stat-value dashboard-stat-value--mono">{stats.credits}</span>
                    <span className="dashboard-stat-trend">Bring your own keys</span>
                </div>
            </section>

            {/* Toolbar */}
            <div className="dashboard-toolbar">
                <h2>My <em>workflows</em></h2>
                <div className="dashboard-toolbar-actions">
                    <div className="dashboard-filters" role="tablist" aria-label="Workflow filter">
                        {FILTERS.map((f) => (
                            <button
                                key={f}
                                type="button"
                                className={`dashboard-filter${filter === f ? ' active' : ''}`}
                                onClick={() => setFilter(f)}
                                role="tab"
                                aria-selected={filter === f}
                            >
                                {f}
                            </button>
                        ))}
                    </div>
                    <div className="dashboard-search">
                        <span className="dashboard-search-icon"><Icon name="search" size={14} /></span>
                        <input
                            className="input"
                            type="text"
                            placeholder="Search flows…"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                    </div>
                </div>
            </div>

            {/* Grid */}
            <div className="workflow-grid">
                <div className="create-workflow-card" onClick={() => setShowCreateModal(true)}>
                    <span className="plus-icon"><Icon name="plus" size={36} /></span>
                    <span>Start a new flow</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.1em', color: 'var(--ink-muted)' }}>
                        BLANK · TEMPLATE · IMPORT
                    </span>
                </div>

                {visibleWorkflows.map((wf) => (
                    <div key={wf.id} className="workflow-card" onClick={() => navigate(`/workflow/${wf.id}`)}>
                        <div className="workflow-card-name">{wf.name}</div>
                        <div className="workflow-card-desc">
                            {wf.description || 'No description'}
                        </div>
                        <div className="workflow-card-footer">
                            <span className="workflow-card-meta">
                                {formatDate(wf.updatedAt)} · {wf._count?.executions || 0} RUNS
                            </span>
                            <div className="workflow-card-actions">
                                <button className="btn btn-sm btn-icon" title="Duplicate" onClick={(e) => duplicateWorkflow(e, wf.id)}>
                                    <Icon name="copy" size={14} />
                                </button>
                                <button className="btn btn-sm btn-icon btn-danger" title="Delete" onClick={(e) => deleteWorkflow(e, wf.id)}>
                                    <Icon name="trash" size={14} />
                                </button>
                            </div>
                        </div>
                    </div>
                ))}

                {workflows.length > 0 && visibleWorkflows.length === 0 && (
                    <div className="dashboard-empty">
                        <h3>Nothing matches that search.</h3>
                        <p style={{ margin: 0, fontSize: 13 }}>Try a different keyword or clear the filter.</p>
                    </div>
                )}
            </div>

            {showCreateModal && (
                <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()}>
                        <h2>Create a <em>new flow</em></h2>
                        <p style={{ color: 'var(--ink-soft)', fontSize: 14, lineHeight: 1.6, marginBottom: 20 }}>
                            Give it a name. You can change everything else inside the canvas.
                        </p>
                        <div className="form-group">
                            <label className="form-label">Workflow name</label>
                            <input
                                className="input"
                                type="text"
                                placeholder="My awesome workflow"
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && createWorkflow()}
                                autoFocus
                            />
                        </div>
                        <div className="modal-actions">
                            <button className="btn btn-ghost" onClick={() => setShowCreateModal(false)}>Cancel</button>
                            <button className="btn btn-primary" onClick={createWorkflow}>Create flow</button>
                        </div>
                    </div>
                </div>
            )}

            {deleteTarget && (
                <ConfirmModal
                    title="Delete this flow?"
                    message="This action cannot be undone. All workflow data, runs, and history will be permanently removed."
                    confirmLabel="Delete"
                    variant="danger"
                    onConfirm={confirmDelete}
                    onCancel={() => setDeleteTarget(null)}
                />
            )}
        </div>
    );
}
