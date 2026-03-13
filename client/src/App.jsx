import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { api } from './services/api.js';
import { connectSocket, disconnectSocket } from './services/socket.js';
import AuthPage from './components/Auth/AuthPage.jsx';
import AppLayout from './components/Layout/AppLayout.jsx';
import Dashboard from './components/Dashboard/Dashboard.jsx';
import WorkflowBuilder from './components/WorkflowBuilder/WorkflowBuilder.jsx';
import CredentialsPage from './components/Credentials/CredentialsPage.jsx';
import AdminPage from './components/Admin/AdminPage.jsx';
import './index.css';

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkAuth();
    // Theme init: localStorage > prefers-color-scheme > default dark
    const saved = localStorage.getItem('theme');
    if (saved) {
      document.documentElement.setAttribute('data-theme', saved);
    } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      document.documentElement.setAttribute('data-theme', 'light');
    }

    // E2: Real-time system theme sync — listen for OS theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    function handleSystemThemeChange(e) {
      // Only auto-sync if user hasn't explicitly chosen a theme
      if (!localStorage.getItem('theme')) {
        const systemTheme = e.matches ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', systemTheme);
      }
    }
    mediaQuery.addEventListener('change', handleSystemThemeChange);
    return () => mediaQuery.removeEventListener('change', handleSystemThemeChange);
  }, []);

  async function checkAuth() {
    const token = api.getToken();
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const data = await api.getMe();
      setUser(data.user);
      connectSocket();
    } catch {
      api.logout();
    }
    setLoading(false);
  }

  function handleLogin(userData) {
    setUser(userData.user);
    connectSocket();
  }

  function handleLogout() {
    api.logout();
    disconnectSocket();
    setUser(null);
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <div className="loading-spinner" style={{ width: 40, height: 40 }} />
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-primary)',
            borderRadius: '10px',
            fontSize: '14px',
          },
        }}
      />
      <Routes>
        {!user ? (
          <>
            <Route path="/auth" element={<AuthPage onLogin={handleLogin} />} />
            <Route path="/auth/verify" element={<AuthPage onLogin={handleLogin} />} />
            <Route path="*" element={<Navigate to="/auth" replace />} />
          </>
        ) : (
          <>
            <Route path="/" element={<AppLayout user={user} onLogout={handleLogout} />}>
              <Route index element={<Dashboard />} />
              <Route path="credentials" element={<CredentialsPage />} />
              {user.role === 'admin' && (
                <Route path="admin" element={<AdminPage />} />
              )}
            </Route>
            <Route path="/workflow/:id" element={<WorkflowBuilder />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </>
        )}
      </Routes>
    </BrowserRouter>
  );
}

export default App;
