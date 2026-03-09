import { NavLink, Outlet, useLocation } from 'react-router-dom';

export default function AppLayout({ user, onLogout }) {
    const location = useLocation();

    return (
        <div className="app-layout">
            <aside className="app-sidebar">
                <div className="app-sidebar-header">
                    <h1>⚡ VCW</h1>
                    <p>Video Creator Workflow</p>
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
                </nav>

                <div className="app-sidebar-footer">
                    <div className="user-info">
                        <div className="user-avatar">
                            {user.name?.[0]?.toUpperCase() || 'U'}
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                            <div className="user-name">{user.name}</div>
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
