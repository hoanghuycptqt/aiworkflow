import { useState } from 'react';
import AdminDashboard from './AdminDashboard.jsx';
import UserManagement from './UserManagement.jsx';

const TABS = [
    { id: 'dashboard', label: '📊 Dashboard', icon: '📊' },
    { id: 'users', label: '👥 Users', icon: '👥' },
];

export default function AdminPage() {
    const [activeTab, setActiveTab] = useState('dashboard');

    return (
        <div className="admin-page">
            <div className="admin-header">
                <h1>⚙️ Admin Panel</h1>
                <div className="admin-tabs">
                    {TABS.map(tab => (
                        <button
                            key={tab.id}
                            className={`admin-tab ${activeTab === tab.id ? 'active' : ''}`}
                            onClick={() => setActiveTab(tab.id)}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="admin-content">
                {activeTab === 'dashboard' && <AdminDashboard />}
                {activeTab === 'users' && <UserManagement />}
            </div>
        </div>
    );
}
