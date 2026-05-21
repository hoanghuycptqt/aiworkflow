import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api.js';
import Icon from '../../services/icons.jsx';
import Logo, { Wordmark } from '../../services/Logo.jsx';
import toast from 'react-hot-toast';

function passwordStrength(pw) {
    if (!pw) return 0;
    let score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
    return score; // 0..4
}

function AuthAside() {
    return (
        <aside className="auth-aside" aria-hidden="true">
            <div className="auth-aside-top">
                <Link to="/" className="auth-aside-brand">
                    <Logo chip size={30} />
                    <Wordmark size={22} />
                </Link>
                <div className="auth-aside-stamp">
                    EST. 2025<br />VISUAL AI WORKFLOWS
                </div>
            </div>
            <div className="auth-aside-art">
                {/* Editorial SVG composition — wired flow nodes */}
                <svg viewBox="0 0 360 320" width="100%" style={{ maxWidth: 360 }}>
                    {/* Dot grid background */}
                    <defs>
                        <pattern id="auth-dots" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
                            <circle cx="1" cy="1" r="1" fill="rgba(42,37,32,0.08)" />
                        </pattern>
                    </defs>
                    <rect width="360" height="320" fill="url(#auth-dots)" />
                    {/* Flow curves */}
                    <path d="M 60 80 Q 140 60 200 130 T 320 200" stroke="var(--ink)" strokeWidth="1.5" fill="none" strokeLinecap="round" />
                    <path d="M 60 200 Q 130 240 220 220 T 320 130" stroke="var(--ink)" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeDasharray="2 4" />
                    {/* Nodes */}
                    <g>
                        <circle cx="60" cy="80" r="18" fill="var(--peach)" stroke="var(--ink)" strokeWidth="1.5" />
                        <circle cx="200" cy="130" r="22" fill="var(--lavender)" stroke="var(--ink)" strokeWidth="1.5" />
                        <circle cx="320" cy="200" r="18" fill="var(--butter)" stroke="var(--ink)" strokeWidth="1.5" />
                        <circle cx="60" cy="200" r="14" fill="var(--sage)" stroke="var(--ink)" strokeWidth="1.5" />
                        <circle cx="220" cy="220" r="14" fill="var(--sky)" stroke="var(--ink)" strokeWidth="1.5" />
                        <circle cx="320" cy="130" r="14" fill="var(--peach-soft)" stroke="var(--ink)" strokeWidth="1.5" />
                    </g>
                </svg>
            </div>
            <p className="auth-aside-quote">
                &ldquo;Wire the idea once. Run it <em>a hundred times.</em>&rdquo;
            </p>
        </aside>
    );
}

