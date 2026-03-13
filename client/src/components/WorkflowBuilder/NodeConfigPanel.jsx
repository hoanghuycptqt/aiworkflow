import { useState, useEffect, useRef } from 'react';
import { getNodeType, PROVIDER_MODELS } from '../../services/nodeTypes.js';
import { api } from '../../services/api.js';
import Icon from '../../services/icons.jsx';

const SERVER = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';

export default function NodeConfigPanel({ node, onUpdateConfig, onDelete, onClose }) {
    const [credentials, setCredentials] = useState([]);
    const [uploading, setUploading] = useState(false);
    const [uploadPreviews, setUploadPreviews] = useState([]);
    const typeDef = getNodeType(node.data?.type);

    useEffect(() => {
        loadCredentials();
    }, [node?.id]);

    // Set previews if files already uploaded
    useEffect(() => {
        const config = node.data?.config || {};
        // Multi-file: filePaths array
        if (config.filePaths && config.filePaths.length > 0) {
            setUploadPreviews(config.filePaths.map(p =>
                p.startsWith('/uploads') ? `${SERVER}${p}` : p
            ));
        } else if (config.filePath && (config.filePath.startsWith('/uploads') || config.filePath.startsWith('http'))) {
            // Legacy single file compat
            setUploadPreviews([config.filePath.startsWith('/uploads') ? `${SERVER}${config.filePath}` : config.filePath]);
        } else {
            setUploadPreviews([]);
        }
    }, [node?.id, node?.data?.config?.filePaths, node?.data?.config?.filePath]);

    async function loadCredentials() {
        try {
            const data = await api.getCredentials();
            setCredentials(data.credentials);
        } catch {
            // ignore
        }
    }

    async function handleFileUpload(files) {
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
            const existingPaths = node.data?.config?.filePaths || [];
            const newPaths = data.files.map(f => f.fileUrl);
            const allPaths = [...existingPaths, ...newPaths];
            onUpdateConfig({ filePaths: allPaths, filePath: allPaths[0] });
            setUploadPreviews(allPaths.map(p => `${SERVER}${p}`));
        } catch (err) {
            alert(`Upload failed: ${err.message}`);
        }
        setUploading(false);
    }

    // Clipboard paste support — Ctrl+V / Cmd+V to paste images
    useEffect(() => {
        function handlePaste(e) {
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
                handleFileUpload(imageFiles);
            }
        }
        document.addEventListener('paste', handlePaste);
        return () => document.removeEventListener('paste', handlePaste);
    }, [node?.id, node?.data?.config?.filePaths]);

    if (!typeDef) return null;

    const config = node.data?.config || {};
    const schema = typeDef.configSchema || {};

    function renderField(key, fieldSchema) {
        const value = config[key] ?? fieldSchema.default ?? '';

        switch (fieldSchema.type) {
            case 'text':
                return (
                    <input
                        className="input"
                        type="text"
                        value={value}
                        placeholder={fieldSchema.description || ''}
                        onChange={(e) => onUpdateConfig({ [key]: e.target.value })}
                    />
                );

            case 'textarea':
                return (
                    <textarea
                        className="textarea"
                        value={value}
                        placeholder={fieldSchema.description || ''}
                        onChange={(e) => onUpdateConfig({ [key]: e.target.value })}
                    />
                );

            case 'number':
                return (
                    <input
                        className="input"
                        type="number"
                        value={value}
                        min={fieldSchema.min}
                        max={fieldSchema.max}
                        onChange={(e) => onUpdateConfig({ [key]: parseInt(e.target.value) || 0 })}
                    />
                );

            case 'select': {
                // Dynamic model list based on selected credential's provider
                let options = fieldSchema.options || [];
                if (fieldSchema.dynamic && key === 'model') {
                    const credId = config.credentialId;
                    const selectedCred = credentials.find(c => c.id === credId);
                    if (selectedCred && PROVIDER_MODELS[selectedCred.provider]) {
                        options = PROVIDER_MODELS[selectedCred.provider];
                    } else {
                        // Show all models grouped if no credential selected yet
                        options = Object.values(PROVIDER_MODELS).flat();
                    }
                }
                return (
                    <select
                        className="select"
                        value={value}
                        onChange={(e) => onUpdateConfig({ [key]: e.target.value })}
                    >
                        {!value && <option value="">Select model...</option>}
                        {options.map((opt) => {
                            const optValue = typeof opt === 'object' ? opt.value : opt;
                            const optLabel = typeof opt === 'object' ? opt.label : opt;
                            return <option key={optValue} value={optValue}>{optLabel}</option>;
                        })}
                    </select>
                );
            }

            case 'boolean':
                return (
                    <div className="toggle-container">
                        <div
                            className={`toggle ${value ? 'active' : ''}`}
                            onClick={() => onUpdateConfig({ [key]: !value })}
                        >
                            <div className="toggle-thumb" />
                        </div>
                        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                            {value ? 'Enabled' : 'Disabled'}
                        </span>
                    </div>
                );

            case 'credential': {
                const providerFilter = fieldSchema.provider;
                const filtered = credentials.filter((c) => {
                    if (Array.isArray(providerFilter)) return providerFilter.includes(c.provider);
                    return c.provider === providerFilter;
                });
                return (
                    <div>
                        <select
                            className="select"
                            value={value}
                            onChange={(e) => {
                                const selectedCredId = e.target.value;
                                const updates = { [key]: selectedCredId };
                                // When credential changes, auto-set model to provider's default
                                const selectedCred = credentials.find(c => c.id === selectedCredId);
                                if (selectedCred && PROVIDER_MODELS[selectedCred.provider]) {
                                    const currentModel = config.model || '';
                                    const providerModels = PROVIDER_MODELS[selectedCred.provider];
                                    // Only reset model if current model doesn't belong to new provider
                                    if (!providerModels.includes(currentModel)) {
                                        updates.model = providerModels[0];
                                    }
                                }
                                onUpdateConfig(updates);
                            }}
                        >
                            <option value="">Select credential...</option>
                            {filtered.map((c) => {
                                const providerLabel = Array.isArray(providerFilter) ? ` (${c.provider})` : '';
                                return <option key={c.id} value={c.id}>{c.label}{providerLabel}</option>;
                            })}
                        </select>
                        {filtered.length === 0 && (
                            <span className="form-hint" style={{ color: 'var(--warning)', marginTop: 6, display: 'block' }}>
                                 <Icon name="alert-triangle" size={14} color="var(--warning)" style={{ marginRight: 4 }} /> No credentials found. <a href="/credentials" style={{ color: 'var(--accent)' }}>Add one in Credentials page</a>
                            </span>
                        )}
                    </div>
                );
            }

            case 'file':
                return (
                    <div>
                        {/* Upload zone */}
                        <div
                            style={{
                                border: '2px dashed var(--border-primary)',
                                borderRadius: 'var(--radius-md)',
                                padding: '20px 16px',
                                textAlign: 'center',
                                cursor: uploading ? 'wait' : 'pointer',
                                background: 'var(--bg-primary)',
                                transition: 'border-color 0.2s, background 0.2s',
                            }}
                            onClick={() => {
                                if (!uploading) {
                                    const input = document.createElement('input');
                                    input.type = 'file';
                                    input.accept = fieldSchema.accept || 'image/*';
                                    input.multiple = true;
                                    input.onchange = (e) => {
                                        if (e.target.files.length > 0) handleFileUpload(e.target.files);
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
                                if (e.dataTransfer.files.length > 0) handleFileUpload(e.dataTransfer.files);
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

                        {/* Image grid preview */}
                        {uploadPreviews.length > 0 && (
                            <div style={{ marginTop: 10 }}>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: 8 }}>
                                    {uploadPreviews.map((url, idx) => (
                                        <div key={idx} style={{ position: 'relative' }}>
                                            <img
                                                src={url}
                                                alt={`Upload ${idx + 1}`}
                                                style={{
                                                    width: '100%',
                                                    height: 80,
                                                    objectFit: 'cover',
                                                    borderRadius: 'var(--radius-sm)',
                                                    border: '1px solid var(--border-primary)',
                                                }}
                                            />
                                            <button
                                                className="btn btn-sm"
                                                onClick={() => {
                                                    const paths = [...(config.filePaths || [])];
                                                    paths.splice(idx, 1);
                                                    onUpdateConfig({
                                                        filePaths: paths,
                                                        filePath: paths[0] || '',
                                                    });
                                                }}
                                                style={{
                                                    position: 'absolute',
                                                    top: 2,
                                                    right: 2,
                                                    padding: '0 4px',
                                                    fontSize: 10,
                                                    lineHeight: '16px',
                                                    background: 'rgba(0,0,0,0.7)',
                                                    color: '#fff',
                                                    borderRadius: 3,
                                                    minWidth: 'unset',
                                                }}
                                            >✕</button>
                                        </div>
                                    ))}
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                                    <Icon name="paperclip" size={12} style={{ marginRight: 4 }} /> {uploadPreviews.length} image{uploadPreviews.length > 1 ? 's' : ''} uploaded
                                </div>
                            </div>
                        )}
                    </div>
                );

            default:
                return (
                    <input
                        className="input"
                        type="text"
                        value={value}
                        onChange={(e) => onUpdateConfig({ [key]: e.target.value })}
                    />
                );
        }
    }

    return (
        <div className="config-panel">
            <div className="config-panel-header">
                <h3>
                    <Icon name={typeDef.icon} size={16} color={typeDef.color} />
                    {typeDef.label}
                </h3>
                <button className="btn btn-sm btn-icon" onClick={onClose}>✕</button>
            </div>

            <div className="config-panel-body">
                <div className="form-group">
                    <label className="form-label">Node ID</label>
                    <input className="input input-readonly" type="text" value={node.id} readOnly />
                </div>

                {Object.entries(schema).map(([key, fieldSchema]) => (
                    <div key={key} className="form-group">
                        <label className="form-label">
                            {fieldSchema.label}
                            {fieldSchema.required && <span style={{ color: 'var(--error)' }}> *</span>}
                        </label>
                        {renderField(key, fieldSchema)}
                        {fieldSchema.description && fieldSchema.type !== 'file' && (
                            <span className="form-hint">{fieldSchema.description}</span>
                        )}
                    </div>
                ))}
            </div>

            <div className="config-panel-footer">
                <button className="btn btn-danger btn-sm" onClick={onDelete} style={{ width: '100%' }}>
                    <Icon name="trash" size={14} style={{ marginRight: 4 }} /> Delete Node
                </button>
            </div>
        </div>
    );
}
