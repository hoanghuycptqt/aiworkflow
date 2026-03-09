import { useState } from 'react';
import { api } from '../../services/api.js';
import toast from 'react-hot-toast';

export default function AuthPage({ onLogin }) {
    const [isLogin, setIsLogin] = useState(true);
    const [form, setForm] = useState({ email: '', password: '', name: '' });
    const [loading, setLoading] = useState(false);

    async function handleSubmit(e) {
        e.preventDefault();
        setLoading(true);
        try {
            let data;
            if (isLogin) {
                data = await api.login(form.email, form.password);
                toast.success('Welcome back!');
            } else {
                data = await api.register(form.email, form.password, form.name);
                toast.success('Account created!');
            }
            onLogin(data);
        } catch (err) {
            toast.error(err.message);
        }
        setLoading(false);
    }

    return (
        <div className="auth-container">
            <div className="auth-card">
                <h1>⚡ VCW</h1>
                <p className="subtitle">Video Creator Workflow</p>

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

                <p className="auth-switch">
                    {isLogin ? "Don't have an account? " : 'Already have an account? '}
                    <a href="#" onClick={(e) => { e.preventDefault(); setIsLogin(!isLogin); }}>
                        {isLogin ? 'Sign Up' : 'Sign In'}
                    </a>
                </p>
            </div>
        </div>
    );
}
