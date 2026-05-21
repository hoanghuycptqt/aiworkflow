import { useState } from 'react';
import AdminDashboard from './AdminDashboard.jsx';
import UserManagement from './UserManagement.jsx';
import AdminSettings from './AdminSettings.jsx';
import AdminAnalytics from './analytics/AdminAnalytics.jsx';
import Icon from '../../services/icons.jsx';

const TABS = [
    { id: 'dashboard', label: 'Dashboard', icon: 'bar-chart' },
    { id: 'analytics', label: 'Analytics', icon: 'flame' },
    { id: 'users', label: 'Users', icon: 'users' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
];

export default function AdminPage() {
    const [activeTab, setActiveTab] = useState('dashboard');

    return (
        <div className="admin-page">
            <div className="admin-header">
                <div className="dashboard-header-body">
                    <span className="dashboard-eyebrow">OPERATIONS · THE BACK OFFICE</span>
                    <h1>Admin <em>panel.</em></h1>
                </div>
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
                {activeTab === 'analytics' && <AdminAnalytics />}
                {activeTab === 'users' && <UserManagement />}
                {activeTab === 'settings' && <AdminSettings />}
            </div>
        </div>
    );
}

