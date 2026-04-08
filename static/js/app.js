// John the Ripper Web UI - JavaScript
const API_BASE = '/api';
let currentJobs = {};
let refreshInterval = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    console.log('John the Ripper Web UI Initialized');
    
    // Load system info
    loadSystemInfo();
    
    // Setup form handlers
    setupFormHandlers();
    
    // Start auto-refresh
    startAutoRefresh();
    
    // Load initial jobs
    refreshJobs();
});

// Load system information
async function loadSystemInfo() {
    try {
        const response = await fetch(`${API_BASE}/info`);
        const data = await response.json();
        
        if (data.status === 'success') {
            document.getElementById('version-info').textContent = data.version;
        }
    } catch (error) {
        console.error('Failed to load system info:', error);
        showToast('Failed to connect to server', 'error');
    }
}

// Setup form handlers
function setupFormHandlers() {
    const form = document.getElementById('crack-form');
    const modeSelect = document.getElementById('crack-mode');
    const wordlistGroup = document.getElementById('wordlist-group');
    const fileInput = document.getElementById('hash-file');
    
    // Mode change handler
    modeSelect.addEventListener('change', function() {
        if (this.value === 'wordlist') {
            wordlistGroup.style.display = 'block';
        } else {
            wordlistGroup.style.display = 'none';
        }
    });
    
    // File input handler
    fileInput.addEventListener('change', function() {
        if (this.files.length > 0) {
            const fileName = this.files[0].name;
            const display = document.querySelector('.file-upload-display span');
            display.textContent = `Selected: ${fileName}`;
        }
    });
    
    // Form submit handler
    form.addEventListener('submit', async function(e) {
        e.preventDefault();
        await startCrackingJob();
    });
    
    // Reset handler
    form.addEventListener('reset', function() {
        const display = document.querySelector('.file-upload-display span');
        display.textContent = 'Click to upload or drag and drop';
        document.getElementById('upload-status').innerHTML = '';
        wordlistGroup.style.display = 'none';
    });
}

// Start cracking job
async function startCrackingJob() {
    const fileInput = document.getElementById('hash-file');
    const mode = document.getElementById('crack-mode').value;
    const wordlistPath = document.getElementById('wordlist-path').value;
    const uploadStatus = document.getElementById('upload-status');
    
    if (!fileInput.files.length) {
        showToast('Please select a hash file', 'error');
        return;
    }
    
    try {
        // Upload file first
        uploadStatus.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading file...';
        
        const formData = new FormData();
        formData.append('file', fileInput.files[0]);
        
        const uploadResponse = await fetch(`${API_BASE}/upload`, {
            method: 'POST',
            body: formData
        });
        
        const uploadData = await uploadResponse.json();
        
        if (uploadData.status !== 'success') {
            throw new Error(uploadData.message || 'Upload failed');
        }
        
        uploadStatus.innerHTML = `<i class="fas fa-check-circle"></i> File uploaded successfully`;
        uploadStatus.className = 'upload-status success';
        
        // Start cracking job
        const jobData = {
            hash_file: uploadData.filepath,
            mode: mode,
            wordlist: mode === 'wordlist' && wordlistPath ? wordlistPath : null
        };
        
        const crackResponse = await fetch(`${API_BASE}/crack`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(jobData)
        });
        
        const crackData = await crackResponse.json();
        
        if (crackData.status === 'success') {
            showToast('Cracking job started successfully!', 'success');
            document.getElementById('crack-form').reset();
            uploadStatus.innerHTML = '';
            document.querySelector('.file-upload-display span').textContent = 'Click to upload or drag and drop';
            
            // Refresh jobs immediately
            setTimeout(() => refreshJobs(), 500);
        } else {
            throw new Error(crackData.message || 'Failed to start job');
        }
        
    } catch (error) {
        console.error('Error starting job:', error);
        uploadStatus.innerHTML = `<i class="fas fa-exclamation-circle"></i> Error: ${error.message}`;
        uploadStatus.className = 'upload-status error';
        showToast(`Error: ${error.message}`, 'error');
    }
}

// Refresh all jobs
async function refreshJobs() {
    try {
        const response = await fetch(`${API_BASE}/jobs`);
        const data = await response.json();
        
        if (data.status === 'success') {
            currentJobs = {};
            data.jobs.forEach(job => {
                currentJobs[job.job_id] = job;
            });
            
            updateJobsList();
            updateStats();
        }
    } catch (error) {
        console.error('Failed to refresh jobs:', error);
    }
}

