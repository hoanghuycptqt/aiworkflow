import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../../services/icons.jsx';
import Logo, { Wordmark } from '../../services/Logo.jsx';

function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

export default function LegalLayout({ title, lastUpdated, version = '1.0', effectiveDate, children }) {
    const [theme, setTheme] = useState(
        () => document.documentElement.getAttribute('data-theme') || 'light'
    );
    const [toc, setToc] = useState([]);
    const [activeId, setActiveId] = useState('');
    const bodyRef = useRef(null);

    function toggleTheme() {
        const next = theme === 'dark' ? 'light' : 'dark';
        document.documentElement.classList.add('theme-transitioning');
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
        setTheme(next);
        setTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 350);
    }

    useEffect(() => {
        document.documentElement.classList.add('public-page');
        window.scrollTo(0, 0);
        return () => document.documentElement.classList.remove('public-page');
    }, []);

    // Build the TOC from the rendered h2 elements + assign ids
    useEffect(() => {
        if (!bodyRef.current) return;
        const items = [];
        bodyRef.current.querySelectorAll('h2').forEach((h, i) => {
            const text = h.textContent.trim();
            const id = h.id || slugify(text) || `section-${i + 1}`;
            h.id = id;
            items.push({ id, text });
        });
        setToc(items);

        // Intersection observer to highlight the active section
        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) setActiveId(entry.target.id);
                });
            },
            { rootMargin: '-30% 0px -60% 0px' }
        );
        items.forEach((item) => {
            const el = document.getElementById(item.id);
            if (el) observer.observe(el);
        });
        return () => observer.disconnect();
    }, [children]);

    return (
        <div className="legal-page">
            <header className="legal-header">
                <Link to="/" className="legal-brand">
                    <Logo chip size={28} />
                    <Wordmark size={20} />
                </Link>
                <div className="legal-header-actions">
                    <Link to="/" className="legal-back-link">
                        <Icon name="arrow-left" size={14} /> Back to home
                    </Link>
                    <Link to="/privacy" className="legal-header-link">Privacy</Link>
                    <Link to="/terms" className="legal-header-link">Terms</Link>
                    <button
                        className="auth-theme-toggle"
                        onClick={toggleTheme}
                        title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                        style={{ position: 'static' }}
                    >
                        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
                    </button>
                </div>
            </header>
            <main className="legal-content">
                <aside className="legal-toc" aria-label="On this page">
                    {toc.map((item) => (
                        <a
                            key={item.id}
                            href={`#${item.id}`}
                            className={`legal-toc-item${activeId === item.id ? ' active' : ''}`}
                        >
                            {item.text}
                        </a>
                    ))}
                </aside>
                <div className="legal-body" ref={bodyRef}>
                    <h1>{title}</h1>
                    <div className="legal-meta">
                        <div className="legal-meta-item">
                            Version
                            <strong>v{version}</strong>
                        </div>
                        {lastUpdated && (
                            <div className="legal-meta-item">
                                Last updated
                                <strong>{lastUpdated}</strong>
                            </div>
                        )}
                        {effectiveDate && (
                            <div className="legal-meta-item">
                                Effective
                                <strong>{effectiveDate}</strong>
                            </div>
                        )}
                    </div>
                    {children}
                </div>
            </main>
            <footer className="legal-footer">
                <div className="legal-footer-links">
                    <Link to="/">Home</Link>
                    <Link to="/privacy">Privacy Policy</Link>
                    <Link to="/terms">Terms of Service</Link>
                </div>
                <p>&copy; {new Date().getFullYear()} THHFlow · All rights reserved</p>
            </footer>
        </div>
    );
}
