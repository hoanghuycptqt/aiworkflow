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
import './index.css';

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkAuth();
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
            background: '#1a1a2e',
            color: '#f0f0f5',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '10px',
            fontSize: '14px',
          },
        }}
      />
      <Routes>
        {!user ? (
          <>
            <Route path="/auth" element={<AuthPage onLogin={handleLogin} />} />
            <Route path="*" element={<Navigate to="/auth" replace />} />
          </>
        ) : (
          <>
            <Route path="/" element={<AppLayout user={user} onLogout={handleLogout} />}>
              <Route index element={<Dashboard />} />
              <Route path="credentials" element={<CredentialsPage />} />
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