// Update jobs list display
function updateJobsList() {
    const jobsList = document.getElementById('jobs-list');
    const historyList = document.getElementById('history-list');
    
    const runningJobs = Object.values(currentJobs).filter(j => j.status === 'running' || j.status === 'queued');
    const completedJobs = Object.values(currentJobs).filter(j => j.status === 'completed' || j.status === 'failed' || j.status === 'stopped');
    
    // Update active jobs
    if (runningJobs.length === 0) {
        jobsList.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-inbox"></i>
                <p>No jobs running. Start a new cracking job above.</p>
            </div>
        `;
    } else {
        jobsList.innerHTML = runningJobs.map(job => createJobCard(job, true)).join('');
    }
    
    // Update history
    if (completedJobs.length === 0) {
        historyList.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-clock"></i>
                <p>No job history yet.</p>
            </div>
        `;
    } else {
        historyList.innerHTML = completedJobs.map(job => createJobCard(job, false)).join('');
    }
}

// Create job card HTML
function createJobCard(job, isActive) {
    const statusClass = job.status.toLowerCase();
    const statusIcon = {
        'running': 'fa-spinner fa-spin',
        'completed': 'fa-check-circle',
        'failed': 'fa-times-circle',
        'stopped': 'fa-stop-circle',
        'queued': 'fa-clock'
    };
    
    const crackedPasswordsHtml = job.cracked_passwords.length > 0 ? `
        <div class="cracked-list">
            <strong><i class="fas fa-unlock-alt"></i> Cracked Passwords (${job.cracked_passwords.length}):</strong>
            ${job.cracked_passwords.map(p => `
                <div class="cracked-item">
                    <span class="username">${escapeHtml(p.username)}</span>: 
                    <span class="password">${escapeHtml(p.password)}</span>
                </div>
            `).join('')}
        </div>
    ` : '';
    
    const actionButtons = isActive ? `
        <button class="btn btn-small btn-secondary" onclick="viewJobDetails('${job.job_id}')">
            <i class="fas fa-eye"></i> View Details
        </button>
        ${job.status === 'running' ? `
            <button class="btn btn-small btn-danger" onclick="stopJob('${job.job_id}')">
                <i class="fas fa-stop"></i> Stop
            </button>
        ` : ''}
    ` : `
        <button class="btn btn-small btn-secondary" onclick="viewJobDetails('${job.job_id}')">
            <i class="fas fa-eye"></i> View Details
        </button>
        <button class="btn btn-small btn-danger" onclick="deleteJob('${job.job_id}')">
            <i class="fas fa-trash"></i> Delete
        </button>
    `;
    
    return `
        <div class="job-item">
            <div class="job-header">
                <span class="job-id">Job ID: ${job.job_id.substring(0, 8)}...</span>
                <span class="job-status ${statusClass}">
                    <i class="fas ${statusIcon[job.status]}"></i> ${job.status.toUpperCase()}
                </span>
            </div>
            
            <div class="job-info">
                <div class="job-info-item">
                    <label>Hash File</label>
                    <span>${job.hash_file.split('/').pop()}</span>
                </div>
                <div class="job-info-item">
                    <label>Mode</label>
                    <span>${job.mode}</span>
                </div>
                <div class="job-info-item">
                    <label>Duration</label>
                    <span>${job.duration}s</span>
                </div>
                <div class="job-info-item">
                    <label>Cracked</label>
                    <span>${job.cracked_passwords.length} passwords</span>
                </div>
            </div>
            
            ${job.status === 'running' ? `
                <div class="job-progress">
                    <label>Progress</label>
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${job.progress}%"></div>
                    </div>
                </div>
            ` : ''}
            
            ${crackedPasswordsHtml}
            
            <div class="job-actions">
                ${actionButtons}
            </div>
        </div>
    `;
}

// Update statistics
function updateStats() {
    const jobs = Object.values(currentJobs);
    
    document.getElementById('total-jobs').textContent = jobs.length;
    document.getElementById('running-jobs').textContent = jobs.filter(j => j.status === 'running').length;
    document.getElementById('completed-jobs').textContent = jobs.filter(j => j.status === 'completed').length;
    
    const totalCracked = jobs.reduce((sum, job) => sum + job.cracked_passwords.length, 0);
    document.getElementById('cracked-passwords').textContent = totalCracked;
}

