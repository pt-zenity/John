// ─────────────────────────────────────────────────────────────────────────────
//  John the Ripper Web UI  –  app.js  v6.0
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const API_BASE = '/api';

let currentJobs        = {};        // job_id → job object
let refreshInterval    = null;
let currentInputMode   = 'upload';
let telegramReady      = false;     // true when enabled+configured
let audioCtx           = null;      // singleton AudioContext (lazy – created on first user gesture)
let prevCrackedCount   = {};        // job_id → last known cracked count
let shownModalForPwd   = new Set(); // "job_id:username" pairs already shown in modal
let modalAutoRefresh   = null;      // interval for detail modal live updates
let modalJobId         = null;      // job id currently shown in modal

// ─────────────────────────────────────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    loadSystemInfo();
    loadTelegramConfig();
    setupFormHandlers();
    refreshJobs();
    startAutoRefresh();
});

// ─────────────────────────────────────────────────────────────────────────────
//  System info
// ─────────────────────────────────────────────────────────────────────────────
async function loadSystemInfo() {
    try {
        const res  = await fetch(`${API_BASE}/info`);
        const data = await res.json();
        if (data.status === 'success') {
            const el = document.getElementById('version-info');
            if (el) el.textContent = data.version;
        }
    } catch (e) {
        console.error('loadSystemInfo:', e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Telegram config
// ─────────────────────────────────────────────────────────────────────────────
async function loadTelegramConfig() {
    try {
        const res  = await fetch(`${API_BASE}/telegram/config`);
        const data = await res.json();
        if (data.status === 'success') {
            telegramReady = data.config.configured && data.config.enabled;
            _syncTelegramUI();
        }
    } catch (e) {
        console.error('loadTelegramConfig:', e);
    }
}

function _syncTelegramUI() {
    const cb   = document.getElementById('telegram-notify');
    const hint = document.getElementById('telegram-status');
    if (!cb || !hint) return;
    if (telegramReady) {
        cb.disabled = false;
        hint.textContent = '✅ Telegram notifications are enabled';
        hint.classList.add('enabled');
    } else {
        cb.disabled = true;
        cb.checked  = false;
        hint.textContent = 'Configure Telegram in settings to enable notifications';
        hint.classList.remove('enabled');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Input mode toggle
// ─────────────────────────────────────────────────────────────────────────────
function switchInputMode(mode, clickedBtn) {
    currentInputMode = mode;

    document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    // clickedBtn can be passed explicitly, or find it by mode
    if (clickedBtn) {
        clickedBtn.classList.add('active');
    } else {
        const btn = document.querySelector(`.toggle-btn[data-target="${mode}-section"]`);
        if (btn) btn.classList.add('active');
    }

    document.querySelectorAll('.input-section').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(mode === 'upload' ? 'upload-section' : 'paste-section');
    if (target) target.classList.add('active');

    const statusEl = document.getElementById('upload-status');
    if (statusEl) statusEl.innerHTML = '';
}

// ─────────────────────────────────────────────────────────────────────────────
//  Form wiring
// ─────────────────────────────────────────────────────────────────────────────
function setupFormHandlers() {
    const form         = document.getElementById('crack-form');
    const modeSelect   = document.getElementById('crack-mode');
    const wlGroup      = document.getElementById('wordlist-group');
    const fileInput    = document.getElementById('hash-file');
    const telegramForm = document.getElementById('telegram-form');

    if (!form || !modeSelect) return;

    // Show wordlist field only in wordlist mode
    modeSelect.addEventListener('change', () => {
        if (wlGroup) wlGroup.style.display = modeSelect.value === 'wordlist' ? 'block' : 'none';
    });

    // Show selected filename
    if (fileInput) {
        fileInput.addEventListener('change', () => {
            const span = document.querySelector('.file-upload-display span');
            if (span && fileInput.files.length) {
                span.textContent = `✅ Selected: ${fileInput.files[0].name}`;
            }
        });
    }

    // Drag-and-drop on the upload zone
    const uploadZone = document.querySelector('.file-upload-wrapper');
    if (uploadZone) {
        uploadZone.addEventListener('dragover', e => {
            e.preventDefault();
            const disp = uploadZone.querySelector('.file-upload-display');
            if (disp) disp.style.borderColor = 'var(--primary-color)';
        });
        uploadZone.addEventListener('dragleave', () => {
            const disp = uploadZone.querySelector('.file-upload-display');
            if (disp) disp.style.borderColor = '';
        });
        uploadZone.addEventListener('drop', e => {
            e.preventDefault();
            const disp = uploadZone.querySelector('.file-upload-display');
            if (disp) disp.style.borderColor = '';
            const dt = e.dataTransfer;
            if (dt && dt.files.length && fileInput) {
                // Modern way to assign files to input
                try {
                    const dataTransfer = new DataTransfer();
                    dataTransfer.items.add(dt.files[0]);
                    fileInput.files = dataTransfer.files;
                } catch (_) {
                    // Fallback: some browsers don't support DataTransfer constructor
                }
                const span = document.querySelector('.file-upload-display span');
                if (span) span.textContent = `✅ Selected: ${dt.files[0].name}`;
            }
        });
    }

    // Main submit
    form.addEventListener('submit', async e => { e.preventDefault(); await startCrackingJob(); });

    // Reset
    form.addEventListener('reset', () => {
        const span = document.querySelector('.file-upload-display span');
        if (span) span.textContent = 'Click to upload or drag and drop';
        const statusEl = document.getElementById('upload-status');
        if (statusEl) statusEl.innerHTML = '';
        const pa = document.getElementById('hash-paste');
        if (pa) pa.value = '';
        if (wlGroup) wlGroup.style.display = 'none';
    });

    // Telegram form
    if (telegramForm) {
        telegramForm.addEventListener('submit', async e => { e.preventDefault(); await saveTelegramConfig(); });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Start a cracking job
// ─────────────────────────────────────────────────────────────────────────────
async function startCrackingJob() {
    const modeEl    = document.getElementById('crack-mode');
    const wlPathEl  = document.getElementById('wordlist-path');
    const tgNotify  = document.getElementById('telegram-notify');
    const statusEl  = document.getElementById('upload-status');

    if (!modeEl || !statusEl) return;

    const mode      = modeEl.value;
    const wlPath    = wlPathEl ? wlPathEl.value.trim() : '';
    const notify    = tgNotify ? tgNotify.checked : false;

    let filepath;

    try {
        if (currentInputMode === 'upload') {
            const fileInput = document.getElementById('hash-file');
            if (!fileInput || !fileInput.files.length) {
                showToast('Please select a hash file', 'error'); return;
            }
            statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading…';
            statusEl.className = 'upload-status';

            const fd = new FormData();
            fd.append('file', fileInput.files[0]);
            const upRes  = await fetch(`${API_BASE}/upload`, { method: 'POST', body: fd });
            const upData = await upRes.json();
            if (upData.status !== 'success') throw new Error(upData.message || 'Upload failed');

            filepath = upData.filepath;
            statusEl.innerHTML = '<i class="fas fa-check-circle"></i> File uploaded';
            statusEl.className = 'upload-status success';

        } else {
            const pasteEl = document.getElementById('hash-paste');
            const paste   = pasteEl ? pasteEl.value.trim() : '';
            if (!paste) { showToast('Please paste some hashes', 'error'); return; }

            statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing…';
            statusEl.className = 'upload-status';

            const pRes  = await fetch(`${API_BASE}/paste`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ content: paste }),
            });
            const pData = await pRes.json();
            if (pData.status !== 'success') throw new Error(pData.message || 'Paste failed');

            filepath = pData.filepath;
            statusEl.innerHTML = '<i class="fas fa-check-circle"></i> Hashes saved';
            statusEl.className = 'upload-status success';
        }

        // Kick off the job
        const crRes  = await fetch(`${API_BASE}/crack`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                hash_file:       filepath,
                mode,
                wordlist:        mode === 'wordlist' && wlPath ? wlPath : null,
                telegram_notify: notify,
            }),
        });
        const crData = await crRes.json();
        if (crData.status !== 'success') throw new Error(crData.message || 'Start failed');

        const wl = crData.wordlist || 'auto';
        showToast(`Job started! Mode: ${mode} | Wordlist: ${wl.split('/').pop()}`, 'success');

        const form = document.getElementById('crack-form');
        if (form) form.reset();
        statusEl.innerHTML = '';

        setTimeout(refreshJobs, 800);

    } catch (err) {
        console.error('startCrackingJob:', err);
        statusEl.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${escapeHtml(err.message)}`;
        statusEl.className = 'upload-status error';
        showToast(`Error: ${err.message}`, 'error');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Telegram modal
// ─────────────────────────────────────────────────────────────────────────────
function openTelegramSettings() {
    loadCurrentTelegramConfig();
    const modal = document.getElementById('telegram-modal');
    if (modal) modal.classList.add('active');
}

async function loadCurrentTelegramConfig() {
    try {
        const res  = await fetch(`${API_BASE}/telegram/config`);
        const data = await res.json();
        if (data.status === 'success') {
            const el = document.getElementById('telegram-enabled');
            if (el) el.checked = data.config.enabled;
        }
    } catch (e) { console.error(e); }
}

async function saveTelegramConfig() {
    const tokenEl   = document.getElementById('bot-token');
    const chatIdEl  = document.getElementById('chat-id');
    const enabledEl = document.getElementById('telegram-enabled');

    const token   = tokenEl  ? tokenEl.value.trim()  : '';
    const chatId  = chatIdEl ? chatIdEl.value.trim()  : '';
    const enabled = enabledEl ? enabledEl.checked      : false;

    if (!token || !chatId) {
        showToast('Bot Token and Chat ID are required', 'error'); return;
    }
    try {
        const res  = await fetch(`${API_BASE}/telegram/config`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ bot_token: token, chat_id: chatId, enabled }),
        });
        const data = await res.json();
        if (data.status === 'success') {
            showToast('Telegram configured! Test message sent ✅', 'success');
            closeModal('telegram-modal');
            loadTelegramConfig();
        } else {
            showToast(data.message || 'Failed to configure Telegram', 'error');
        }
    } catch (e) {
        showToast(`Error: ${e.message}`, 'error');
    }
}

async function testTelegram() {
    try {
        const res  = await fetch(`${API_BASE}/telegram/test`, { method: 'POST' });
        const data = await res.json();
        showToast(
            data.status === 'success' ? 'Test message sent ✅' : (data.message || 'Failed'),
            data.status === 'success' ? 'success' : 'error'
        );
    } catch (e) {
        showToast(`Error: ${e.message}`, 'error');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Jobs refresh
// ─────────────────────────────────────────────────────────────────────────────
async function refreshJobs() {
    try {
        const res  = await fetch(`${API_BASE}/jobs`);
        const data = await res.json();
        if (data.status !== 'success') return;

        const incoming = {};
        data.jobs.forEach(j => { incoming[j.job_id] = j; });

        // Detect new cracked passwords (compare with previous snapshot)
        Object.values(incoming).forEach(job => {
            const prev  = prevCrackedCount[job.job_id] || 0;
            const curr  = job.cracked_passwords.length;
            if (curr > prev) {
                const newOnes = job.cracked_passwords.slice(prev);
                newOnes.forEach(pwd => {
                    const key = `${job.job_id}:${pwd.username}`;
                    // Only show banner + modal once per unique credential
                    if (!shownModalForPwd.has(key)) {
                        shownModalForPwd.add(key);
                        showPasswordFoundNotification(pwd, job);
                        playNotificationSound();
                        highlightJobCard(job.job_id);
                    }
                });
            }
            prevCrackedCount[job.job_id] = curr;
        });

        currentJobs = incoming;
        renderJobsList();
        updateStats();

        // If the job detail modal is open and that job is still running, refresh it
        if (modalJobId && incoming[modalJobId] && incoming[modalJobId].status === 'running') {
            _refreshModalContent(incoming[modalJobId]);
        }

    } catch (e) {
        console.error('refreshJobs:', e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Render
// ─────────────────────────────────────────────────────────────────────────────
function renderJobsList() {
    const all       = Object.values(currentJobs);
    const running   = all.filter(j => j.status === 'running' || j.status === 'queued');
    const completed = all.filter(j => !['running', 'queued'].includes(j.status));

    const jobsList = document.getElementById('jobs-list');
    if (jobsList) {
        jobsList.innerHTML = running.length
            ? running.map(j => buildJobCard(j, true)).join('')
            : `<div class="empty-state"><i class="fas fa-inbox"></i><p>No active jobs. Start a new cracking job above.</p></div>`;
    }

    const histList = document.getElementById('history-list');
    if (histList) {
        histList.innerHTML = completed.length
            ? completed.map(j => buildJobCard(j, false)).join('')
            : `<div class="empty-state"><i class="fas fa-clock"></i><p>No history yet.</p></div>`;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Build job card HTML
// ─────────────────────────────────────────────────────────────────────────────
function buildJobCard(job, isActive) {
    const icons = {
        running:   'fa-spinner fa-spin',
        completed: 'fa-check-circle',
        failed:    'fa-times-circle',
        stopped:   'fa-stop-circle',
        queued:    'fa-clock',
    };

    // ── Cracked passwords block ─────────────────────────────────────
    let crackedHtml = '';
    if (job.cracked_passwords && job.cracked_passwords.length > 0) {
        const items = job.cracked_passwords.map((p, i) => `
            <div class="cracked-item" style="animation-delay:${i * 0.08}s">
                <div class="cracked-credentials">
                    <div class="cracked-username"><i class="fas fa-user"></i>${escapeHtml(p.username)}</div>
                    <div class="cracked-password">${escapeHtml(p.password)}</div>
                    <div class="cracked-timestamp"><i class="fas fa-clock"></i>Found ${formatDate(p.timestamp)}</div>
                </div>
                <button class="copy-btn" data-copy="${escapeAttr(p.username + ':' + p.password)}" title="Copy credential">
                    <i class="fas fa-copy"></i> Copy
                </button>
            </div>`).join('');

        crackedHtml = `
            <div class="cracked-passwords-section">
                <div class="cracked-passwords-header">
                    <i class="fas fa-check-circle"></i>
                    <h4>🎉 Passwords Found!</h4>
                    <span class="cracked-passwords-count">${job.cracked_passwords.length}</span>
                </div>
                <div class="cracked-list">${items}</div>
            </div>`;
    }

    // ── Progress block ──────────────────────────────────────────────
    let progressHtml = '';
    if (job.status === 'running') {
        const pct = Math.min(99, Math.max(0, job.progress_percentage || job.progress || 0));
        progressHtml = `
            <div class="job-progress">
                <div class="progress-header">
                    <label>Progress: ${pct}%</label>
                    <span class="progress-speed">${escapeHtml(job.speed || '0 p/s')}</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" style="width:${pct}%">
                        <span class="progress-text">${pct > 8 ? pct + '%' : ''}</span>
                    </div>
                </div>
                <div class="progress-details">
                    ${job.loaded_hashes > 0 ? `<div class="progress-item"><i class="fas fa-hashtag"></i><span>Hashes: ${job.loaded_hashes}</span></div>` : ''}
                    ${job.passwords_tried > 0 ? `<div class="progress-item"><i class="fas fa-calculator"></i><span>Tried: ${Number(job.passwords_tried).toLocaleString()}</span></div>` : ''}
                    ${job.current_password ? `<div class="progress-item"><i class="fas fa-key"></i><span>Trying: <code>${escapeHtml(job.current_password)}</code></span></div>` : ''}
                    ${job.eta && job.eta !== 'N/A' ? `<div class="progress-item"><i class="fas fa-hourglass-half"></i><span>ETA: ${escapeHtml(job.eta)}</span></div>` : ''}
                    ${job.hash_format ? `<div class="progress-item"><i class="fas fa-code"></i><span>Format: ${escapeHtml(job.hash_format)}</span></div>` : ''}
                </div>
            </div>`;
    }

    // ── Action buttons ──────────────────────────────────────────────
    const actions = isActive
        ? `<button class="btn btn-small btn-secondary" data-action="view" data-jobid="${job.job_id}"><i class="fas fa-eye"></i> Details</button>
           ${job.status === 'running'
               ? `<button class="btn btn-small btn-danger" data-action="stop" data-jobid="${job.job_id}"><i class="fas fa-stop"></i> Stop</button>`
               : ''}`
        : `<button class="btn btn-small btn-secondary" data-action="view"   data-jobid="${job.job_id}"><i class="fas fa-eye"></i> Details</button>
           <button class="btn btn-small btn-danger"    data-action="delete" data-jobid="${job.job_id}"><i class="fas fa-trash"></i> Delete</button>`;

    const wordlistName = job.wordlist ? job.wordlist.split('/').pop() : 'auto';
    const duration     = typeof job.duration === 'number' ? job.duration.toFixed(1) : '0.0';

    return `
        <div class="job-item" id="card-${job.job_id}">
            <div class="job-header">
                <span class="job-id"><i class="fas fa-fingerprint"></i> ${job.job_id.substring(0,8)}…</span>
                <span class="job-status ${escapeHtml(job.status)}">
                    <i class="fas ${icons[job.status] || 'fa-question'}"></i> ${job.status.toUpperCase()}
                </span>
            </div>
            <div class="job-info">
                <div class="job-info-item"><label>File</label><span title="${escapeHtml(job.hash_file)}">${escapeHtml(job.hash_file.split('/').pop())}</span></div>
                <div class="job-info-item"><label>Mode</label><span>${escapeHtml(job.mode)}</span></div>
                <div class="job-info-item"><label>Wordlist</label><span title="${escapeHtml(job.wordlist || 'auto')}">${escapeHtml(wordlistName)}</span></div>
                <div class="job-info-item"><label>Duration</label><span>${duration}s</span></div>
                <div class="job-info-item"><label>Cracked</label><span class="${job.cracked_passwords.length > 0 ? 'text-success' : ''}">${job.cracked_passwords.length}</span></div>
            </div>
            ${progressHtml}
            ${crackedHtml}
            <div class="job-actions">${actions}</div>
        </div>`;
}

// ── Delegated click handler ───────────────────────────────────────────────────
document.addEventListener('click', e => {
    // data-action buttons
    const btn = e.target.closest('[data-action]');
    if (btn) {
        const action = btn.dataset.action;
        const jobId  = btn.dataset.jobid;
        if (action === 'view')   viewJobDetails(jobId);
        if (action === 'stop')   stopJob(jobId);
        if (action === 'delete') deleteJob(jobId);
        return;
    }

    // copy-btn with data-copy
    const cp = e.target.closest('.copy-btn[data-copy]');
    if (cp) {
        copyToClipboard(cp.dataset.copy);
        return;
    }

    // close modal on backdrop click
    if (e.target.classList.contains('modal')) {
        _closeModalEl(e.target);
    }
    if (e.target.classList.contains('password-found-modal')) {
        e.target.classList.remove('active');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Stats
// ─────────────────────────────────────────────────────────────────────────────
function updateStats() {
    const all = Object.values(currentJobs);

    const totalEl     = document.getElementById('total-jobs');
    const runningEl   = document.getElementById('running-jobs');
    const completedEl = document.getElementById('completed-jobs');
    const crackedEl   = document.getElementById('cracked-passwords');

    if (totalEl)     totalEl.textContent     = all.length;
    if (runningEl)   runningEl.textContent   = all.filter(j => j.status === 'running').length;
    if (completedEl) completedEl.textContent = all.filter(j => j.status === 'completed').length;
    if (crackedEl)   crackedEl.textContent   =
        all.reduce((n, j) => n + (j.cracked_passwords ? j.cracked_passwords.length : 0), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Job detail modal
// ─────────────────────────────────────────────────────────────────────────────
async function viewJobDetails(jobId) {
    modalJobId = jobId;
    try {
        const res  = await fetch(`${API_BASE}/status/${jobId}`);
        const data = await res.json();
        if (data.status !== 'success') { showToast('Job not found', 'error'); return; }

        const modal = document.getElementById('job-modal');
        if (!modal) return;

        _renderModalBody(data.job);
        modal.classList.add('active');

    } catch (e) {
        console.error('viewJobDetails:', e);
        showToast('Failed to load job details', 'error');
    }
}

function _renderModalBody(job) {
    const body   = document.getElementById('modal-body');
    if (!body) return;

    const pct = Math.min(99, Math.max(0, job.progress_percentage || 0));

    const crackedRows = (job.cracked_passwords && job.cracked_passwords.length)
        ? job.cracked_passwords.map(p => `
            <div style="padding:.75rem 1rem;border-bottom:1px solid var(--border-color);font-family:monospace;display:flex;justify-content:space-between;align-items:center;gap:.5rem">
                <div>
                    <span style="color:var(--primary-color);font-weight:600">${escapeHtml(p.username)}</span>
                    <span style="color:var(--text-secondary)">:</span>
                    <span style="color:var(--success-color);font-weight:700;font-size:1.05em">${escapeHtml(p.password)}</span>
                    <div style="font-size:.7rem;color:var(--text-secondary);margin-top:.2rem">${formatDate(p.timestamp)}</div>
                </div>
                <button class="copy-btn" data-copy="${escapeAttr(p.username + ':' + p.password)}" title="Copy" style="flex-shrink:0"><i class="fas fa-copy"></i></button>
            </div>`).join('')
        : '<p style="color:var(--text-secondary);padding:.75rem">No passwords cracked yet.</p>';

    const outputLines = (job.output && job.output.length)
        ? job.output.map(l => `<div class="output-line${l.startsWith('[+]') ? ' output-success' : l.startsWith('[!]') ? ' output-error' : ''}">${escapeHtml(l)}</div>`).join('')
        : '<p>No output yet.</p>';

    const duration = typeof job.duration === 'number' ? job.duration.toFixed(1) : '0.0';

    body.innerHTML = `
        <div class="modal-section">
            <h3><i class="fas fa-info-circle"></i> Job Info</h3>
            <div class="modal-grid">
                <div><strong>Job ID:</strong><br><code style="font-size:.75rem;word-break:break-all">${escapeHtml(job.job_id)}</code></div>
                <div><strong>Status:</strong><br><span class="job-status ${escapeHtml(job.status)}">${job.status.toUpperCase()}</span></div>
                <div><strong>File:</strong><br><span style="font-size:.8rem;word-break:break-all">${escapeHtml(job.hash_file)}</span></div>
                <div><strong>Mode:</strong><br>${escapeHtml(job.mode)}</div>
                <div><strong>Wordlist:</strong><br><span style="font-size:.8rem">${escapeHtml(job.wordlist || 'auto')}</span></div>
                <div><strong>Duration:</strong><br>${duration}s</div>
                ${job.hash_format ? `<div><strong>Format:</strong><br><code>${escapeHtml(job.hash_format)}</code></div>` : ''}
            </div>
        </div>

        ${job.status === 'running' ? `
        <div class="modal-section">
            <h3><i class="fas fa-chart-line"></i> Live Progress</h3>
            <div class="progress-bar" style="height:28px;margin-bottom:.75rem">
                <div class="progress-fill" style="width:${pct}%">
                    <span class="progress-text">${pct > 8 ? pct + '%' : ''}</span>
                </div>
            </div>
            <div class="modal-grid" style="font-size:.875rem">
                ${job.speed         ? `<div><strong>Speed:</strong><br><code style="color:var(--success-color)">${escapeHtml(job.speed)}</code></div>` : ''}
                ${job.loaded_hashes > 0 ? `<div><strong>Loaded:</strong><br>${job.loaded_hashes} hashes</div>` : ''}
                ${job.passwords_tried > 0 ? `<div><strong>Tried:</strong><br>${Number(job.passwords_tried).toLocaleString()}</div>` : ''}
                ${job.eta && job.eta !== 'N/A' ? `<div><strong>ETA:</strong><br>${escapeHtml(job.eta)}</div>` : ''}
                ${job.current_password ? `<div style="grid-column:1/-1"><strong>Trying:</strong><br><code style="background:var(--bg-card);padding:.2rem .4rem;border-radius:4px;color:var(--warning-color)">${escapeHtml(job.current_password)}</code></div>` : ''}
            </div>
        </div>` : ''}

        <div class="modal-section">
            <h3><i class="fas fa-unlock-alt"></i> Cracked Passwords (${(job.cracked_passwords || []).length})</h3>
            <div class="modal-cracked-list">${crackedRows}</div>
        </div>

        <div class="modal-section">
            <h3><i class="fas fa-terminal"></i> Output Log</h3>
            <div class="modal-output">${outputLines}</div>
        </div>`;
}

function _refreshModalContent(job) {
    const modal = document.getElementById('job-modal');
    if (modal && modal.classList.contains('active') && modalJobId === job.job_id) {
        _renderModalBody(job);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Stop / Delete
// ─────────────────────────────────────────────────────────────────────────────
async function stopJob(jobId) {
    if (!confirm('Stop this job?')) return;
    try {
        const r = await fetch(`${API_BASE}/stop/${jobId}`, { method: 'POST' });
        const d = await r.json();
        showToast(d.status === 'success' ? '⏹ Job stopped' : d.message,
                  d.status === 'success' ? 'success' : 'error');
        setTimeout(refreshJobs, 300);
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteJob(jobId) {
    if (!confirm('Delete this job? This cannot be undone.')) return;
    try {
        const r = await fetch(`${API_BASE}/delete/${jobId}`, { method: 'DELETE' });
        const d = await r.json();
        showToast(d.status === 'success' ? '🗑 Job deleted' : d.message,
                  d.status === 'success' ? 'success' : 'error');
        delete prevCrackedCount[jobId];
        if (modalJobId === jobId) {
            closeModal('job-modal');
            modalJobId = null;
        }
        setTimeout(refreshJobs, 300);
    } catch (e) { showToast(e.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Password Found notifications
// ─────────────────────────────────────────────────────────────────────────────
function showPasswordFoundNotification(pwd, job) {
    // Slide-in banner (stacked if multiple)
    const banner  = document.createElement('div');
    banner.className = 'password-notification';
    banner.innerHTML = `
        <div class="notification-icon"><i class="fas fa-unlock-alt"></i></div>
        <div class="notification-content">
            <div class="notification-title">🎉 Password Cracked!</div>
            <div class="notification-username">${escapeHtml(pwd.username)}</div>
            <div class="notification-password">${escapeHtml(pwd.password)}</div>
            <div class="notification-job">Job ${job.job_id.substring(0,8)}…</div>
        </div>
        <button class="notification-close" onclick="this.closest('.password-notification').remove()">×</button>`;
    document.body.appendChild(banner);
    requestAnimationFrame(() => banner.classList.add('show'));
    setTimeout(() => {
        banner.classList.remove('show');
        setTimeout(() => { if (banner.parentNode) banner.remove(); }, 400);
    }, 6000);

    // Big celebration modal
    showPasswordFoundModal(pwd, job);
}

function showPasswordFoundModal(pwd, job) {
    const modal   = document.getElementById('password-found-modal');
    const display = document.getElementById('cracked-password-display');
    if (!modal || !display) return;

    display.innerHTML = `
        <div class="password-result-item">
            <div class="password-result-label">
                <small>Username</small>
                <span class="password-result-username">${escapeHtml(pwd.username)}</span>
            </div>
            <button class="copy-btn" data-copy="${escapeAttr(pwd.username)}" title="Copy username"><i class="fas fa-copy"></i></button>
        </div>
        <div class="password-result-item">
            <div class="password-result-label">
                <small>Password</small>
                <span class="password-result-value">${escapeHtml(pwd.password)}</span>
            </div>
            <button class="copy-btn" data-copy="${escapeAttr(pwd.password)}" title="Copy password"><i class="fas fa-copy"></i></button>
        </div>
        <div class="password-result-item">
            <div class="password-result-label">
                <small>Full credential</small>
                <span style="font-family:monospace;color:var(--text-secondary)">${escapeHtml(pwd.username)}:${escapeHtml(pwd.password)}</span>
            </div>
            <button class="copy-btn" data-copy="${escapeAttr(pwd.username + ':' + pwd.password)}" title="Copy full credential"><i class="fas fa-copy"></i></button>
        </div>
        <div style="text-align:center;margin-top:1rem;color:var(--text-secondary);font-size:.875rem">
            <i class="fas fa-clock"></i> ${formatDate(pwd.timestamp)}
        </div>`;

    modal.classList.add('active');
}

function closePasswordModal() {
    const modal = document.getElementById('password-found-modal');
    if (modal) modal.classList.remove('active');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Audio notification
//  AudioContext is created lazily on the first user interaction that triggers a
//  notification, avoiding the browser's autoplay-policy console warning on load.
// ─────────────────────────────────────────────────────────────────────────────
function _getAudioCtx() {
    if (!audioCtx) {
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (_) {
            return null;
        }
    }
    return audioCtx;
}

function playNotificationSound() {
    try {
        const ctx = _getAudioCtx();
        if (!ctx) return;
        if (ctx.state === 'suspended') ctx.resume();

        // Victory jingle: three ascending notes (C5 → E5 → G5)
        [[523, 0, 0.22], [659, 0.20, 0.22], [784, 0.40, 0.38]].forEach(([freq, start, dur]) => {
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = freq;
            osc.type = 'sine';
            const t0 = ctx.currentTime + start;
            gain.gain.setValueAtTime(0.28, t0);
            gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
            osc.start(t0);
            osc.stop(t0 + dur + 0.05);
        });
    } catch (e) {
        // Silently ignore audio errors
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Highlight job card
// ─────────────────────────────────────────────────────────────────────────────
function highlightJobCard(jobId) {
    const card = document.getElementById(`card-${jobId}`);
    if (!card) return;
    card.classList.add('password-found-highlight');
    setTimeout(() => card.classList.remove('password-found-highlight'), 2500);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Toast
// ─────────────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle' };
    toast.innerHTML  = `<i class="fas ${icons[type] || icons.info}"></i> ${escapeHtml(message)}`;
    toast.className  = `toast ${type} show`;
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => toast.classList.remove('show'), 4500);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Auto-refresh  (adaptive: faster when jobs running)
// ─────────────────────────────────────────────────────────────────────────────
function startAutoRefresh() {
    if (refreshInterval) clearInterval(refreshInterval);
    // Base refresh 4s; will adapt based on running jobs
    refreshInterval = setInterval(() => {
        const hasRunning = Object.values(currentJobs).some(j => j.status === 'running');
        // Always refresh, just log current state
        refreshJobs();
    }, 4000);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Modal helpers
// ─────────────────────────────────────────────────────────────────────────────
function closeModal(id) {
    const el = document.getElementById(id || 'job-modal');
    if (el) {
        _closeModalEl(el);
        if (id === 'job-modal') modalJobId = null;
    }
}

function _closeModalEl(el) {
    el.classList.remove('active');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Clipboard
// ─────────────────────────────────────────────────────────────────────────────
function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text)
            .then(() => showToast('✅ Copied to clipboard!', 'success'))
            .catch(() => _fallbackCopy(text));
    } else {
        _fallbackCopy(text);
    }
}

function _fallbackCopy(text) {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;left:-9999px;top:-9999px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('✅ Copied!', 'success');
    } catch (e) {
        showToast('Could not copy – please copy manually', 'error');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  XSS-safe HTML escape
// ─────────────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#39;');
}

// Escape for use inside HTML attribute values (data-copy="...")
function escapeAttr(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#39;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Date formatter
// ─────────────────────────────────────────────────────────────────────────────
function formatDate(isoStr) {
    if (!isoStr) return 'N/A';
    try {
        return new Date(isoStr).toLocaleString();
    } catch (_) {
        return isoStr;
    }
}
