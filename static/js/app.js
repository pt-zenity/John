// ─────────────────────────────────────────────────────────────────────────────
//  John the Ripper Web UI  –  app.js  v7.1
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
    loadWordlists();          // populate wordlist selector dropdown
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

    // Show wordlist selector only in wordlist / default modes
    const showWlGroup = () => {
        if (!wlGroup) return;
        const show = ['wordlist', 'default'].includes(modeSelect.value);
        wlGroup.style.display = show ? 'block' : 'none';
    };
    modeSelect.addEventListener('change', showWlGroup);
    showWlGroup(); // run once on init

    // Toggle manual path input when "custom path" option selected
    const wlSel = document.getElementById('wordlist-select');
    if (wlSel) {
        wlSel.addEventListener('change', () => {
            const pathEl = document.getElementById('wordlist-path');
            const hint   = document.getElementById('wordlist-select-hint');
            if (!pathEl) return;
            if (wlSel.value === '__custom__') {
                pathEl.style.display = 'block';
                if (hint) hint.textContent = 'Enter full path to wordlist file';
            } else {
                pathEl.style.display = 'none';
                if (hint) {
                    hint.textContent = wlSel.value
                        ? `Selected: ${wlSel.value.split('/').pop()}`
                        : 'Will use rockyou.txt automatically';
                }
            }
        });
    }

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
        // Reset wordlist selector to auto
        const wlSel = document.getElementById('wordlist-select');
        if (wlSel) wlSel.value = '';
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
    const wlSelEl   = document.getElementById('wordlist-select');  // dropdown from wordlist manager
    const tgNotify  = document.getElementById('telegram-notify');
    const statusEl  = document.getElementById('upload-status');

    if (!modeEl || !statusEl) return;

    const mode = modeEl.value;
    // Wordlist priority: dropdown selection → manual path input → auto
    // When '__custom__' is selected, fall back to the manual text input
    const wlPath = (wlSelEl && wlSelEl.value && wlSelEl.value !== '__custom__')
        ? wlSelEl.value
        : (wlPathEl ? wlPathEl.value.trim() : '');
    const notify = tgNotify ? tgNotify.checked : false;

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

// ─────────────────────────────────────────────────────────────────────────────
//  Wordlist Manager  (v7.0)
//  Cards, selector, upload, add-entries modal, preview, delete
// ─────────────────────────────────────────────────────────────────────────────
let _wordlistCache = [];   // last fetched list

/** Load wordlists from API → populate selector + manager card. */
async function loadWordlists() {
    try {
        const res  = await fetch(`${API_BASE}/wordlists`);
        const data = await res.json();
        if (data.status !== 'success') return;
        _wordlistCache = data.wordlists || [];
        _renderWordlistSelector(_wordlistCache);
        _renderWordlistCards(_wordlistCache);
        const badge = document.getElementById('wl-total-badge');
        if (badge) badge.textContent = `${_wordlistCache.length} wordlist${_wordlistCache.length !== 1 ? 's' : ''}`;
    } catch (e) {
        console.error('loadWordlists:', e);
    }
}

/** Populate <select id="wordlist-select"> in crack form. */
function _renderWordlistSelector(wls) {
    const sel = document.getElementById('wordlist-select');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '';

    // Auto / default option
    const defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = '— Auto (rockyou.txt) —';
    sel.appendChild(defOpt);

    wls.forEach(wl => {
        const opt   = document.createElement('option');
        opt.value   = wl.path;
        const icon  = wl.builtin ? '📦' : '✏️';
        const lines = wl.lines > 999999
            ? `${(wl.lines/1000000).toFixed(1)}M`
            : wl.lines > 999 ? `${(wl.lines/1000).toFixed(0)}K` : String(wl.lines);
        opt.textContent = `${icon} ${wl.name}  (${lines} lines)`;
        if (!wl.builtin) opt.style.color = 'var(--success-color)';
        sel.appendChild(opt);
    });

    // "Enter custom path" option
    const custOpt = document.createElement('option');
    custOpt.value = '__custom__';
    custOpt.textContent = '📝 Enter custom path…';
    sel.appendChild(custOpt);

    // Restore previous selection
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    sel.dispatchEvent(new Event('change'));
}

