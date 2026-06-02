import { useState, useEffect } from 'react';
import { api } from '../../services/api.js';
import Icon from '../../services/icons.jsx';
import toast from 'react-hot-toast';

export default function AdminSettings() {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [settings, setSettings] = useState({});
    const [geminiModels, setGeminiModels] = useState([]);
    const [ollamaModels, setOllamaModels] = useState([]);
    const [selectedModel, setSelectedModel] = useState('gemini-3-flash-preview');
    const [selectedProvider, setSelectedProvider] = useState('gemini');

    // Local LLM (Ollama) basic-auth password
    const [ollamaPassword, setOllamaPassword] = useState('');
    const [savingPw, setSavingPw] = useState(false);

    useEffect(() => {
        loadSettings();
    }, []);

    async function loadSettings() {
        try {
            const data = await api.getSettings();
            setSettings(data.settings || {});
            setGeminiModels(data.geminiModels || []);
            setOllamaModels(data.ollamaModels || []);
            setSelectedModel(data.settings?.telegram_ai_model || 'gemini-3-flash-preview');
            setSelectedProvider(data.settings?.telegram_ai_provider || 'gemini');
        } catch (err) {
            toast.error('Failed to load settings');
        }
        setLoading(false);
    }

    async function handleSave() {
        setSaving(true);
        try {
            await api.updateSettings({
                telegram_ai_model: selectedModel,
                telegram_ai_provider: selectedProvider,
            });
            toast.success('Settings saved');
        } catch (err) {
            toast.error(err.message || 'Failed to save');
        }
        setSaving(false);
    }

    async function handleSavePassword() {
        if (ollamaPassword.length < 6) {
            toast.error('Password must be at least 6 characters');
            return;
        }
        setSavingPw(true);
        try {
            await api.updateOllamaPassword(ollamaPassword);
            toast.success('Local LLM password updated');
            setOllamaPassword('');
        } catch (err) {
            toast.error(err.message || 'Failed to update password');
        }
        setSavingPw(false);
    }

    if (loading) return <div className="admin-loading"><div className="loading-spinner" /></div>;

    // Combined model groups, each tagged with its provider so we can persist
    // both telegram_ai_model and telegram_ai_provider on selection.
    const groups = [
        ...geminiModels.map(g => ({ ...g, provider: 'gemini' })),
        ...(ollamaModels.length ? [{
            group: 'Ollama (Local)',
            provider: 'ollama',
            models: ollamaModels.map(m => ({ id: m, label: m, desc: 'Self-hosted on this server — no API cost' })),
        }] : []),
    ];

    const currentModelInfo = groups
        .flatMap(g => g.models.map(m => ({ ...m, provider: g.provider })))
        .find(m => m.id === selectedModel && m.provider === selectedProvider);

    return (
        <div className="admin-settings">
            <div className="admin-card">
                <h3><Icon name="bot" size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} /> Telegram Bot AI</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 20 }}>
                    Select the model for the Telegram bot AI assistant — Gemini (cloud) or the local Ollama LLM (self-hosted, no API cost).
                </p>

                <div className="settings-field">
                    <label className="form-label">AI Model</label>
                    <div className="model-selector">
                        {groups.map(group => (
                            <div key={group.group} className="model-group">
                                <div className="model-group-label">{group.group}</div>
                                {group.models.map(model => {
                                    const active = selectedModel === model.id && selectedProvider === group.provider;
                                    return (
                                        <div
                                            key={`${group.provider}:${model.id}`}
                                            className={`model-option ${active ? 'active' : ''}`}
                                            onClick={() => { setSelectedModel(model.id); setSelectedProvider(group.provider); }}
                                        >
                                            <div className="model-radio">
                                                <div className={`radio-dot ${active ? 'checked' : ''}`} />
                                            </div>
                                            <div className="model-info">
                                                <div className="model-name">{model.label}</div>
                                                <div className="model-desc">{model.desc}</div>
                                                <div className="model-id">{model.id}</div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                    </div>
                    {ollamaModels.length === 0 && (
                        <span className="form-hint" style={{ marginTop: 8, display: 'block' }}>
                            <Icon name="alert-triangle" size={13} style={{ marginRight: 4 }} />
                            No local Ollama models detected (Ollama may be offline). Only Gemini is selectable right now.
                        </span>
                    )}
                </div>

                {currentModelInfo && (
                    <div className="settings-active-model">
                        <span>Active:</span>
                        <strong>{currentModelInfo.label}</strong>
                        <code>{selectedProvider} · {currentModelInfo.id}</code>
                    </div>
                )}

                <button
                    className="btn btn-primary"
                    onClick={handleSave}
                    disabled={saving}
                    style={{ marginTop: 20, width: '100%' }}
                >
                    {saving ? 'Saving...' : <><Icon name="save" size={14} style={{ marginRight: 4 }} /> Save Settings</>}
                </button>
            </div>

            {/* ─── Local LLM (Ollama) public password ─── */}
            <div className="admin-card" style={{ marginTop: 20 }}>
                <h3><Icon name="key" size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} /> Local LLM Password</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
                    Change the password for external access to the local LLM at <code>https://thhflow.com/ollama/</code> (username: <strong>flowadmin</strong>).
                    The server itself reaches the LLM locally without auth, so this only affects external clients (e.g. your own machine).
                </p>

                <div className="settings-field">
                    <label className="form-label">New Password</label>
                    <input
                        className="input"
                        type="password"
                        placeholder="At least 6 characters"
                        value={ollamaPassword}
                        onChange={(e) => setOllamaPassword(e.target.value)}
                        autoComplete="new-password"
                    />
                </div>

                <button
                    className="btn btn-primary"
                    onClick={handleSavePassword}
                    disabled={savingPw || ollamaPassword.length < 6}
                    style={{ marginTop: 16, width: '100%' }}
                >
                    {savingPw ? 'Updating...' : <><Icon name="key" size={14} style={{ marginRight: 4 }} /> Update Password</>}
                </button>
            </div>
        </div>
    );
}
