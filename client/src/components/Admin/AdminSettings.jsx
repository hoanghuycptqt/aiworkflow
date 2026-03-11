import { useState, useEffect } from 'react';
import { api } from '../../services/api.js';
import toast from 'react-hot-toast';

export default function AdminSettings() {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [settings, setSettings] = useState({});
    const [geminiModels, setGeminiModels] = useState([]);
    const [selectedModel, setSelectedModel] = useState('gemini-3-flash-preview');

    useEffect(() => {
        loadSettings();
    }, []);

    async function loadSettings() {
        try {
            const data = await api.getSettings();
            setSettings(data.settings || {});
            setGeminiModels(data.geminiModels || []);
            setSelectedModel(data.settings?.telegram_ai_model || 'gemini-3-flash-preview');
        } catch (err) {
            toast.error('Failed to load settings');
        }
        setLoading(false);
    }

    async function handleSave() {
        setSaving(true);
        try {
            await api.updateSettings({ telegram_ai_model: selectedModel });
            toast.success('Settings saved');
        } catch (err) {
            toast.error(err.message || 'Failed to save');
        }
        setSaving(false);
    }

    if (loading) return <div className="admin-loading"><div className="loading-spinner" /></div>;

    // Find current model info
    const currentModelInfo = geminiModels
        .flatMap(g => g.models)
        .find(m => m.id === selectedModel);

    return (
        <div className="admin-settings">
            <div className="admin-card">
                <h3>🤖 Telegram Bot AI</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 20 }}>
                    Chọn model Gemini cho Telegram bot AI assistant.
                </p>

                <div className="settings-field">
                    <label className="form-label">AI Model</label>
                    <div className="model-selector">
                        {geminiModels.map(group => (
                            <div key={group.group} className="model-group">
                                <div className="model-group-label">{group.group}</div>
                                {group.models.map(model => (
                                    <div
                                        key={model.id}
                                        className={`model-option ${selectedModel === model.id ? 'active' : ''}`}
                                        onClick={() => setSelectedModel(model.id)}
                                    >
                                        <div className="model-radio">
                                            <div className={`radio-dot ${selectedModel === model.id ? 'checked' : ''}`} />
                                        </div>
                                        <div className="model-info">
                                            <div className="model-name">{model.label}</div>
                                            <div className="model-desc">{model.desc}</div>
                                            <div className="model-id">{model.id}</div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>
                </div>

                {currentModelInfo && (
                    <div className="settings-active-model">
                        <span>Active:</span>
                        <strong>{currentModelInfo.label}</strong>
                        <code>{currentModelInfo.id}</code>
                    </div>
                )}

                <button
                    className="btn btn-primary"
                    onClick={handleSave}
                    disabled={saving}
                    style={{ marginTop: 20, width: '100%' }}
                >
                    {saving ? 'Saving...' : '💾 Save Settings'}
                </button>
            </div>
        </div>
    );
}
