import { useState, useEffect } from 'react';
import { api } from '../../services/api.js';
import toast from 'react-hot-toast';

export default function AuthPage({ onLogin }) {
    const [isLogin, setIsLogin] = useState(true);
    const [form, setForm] = useState({ email: '', password: '', name: '' });
    const [loading, setLoading] = useState(false);
    const [verificationSent, setVerificationSent] = useState(false);
    const [verifyStatus, setVerifyStatus] = useState(null); // null | 'success' | 'error'
    const [unverifiedEmail, setUnverifiedEmail] = useState('');

    // Handle /auth/verify?token=xxx
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const token = params.get('token');
        if (token) {
            verifyEmail(token);
        }
    }, []);

    async function verifyEmail(token) {
        try {
            const data = await api.request(`/auth/verify?token=${token}`);
            setVerifyStatus('success');
            toast.success(data.message || 'Email verified!');
            // Clean URL
            window.history.replaceState({}, '', '/auth');
        } catch (err) {
            setVerifyStatus('error');
            toast.error(err.message || 'Verification failed');
        }
    }

    async function handleSubmit(e) {
        e.preventDefault();
        setLoading(true);
        setUnverifiedEmail('');
        try {
            if (isLogin) {
                const data = await api.login(form.email, form.password);
                toast.success('Welcome back!');
                onLogin(data);
            } else {
                const data = await api.register(form.email, form.password, form.name);
                if (data.requireVerification) {
                    setVerificationSent(true);
                    toast.success('Check your email!');
                } else {
                    // First user: auto-login
                    toast.success('Account created!');
                    onLogin(data);
                }
            }
        } catch (err) {
            if (err.needVerification) {
                setUnverifiedEmail(err.email || form.email);
            }
            toast.error(err.message);
        }
        setLoading(false);
    }

    async function handleResendVerification() {
        const email = unverifiedEmail || form.email;
        if (!email) return;
        try {
            const data = await api.request('/auth/resend-verification', {
                method: 'POST',
                body: JSON.stringify({ email }),
            });
            toast.success(data.message || 'Verification email sent!');
        } catch (err) {
            toast.error(err.message || 'Failed to resend');
        }
    }

    // Verification sent screen
    if (verificationSent) {
        return (
            <div className="auth-container">
                <div className="auth-card" style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 48, marginBottom: 16 }}>✉️</div>
                    <h1 style={{ background: 'none', WebkitTextFillColor: 'var(--text-primary)', fontSize: 22 }}>
                        Check your email
                    </h1>
                    <p className="subtitle" style={{ marginBottom: 24 }}>
                        We sent a verification link to <br />
                        <strong style={{ color: 'var(--accent-primary)' }}>{form.email}</strong>
                    </p>
                    <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20 }}>
                        Click the link in the email to activate your account.
                    </p>
                    <button className="btn btn-secondary" onClick={handleResendVerification} style={{ marginBottom: 12 }}>
                        Resend verification email
                    </button>
                    <p className="auth-switch">
                        <a href="#" onClick={(e) => { e.preventDefault(); setVerificationSent(false); setIsLogin(true); }}>
                            Back to Sign In
                        </a>
                    </p>
                </div>
            </div>
        );
    }

    // Verify success screen
    if (verifyStatus === 'success') {
        return (
            <div className="auth-container">
                <div className="auth-card" style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
                    <h1 style={{ background: 'none', WebkitTextFillColor: 'var(--text-primary)', fontSize: 22 }}>
                        Email verified!
                    </h1>
                    <p className="subtitle" style={{ marginBottom: 24 }}>
                        Your account is now active. You can log in.
                    </p>
                    <button className="btn btn-primary" onClick={() => setVerifyStatus(null)}>
                        Sign In
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="auth-container">
            <div className="auth-card">
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <img src="/logo.png" alt="THHFlow logo" style={{ width: 64, height: 64, borderRadius: 16 }} />
                    <h1 style={{ margin: 0, fontSize: 24, background: 'var(--gradient-primary)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>THHFlow</h1>
                </div>
                <p className="subtitle">AI Workflow Automation</p>

                <form className="auth-form" onSubmit={handleSubmit}>
                    {!isLogin && (
                        <div className="form-group">
                            <label className="form-label">Name</label>
                            <input
                                className="input"
                                type="text"
                                placeholder="Your name"
                                value={form.name}
                                onChange={(e) => setForm({ ...form, name: e.target.value })}
                                required={!isLogin}
                            />
                        </div>
                    )}

                    <div className="form-group">
                        <label className="form-label">Email</label>
                        <input
                            className="input"
                            type="email"
                            placeholder="you@example.com"
                            value={form.email}
                            onChange={(e) => setForm({ ...form, email: e.target.value })}
                            required
                        />
                    </div>

                    <div className="form-group">
                        <label className="form-label">Password</label>
                        <input
                            className="input"
                            type="password"
                            placeholder="••••••••"
                            value={form.password}
                            onChange={(e) => setForm({ ...form, password: e.target.value })}
                            required
                            minLength={6}
                        />
                    </div>

                    <button className="btn btn-primary" type="submit" disabled={loading}>
                        {loading ? <span className="loading-spinner" /> : null}
                        {isLogin ? 'Sign In' : 'Create Account'}
                    </button>
                </form>

                {unverifiedEmail && (
                    <div style={{ marginTop: 16, padding: 12, background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)', borderRadius: 8, textAlign: 'center' }}>
                        <p style={{ fontSize: 13, color: '#f59e0b', marginBottom: 8 }}>
                            ⚠️ Email not verified yet
                        </p>
                        <button className="btn btn-secondary" onClick={handleResendVerification} style={{ fontSize: 12 }}>
                            Resend verification email
                        </button>
                    </div>
                )}

                <p className="auth-switch">
                    {isLogin ? "Don't have an account? " : 'Already have an account? '}
                    <a href="#" onClick={(e) => { e.preventDefault(); setIsLogin(!isLogin); setUnverifiedEmail(''); }}>
                        {isLogin ? 'Sign Up' : 'Sign In'}
                    </a>
                </p>
            </div>
        </div>
    );
}
