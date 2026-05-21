import { useState, useEffect } from 'react';
import { api } from '../../services/api.js';
import Icon from '../../services/icons.jsx';
import toast from 'react-hot-toast';

/**
 * TelegramLink — Component for linking/unlinking Telegram accounts.
 * Shows deep link button and list of linked accounts.
 */
export default function TelegramLink() {
    const [accounts, setAccounts] = useState([]);
    const [linkData, setLinkData] = useState(null); // { deepLink, token, expiresAt }
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        loadAccounts();
    }, []);

    async function loadAccounts() {
        try {
            const data = await api.getTelegramAccounts();
            setAccounts(data.accounts || []);
        } catch (err) {
            console.error('Failed to load Telegram accounts:', err);
        }
    }

    async function generateLink() {
        setLoading(true);
        try {
            const data = await api.generateTelegramLink();
            setLinkData(data);
            toast.success('Link created! Click to open Telegram.');
        } catch (err) {
            toast.error(err.message || 'Failed to generate link');
        }
        setLoading(false);
    }

    async function unlinkAccount(linkId) {
        if (!window.confirm('Are you sure you want to unlink this Telegram account?')) return;
        try {
            await api.unlinkTelegram(linkId);
            toast.success('Unlinked successfully');
            setAccounts(prev => prev.filter(a => a.id !== linkId));
        } catch (err) {
            toast.error(err.message || 'Failed to unlink');
        }
    }

    return (
        <section className="tg-section">
            <div className="tg-section-inner">
                <span className="dashboard-eyebrow">RUN FROM YOUR PHONE · ANY TIME</span>
                <h2>Open in <em>Telegram.</em></h2>
                <p>
                    Link your Telegram account to receive job notifications, create jobs, and
                    manage workflows from chat — perfect for kicking off long-running renders
                    while you're away from the canvas.
                </p>

                {/* Generate Link Button */}
                <button
                    className="btn btn-primary"
                    onClick={generateLink}
                    disabled={loading}
                    style={{ marginBottom: 18 }}
                >
                    {loading ? <><Icon name="loader" size={14} className="loading-spinner" style={{ marginRight: 4 }} /> Generating…</> : <><Icon name="smartphone" size={14} style={{ marginRight: 4 }} /> Link Telegram account</>}
                </button>

            {/* Deep Link Display */}
            {linkData && (
                <div style={{
                    padding: 16,
                    background: 'var(--bg-tertiary)',
                    borderRadius: 8,
                    border: '1px solid var(--border-primary)',
                    marginBottom: 16,
                }}>
                    <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>
                        Click the link below to open Telegram and link your account:
                    </div>
                    <a
                        href={linkData.deepLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                            display: 'inline-block',
                            padding: '8px 16px',
                            background: '#0088cc',
                            color: '#fff',
                            borderRadius: 6,
                            textDecoration: 'none',
                            fontSize: 14,
                            fontWeight: 500,
                        }}
                    >
                        <Icon name="link" size={14} style={{ marginRight: 4 }} /> Open in Telegram (@{linkData.botUsername})
                    </a>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                        <Icon name="timer" size={11} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Link expires: {new Date(linkData.expiresAt).toLocaleTimeString()}
                    </div>
                </div>
            )}

            {/* Linked Accounts List */}
            {accounts.length > 0 && (
                <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
                        Linked Accounts ({accounts.length})
                    </div>
                    {accounts.map(acc => (
                        <div key={acc.id} style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '10px 14px',
                            background: 'var(--bg-tertiary)',
                            borderRadius: 6,
                            marginBottom: 6,
                            border: '1px solid var(--border-primary)',
                        }}>
                            <div>
                                <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                                    <Icon name="message-square" size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} /> {acc.label || 'Telegram'}
                                </span>
                                <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>
                                    Chat ID: {acc.chatId}
                                </span>
                                <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>
                                    {new Date(acc.createdAt).toLocaleDateString('vi-VN')}
                                </span>
                            </div>
                            <button
                                onClick={() => unlinkAccount(acc.id)}
                                style={{
                                    padding: '4px 12px',
                                    background: 'transparent',
                                    color: '#ef4444',
                                    border: '1px solid #ef4444',
                                    borderRadius: 4,
                                    cursor: 'pointer',
                                    fontSize: 12,
                                }}
                            >
                                Unlink
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {accounts.length === 0 && (
                <div style={{ fontSize: 13, color: 'var(--ink-muted)', fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}>
                    No Telegram accounts linked yet.
                </div>
            )}
            </div>
        </section>
    );
}
