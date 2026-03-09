import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api.js';
import toast from 'react-hot-toast';

export default function Dashboard() {
    const [workflows, setWorkflows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [newName, setNewName] = useState('');
    const navigate = useNavigate();

    useEffect(() => {
        loadWorkflows();
    }, []);

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
        if (!confirm('Delete this workflow?')) return;
        try {
            await api.deleteWorkflow(id);
            setWorkflows((w) => w.filter((wf) => wf.id !== id));
            toast.success('Workflow deleted');
        } catch (err) {
            toast.error(err.message);
        }
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

    if (loading) {
        return (
            <div className="dashboard">
                <div className="loading-overlay" style={{ position: 'relative', height: 300 }}>
                    <div className="loading-spinner" />
                </div>
            </div>
        );
    }

    return (
        <div className="dashboard">
            <div className="dashboard-header">
                <h2>My Workflows</h2>
                <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
                    + New Workflow
                </button>
            </div>

            <div className="workflow-grid">
                <div className="create-workflow-card" onClick={() => setShowCreateModal(true)}>
                    <span className="plus-icon">+</span>
                    <span>Create Workflow</span>
                </div>

                {workflows.map((wf) => (
                    <div key={wf.id} className="workflow-card" onClick={() => navigate(`/workflow/${wf.id}`)}>
                        <div className="workflow-card-name">{wf.name}</div>
                        <div className="workflow-card-desc">
                            {wf.description || 'No description'}
                        </div>
                        <div className="workflow-card-footer">
                            <span className="workflow-card-meta">
                                {formatDate(wf.updatedAt)} · {wf._count?.executions || 0} runs
                            </span>
                            <div className="workflow-card-actions">
                                <button className="btn btn-sm btn-icon" title="Duplicate" onClick={(e) => duplicateWorkflow(e, wf.id)}>
                                    📋
                                </button>
                                <button className="btn btn-sm btn-icon btn-danger" title="Delete" onClick={(e) => deleteWorkflow(e, wf.id)}>
                                    🗑️
                                </button>
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {showCreateModal && (
                <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()}>
                        <h2>Create New Workflow</h2>
                        <div className="form-group">
                            <label className="form-label">Workflow Name</label>
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
                            <button className="btn" onClick={() => setShowCreateModal(false)}>Cancel</button>
                            <button className="btn btn-primary" onClick={createWorkflow}>Create</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
