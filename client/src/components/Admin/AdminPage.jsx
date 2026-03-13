import { useState } from 'react';
import AdminDashboard from './AdminDashboard.jsx';
import UserManagement from './UserManagement.jsx';
import AdminSettings from './AdminSettings.jsx';
import Icon from '../../services/icons.jsx';

const TABS = [
    { id: 'dashboard', label: 'Dashboard', icon: 'bar-chart' },
    { id: 'users', label: 'Users', icon: 'users' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
];

export default function AdminPage() {
    const [activeTab, setActiveTab] = useState('dashboard');

    return (
        <div className="admin-page">
            <div className="admin-header">
                <h1><Icon name="settings" size={22} style={{ marginRight: 8, verticalAlign: 'middle' }} /> Admin Panel</h1>
                <div className="admin-tabs">
                    {TABS.map(tab => (
                        <button
                            key={tab.id}
                            className={`admin-tab ${activeTab === tab.id ? 'active' : ''}`}
                            onClick={() => setActiveTab(tab.id)}
                        >
                            <Icon name={tab.icon} size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                            {tab.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="admin-content">
                {activeTab === 'dashboard' && <AdminDashboard />}
                {activeTab === 'users' && <UserManagement />}
                {activeTab === 'settings' && <AdminSettings />}
            </div>
        </div>
    );
}
