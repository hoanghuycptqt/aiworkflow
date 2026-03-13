import { useState, useEffect, useRef, useCallback } from 'react';
import { api, SERVER } from '../../services/api.js';
import Icon from '../../services/icons.jsx';
import toast from 'react-hot-toast';

export default function AuthPage({ onLogin }) {
    const [isLogin, setIsLogin] = useState(true);
    const [form, setForm] = useState({ email: '', password: '', name: '' });
    const [loading, setLoading] = useState(false);
    const [verificationSent, setVerificationSent] = useState(false);
    const [verifyStatus, setVerifyStatus] = useState(null); // null | 'success' | 'error'
    const [unverifiedEmail, setUnverifiedEmail] = useState('');
    const [theme, setTheme] = useState(
        () => document.documentElement.getAttribute('data-theme') || 'dark'
    );
    const googleBtnRef = useRef(null);
    const googleInitRef = useRef(false);

    function toggleTheme() {
        const next = theme === 'dark' ? 'light' : 'dark';
        document.documentElement.classList.add('theme-transitioning');
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
        setTheme(next);
        setTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 350);
    }

    // Initialize Google Sign-In
    useEffect(() => {
        if (googleInitRef.current) return;

        function initGoogle() {
            if (!window.google?.accounts?.id) {
                // GIS script not loaded yet, retry
                setTimeout(initGoogle, 200);
                return;
            }
            googleInitRef.current = true;
            window.google.accounts.id.initialize({
                client_id: '691523742369-iajbsntm2pq5qso2ar37rg11l8m6545p.apps.googleusercontent.com',
                callback: handleGoogleResponse,
            });
            if (googleBtnRef.current) {
                window.google.accounts.id.renderButton(googleBtnRef.current, {
                    theme: theme === 'light' ? 'outline' : 'filled_black',
                    size: 'large',
                    width: '100%',
                    text: 'signin_with',
                    shape: 'rectangular',
                });
            }
        }
        initGoogle();
    }, []);

    // Re-render Google button when theme changes
    useEffect(() => {
        if (!googleInitRef.current || !window.google?.accounts?.id || !googleBtnRef.current) return;
        // Clear and re-render with new theme
        googleBtnRef.current.innerHTML = '';
        window.google.accounts.id.renderButton(googleBtnRef.current, {
            theme: theme === 'light' ? 'outline' : 'filled_black',
            size: 'large',
            width: '100%',
            text: 'signin_with',
            shape: 'rectangular',
        });
    }, [theme]);

    async function handleGoogleResponse(response) {
        try {
            const data = await api.request('/auth/google', {
                method: 'POST',
                body: JSON.stringify({ credential: response.credential }),
            });
            if (data.token) {
                api.setToken(data.token);
                toast.success(`Welcome, ${data.user.name}!`);
                onLogin(data);
            }
        } catch (err) {
            toast.error(err.message || 'Google login failed');
        }
    }

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
                    <div style={{ fontSize: 48, marginBottom: 16 }}><Icon name="mail" size={48} color="var(--accent-primary)" /></div>
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
                    <div style={{ fontSize: 48, marginBottom: 16 }}><Icon name="mail-check" size={48} color="var(--success)" /></div>
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
            <button
                className="auth-theme-toggle"
                onClick={toggleTheme}
                title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            >
                <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
            </button>
            <div className="auth-card">
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <img src="/icon.png" alt="THHFlow" style={{ width: 56, height: 56 }} />
                    <h1 style={{ margin: 0, fontSize: 24, background: 'var(--accent-gradient)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>THHFlow</h1>
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

                {/* Google Sign-In */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0 12px' }}>
                    <div style={{ flex: 1, height: 1, background: 'var(--border-primary)' }} />
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>or</span>
                    <div style={{ flex: 1, height: 1, background: 'var(--border-primary)' }} />
                </div>
                <div ref={googleBtnRef} style={{ display: 'flex', justifyContent: 'center' }} />

                {unverifiedEmail && (
                    <div style={{ marginTop: 16, padding: 12, background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)', borderRadius: 8, textAlign: 'center' }}>
                        <p style={{ fontSize: 13, color: '#f59e0b', marginBottom: 8 }}>
                            <Icon name="alert-triangle" size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Email not verified yet
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
