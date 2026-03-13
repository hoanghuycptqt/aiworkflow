import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
    ReactFlow,
    Background,
    Controls,
    addEdge,
    useNodesState,
    useEdgesState,
    ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { api } from '../../services/api.js';
import { onExecutionUpdate } from '../../services/socket.js';
import { NODE_TYPES, NODE_CATEGORIES, getNodeType } from '../../services/nodeTypes.js';
import CustomNode from './CustomNode.jsx';
import NodeConfigPanel from './NodeConfigPanel.jsx';
import JobManager from './JobManager.jsx';
import JobMonitor from './JobMonitor.jsx';
import Icon from '../../services/icons.jsx';
import toast from 'react-hot-toast';

const nodeComponentTypes = {
    custom: CustomNode,
};

let nodeIdCounter = 0;

export default function WorkflowBuilder() {
    return (
        <ReactFlowProvider>
            <WorkflowBuilderInner />
        </ReactFlowProvider>
    );
}

function WorkflowBuilderInner() {
    const { id } = useParams();
    const navigate = useNavigate();
    const reactFlowWrapper = useRef(null);

    const [name, setName] = useState('');
    const [nodes, setNodes, onNodesChange] = useNodesState([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([]);
    const [selectedNode, setSelectedNode] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [nodeStatuses, setNodeStatuses] = useState({});
    const [showRunModal, setShowRunModal] = useState(false);
    const [instanceCount, setInstanceCount] = useState(1);
    const [executionStatus, setExecutionStatus] = useState(null);
    const [reactFlowInstance, setReactFlowInstance] = useState(null);
    const [nodeOutputs, setNodeOutputs] = useState({});
    const [showResults, setShowResults] = useState(false);
    const [expandedNodes, setExpandedNodes] = useState({});
    const [activeTab, setActiveTab] = useState('canvas');
    const [jobCount, setJobCount] = useState(0);
    const [historyKey, setHistoryKey] = useState(0); // bump to force refresh
    const [showMobilePalette, setShowMobilePalette] = useState(false);

    // Load workflow
    useEffect(() => {
        loadWorkflow();
    }, [id]);

    // Listen for execution updates
    useEffect(() => {
        const unsub = onExecutionUpdate((data) => {
            if (data.nodeId) {
                setNodeStatuses((prev) => ({
                    ...prev,
                    [data.nodeId]: data.nodeStatus,
                }));
                // Capture node output
                if (data.output) {
                    setNodeOutputs((prev) => ({
                        ...prev,
                        [data.nodeId]: data.output,
                    }));
                    setExpandedNodes((prev) => ({ ...prev, [data.nodeId]: true }));
                }
                if (data.error) {
                    setNodeOutputs((prev) => ({
                        ...prev,
                        [data.nodeId]: { _error: data.error },
                    }));
                }
            }
            if (data.status) {
                setExecutionStatus(data.status);
                if (data.status === 'completed') {
                    toast.success('Workflow completed!');
                } else if (data.status === 'failed') {
                    toast.error(`Workflow failed: ${data.error || 'Unknown error'}`);
                }
            }
        });
        return unsub;
    }, []);

    async function loadWorkflow() {
        try {
            const data = await api.getWorkflow(id);
            const wf = data.workflow;
            setName(wf.name);

            const loadedNodes = (wf.nodesData || []).map((n) => ({
                ...n,
                type: 'custom',
            }));

            loadedNodes.forEach((n) => {
                const num = parseInt(n.id.replace('node_', ''));
                if (num >= nodeIdCounter) nodeIdCounter = num + 1;
            });

            setNodes(loadedNodes);
            setEdges(wf.edgesData || []);
        } catch (err) {
            toast.error('Failed to load workflow');
            navigate('/');
        }
        setLoading(false);
    }

    async function saveWorkflow() {
        setSaving(true);
        try {
            await api.updateWorkflow(id, {
                name,
                nodesData: nodes,
                edgesData: edges,
            });
            toast.success('Saved!');
        } catch (err) {
            toast.error(err.message);
        }
        setSaving(false);
    }

    const onConnect = useCallback(
        (connection) => {
            setEdges((eds) => addEdge({ ...connection, animated: true, style: { stroke: '#818cf8', strokeWidth: 2 } }, eds));
        },
        [setEdges],
    );

    const onNodeClick = useCallback((event, node) => {
        setSelectedNode(node);
    }, []);

    const onPaneClick = useCallback(() => {
        setSelectedNode(null);
    }, []);

    const onDragOver = useCallback((event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    }, []);

    const onDrop = useCallback(
        (event) => {
            event.preventDefault();
            const nodeType = event.dataTransfer.getData('application/vcw-node-type');
            if (!nodeType || !reactFlowInstance) return;

            const typeDef = getNodeType(nodeType);
            if (!typeDef) return;

            const position = reactFlowInstance.screenToFlowPosition({
                x: event.clientX,
                y: event.clientY,
            });

            const newNode = {
                id: `node_${nodeIdCounter++}`,
                type: 'custom',
                position,
                data: {
                    type: nodeType,
                    label: typeDef.label,
                    icon: typeDef.icon,
                    color: typeDef.color,
                    config: {},
                },
            };

            setNodes((nds) => [...nds, newNode]);
        },
        [reactFlowInstance, setNodes],
    );

    // Mobile: tap to add node at viewport center
    function addNodeAtCenter(nodeType) {
        const typeDef = getNodeType(nodeType);
        if (!typeDef || !reactFlowInstance) return;

        const { x, y, zoom } = reactFlowInstance.getViewport();
        const centerX = (-x + window.innerWidth / 2) / zoom;
        const centerY = (-y + window.innerHeight / 2) / zoom;

        const newNode = {
            id: `node_${nodeIdCounter++}`,
            type: 'custom',
            position: { x: centerX - 80, y: centerY - 30 },
            data: {
                type: nodeType,
                label: typeDef.label,
                icon: typeDef.icon,
                color: typeDef.color,
                config: {},
            },
        };

        setNodes((nds) => [...nds, newNode]);
        setShowMobilePalette(false);
    }

    function updateNodeConfig(nodeId, config) {
        setNodes((nds) =>
            nds.map((n) =>
                n.id === nodeId
                    ? { ...n, data: { ...n.data, config: { ...n.data.config, ...config } } }
                    : n,
            ),
        );

        if (selectedNode?.id === nodeId) {
            setSelectedNode((prev) => ({
                ...prev,
                data: { ...prev.data, config: { ...prev.data.config, ...config } },
            }));
        }
    }

    function deleteNode(nodeId) {
        setNodes((nds) => nds.filter((n) => n.id !== nodeId));
        setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
        if (selectedNode?.id === nodeId) setSelectedNode(null);
    }

    async function runWorkflow() {
        setShowRunModal(false);
        setNodeStatuses({});
        setNodeOutputs({});
        setExpandedNodes({});
        setExecutionStatus('starting');
        setShowResults(true);
        try {
            await saveWorkflow();
            const data = await api.executeWorkflow(id, instanceCount);
            toast.success(`Started ${data.executions.length} instance(s)`);
            setExecutionStatus('running');
        } catch (err) {
            toast.error(err.message);
            setExecutionStatus(null);
        }
    }

    function toggleNodeExpand(nodeId) {
        setExpandedNodes((prev) => ({ ...prev, [nodeId]: !prev[nodeId] }));
    }

    function getNodeLabel(nodeId) {
        const node = nodes.find((n) => n.id === nodeId);
        return node?.data?.label || nodeId;
    }

    function getNodeIcon(nodeId) {
        const node = nodes.find((n) => n.id === nodeId);
        return node?.data?.icon || 'package';
    }

    function formatOutput(output) {
        if (!output) return 'No output';
        if (output._error) return output._error;
        if (output.text) return output.text;
        if (typeof output === 'string') return output;
        return JSON.stringify(output, null, 2);
    }

    async function handleRunBatch(jobIds, mode, concurrency) {
        try {
            await saveWorkflow();
            const data = await api.runJobs(id, jobIds, mode, concurrency);
            setActiveTab('history');
            setHistoryKey(k => k + 1); // force refresh
            toast.success(`Started ${data.executions.length} job(s) in ${mode} mode`);
        } catch (err) {
            toast.error(err.message);
        }
    }

    // Update job count when viewing jobs tab
    useEffect(() => {
        if (id) {
            api.getJobs(id).then(data => setJobCount(data.jobs?.length || 0)).catch(() => { });
        }
    }, [id, activeTab]);

    if (loading) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg-primary)' }}>
                <div className="loading-spinner" style={{ width: 40, height: 40 }} />
            </div>
        );
    }

    const hasResults = Object.keys(nodeOutputs).length > 0;

    return (
        <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)' }}>
            {/* Header */}
            <div className="builder-header">
                <div className="builder-header-left">
                    <button className="builder-back-btn" onClick={() => navigate('/')}>←</button>
                    <input
                        className="builder-title-input"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Workflow name"
                    />
                    {executionStatus && (
                        <span className={`badge badge-${executionStatus === 'running' ? 'warning' : executionStatus === 'completed' ? 'success' : executionStatus === 'failed' ? 'error' : 'info'}`}>
                            {executionStatus === 'running' && <><Icon name="zap" size={12} /> </>}
                            {executionStatus}
                        </span>
                    )}
                </div>
                <div className="builder-header-actions">
                    {hasResults && activeTab === 'canvas' && (
                        <button className="btn btn-sm" onClick={() => setShowResults(!showResults)}>
                            <Icon name={showResults ? 'chevron-down' : 'chevron-up'} size={14} /> {showResults ? 'Hide Results' : 'Show Results'}
                        </button>
                    )}
                    <button className="btn btn-sm" onClick={saveWorkflow} disabled={saving}>
                        {saving ? <span className="loading-spinner" /> : <Icon name="save" size={14} />} Save
                    </button>
                    <button className="btn btn-sm btn-primary" onClick={() => setShowRunModal(true)}>
                        <Icon name="play" size={14} /> Quick Run
                    </button>
                </div>
            </div>

            {/* Tab bar */}
            <div className="tab-bar">
                {['canvas', 'jobs', 'history'].map((tab) => {
                    const labels = {
                        canvas: 'Canvas',
                        jobs: `Jobs${jobCount > 0 ? ` (${jobCount})` : ''}`,
                        history: 'History',
                    };
                    const icons = {
                        canvas: 'palette',
                        jobs: 'list-ordered',
                        history: 'clock',
                    };
                    return (
                        <button
                            key={tab}
                            className={`tab-item${activeTab === tab ? ' active' : ''}`}
                            onClick={() => setActiveTab(tab)}
                        ><Icon name={icons[tab]} size={14} />{labels[tab]}</button>
                    );
                })}
            </div>

            {/* Canvas tab */}
            {activeTab === 'canvas' && (
                <>
                    <div className="builder-content" style={{ flex: showResults ? '1 1 50%' : '1 1 100%' }}>
                        {/* Node palette */}
                        <div className="node-palette">
                            {NODE_CATEGORIES.map((cat) => (
                                <div key={cat.id} className="palette-section">
                                    <div className="palette-section-title">
                                        <Icon name={cat.icon} size={14} /> {cat.label}
                                    </div>
                                    {Object.values(NODE_TYPES)
                                        .filter((nt) => nt.category === cat.id)
                                        .map((nt) => (
                                            <div
                                                key={nt.type}
                                                className="palette-node"
                                                draggable
                                                onDragStart={(e) => {
                                                    e.dataTransfer.setData('application/vcw-node-type', nt.type);
                                                    e.dataTransfer.effectAllowed = 'move';
                                                }}
                                            >
                                                <div className="palette-node-icon" style={{ background: `${nt.color}15`, color: nt.color }}>
                                                    <Icon name={nt.icon} size={18} />
                                                </div>
                                                <div className="palette-node-info">
                                                    <div className="palette-node-name">{nt.label}</div>
                                                    <div className="palette-node-desc">{nt.description}</div>
                                                </div>
                                            </div>
                                        ))}
                                </div>
                            ))}
                        </div>

                        {/* React Flow canvas */}
                        <div className="flow-canvas" ref={reactFlowWrapper}>
                            <ReactFlow
                                nodes={nodes.map((n) => ({
                                    ...n,
                                    data: {
                                        ...n.data,
                                        status: nodeStatuses[n.id],
                                    },
                                    selected: selectedNode?.id === n.id,
                                }))}
                                edges={edges}
                                onNodesChange={onNodesChange}
                                onEdgesChange={onEdgesChange}
                                onConnect={onConnect}
                                onNodeClick={onNodeClick}
                                onPaneClick={onPaneClick}
                                onDrop={onDrop}
                                onDragOver={onDragOver}
                                onInit={setReactFlowInstance}
                                nodeTypes={nodeComponentTypes}
                                fitView
                                proOptions={{ hideAttribution: true }}
                                defaultEdgeOptions={{ animated: true, style: { stroke: '#4b5563', strokeWidth: 2 } }}
                            >
                                <Background color="#1e1e3e" gap={20} size={1} />
                                <Controls
                                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-md)' }}
                                />
                            </ReactFlow>
                        </div>

                        {/* Config panel */}
                        {selectedNode && (
                            <NodeConfigPanel
                                node={selectedNode}
                                onUpdateConfig={(config) => updateNodeConfig(selectedNode.id, config)}
                                onDelete={() => deleteNode(selectedNode.id)}
                                onClose={() => setSelectedNode(null)}
                            />
                        )}
                    </div>

                    {/* Mobile FAB — add node */}
                    <button className="mobile-fab" onClick={() => setShowMobilePalette(true)} aria-label="Add Node">
                        <Icon name="plus" size={24} />
                    </button>

                    {/* Mobile bottom sheet — node palette */}
                    {showMobilePalette && (
                        <>
                            <div className="bottom-sheet-overlay" onClick={() => setShowMobilePalette(false)} />
                            <div className="bottom-sheet">
                                <div className="bottom-sheet-handle" />
                                <div className="bottom-sheet-header">
                                    <h3>Add Node</h3>
                                    <button className="btn btn-sm" onClick={() => setShowMobilePalette(false)}>
                                        <Icon name="x" size={16} />
                                    </button>
                                </div>
                                {NODE_CATEGORIES.map((cat) => (
                                    <div key={cat.id} className="palette-section">
                                        <div className="palette-section-title">
                                            <Icon name={cat.icon} size={14} /> {cat.label}
                                        </div>
                                        {Object.values(NODE_TYPES)
                                            .filter((nt) => nt.category === cat.id)
                                            .map((nt) => (
                                                <div
                                                    key={nt.type}
                                                    className="palette-node"
                                                    onClick={() => addNodeAtCenter(nt.type)}
                                                >
                                                    <div className="palette-node-icon" style={{ background: `${nt.color}15`, color: nt.color }}>
                                                        <Icon name={nt.icon} size={18} />
                                                    </div>
                                                    <div className="palette-node-info">
                                                        <div className="palette-node-name">{nt.label}</div>
                                                        <div className="palette-node-desc">{nt.description}</div>
                                                    </div>
                                                </div>
                                            ))}
                                    </div>
                                ))}
                            </div>
                        </>
                    )}
                </>
            )}

            {/* Jobs tab */}
            {activeTab === 'jobs' && (
                <div style={{ flex: 1, overflow: 'hidden' }}>
                    <JobManager
                        workflowId={id}
                        onRunBatch={handleRunBatch}
                    />
                </div>
            )}

            {/* History tab — merged history + monitor */}
            {activeTab === 'history' && (
                <div style={{ flex: 1, overflow: 'hidden' }}>
                    <JobMonitor
                        key={historyKey}
                        workflowId={id}
                    />
                </div>
            )}

            {/* Execution Results Panel */}
            {showResults && (
                <div className="results-panel" style={{ flex: '0 0 auto', maxHeight: '45vh' }}>
                    <div className="results-panel-header">
                        <h3 style={{ margin: 0, fontSize: 14, color: 'var(--text-primary)' }}>
                            Execution Results
                            {executionStatus === 'running' && <span className="loading-spinner" style={{ width: 14, height: 14, marginLeft: 8 }} />}
                        </h3>
                        <button
                            className="btn btn-sm"
                            onClick={() => setShowResults(false)}
                            style={{ fontSize: 12, padding: '2px 8px' }}
                        >✕</button>
                    </div>
                    <div className="results-panel-body">
                        {Object.keys(nodeOutputs).length === 0 ? (
                            <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 20, fontSize: 13 }}>
                                {executionStatus === 'running' ? 'Waiting for node outputs...' : 'No results yet. Run the workflow to see outputs here.'}
                            </div>
                        ) : (
                            Object.entries(nodeOutputs).map(([nodeId, output]) => (
                                <div key={nodeId} style={{
                                    marginBottom: 10,
                                    border: '1px solid var(--border-primary)',
                                    borderRadius: 'var(--radius-md)',
                                    overflow: 'hidden',
                                    background: 'var(--bg-primary)',
                                }}>
                                    <div
                                        onClick={() => toggleNodeExpand(nodeId)}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 8,
                                            padding: '8px 12px',
                                            cursor: 'pointer',
                                            background: output._error ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.1)',
                                            borderBottom: expandedNodes[nodeId] ? '1px solid var(--border-primary)' : 'none',
                                        }}
                                    >
                                        <span style={{ fontSize: 12 }}>{expandedNodes[nodeId] ? '▼' : '▶'}</span>
                                        <span><Icon name={getNodeIcon(nodeId)} size={14} /></span>
                                        <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                                            {getNodeLabel(nodeId)}
                                        </strong>
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                                            {nodeId}
                                        </span>
                                        <span style={{
                                            fontSize: 11,
                                            padding: '2px 6px',
                                            borderRadius: 4,
                                            background: output._error ? 'var(--error)' : 'var(--success)',
                                            color: '#fff',
                                        }}>
                                            {output._error ? 'Error' : 'Done'}
                                        </span>
                                    </div>
                                    {expandedNodes[nodeId] && (
                                        <div style={{
                                            padding: '10px 12px',
                                            maxHeight: 200,
                                            overflowY: 'auto',
                                        }}>
                                            <pre style={{
                                                whiteSpace: 'pre-wrap',
                                                wordBreak: 'break-word',
                                                fontSize: 12,
                                                lineHeight: 1.5,
                                                color: output._error ? 'var(--error)' : 'var(--text-primary)',
                                                margin: 0,
                                                fontFamily: 'var(--font-mono, "Fira Code", monospace)',
                                            }}>
                                                {formatOutput(output)}
                                            </pre>
                                            {output.model && (
                                                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                                                    Model: {output.model}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}

            {/* Run modal */}
            {showRunModal && (
                <div className="modal-overlay" onClick={() => setShowRunModal(false)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()}>
                        <h2><Icon name="play" size={18} style={{ marginRight: 6, verticalAlign: 'middle' }} /> Run Workflow</h2>
                        <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 16 }}>
                            Execute this workflow with one or more parallel instances.
                        </p>
                        <div className="run-modal-instances">
                            <label>Number of instances:</label>
                            <input
                                className="input"
                                type="number"
                                min="1"
                                max="50"
                                value={instanceCount}
                                onChange={(e) => setInstanceCount(parseInt(e.target.value) || 1)}
                            />
                        </div>
                        <div className="modal-actions">
                            <button className="btn" onClick={() => setShowRunModal(false)}>Cancel</button>
                            <button className="btn btn-primary" onClick={runWorkflow}>
                                <Icon name="play" size={14} style={{ marginRight: 4 }} /> Run {instanceCount > 1 ? `${instanceCount} Instances` : 'Workflow'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