/** Render wordlist cards inside #wordlists-container. */
function _renderWordlistCards(wls) {
    const container = document.getElementById('wordlists-container');
    if (!container) return;

    if (!wls.length) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-file-alt"></i>
                <p>No wordlists yet. Upload a .txt file or click <strong>Add Passwords</strong>.</p>
            </div>`;
        return;
    }

    container.innerHTML = `<div class="wl-grid">${wls.map(wl => _buildWordlistCard(wl)).join('')}</div>`;
}

function _buildWordlistCard(wl) {
    const sizeStr = wl.size >= 1024*1024
        ? `${(wl.size/1024/1024).toFixed(1)} MB`
        : wl.size >= 1024 ? `${(wl.size/1024).toFixed(1)} KB` : `${wl.size} B`;
    const lines = wl.lines.toLocaleString();
    const typeBadge = wl.builtin
        ? `<span class="wl-badge wl-badge-builtin"><i class="fas fa-box"></i> built-in</span>`
        : `<span class="wl-badge wl-badge-custom"><i class="fas fa-pen"></i> custom</span>`;

    const previewBtn = wl.builtin ? '' :
        `<button class="btn btn-small btn-secondary" onclick="previewWordlist('${escapeAttr(wl.name)}')" title="Preview"><i class="fas fa-eye"></i> Preview</button>`;
    const deleteBtn = wl.builtin ? '' :
        `<button class="btn btn-small btn-danger" onclick="deleteWordlist('${escapeAttr(wl.name)}')" title="Delete"><i class="fas fa-trash"></i></button>`;
    const addBtn = wl.builtin ? '' :
        `<button class="btn btn-small btn-success" onclick="openAddEntriesModal('${escapeAttr(wl.name)}')" title="Add passwords"><i class="fas fa-plus"></i></button>`;

    return `
        <div class="wl-card ${wl.builtin ? 'wl-card-builtin' : 'wl-card-custom'}">
            <div class="wl-card-header">
                <div class="wl-card-icon"><i class="fas fa-file-alt"></i></div>
                <div class="wl-card-info">
                    <div class="wl-card-name" title="${escapeAttr(wl.path)}">${escapeHtml(wl.name)}</div>
                    ${typeBadge}
                </div>
            </div>
            <div class="wl-card-stats">
                <div class="wl-stat"><i class="fas fa-align-left"></i> ${lines} lines</div>
                <div class="wl-stat"><i class="fas fa-hdd"></i> ${sizeStr}</div>
            </div>
            <div class="wl-card-actions">
                ${previewBtn}
                ${addBtn}
                <button class="btn btn-small btn-primary" onclick="selectWordlistForCrack('${escapeAttr(wl.path)}')" title="Use this wordlist"><i class="fas fa-play"></i> Use</button>
                ${deleteBtn}
            </div>
        </div>`;
}

/** Select a wordlist in the crack-form dropdown and scroll to form. */
function selectWordlistForCrack(path) {
    const modeEl = document.getElementById('crack-mode');
    const selEl  = document.getElementById('wordlist-select');
    if (modeEl) {
        modeEl.value = 'wordlist';
        modeEl.dispatchEvent(new Event('change'));
    }
    if (selEl) {
        selEl.value = path;
        selEl.dispatchEvent(new Event('change'));
    }
    showToast(`✅ Wordlist "${path.split('/').pop()}" selected`, 'success');
    document.getElementById('crack-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Preview first 50 lines of a custom wordlist. */
async function previewWordlist(filename) {
    try {
        const res  = await fetch(`${API_BASE}/wordlists/preview/${encodeURIComponent(filename)}`);
        const data = await res.json();
        if (data.status !== 'success') { showToast(data.message || 'Preview failed', 'error'); return; }

        const title = document.getElementById('wl-modal-title');
        const body  = document.getElementById('wl-modal-body');
        const modal = document.getElementById('wordlist-modal');
        if (!modal || !body) return;

        if (title) title.innerHTML =
            `<i class="fas fa-eye"></i> ${escapeHtml(filename)}
             <small style="color:var(--text-secondary);font-size:.75rem;margin-left:.5rem">${data.total.toLocaleString()} lines</small>`;

        const wlObj   = _wordlistCache.find(w => w.name === filename);
        const usePath = wlObj ? wlObj.path : filename;

        body.innerHTML = `
            <div class="modal-output" style="max-height:380px">
                ${data.lines.map((ln, i) =>
                    `<div class="output-line"><span style="color:var(--text-secondary);margin-right:.75rem;min-width:2rem;display:inline-block">${i+1}</span>${escapeHtml(ln)}</div>`
                ).join('')}
                ${data.total > 50
                    ? `<div class="output-line" style="color:var(--text-secondary);font-style:italic">… and ${(data.total-50).toLocaleString()} more lines</div>`
                    : ''}
            </div>
            <div style="margin-top:1rem;display:flex;gap:.5rem;justify-content:flex-end;flex-wrap:wrap">
                <button class="btn btn-success" onclick="openAddEntriesModal('${escapeAttr(filename)}')">
                    <i class="fas fa-plus"></i> Add Passwords
                </button>
                <button class="btn btn-primary" onclick="selectWordlistForCrack('${escapeAttr(usePath)}');closeModal('wordlist-modal')">
                    <i class="fas fa-play"></i> Use this wordlist
                </button>
                <button class="btn btn-secondary" onclick="closeModal('wordlist-modal')">Close</button>
            </div>`;
        modal.classList.add('active');
    } catch (e) {
        showToast('Preview failed: ' + e.message, 'error');
    }
}

/** Delete a custom wordlist. */
async function deleteWordlist(filename) {
    if (!confirm(`Delete wordlist "${filename}"?\nThis cannot be undone.`)) return;
    try {
        const res  = await fetch(`${API_BASE}/wordlists/delete/${encodeURIComponent(filename)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.status === 'success') {
            showToast(`✅ ${data.message}`, 'success');
            loadWordlists();
        } else {
            showToast(data.message || 'Delete failed', 'error');
        }
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
    }
}

