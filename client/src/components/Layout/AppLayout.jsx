import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

export default function AppLayout({ user, onLogout }) {
    const location = useLocation();
    const [sidebarOpen, setSidebarOpen] = useState(false);

    // Auto-close sidebar on navigation
    useEffect(() => {
        setSidebarOpen(false);
    }, [location.pathname]);

    return (
        <div className="app-layout">
            {/* Mobile top bar (visible only on mobile via CSS) */}
            <div className="mobile-topbar">
                <button className="hamburger-btn" onClick={() => setSidebarOpen(true)}>
                    ☰
                </button>
                <span className="mobile-topbar-title">THHFlow</span>
            </div>

            {/* Sidebar overlay (mobile only) */}
            <div
                className={`sidebar-overlay ${sidebarOpen ? 'visible' : ''}`}
                onClick={() => setSidebarOpen(false)}
            />

            <aside className={`app-sidebar ${sidebarOpen ? 'open' : ''}`}>
                <div className="app-sidebar-header">
                    <img src="/icon.png" alt="THHFlow" style={{ width: 36, height: 36 }} />
                    <div>
                        <h1 style={{ fontSize: 18, margin: 0 }}>THHFlow</h1>
                        <p style={{ margin: 0, fontSize: 11 }}>AI Workflow Automation</p>
                    </div>
                </div>

                <nav className="app-sidebar-nav">
                    <NavLink to="/" end className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                        <span className="nav-icon">📋</span>
                        Workflows
                    </NavLink>
                    <NavLink to="/credentials" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                        <span className="nav-icon">🔑</span>
                        Credentials
                    </NavLink>
                    {user.role === 'admin' && (
                        <NavLink to="/admin" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                            <span className="nav-icon">⚙️</span>
                            Admin
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
                    <button className="nav-item" onClick={onLogout} style={{ marginTop: 4 }}>
                        <span className="nav-icon">🚪</span>
                        Logout
                    </button>
                </div>
            </aside>

            <main className="app-main">
                <Outlet />
            </main>
        </div>
    );
}
