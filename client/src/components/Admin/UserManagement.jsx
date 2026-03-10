import { useState, useEffect } from 'react';
import { api } from '../../services/api.js';
import toast from 'react-hot-toast';

export default function UserManagement() {
    const [users, setUsers] = useState([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [roleFilter, setRoleFilter] = useState('');
    const [statusFilter, setStatusFilter] = useState('');
    const [modal, setModal] = useState(null); // null | { mode: 'create' | 'edit' | 'password', user? }
    const [form, setForm] = useState({ name: '', email: '', password: '', role: 'user' });

    useEffect(() => {
        loadUsers();
    }, [search, roleFilter, statusFilter]);

    async function loadUsers() {
        try {
            const params = new URLSearchParams();
            if (search) params.set('search', search);
            if (roleFilter) params.set('role', roleFilter);
            if (statusFilter) params.set('status', statusFilter);
            const result = await api.request(`/admin/users?${params}`);
            setUsers(result.users);
            setTotal(result.total);
        } catch (err) {
            toast.error('Failed to load users');
        }
        setLoading(false);
    }

    function openCreate() {
        setForm({ name: '', email: '', password: '', role: 'user' });
        setModal({ mode: 'create' });
    }

    function openEdit(user) {
        setForm({ name: user.name, email: user.email, role: user.role });
        setModal({ mode: 'edit', user });
    }

    function openResetPassword(user) {
        setForm({ password: '' });
        setModal({ mode: 'password', user });
    }

    async function handleSubmit(e) {
        e.preventDefault();
        try {
            if (modal.mode === 'create') {
                await api.request('/admin/users', {
                    method: 'POST',
                    body: JSON.stringify(form),
                });
                toast.success('User created');
            } else if (modal.mode === 'edit') {
                await api.request(`/admin/users/${modal.user.id}`, {
                    method: 'PUT',
                    body: JSON.stringify({ name: form.name, email: form.email, role: form.role }),
                });
                toast.success('User updated');
            } else if (modal.mode === 'password') {
                await api.request(`/admin/users/${modal.user.id}/reset-password`, {
                    method: 'PUT',
                    body: JSON.stringify({ password: form.password }),
                });
                toast.success('Password reset');
            }
            setModal(null);
            loadUsers();
        } catch (err) {
            toast.error(err.message || 'Operation failed');
        }
    }

    async function toggleActive(user) {
        try {
            await api.request(`/admin/users/${user.id}`, {
                method: 'PUT',
                body: JSON.stringify({ isActive: !user.isActive }),
            });
            toast.success(user.isActive ? 'User disabled' : 'User enabled');
            loadUsers();
        } catch (err) {
            toast.error(err.message || 'Failed');
        }
    }

    async function deleteUser(user) {
        if (!confirm(`Delete "${user.name}" permanently? All their data will be lost.`)) return;
        try {
            await api.request(`/admin/users/${user.id}`, { method: 'DELETE' });
            toast.success('User deleted');
            loadUsers();
        } catch (err) {
            toast.error(err.message || 'Failed');
        }
    }

    if (loading) return <div className="admin-loading"><div className="loading-spinner" /></div>;

    return (
        <div className="user-management">
            {/* Toolbar */}
            <div className="um-toolbar">
                <input
                    type="text"
                    placeholder="🔍 Search by name or email..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="um-search"
                />
                <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)} className="um-filter">
                    <option value="">All Roles</option>
                    <option value="admin">Admin</option>
                    <option value="user">User</option>
                    <option value="viewer">Viewer</option>
                </select>
                <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="um-filter">
                    <option value="">All Status</option>
                    <option value="active">Active</option>
                    <option value="disabled">Disabled</option>
                </select>
                <button className="btn btn-primary" onClick={openCreate}>+ New User</button>
            </div>

            <div className="um-count">{total} user{total !== 1 ? 's' : ''}</div>

            {/* Table */}
            <div className="um-table-wrapper">
                <table className="um-table">
                    <thead>
                        <tr>
                            <th>User</th>
                            <th>Role</th>
                            <th>Status</th>
                            <th>Last Login</th>
                            <th>Created</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {users.map(user => (
                            <tr key={user.id} className={!user.isActive ? 'disabled-row' : ''}>
                                <td>
                                    <div className="um-user-cell">
                                        <div className="user-avatar-sm">{user.name?.[0]?.toUpperCase() || 'U'}</div>
                                        <div>
                                            <div className="um-user-name">{user.name}</div>
                                            <div className="um-user-email">{user.email}</div>
                                        </div>
                                    </div>
                                </td>
                                <td><span className={`role-badge role-${user.role}`}>{user.role}</span></td>
                                <td>
                                    <span className={`status-badge ${user.isActive ? 'status-completed' : 'status-failed'}`}>
                                        {user.isActive ? 'Active' : 'Disabled'}
                                    </span>
                                </td>
                                <td className="um-date">{user.lastLoginAt ? formatDate(user.lastLoginAt) : 'Never'}</td>
                                <td className="um-date">{formatDate(user.createdAt)}</td>
                                <td>
                                    <div className="um-actions">
                                        <button className="um-btn" title="Edit" onClick={() => openEdit(user)}>✏️</button>
                                        <button className="um-btn" title="Reset Password" onClick={() => openResetPassword(user)}>🔑</button>
                                        <button className="um-btn" title={user.isActive ? 'Disable' : 'Enable'} onClick={() => toggleActive(user)}>
                                            {user.isActive ? '🚫' : '✅'}
                                        </button>
                                        <button className="um-btn um-btn-danger" title="Delete" onClick={() => deleteUser(user)}>🗑️</button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Modal */}
            {modal && (
                <div className="modal-overlay" onClick={() => setModal(null)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()}>
                        <h3>
                            {modal.mode === 'create' ? '➕ Create User' :
                                modal.mode === 'edit' ? `✏️ Edit ${modal.user.name}` :
                                    `🔑 Reset Password — ${modal.user.name}`}
                        </h3>
                        <form onSubmit={handleSubmit}>
                            {modal.mode !== 'password' && (
                                <>
                                    <div className="form-group">
                                        <label>Name</label>
                                        <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
                                    </div>
                                    <div className="form-group">
                                        <label>Email</label>
                                        <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required />
                                    </div>
                                </>
                            )}
                            {(modal.mode === 'create' || modal.mode === 'password') && (
                                <div className="form-group">
                                    <label>Password</label>
                                    <input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required minLength={6} />
                                </div>
                            )}
                            {modal.mode !== 'password' && (
                                <div className="form-group">
                                    <label>Role</label>
                                    <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
                                        <option value="admin">Admin</option>
                                        <option value="user">User</option>
                                        <option value="viewer">Viewer</option>
                                    </select>
                                </div>
                            )}
                            <div className="modal-actions">
                                <button type="button" className="btn" onClick={() => setModal(null)}>Cancel</button>
                                <button type="submit" className="btn btn-primary">
                                    {modal.mode === 'create' ? 'Create' : modal.mode === 'edit' ? 'Save' : 'Reset'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString('vi-VN', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}