/** Upload wordlist via the inline file input in the manager card header. */
async function uploadWordlistFile(inputEl) {
    if (!inputEl || !inputEl.files.length) return;
    const fd = new FormData();
    fd.append('file', inputEl.files[0]);
    const label = inputEl.closest('label');
    if (label) { label.style.opacity = '.6'; label.style.pointerEvents = 'none'; }
    try {
        const res  = await fetch(`${API_BASE}/wordlists/upload`, { method: 'POST', body: fd });
        const data = await res.json();
        if (data.status === 'success') {
            showToast(`✅ ${data.message}`, 'success');
            loadWordlists();
        } else {
            showToast(data.message || 'Upload failed', 'error');
        }
    } catch (e) {
        showToast('Upload error: ' + e.message, 'error');
    } finally {
        inputEl.value = '';
        if (label) { label.style.opacity = ''; label.style.pointerEvents = ''; }
    }
}

/** Open Add Passwords modal (appends to specified custom wordlist). */
function openAddEntriesModal(targetFile) {
    const title = document.getElementById('wl-modal-title');
    const body  = document.getElementById('wl-modal-body');
    const modal = document.getElementById('wordlist-modal');
    if (!modal || !body) return;

    const defaultFile  = targetFile || 'custom.txt';
    const customWls    = _wordlistCache.filter(w => !w.builtin);
    const hasDefault   = customWls.some(w => w.name === defaultFile);
    const options      = customWls.map(w =>
        `<option value="${escapeAttr(w.name)}" ${w.name === defaultFile ? 'selected' : ''}>${escapeHtml(w.name)} (${w.lines.toLocaleString()} lines)</option>`
    ).join('');
    const newOpt       = `<option value="custom.txt" ${!hasDefault && defaultFile==='custom.txt' ? 'selected' : ''}>+ custom.txt (create new)</option>`;

    if (title) title.innerHTML = '<i class="fas fa-plus"></i> Add Passwords to Wordlist';
    body.innerHTML = `
        <div class="form-group" style="margin-bottom:1rem">
            <label for="wl-target-name"><i class="fas fa-file-alt"></i> Target wordlist</label>
            <select id="wl-target-name" style="width:100%">
                ${options}
                ${newOpt}
            </select>
            <small>Passwords will be appended to this file</small>
        </div>
        <div class="form-group" style="margin-bottom:1rem">
            <label for="wl-add-entries"><i class="fas fa-key"></i> Passwords (one per line)</label>
            <textarea id="wl-add-entries" rows="12"
                style="width:100%;font-family:monospace;font-size:.875rem"
                placeholder="Paste or type passwords here, one per line:
p95955151
M@rs**70
m@rs27272727
27272727
mars95955151
Mars@95955151
m4rs95955151
.M@rsDB##
mars27272727
M@rs27272727
!Mars27272727
m@rsroya1!
89899898"></textarea>
            <small id="wl-entry-count" style="color:var(--text-secondary)"></small>
        </div>
        <div style="display:flex;gap:.5rem;justify-content:flex-end;flex-wrap:wrap">
            <button class="btn btn-primary" onclick="addEntriesToWordlist()">
                <i class="fas fa-plus"></i> Add to Wordlist
            </button>
            <button class="btn btn-secondary" onclick="closeModal('wordlist-modal')">Cancel</button>
        </div>`;

    // Live entry count
    const ta    = body.querySelector('#wl-add-entries');
    const cntEl = body.querySelector('#wl-entry-count');
    if (ta && cntEl) {
        const updateCount = () => {
            const n = ta.value.split('\n').map(l=>l.trim()).filter(Boolean).length;
            cntEl.textContent = n ? `${n} password${n!==1?'s':''} to add` : '';
        };
        ta.addEventListener('input', updateCount);
    }
    modal.classList.add('active');
}

/** Save textarea entries to a wordlist file. */
async function addEntriesToWordlist() {
    const ta   = document.getElementById('wl-add-entries');
    const fn   = document.getElementById('wl-target-name');
    if (!ta) return;
    const text     = ta.value.trim();
    if (!text) { showToast('Type or paste passwords first', 'error'); return; }
    const filename = fn ? (fn.value.trim() || 'custom.txt') : 'custom.txt';
    const entries  = text.split('\n').map(l => l.trim()).filter(Boolean);
    try {
        const res  = await fetch(`${API_BASE}/wordlists/add-entry`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ filename, entries }),
        });
        const data = await res.json();
        if (data.status === 'success') {
            showToast(`✅ ${data.message}`, 'success');
            closeModal('wordlist-modal');
            loadWordlists();
        } else {
            showToast(data.message || 'Failed', 'error');
        }
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
    }
}

/** Scroll to the Wordlist Manager card. */
function openWordlistManager() {
    const card = document.getElementById('wordlist-manager-card');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    loadWordlists();
}