export default function AuthPage({ onLogin }) {
    const [isLogin, setIsLogin] = useState(true);
    const [form, setForm] = useState({ email: '', password: '', name: '' });
    const [loading, setLoading] = useState(false);
    const [verificationSent, setVerificationSent] = useState(false);
    const [verifyStatus, setVerifyStatus] = useState(null); // null | 'success' | 'error'
    const [unverifiedEmail, setUnverifiedEmail] = useState('');
    const [theme, setTheme] = useState(
        () => document.documentElement.getAttribute('data-theme') || 'light'
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
                    shape: 'pill',
                });
            }
        }
        initGoogle();
    }, []);

    // Re-render Google button when theme changes
    useEffect(() => {
        if (!googleInitRef.current || !window.google?.accounts?.id || !googleBtnRef.current) return;
        googleBtnRef.current.innerHTML = '';
        window.google.accounts.id.renderButton(googleBtnRef.current, {
            theme: theme === 'light' ? 'outline' : 'filled_black',
            size: 'large',
            width: '100%',
            text: 'signin_with',
            shape: 'pill',
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

    // — Verification-sent state —
    if (verificationSent) {
        return (
            <div className="auth-container">
                <AuthAside />
                <main className="auth-main">
                    <button
                        className="auth-theme-toggle"
                        onClick={toggleTheme}
                        title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                    >
                        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
                    </button>
                    <div className="auth-card auth-state">
                        <div className="auth-state-circle auth-state-circle--butter">
                            <Icon name="mail" size={40} />
                            <span className="auth-state-circle-badge">1</span>
                        </div>
                        <h1>Check your <em>inbox.</em></h1>
                        <p className="subtitle" style={{ textAlign: 'center' }}>
                            We sent a verification link to{' '}
                            <strong style={{ color: 'var(--ink)' }}>{form.email}</strong>. Click the
                            link to activate your account.
                        </p>
                        <div className="auth-state-timer">
                            <Icon name="timer" size={12} /> Link expires in 59 min 42 sec
                        </div>
                        <button className="btn btn-primary" onClick={handleResendVerification} style={{ width: '100%' }}>
                            Resend verification email
                        </button>
                        <p className="auth-switch" style={{ marginTop: 18, textAlign: 'center', fontSize: 13, color: 'var(--ink-muted)' }}>
                            <a href="#" onClick={(e) => { e.preventDefault(); setVerificationSent(false); setIsLogin(true); }}
                                style={{ color: 'var(--ink)' }}>
                                ← Back to sign in
                            </a>
                        </p>
                    </div>
                </main>
            </div>
        );
    }

    // — Verified state —
    if (verifyStatus === 'success') {
        return (
            <div className="auth-container">
                <AuthAside />
                <main className="auth-main">
                    <button
                        className="auth-theme-toggle"
                        onClick={toggleTheme}
                        title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                    >
                        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
                    </button>
                    <div className="auth-card auth-state">
                        <div className="auth-state-circle auth-state-circle--sage">
                            <Icon name="check-circle" size={40} />
                            {/* Decorative ring (dashed) */}
                            <svg
                                width="120" height="120" viewBox="0 0 120 120"
                                style={{ position: 'absolute', inset: -12, pointerEvents: 'none' }}
                                aria-hidden="true"
                            >
                                <circle cx="60" cy="60" r="56" fill="none" stroke="var(--sage)" strokeWidth="1.5" strokeDasharray="2 6">
                                    <animateTransform attributeName="transform" attributeType="XML" type="rotate"
                                        from="0 60 60" to="360 60 60" dur="14s" repeatCount="indefinite" />
                                </circle>
                            </svg>
                        </div>
                        <h1><em>Verified.</em> Welcome aboard.</h1>
                        <p className="subtitle" style={{ textAlign: 'center' }}>
                            Your account is now active. Time to open the canvas.
                        </p>
                        <button className="btn btn-primary" onClick={() => setVerifyStatus(null)} style={{ width: '100%' }}>
                            Open the canvas
                        </button>
                    </div>
                </main>
            </div>
        );
    }

    // — Default: sign-in / create-account form —
    const strength = !isLogin ? passwordStrength(form.password) : 0;

    return (
        <div className="auth-container">
            <AuthAside />
            <main className="auth-main">
                <button
                    className="auth-theme-toggle"
                    onClick={toggleTheme}
                    title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                >
                    <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
                </button>
                <div className="auth-card">
                    <span className="auth-eyebrow">{isLogin ? 'WELCOME BACK' : 'CREATE YOUR ACCOUNT'}</span>
                    <h1>Open the <em>canvas.</em></h1>
                    <p className="subtitle">
                        {isLogin
                            ? 'Sign in to pick up where you left off — drafts, runs, and credentials are all where you left them.'
                            : 'Spin up an account in seconds. No credit card, bring your own AI keys, cancel any time.'}
                    </p>

                    <div className="auth-tabs" role="tablist" aria-label="Authentication mode">
                        <button
                            type="button"
                            className={`auth-tab${isLogin ? ' active' : ''}`}
                            role="tab"
                            aria-selected={isLogin}
                            onClick={() => { setIsLogin(true); setUnverifiedEmail(''); }}
                        >
                            Sign in
                        </button>
                        <button
                            type="button"
                            className={`auth-tab${!isLogin ? ' active' : ''}`}
                            role="tab"
                            aria-selected={!isLogin}
                            onClick={() => { setIsLogin(false); setUnverifiedEmail(''); }}
                        >
                            Create account
                        </button>
                    </div>

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
                            {!isLogin && (
                                <div className="auth-strength" aria-label={`Password strength ${strength} of 4`}>
                                    {[0, 1, 2, 3].map((i) => (
                                        <span
                                            key={i}
                                            className={`auth-strength-seg${i < strength ? ' lit' : ''}${i < strength && strength === 4 ? ' strong' : ''}`}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>

                        <button className="btn btn-primary" type="submit" disabled={loading}>
                            {loading ? <span className="loading-spinner" /> : null}
                            {isLogin ? 'Open the canvas' : 'Create my account'}
                        </button>
                    </form>

                    {/* Google Sign-In */}
                    <div className="auth-divider">
                        <div className="auth-divider-line" />
                        <span className="auth-divider-label">OR</span>
                        <div className="auth-divider-line" />
                    </div>
                    <div ref={googleBtnRef} style={{ display: 'flex', justifyContent: 'center' }} />

                    {unverifiedEmail && (
                        <div style={{ marginTop: 16, padding: 12, background: 'var(--butter-soft)', border: '1px solid var(--butter)', borderRadius: 'var(--r-md)', textAlign: 'center' }}>
                            <p style={{ fontSize: 13, color: 'var(--ink)', marginBottom: 8 }}>
                                <Icon name="alert-triangle" size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Email not verified yet
                            </p>
                            <button className="btn btn-ghost btn-sm" onClick={handleResendVerification}>
                                Resend verification email
                            </button>
                        </div>
                    )}

                    <div className="auth-legal-links">
                        <Link to="/privacy">Privacy</Link>
                        <span>·</span>
                        <Link to="/terms">Terms</Link>
                    </div>
                </div>
            </main>
        </div>
    );
}
