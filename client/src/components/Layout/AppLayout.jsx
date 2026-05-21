import { useState, useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import Icon from '../../services/icons.jsx';
import Logo, { Wordmark } from '../../services/Logo.jsx';

export default function AppLayout({ user, onLogout }) {
    const location = useLocation();
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [theme, setTheme] = useState(
        () => document.documentElement.getAttribute('data-theme') || 'light'
    );

    function toggleTheme() {
        const next = theme === 'dark' ? 'light' : 'dark';
        document.documentElement.classList.add('theme-transitioning');
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
        setTheme(next);
        setTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 350);
    }

    // Auto-close sidebar on navigation
    useEffect(() => {
        setSidebarOpen(false);
    }, [location.pathname]);

    return (
        <div className="app-layout">
            {/* Mobile top bar (visible only on mobile via CSS) */}
            <div className="mobile-topbar">
                <button className="hamburger-btn" onClick={() => setSidebarOpen(true)}>
                    <Icon name="list-ordered" size={20} />
                </button>
                <span className="mobile-topbar-title">THHFlow</span>
            </div>

            {/* Sidebar overlay (mobile only) */}
            <div
                className={`sidebar-overlay ${sidebarOpen ? 'visible' : ''}`}
                onClick={() => setSidebarOpen(false)}
            />

            <aside className={`app-sidebar ${sidebarOpen ? 'open' : ''}`}>
                <Link to="/" className="app-sidebar-header">
                    <Logo chip size={30} />
                    <div>
                        <Wordmark size={22} />
                        <p>AI WORKFLOW AUTOMATION</p>
                    </div>
                </Link>

                <nav className="app-sidebar-nav">
                    <NavLink to="/" end className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                        <span className="nav-icon"><Icon name="workflow" size={18} /></span>
                        Workflows
                    </NavLink>
                    <NavLink to="/credentials" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                        <span className="nav-icon"><Icon name="key" size={18} /></span>
                        Credentials
                    </NavLink>
                    {user.role === 'admin' && (
                        <NavLink to="/admin" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                            <span className="nav-icon"><Icon name="settings" size={18} /></span>
                            Admin
                            <span className="nav-item-badge">ADMIN</span>
                        </NavLink>
                    )}
                </nav>

                <div className="app-sidebar-footer">
                    <div className="user-info">
                        <div className="user-avatar">
                            {user.name?.[0]?.toUpperCase() || 'U'}
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                            <div className="user-name">
                                {user.name}
                                <span className={`role-badge role-${user.role}`}>{user.role}</span>
                            </div>
                            <div className="user-email">{user.email}</div>
                        </div>
                    </div>
                    <button className="nav-item" onClick={toggleTheme} style={{ marginTop: 4 }} title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}>
                        <span className="nav-icon"><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} /></span>
                        {theme === 'dark' ? 'Light mode' : 'Dark mode'}
                    </button>
                    <button className="nav-item" onClick={onLogout} style={{ marginTop: 4 }}>
                        <span className="nav-icon"><Icon name="logout" size={18} /></span>
                        Sign out
                    </button>
                    <div className="auth-legal-links" style={{ marginTop: 12 }}>
                        <Link to="/privacy">Privacy</Link>
                        <span>·</span>
                        <Link to="/terms">Terms</Link>
                    </div>
                </div>
            </aside>

            <main className="app-main">
                <Outlet />
            </main>
        </div>
    );
}
