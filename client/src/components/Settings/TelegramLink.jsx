import { useState, useEffect } from 'react';
import { api } from '../../services/api.js';
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
        try {
            await api.unlinkTelegram(linkId);
            toast.success('Unlinked successfully');
            setAccounts(prev => prev.filter(a => a.id !== linkId));
        } catch (err) {
            toast.error(err.message || 'Failed to unlink');
        }
    }

    return (
        <div style={{
            borderTop: '1px solid var(--border-primary)',
            paddingTop: 24,
            marginTop: 24,
        }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
                🤖 Telegram Bot
            </h3>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
                Link your Telegram account to receive job notifications, create jobs, and manage workflows via chat.
            </p>

            {/* Generate Link Button */}
            <button
                onClick={generateLink}
                disabled={loading}
                style={{
                    padding: '10px 20px',
                    background: 'linear-gradient(135deg, #0088cc, #00a8e8)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    cursor: loading ? 'not-allowed' : 'pointer',
                    fontSize: 14,
                    fontWeight: 600,
                    opacity: loading ? 0.7 : 1,
                    marginBottom: 16,
                }}
            >
                {loading ? '⏳ Generating...' : '📱 Link Telegram Account'}
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
                        🔗 Open in Telegram (@{linkData.botUsername})
                    </a>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                        ⏱ Link expires: {new Date(linkData.expiresAt).toLocaleTimeString()}
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
                                    💬 {acc.label || 'Telegram'}
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
                <div style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                    No Telegram accounts linked yet.
                </div>
            )}
        </div>
    );
}
