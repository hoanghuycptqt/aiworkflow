export const SERVER = window.location.hostname === 'localhost'
    ? 'http://localhost:3001'
    : '';

const API_BASE = `${SERVER}/api`;

class ApiClient {
    constructor() {
        this.token = localStorage.getItem('vcw_token') || null;
    }

    setToken(token) {
        this.token = token;
        if (token) {
            localStorage.setItem('vcw_token', token);
        } else {
            localStorage.removeItem('vcw_token');
        }
    }

    getToken() {
        return this.token;
    }

    async request(path, options = {}) {
        const headers = {
            'Content-Type': 'application/json',
            ...options.headers,
        };

        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        const response = await fetch(`${API_BASE}${path}`, {
            ...options,
            headers,
        });

        const data = await response.json();

        if (!response.ok) {
            const err = new Error(data.error || `Request failed: ${response.status}`);
            if (data.needVerification) err.needVerification = true;
            if (data.email) err.email = data.email;
            throw err;
        }

        return data;
    }

    async register(email, password, name) {
        const data = await this.request('/auth/register', {
            method: 'POST',
            body: JSON.stringify({ email, password, name }),
        });
        if (data.token) {
            this.setToken(data.token);
        }
        return data;
    }

    async login(email, password) {
        const data = await this.request('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        });
        this.setToken(data.token);
        return data;
    }

    async getMe() {
        return this.request('/auth/me');
    }

    logout() {
        this.setToken(null);
    }

    // Workflows
    async getWorkflows() {
        return this.request('/workflows');
    }

    async getWorkflow(id) {
        return this.request(`/workflows/${id}`);
    }

    async createWorkflow(data) {
        return this.request('/workflows', {
            method: 'POST',
            body: JSON.stringify(data),
        });
    }

    async updateWorkflow(id, data) {
        return this.request(`/workflows/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
    }

    async deleteWorkflow(id) {
        return this.request(`/workflows/${id}`, {
            method: 'DELETE',
        });
    }

    async duplicateWorkflow(id) {
        return this.request(`/workflows/${id}/duplicate`, {
            method: 'POST',
        });
    }

    // Credentials
    async getCredentials() {
        return this.request('/credentials');
    }

    async createCredential(data) {
        return this.request('/credentials', {
            method: 'POST',
            body: JSON.stringify(data),
        });
    }

    async updateCredential(id, data) {
        return this.request(`/credentials/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
    }

    async deleteCredential(id) {
        return this.request(`/credentials/${id}`, {
            method: 'DELETE',
        });
    }

    // Executions
    async executeWorkflow(workflowId, instanceCount = 1, inputData = null) {
        return this.request(`/executions/${workflowId}/run`, {
            method: 'POST',
            body: JSON.stringify({ instanceCount, inputData }),
        });
    }

    async getExecutions(workflowId) {
        return this.request(`/executions/${workflowId}`);
    }

    async getExecutionDetail(executionId) {
        return this.request(`/executions/detail/${executionId}`);
    }

    async cancelExecution(executionId) {
        return this.request(`/executions/cancel/${executionId}`, {
            method: 'POST',
        });
    }

    // Jobs
    async getJobs(workflowId) {
        return this.request(`/jobs/${workflowId}`);
    }

    async createJob(workflowId, data) {
        return this.request(`/jobs/${workflowId}`, {
            method: 'POST',
            body: JSON.stringify(data),
        });
    }

    async updateJob(id, data) {
        return this.request(`/jobs/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
    }

    async deleteJob(id) {
        return this.request(`/jobs/${id}`, {
            method: 'DELETE',
        });
    }

    async duplicateJob(id) {
        return this.request(`/jobs/${id}/duplicate`, {
            method: 'POST',
        });
    }

    async reorderJobs(workflowId, jobIds) {
        return this.request(`/jobs/${workflowId}/reorder`, {
            method: 'POST',
            body: JSON.stringify({ jobIds }),
        });
    }

    // Job Batch Execution
    async runJobs(workflowId, jobIds, mode = 'parallel', concurrency = 3) {
        return this.request(`/executions/${workflowId}/run-jobs`, {
            method: 'POST',
            body: JSON.stringify({ jobIds, mode, concurrency }),
        });
    }

    async getBatchStatus(batchId) {
        return this.request(`/executions/batch/${batchId}`);
    }

    async pauseBatch(batchId) {
        return this.request(`/executions/batch/${batchId}/pause`, {
            method: 'POST',
        });
    }

    async resumeBatch(batchId) {
        return this.request(`/executions/batch/${batchId}/resume`, {
            method: 'POST',
        });
    }

    async cancelBatch(batchId) {
        return this.request(`/executions/batch/${batchId}/cancel`, {
            method: 'POST',
        });
    }

    async getJobHistory(workflowId, limit = 10, offset = 0) {
        return this.request(`/executions/${workflowId}/job-history?limit=${limit}&offset=${offset}`);
    }

    async deleteExecution(executionId) {
        return this.request(`/executions/${executionId}`, { method: 'DELETE' });
    }

    // ─── Telegram ────────────────────────────────────────
    async generateTelegramLink() {
        return this.request('/telegram/generate-link', { method: 'POST' });
    }

    async getTelegramAccounts() {
        return this.request('/telegram/linked-accounts');
    }

    async unlinkTelegram(linkId) {
        return this.request(`/telegram/unlink/${linkId}`, { method: 'DELETE' });
    }
}

export const api = new ApiClient();
