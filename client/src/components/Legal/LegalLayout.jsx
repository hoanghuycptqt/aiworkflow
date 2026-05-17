import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../../services/icons.jsx';

export default function LegalLayout({ title, lastUpdated, children }) {
    const [theme, setTheme] = useState(
        () => document.documentElement.getAttribute('data-theme') || 'dark'
    );

    function toggleTheme() {
        const next = theme === 'dark' ? 'light' : 'dark';
        document.documentElement.classList.add('theme-transitioning');
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
        setTheme(next);
        setTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 350);
    }

    useEffect(() => {
        window.scrollTo(0, 0);
    }, []);

    return (
        <div className="legal-page">
            <header className="legal-header">
                <Link to="/" className="legal-brand">
                    <img src="/icon.png" alt="THHFlow" />
                    <span>THHFlow</span>
                </Link>
                <button
                    className="auth-theme-toggle"
                    onClick={toggleTheme}
                    title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                    style={{ position: 'static' }}
                >
                    <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
                </button>
            </header>
            <main className="legal-content">
                <h1>{title}</h1>
                {lastUpdated && (
                    <p className="legal-meta">Last updated: {lastUpdated}</p>
                )}
                {children}
            </main>
            <footer className="legal-footer">
                <div className="legal-footer-links">
                    <Link to="/">Home</Link>
                    <Link to="/privacy">Privacy Policy</Link>
                    <Link to="/terms">Terms of Service</Link>
                </div>
                <p>&copy; {new Date().getFullYear()} THHFlow. All rights reserved.</p>
            </footer>
        </div>
    );
}