// View job details
async function viewJobDetails(jobId) {
    try {
        const response = await fetch(`${API_BASE}/status/${jobId}`);
        const data = await response.json();
        
        if (data.status === 'success') {
            const job = data.job;
            const modal = document.getElementById('job-modal');
            const modalBody = document.getElementById('modal-body');
            
            const outputHtml = job.output.length > 0 ? `
                <div style="background: var(--bg-color); padding: 1rem; border-radius: 8px; max-height: 300px; overflow-y: auto; font-family: monospace; font-size: 0.75rem;">
                    ${job.output.map(line => `<div>${escapeHtml(line)}</div>`).join('')}
                </div>
            ` : '<p>No output yet.</p>';
            
            const crackedHtml = job.cracked_passwords.length > 0 ? `
                <div style="background: var(--bg-color); padding: 1rem; border-radius: 8px; max-height: 200px; overflow-y: auto;">
                    ${job.cracked_passwords.map(p => `
                        <div style="padding: 0.5rem; border-bottom: 1px solid var(--border-color); font-family: monospace;">
                            <span style="color: var(--primary-color);">${escapeHtml(p.username)}</span>: 
                            <span style="color: var(--success-color);">${escapeHtml(p.password)}</span>
                            <small style="color: var(--text-secondary); float: right;">${new Date(p.timestamp).toLocaleString()}</small>
                        </div>
                    `).join('')}
                </div>
            ` : '<p>No passwords cracked yet.</p>';
            
            modalBody.innerHTML = `
                <div style="margin-bottom: 1.5rem;">
                    <h3 style="margin-bottom: 0.5rem;">Job Information</h3>
                    <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem;">
                        <div><strong>Job ID:</strong> ${job.job_id}</div>
                        <div><strong>Status:</strong> <span class="job-status ${job.status}">${job.status.toUpperCase()}</span></div>
                        <div><strong>Hash File:</strong> ${job.hash_file}</div>
                        <div><strong>Mode:</strong> ${job.mode}</div>
                        <div><strong>Duration:</strong> ${job.duration}s</div>
                        <div><strong>Cracked:</strong> ${job.cracked_passwords.length} passwords</div>
                    </div>
                </div>
                
                <div style="margin-bottom: 1.5rem;">
                    <h3 style="margin-bottom: 0.5rem;"><i class="fas fa-unlock-alt"></i> Cracked Passwords (${job.cracked_passwords.length})</h3>
                    ${crackedHtml}
                </div>
                
                <div>
                    <h3 style="margin-bottom: 0.5rem;"><i class="fas fa-terminal"></i> Output Log</h3>
                    ${outputHtml}
                </div>
            `;
            
            modal.classList.add('active');
        }
    } catch (error) {
        console.error('Failed to load job details:', error);
        showToast('Failed to load job details', 'error');
    }
}

// Close modal
function closeModal() {
    const modal = document.getElementById('job-modal');
    modal.classList.remove('active');
}

// Stop job
async function stopJob(jobId) {
    if (!confirm('Are you sure you want to stop this job?')) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/stop/${jobId}`, {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (data.status === 'success') {
            showToast('Job stopped successfully', 'success');
            refreshJobs();
        } else {
            throw new Error(data.message || 'Failed to stop job');
        }
    } catch (error) {
        console.error('Failed to stop job:', error);
        showToast(`Error: ${error.message}`, 'error');
    }
}

// Delete job
async function deleteJob(jobId) {
    if (!confirm('Are you sure you want to delete this job? This action cannot be undone.')) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/delete/${jobId}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.status === 'success') {
            showToast('Job deleted successfully', 'success');
            refreshJobs();
        } else {
            throw new Error(data.message || 'Failed to delete job');
        }
    } catch (error) {
        console.error('Failed to delete job:', error);
        showToast(`Error: ${error.message}`, 'error');
    }
}

// Show toast notification
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    const icon = {
        'success': 'fa-check-circle',
        'error': 'fa-exclamation-circle',
        'info': 'fa-info-circle'
    };
    
    toast.innerHTML = `<i class="fas ${icon[type]}"></i> ${message}`;
    toast.className = `toast ${type} show`;
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 4000);
}

// Auto-refresh
function startAutoRefresh() {
    refreshInterval = setInterval(() => {
        refreshJobs();
    }, 3000); // Refresh every 3 seconds
}

// Utility function to escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Close modal when clicking outside
document.addEventListener('click', function(e) {
    const modal = document.getElementById('job-modal');
    if (e.target === modal) {
        closeModal();
    }
});
