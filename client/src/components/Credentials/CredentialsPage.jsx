import { useState, useEffect } from 'react';
import { api } from '../../services/api.js';
import toast from 'react-hot-toast';
import TelegramLink from '../Settings/TelegramLink.jsx';

const PROVIDERS = [
    { id: 'gemini', label: 'Google Gemini (OpenRouter)', icon: '✨', description: 'Free AI via OpenRouter — supports Gemini, Llama, DeepSeek' },
    { id: 'google-flow', label: 'Google Flow', icon: '🎬', description: 'Auth token for Google Flow (labs.google/fx)' },
    { id: 'chatgpt', label: 'ChatGPT', icon: '💬', description: 'Access Token for ChatGPT (chatgpt.com) — supports Custom GPTs' },
];

export default function CredentialsPage() {
    const [credentials, setCredentials] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [editingId, setEditingId] = useState(null);
    const [form, setForm] = useState({ provider: 'gemini', label: '', token: '', metadata: {} });
    const [refreshing, setRefreshing] = useState(null); // credentialId being refreshed
    const [tokenStatus, setTokenStatus] = useState({}); // { credentialId: { valid, expiresInHuman } }

    const checkTokenStatus = async (credId, provider) => {
        try {
            if (provider === 'chatgpt') {
                const res = await api.request('/chatgpt-auth/check', {
                    method: 'POST',
                    body: JSON.stringify({ credentialId: credId }),
                });
                setTokenStatus(prev => ({ ...prev, [credId]: res }));
            } else {
                // Lightweight JWT-only check for google-flow and others
                const res = await api.request('/credential-check/token', {
                    method: 'POST',
                    body: JSON.stringify({ credentialId: credId }),
                });
                setTokenStatus(prev => ({ ...prev, [credId]: { ...res, tokenOnly: true } }));
            }
        } catch (e) { /* ignore */ }
    };

    const handleRefreshCredential = async (credId) => {
        setRefreshing(credId);
        toast('🌐 Opening Chrome... Please log in to ChatGPT', { duration: 10000 });
        try {
            const res = await api.request('/chatgpt-auth/refresh', {
                method: 'POST',
                body: JSON.stringify({ credentialId: credId }),
            });
            if (res.success) {
                toast.success(`✅ Credentials updated! Expires: ${res.expiresAt ? new Date(res.expiresAt).toLocaleString('vi-VN') : 'N/A'}`);
                // Immediately show as active (no need for slow re-check)
                const expiresIn = res.expiresAt ? Math.floor((new Date(res.expiresAt) - Date.now()) / 1000) : 0;
                const hours = Math.floor(expiresIn / 3600);
                const mins = Math.floor((expiresIn % 3600) / 60);
                setTokenStatus(prev => ({
                    ...prev, [credId]: {
                        valid: true,
                        tokenValid: true,
                        sessionValid: true,
                        expiresInHuman: `${hours}h ${mins}m`,
                    }
                }));
                loadCredentials();
            }
        } catch (err) {
            toast.error(`❌ Refresh failed: ${err.message}`);
        } finally {
            setRefreshing(null);
        }
    };

    const handleRefreshGoogleFlow = async (credId) => {
        setRefreshing(credId);
        toast('🌐 Opening Chrome... Please log in to Google and interact with Flow', { duration: 15000 });
        try {
            const res = await api.request('/credential-check/google-flow-refresh', {
                method: 'POST',
                body: JSON.stringify({ credentialId: credId }),
            });
            if (res.success) {
                toast.success(`✅ Google Flow credentials updated! Expires: ${res.expiresAt ? new Date(res.expiresAt).toLocaleString('vi-VN') : 'N/A'}`);
                const expiresIn = res.expiresAt ? Math.floor((new Date(res.expiresAt) - Date.now()) / 1000) : 0;
                const hours = Math.floor(expiresIn / 3600);
                const mins = Math.floor((expiresIn % 3600) / 60);
                setTokenStatus(prev => ({
                    ...prev, [credId]: {
                        valid: true,
                        tokenValid: true,
                        tokenOnly: true,
                        expiresInHuman: `${hours}h ${mins}m`,
                    }
                }));
                loadCredentials();
            }
        } catch (err) {
            toast.error(`❌ Refresh failed: ${err.message}`);
        } finally {
            setRefreshing(null);
        }
    };

    useEffect(() => {
        loadCredentials();
    }, []);

    async function loadCredentials() {
        try {
            const data = await api.getCredentials();
            setCredentials(data.credentials);
            // Auto-check token status for ChatGPT and Google Flow credentials
            for (const cred of data.credentials) {
                if (cred.provider === 'chatgpt' || cred.provider === 'google-flow') {
                    checkTokenStatus(cred.id, cred.provider);
                }
            }
        } catch (err) {
            toast.error('Failed to load credentials');
        }
        setLoading(false);
    }

    async function saveCredential() {
        if (!form.label.trim() || !form.token.trim()) {
            toast.error('Label and token are required');
            return;
        }

        try {
            if (editingId) {
                await api.updateCredential(editingId, form);
                toast.success('Credential updated');
            } else {
                await api.createCredential(form);
                toast.success('Credential added');
            }
            setShowModal(false);
            setEditingId(null);
            setForm({ provider: 'chatgpt', label: '', token: '', metadata: {} });
            loadCredentials();
        } catch (err) {
            toast.error(err.message);
        }
    }

    async function deleteCredential(id) {
        if (!confirm('Delete this credential?')) return;
        try {
            await api.deleteCredential(id);
            setCredentials((c) => c.filter((cr) => cr.id !== id));
            toast.success('Credential deleted');
        } catch (err) {
            toast.error(err.message);
        }
    }

    function openEdit(cred) {
        setEditingId(cred.id);
        setForm({ provider: cred.provider, label: cred.label, token: '', metadata: cred.metadata || {} });
        setShowModal(true);
    }

    function getProviderInfo(providerId) {
        return PROVIDERS.find((p) => p.id === providerId) || { icon: '⚙️', label: providerId };
    }

    if (loading) {
        return (
            <div className="credentials-page">
                <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
                    <div className="loading-spinner" />
                </div>
            </div>
        );
    }

    return (
        <div className="credentials-page">
            <div className="dashboard-header">
                <div>
                    <h2>Credentials</h2>
                    <p style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 4 }}>
                        Manage your API keys for Google Gemini and Google Flow
                    </p>
                </div>
                <button className="btn btn-primary" onClick={() => { setEditingId(null); setForm({ provider: 'gemini', label: '', token: '', metadata: {} }); setShowModal(true); }}>
                    + Add Credential
                </button>
            </div>

            {credentials.length === 0 ? (
                <div className="empty-state">
                    <div className="empty-state-icon">🔑</div>
                    <h3>No Credentials Yet</h3>
                    <p>Add your Google Gemini API key or Google Flow token to start using AI nodes in your workflows.</p>
                </div>
            ) : (
                <div className="credential-list">
                    {credentials.map((cred) => {
                        const provider = getProviderInfo(cred.provider);
                        const status = tokenStatus[cred.id];
                        return (
                            <div key={cred.id} className="credential-card">
                                <div className="credential-info">
                                    <div className="credential-provider-icon">{provider.icon}</div>
                                    <div className="credential-detail">
                                        <h4>{cred.label}</h4>
                                        <p>{provider.label} · Added {new Date(cred.createdAt).toLocaleDateString('vi-VN')}</p>
                                        {cred.provider === 'chatgpt' && status && (
                                            <div style={{ fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>
                                                <span style={{ color: status.tokenValid ? '#4ade80' : '#f87171', fontWeight: 500 }}>
                                                    {status.tokenValid ? `🔑 Token: ✅ ${status.expiresInHuman}` : '🔑 Token: ❌ EXPIRED'}
                                                </span>
                                                <br />
                                                <span style={{ color: status.sessionValid ? '#4ade80' : '#f87171', fontWeight: 500 }}>
                                                    {status.sessionValid ? '🍪 Session: ✅ Active' : '🍪 Session: ❌ Invalid'}
                                                </span>
                                                {cred.metadata?.lastRefreshed && (
                                                    <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8 }}>
                                                        · Refreshed: {new Date(cred.metadata.lastRefreshed).toLocaleString('vi-VN')}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                        {cred.provider === 'google-flow' && status && (
                                            <div style={{ fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>
                                                <span style={{ color: status.tokenValid ? '#4ade80' : '#f87171', fontWeight: 500 }}>
                                                    {status.tokenValid ? '🔑 Token: ✅ Valid' : '🔑 Token: ❌ Invalid'}
                                                </span>
                                                <br />
                                                <span style={{ color: status.hasSession ? '#4ade80' : '#f87171', fontWeight: 500 }}>
                                                    {status.hasSession ? '🍪 Session: ✅ Valid' : '🍪 Session: ❌ Expired'}
                                                </span>
                                                {cred.metadata?.lastRefreshed && (
                                                    <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8 }}>
                                                        · Refreshed: {new Date(cred.metadata.lastRefreshed).toLocaleString('vi-VN')}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                        {(cred.provider === 'chatgpt' || cred.provider === 'google-flow') && !status && (
                                            <p style={{ fontSize: 12, marginTop: 4, color: 'var(--text-muted)' }}>⏳ Checking status...</p>
                                        )}
                                    </div>
                                </div>
                                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                    {cred.provider === 'chatgpt' && (
                                        <button
                                            className="btn btn-sm"
                                            style={{
                                                background: refreshing === cred.id ? 'var(--bg-tertiary)' : 'linear-gradient(135deg, #10b981, #059669)',
                                                color: '#fff',
                                                border: 'none',
                                                opacity: refreshing === cred.id ? 0.7 : 1,
                                            }}
                                            onClick={() => handleRefreshCredential(cred.id)}
                                            disabled={refreshing === cred.id}
                                        >
                                            {refreshing === cred.id ? '⏳ Waiting for login...' : '🔄 Auto Refresh'}
                                        </button>
                                    )}
                                    {cred.provider === 'google-flow' && (
                                        <button
                                            className="btn btn-sm"
                                            style={{
                                                background: refreshing === cred.id ? 'var(--bg-tertiary)' : (status?.valid ? 'linear-gradient(135deg, #10b981, #059669)' : 'linear-gradient(135deg, #f59e0b, #d97706)'),
                                                color: '#fff',
                                                border: 'none',
                                                opacity: refreshing === cred.id ? 0.7 : 1,
                                            }}
                                            onClick={() => handleRefreshGoogleFlow(cred.id)}
                                            disabled={refreshing === cred.id}
                                        >
                                            {refreshing === cred.id ? '⏳ Waiting for login...' : '🔄 Auto Refresh'}
                                        </button>
                                    )}
                                    <button className="btn btn-sm" onClick={() => openEdit(cred)}>Edit</button>
                                    <button className="btn btn-sm btn-danger" onClick={() => deleteCredential(cred.id)}>Delete</button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {showModal && (
                <div className="modal-overlay" onClick={() => setShowModal(false)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()}>
                        <h2>{editingId ? 'Edit Credential' : 'Add Credential'}</h2>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                            <div className="form-group">
                                <label className="form-label">Provider</label>
                                <select
                                    className="select"
                                    value={form.provider}
                                    onChange={(e) => setForm({ ...form, provider: e.target.value })}
                                    disabled={!!editingId}
                                >
                                    {PROVIDERS.map((p) => (
                                        <option key={p.id} value={p.id}>{p.icon} {p.label}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="form-group">
                                <label className="form-label">Label</label>
                                <input
                                    className="input"
                                    type="text"
                                    placeholder="My Gemini API Key"
                                    value={form.label}
                                    onChange={(e) => setForm({ ...form, label: e.target.value })}
                                />
                            </div>

                            {form.provider === 'gemini' ? (
                                <div className="form-group">
                                    <label className="form-label">OpenRouter API Key</label>
                                    <input
                                        className="input"
                                        type="password"
                                        placeholder="sk-or-v1-... (from OpenRouter)"
                                        value={form.token}
                                        onChange={(e) => setForm({ ...form, token: e.target.value })}
                                    />
                                    <span className="form-hint">
                                        🔑 Get your free API key at <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>openrouter.ai/keys</a>
                                    </span>
                                </div>
                            ) : form.provider === 'chatgpt' ? (
                                <>
                                    <div className="form-group">
                                        <label className="form-label">Access Token (Bearer)</label>
                                        <textarea
                                            className="textarea"
                                            placeholder={'Paste your ChatGPT access token here...\n\n📝 How to get:\n1. Open chatgpt.com → F12 → Network tab\n2. Find any API request to backend-api/\n3. Copy the Authorization: Bearer ... value'}
                                            value={form.token}
                                            onChange={(e) => setForm({ ...form, token: e.target.value })}
                                            style={{ minHeight: 120 }}
                                        />
                                        <span className="form-hint">
                                            Get from DevTools → Network → Any request to backend-api → Authorization header
                                        </span>
                                    </div>
                                    <div className="form-group">
                                        <label className="form-label">OAI Device ID</label>
                                        <input
                                            className="input"
                                            type="text"
                                            placeholder="5d3d45fb-db4f-46c9-8d09-... (auto-generated if empty)"
                                            value={form.metadata?.deviceId || ''}
                                            onChange={(e) => setForm({ ...form, metadata: { ...form.metadata, deviceId: e.target.value } })}
                                        />
                                        <span className="form-hint">
                                            Optional — found in oai-device-id header. Auto-generated if left empty.
                                        </span>
                                    </div>
                                    <div className="form-group">
                                        <label className="form-label">Browser Cookies 🍪</label>
                                        <textarea
                                            className="textarea"
                                            placeholder={'Paste cookies from browser here...\n\n📝 How to get:\n1. Open chatgpt.com → F12 → Network tab\n2. Click any request to backend-api/\n3. In Headers → find "Cookie:" → copy full value'}
                                            value={form.metadata?.cookies || ''}
                                            onChange={(e) => setForm({ ...form, metadata: { ...form.metadata, cookies: e.target.value } })}
                                            style={{ minHeight: 100, fontSize: 11 }}
                                        />
                                        <span className="form-hint">
                                            Required for Cloudflare bypass. Expires after a few hours — update when needed.
                                        </span>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="form-group">
                                        <label className="form-label">Bearer Token</label>
                                        <textarea
                                            className="textarea"
                                            placeholder={'Paste your Google Flow token here...\n\n📝 How to get: Open Google Flow → F12 → Network tab → find API request → copy Authorization header'}
                                            value={form.token}
                                            onChange={(e) => setForm({ ...form, token: e.target.value })}
                                            style={{ minHeight: 120 }}
                                        />
                                        <span className="form-hint">
                                            Get from DevTools → Network → XHR → Authorization: Bearer ...
                                        </span>
                                    </div>
                                </>
                            )}
                        </div>

                        <div className="modal-actions">
                            <button className="btn" onClick={() => setShowModal(false)}>Cancel</button>
                            <button className="btn btn-primary" onClick={saveCredential}>
                                {editingId ? 'Update' : 'Add Credential'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Telegram Integration */}
            <TelegramLink />
        </div>
    );
}
