#!/usr/bin/env python3
"""
John the Ripper Web UI
Professional web interface for password cracking using John the Ripper (jumbo)
"""

import os
import re
import subprocess
import uuid
import time
import requests
from threading import Thread, Lock
from datetime import datetime
from flask import Flask, render_template, request, jsonify
from flask_cors import CORS
from werkzeug.utils import secure_filename

# ── App setup ─────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)

app.config['UPLOAD_FOLDER']        = 'static/uploads'
app.config['MAX_CONTENT_LENGTH']   = 16 * 1024 * 1024          # 16 MB
app.config['ALLOWED_EXTENSIONS']   = {'txt', 'hash', 'passwd', 'shadow'}

# ── John paths ────────────────────────────────────────────────────────────────
JOHN_EXECUTABLE = '/usr/sbin/john'
JOHN_HOME       = '/usr/share/john'
ROCKYOU         = '/usr/share/wordlists/rockyou.txt'
FALLBACK_WL     = os.path.join(JOHN_HOME, 'password.lst')

# Expose JOHN home so the jumbo binary finds its config/rules
os.environ['JOHN'] = JOHN_HOME

# ── In-memory job store ───────────────────────────────────────────────────────
jobs:      dict = {}
jobs_lock: Lock = Lock()

# ── Telegram config ───────────────────────────────────────────────────────────
telegram_config: dict = {'enabled': False, 'bot_token': None, 'chat_id': None}
telegram_lock:   Lock = Lock()


# ═════════════════════════════════════════════════════════════════════════════
#  Data model
# ═════════════════════════════════════════════════════════════════════════════
class CrackJob:
    """Represents one password-cracking job."""

    def __init__(self, job_id, hash_file, wordlist=None,
                 mode='default', telegram_notify=False):
        self.job_id           = job_id
        self.hash_file        = hash_file
        self.wordlist         = wordlist
        self.mode             = mode
        self.status           = 'queued'
        self.progress         = 0
        self.output           = []
        self.cracked_passwords= []
        self.start_time       = None
        self.end_time         = None
        self.process          = None
        self.telegram_notify  = telegram_notify
        # Live progress fields
        self.total_hashes     = 0
        self.loaded_hashes    = 0
        self.current_password = ''
        self.passwords_tried  = 0
        self.speed            = '0 p/s'
        self.eta              = 'N/A'
        self.progress_percentage = 0
        self.hash_format      = None   # auto-detected format

    # ------------------------------------------------------------------
    def to_dict(self) -> dict:
        return {
            'job_id':            self.job_id,
            'hash_file':         self.hash_file,
            'wordlist':          self.wordlist,
            'mode':              self.mode,
            'status':            self.status,
            'progress':          self.progress,
            'output':            self.output[-100:],   # last 100 lines
            'cracked_passwords': self.cracked_passwords,
            'start_time':        self.start_time,
            'end_time':          self.end_time,
            'duration':          self._duration(),
            'total_hashes':      self.total_hashes,
            'loaded_hashes':     self.loaded_hashes,
            'current_password':  self.current_password,
            'passwords_tried':   self.passwords_tried,
            'speed':             self.speed,
            'eta':               self.eta,
            'progress_percentage': self.progress_percentage,
            'hash_format':       self.hash_format,
        }

    def _duration(self) -> float:
        if not self.start_time:
            return 0.0
        return round((self.end_time or time.time()) - self.start_time, 2)


# ═════════════════════════════════════════════════════════════════════════════
#  Helpers
# ═════════════════════════════════════════════════════════════════════════════
def allowed_file(filename: str) -> bool:
    return ('.' in filename and
            filename.rsplit('.', 1)[1].lower()
            in app.config['ALLOWED_EXTENSIONS'])


# Lines containing these tokens are DEFINITELY metadata, never cracked passwords
_METADATA_TOKENS = (
    'loaded ', 'remaining', 'will run with',
    'using default', 'press ctrl', 'warning:',
    'note:', 'cost ', 'node number', 'each node',
    'delayed', 'openmp', 'failed to', 'duplicat',
    'guesses:', 'time:', 'speed:', 'words:',
    '[*]', 'fopen:', 'no such', 'blowfish',
    'iteration count', 'longer than',
    '0 password', 'password hash',
    'subprocess', 'command', 'starting john',
    'using wordlist', 'rules:', 'huge pages',
    'format:',
)

# Lines we want to silently drop from output AND never parse as passwords
_SKIP_TOKENS = (
    'crash recovery file is locked',
    'john.rec',
    '.rec',
)


def _is_metadata(line: str) -> bool:
    low = line.lower()
    return any(t in low for t in _METADATA_TOKENS)


def _is_skip(line: str) -> bool:
    low = line.lower()
    return any(t in low for t in _SKIP_TOKENS)


def detect_hash_format(hash_file: str, env: dict) -> str | None:
    """
    Inspect hash file to auto-detect the format by content patterns.
    Returns format string like 'bcrypt', 'md5crypt', 'Raw-MD5', etc., or None.
    We rely on content inspection first (more reliable than running john --show=left).
    """
    # Content-based detection (most reliable)
    try:
        with open(hash_file, 'r', errors='ignore') as f:
            content = f.read(8192)

        # Strip to just the hash part (after the last colon in user:hash lines)
        lines = [ln.strip() for ln in content.splitlines() if ln.strip()]
        hashes = []
        for ln in lines:
            parts = ln.split(':')
            # Take the hash part (could be field 1 for user:hash or field 0 for bare)
            if len(parts) >= 2:
                hashes.append(parts[1])
            else:
                hashes.append(parts[0])

        sample = ' '.join(hashes[:5])

        # bcrypt
        if any(h.startswith('$2y$') or h.startswith('$2b$') or h.startswith('$2a$')
               for h in hashes):
            return 'bcrypt'
        # sha512crypt
        if any(h.startswith('$6$') for h in hashes):
            return 'sha512crypt'
        # sha256crypt
        if any(h.startswith('$5$') for h in hashes):
            return 'sha256crypt'
        # md5crypt
        if any(h.startswith('$1$') or h.startswith('$apr1$') for h in hashes):
            return 'md5crypt'
        # phpass (WordPress/Joomla)
        if any(h.startswith('$P$') or h.startswith('$H$') for h in hashes):
            return 'phpass'
        # sha512 (128 hex chars)
        if any(re.match(r'^[0-9a-fA-F]{128}$', h) for h in hashes):
            return 'Raw-SHA512'
        # sha256 (64 hex chars)
        if any(re.match(r'^[0-9a-fA-F]{64}$', h) for h in hashes):
            return 'Raw-SHA256'
        # sha1 (40 hex chars)
        if any(re.match(r'^[0-9a-fA-F]{40}$', h) for h in hashes):
            return 'Raw-SHA1'
        # md5 (32 hex chars) – must NOT look like LM (uppercase 32 hex = could be LM)
        if any(re.match(r'^[0-9a-f]{32}$', h) for h in hashes):
            return 'Raw-MD5'
        # NTLM (32 hex, uppercase) - john calls it NT
        if any(re.match(r'^[0-9A-F]{32}$', h) for h in hashes):
            return 'NT'
        # MySQL 4.1+ (*hex41)
        if any(h.startswith('*') and re.match(r'^\*[0-9A-F]{40}$', h) for h in hashes):
            return 'mysql-sha1'
    except Exception:
        pass
    return None


def parse_john_output(job: CrackJob, line: str) -> None:
    """Extract progress metrics from a line of john output."""
    try:
        # Loaded hashes: "Loaded 5 password hashes with …"
        m = re.search(r'Loaded (\d+) password hash', line)
        if m:
            job.loaded_hashes    = int(m.group(1))
            job.total_hashes     = job.loaded_hashes
            job.progress_percentage = max(job.progress_percentage, 5)

        # Format detection from output
        if not job.hash_format:
            m = re.search(r'\(([A-Za-z0-9_-]+)\)', line)
            if m and job.loaded_hashes > 0:
                fmt = m.group(1).lower()
                if fmt not in ('note', 'warning', 'etc'):
                    job.hash_format = fmt

        # Speed from status line: "0g 0:00:01:23  5.00% (ETA: …) 123p/s …"
        m = re.search(r'(\d+(?:\.\d+)?[KMGTk]?)\s*(?:p/s|c/s|C/s)', line)
        if m:
            job.speed = m.group(0).strip()
            job.progress_percentage = min(99, job.progress_percentage + 1)

        # Percentage completed
        m = re.search(r'(\d+(?:\.\d+)?)\s*%', line)
        if m:
            pct = float(m.group(1))
            if pct <= 100:
                job.progress_percentage = min(99, max(job.progress_percentage, int(pct)))

        # ETA full datetime: "ETA: 2026-04-23 01:07"  or  "ETA: 03:16:18"
        m = re.search(r'ETA:\s*([^\s)]+(?:\s+\d{2}:\d{2})?)', line)
        if m:
            job.eta = m.group(1).strip()

        # Guesses so far: "0g 0:00:01:23"
        m = re.search(r'^(\d+)g\s', line)
        if m:
            job.passwords_tried = int(m.group(1))

        # "Trying: word" on some john builds
        m = re.match(r'Trying:\s*(.+)', line, re.I)
        if m:
            job.current_password = m.group(1).strip()

        job.progress = job.progress_percentage

    except Exception:
        pass


def _best_wordlist(user_provided: str | None) -> str:
    """Return best available wordlist path."""
    if user_provided and os.path.isfile(user_provided):
        return user_provided
    if os.path.isfile(ROCKYOU):
        return ROCKYOU
    if os.path.isfile(FALLBACK_WL):
        return FALLBACK_WL
    return FALLBACK_WL  # return path even if not exists, john will error gracefully


def _cleanup_session(session: str) -> None:
    """Remove john session files from known locations."""
    search_dirs = [
        '/root/.john',
        os.path.join(JOHN_HOME, '..'),  # sometimes relative
        '/home/john/.john',
        '/tmp',
        '.',  # current working directory
    ]
    for d in search_dirs:
        for ext in ('.rec', '.log', '.status'):
            p = os.path.join(d, f"{session}{ext}")
            try:
                if os.path.exists(p):
                    os.remove(p)
            except Exception:
                pass
    # Also clean up local session files
    for ext in ('.rec', '.log'):
        p = f"{session}{ext}"
        try:
            if os.path.exists(p):
                os.remove(p)
        except Exception:
            pass


def _add_cracked(job: CrackJob, username: str, password: str) -> bool:
    """
    Add a cracked credential to the job, avoiding duplicates.
    Returns True if added (new), False if duplicate.
    """
    username = username.strip()
    password = password.strip()
    if not username or not password:
        return False
    # Check for duplicate by username
    if any(p['username'] == username for p in job.cracked_passwords):
        return False
    job.cracked_passwords.append({
        'username':  username,
        'password':  password,
        'timestamp': datetime.now().isoformat(),
    })
    return True


# ═════════════════════════════════════════════════════════════════════════════
#  Telegram
# ═════════════════════════════════════════════════════════════════════════════
def send_telegram_message(message: str) -> bool:
    with telegram_lock:
        cfg = dict(telegram_config)          # snapshot under lock
    if not (cfg['enabled'] and cfg['bot_token'] and cfg['chat_id']):
        return False
    try:
        url  = f"https://api.telegram.org/bot{cfg['bot_token']}/sendMessage"
        resp = requests.post(url, json={
            'chat_id':    cfg['chat_id'],
            'text':       message,
            'parse_mode': 'HTML',
        }, timeout=10)
        return resp.status_code == 200
    except Exception as exc:
        print(f"[Telegram] {exc}")
        return False


def _telegram_job_report(job: CrackJob) -> None:
    try:
        lines = [
            "🔓 <b>John the Ripper – Job Completed</b>",
            "",
            f"📋 <b>Job ID :</b> {job.job_id[:8]}…",
            f"📁 <b>File   :</b> {os.path.basename(job.hash_file)}",
            f"⚙️  <b>Mode   :</b> {job.mode}",
            f"⏱  <b>Time   :</b> {job._duration()}s",
            f"🔑 <b>Cracked ({len(job.cracked_passwords)}):</b>",
        ]
        for i, p in enumerate(job.cracked_passwords[:20], 1):
            lines.append(f"  {i}. <code>{p['username']}:{p['password']}</code>")
        if len(job.cracked_passwords) > 20:
            lines.append(f"  … and {len(job.cracked_passwords) - 20} more")
        lines += ["", "✅ Completed"]
        send_telegram_message("\n".join(lines))
    except Exception as exc:
        print(f"[Telegram report] {exc}")


# ═════════════════════════════════════════════════════════════════════════════
#  Core cracking function (runs in a daemon thread)
# ═════════════════════════════════════════════════════════════════════════════
def run_john_crack(job_id: str) -> None:
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return

    env = os.environ.copy()
    env['JOHN'] = JOHN_HOME

    session = f"sess_{job_id[:8]}"

    try:
        job.status     = 'running'
        job.start_time = time.time()
        job.progress   = 0
        job.progress_percentage = 0

        # ── Auto-detect format ─────────────────────────────────────────
        detected_fmt = detect_hash_format(job.hash_file, env)
        if detected_fmt:
            job.hash_format = detected_fmt
            job.output.append(f"[*] Detected format : {detected_fmt}")

        # ── Build CLI command ──────────────────────────────────────────
        cmd = [JOHN_EXECUTABLE, f'--session={session}']

        # Add format if detected (helps john avoid mis-detection)
        if detected_fmt:
            cmd.append(f'--format={detected_fmt}')

        if job.mode == 'wordlist':
            wl = _best_wordlist(job.wordlist)
            cmd += [f'--wordlist={wl}', '--rules=best64']
        elif job.mode == 'incremental':
            cmd.append('--incremental')
        elif job.mode == 'single':
            cmd.append('--single')
        # 'default' → no extra flags, john auto-selects strategy

        cmd.append(job.hash_file)

        job.output += [
            f"[*] John     : {JOHN_EXECUTABLE} (jumbo)",
            f"[*] Command  : {' '.join(cmd)}",
            f"[*] Wordlist : {job.wordlist or 'auto'}",
            f"[*] Threads  : {os.cpu_count() or 4} OpenMP",
        ]

        # ── Launch ────────────────────────────────────────────────────
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            universal_newlines=True,
            bufsize=1,
            env=env,
        )
        job.process = process

        # ── Stream output ─────────────────────────────────────────────
        for raw in iter(process.stdout.readline, ''):
            line = raw.rstrip('\n').rstrip()
            if not line:
                continue

            # Silently drop noise lines
            if _is_skip(line):
                continue

            job.output.append(line)
            parse_john_output(job, line)

            # ── Detect a cracked password ──────────────────────────────
            # John prints:  username:password  (bare, no extra prefix)
            # Only process if it looks like a credential line
            if ':' in line and not _is_metadata(line):
                # Must not start with typical john status prefixes
                stripped = line.lstrip()
                if stripped and not stripped[0].isdigit():
                    parts    = line.split(':', 1)
                    username = parts[0].strip()
                    password = parts[1].strip()
                    # Sanity checks: non-empty, reasonable length, no path/meta chars
                    if (username and password
                            and 1 <= len(username) <= 256
                            and 1 <= len(password) <= 256
                            and not username.startswith('[')
                            and not username.startswith('(')
                            and not any(c in username for c in ('/', '\\', '*', '=', '(', ')'))
                            and not password.startswith('/')
                            and not username.lower().startswith('using ')
                            and not username.lower().startswith('will ')
                            and not username.lower().startswith('no ')
                            ):
                        if _add_cracked(job, username, password):
                            job.progress_percentage = min(
                                99, job.progress_percentage + 10)
                            job.output.append(
                                f"[+] CRACKED → {username} : {password}")

        process.wait()
        return_code = process.returncode
        job.output.append(f"[*] John exited with code {return_code}")

        # ── --show: collect final results from john's pot file ─────────
        try:
            show_cmd = [JOHN_EXECUTABLE, '--show', job.hash_file]
            if detected_fmt:
                show_cmd.insert(2, f'--format={detected_fmt}')

            show = subprocess.run(
                show_cmd,
                capture_output=True, text=True, timeout=30, env=env,
            )
            show_out = show.stdout.strip()
            if show_out:
                job.output.append("=== Results (--show) ===")
                added_count = 0
                for ln in show_out.splitlines():
                    ln = ln.strip()
                    if not ln:
                        continue
                    job.output.append(ln)
                    # "0 password hashes cracked" → skip
                    if ln.startswith('0 ') or 'password hash' in ln.lower():
                        continue
                    if ':' in ln:
                        p     = ln.split(':', 1)
                        uname = p[0].strip()
                        pwd   = p[1].strip()
                        # Strip trailing hash/format info after the password
                        # john --show lines are: user:password:UID:GID:GECOS:home:shell
                        # or just user:password
                        if _add_cracked(job, uname, pwd):
                            added_count += 1
                if added_count > 0:
                    job.output.append(
                        f"[+] {added_count} additional result(s) from --show")
        except Exception as exc:
            job.output.append(f"[!] --show error: {exc}")

        # ── Clean up session files ─────────────────────────────────────
        _cleanup_session(session)

        job.status             = 'completed'
        job.progress           = 100
        job.progress_percentage= 100
        job.end_time           = time.time()

        n = len(job.cracked_passwords)
        job.output.append(
            f"[✓] Job completed. {n} password(s) cracked.")

        if job.telegram_notify and job.cracked_passwords:
            _telegram_job_report(job)

    except Exception as exc:
        job.status   = 'failed'
        job.end_time = time.time()
        job.output.append(f"[!] Fatal error: {exc}")
        _cleanup_session(session)


# ═════════════════════════════════════════════════════════════════════════════
#  Routes
# ═════════════════════════════════════════════════════════════════════════════
@app.route('/')
def index():
    return render_template('index.html')


# ── System info ───────────────────────────────────────────────────────────────
@app.route('/api/info')
def api_info():
    env = os.environ.copy()
    env['JOHN'] = JOHN_HOME
    try:
        # --list=build-info gives the full jumbo version string
        r = subprocess.run(
            [JOHN_EXECUTABLE, '--list=build-info'],
            capture_output=True, text=True, timeout=8, env=env,
        )
        raw  = (r.stdout or '') + (r.stderr or '')
        ver  = 'John the Ripper (unknown)'
        for ln in raw.splitlines():
            ln = ln.strip()
            if ln.startswith('Version:'):
                ver = ln.replace('Version:', '').strip()
                break
        wl_info = (f"rockyou.txt ({ROCKYOU})"
                   if os.path.isfile(ROCKYOU)
                   else f"password.lst ({FALLBACK_WL})")
        return jsonify({
            'status':   'success',
            'version':  ver,
            'executable': JOHN_EXECUTABLE,
            'john_home':  JOHN_HOME,
            'wordlist':   wl_info,
            'formats_available': True,
        })
    except Exception as exc:
        return jsonify({'status': 'error', 'message': str(exc)}), 500


# ── File upload ───────────────────────────────────────────────────────────────
@app.route('/api/upload', methods=['POST'])
def api_upload():
    if 'file' not in request.files:
        return jsonify({'status': 'error', 'message': 'No file provided'}), 400
    f = request.files['file']
    if not f.filename:
        return jsonify({'status': 'error', 'message': 'No file selected'}), 400
    if not allowed_file(f.filename):
        exts = ', '.join(sorted(app.config['ALLOWED_EXTENSIONS']))
        return jsonify({'status': 'error',
                        'message': f'Allowed extensions: {exts}'}), 400

    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    name     = f"{int(time.time())}_{secure_filename(f.filename)}"
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], name)
    f.save(filepath)
    return jsonify({'status': 'success', 'filename': name, 'filepath': filepath})


# ── Paste hashes ──────────────────────────────────────────────────────────────
@app.route('/api/paste', methods=['POST'])
def api_paste():
    data = request.get_json(silent=True) or {}
    content = data.get('content', '').strip()
    if not content:
        return jsonify({'status': 'error', 'message': 'Content required'}), 400

    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    name     = f"paste_{int(time.time())}.txt"
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], name)
    try:
        with open(filepath, 'w', encoding='utf-8') as fh:
            fh.write(content + '\n')
        return jsonify({'status': 'success', 'filename': name, 'filepath': filepath})
    except Exception as exc:
        return jsonify({'status': 'error', 'message': str(exc)}), 500


# ── Start crack ───────────────────────────────────────────────────────────────
@app.route('/api/crack', methods=['POST'])
def api_crack():
    data = request.get_json(silent=True) or {}
    hash_file = data.get('hash_file', '').strip()
    if not hash_file:
        return jsonify({'status': 'error', 'message': 'hash_file required'}), 400
    if not os.path.isfile(hash_file):
        return jsonify({'status': 'error',
                        'message': f'File not found: {hash_file}'}), 400

    mode     = data.get('mode', 'default')
    raw_wl   = data.get('wordlist') or None
    wordlist = _best_wordlist(raw_wl) if mode == 'wordlist' else raw_wl

    job_id = str(uuid.uuid4())
    job    = CrackJob(job_id=job_id, hash_file=hash_file,
                      wordlist=wordlist, mode=mode,
                      telegram_notify=bool(data.get('telegram_notify', False)))

    with jobs_lock:
        jobs[job_id] = job

    t = Thread(target=run_john_crack, args=(job_id,), daemon=True)
    t.start()

    return jsonify({
        'status':   'success',
        'job_id':   job_id,
        'message':  'Cracking job started',
        'wordlist': wordlist or 'auto',
        'mode':     mode,
    })


# ── Job status ────────────────────────────────────────────────────────────────
@app.route('/api/status/<job_id>')
def api_status(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return jsonify({'status': 'error', 'message': 'Job not found'}), 404
    return jsonify({'status': 'success', 'job': job.to_dict()})


# ── List jobs ─────────────────────────────────────────────────────────────────
@app.route('/api/jobs')
def api_jobs():
    with jobs_lock:
        job_list = [j.to_dict() for j in jobs.values()]
    job_list.sort(key=lambda x: x.get('start_time') or 0, reverse=True)
    return jsonify({'status': 'success', 'jobs': job_list})


# ── Stop job ──────────────────────────────────────────────────────────────────
@app.route('/api/stop/<job_id>', methods=['POST'])
def api_stop(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return jsonify({'status': 'error', 'message': 'Job not found'}), 404
    if job.status != 'running' or not job.process:
        return jsonify({'status': 'error', 'message': 'Job is not running'}), 400
    try:
        job.process.terminate()             # SIGTERM first
        try:
            job.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            job.process.kill()              # SIGKILL if it didn't stop
        job.status              = 'stopped'
        job.end_time            = time.time()
        job.progress_percentage = job.progress_percentage  # keep current
        job.output.append('[*] Job stopped by user')
        return jsonify({'status': 'success', 'message': 'Job stopped'})
    except Exception as exc:
        return jsonify({'status': 'error', 'message': str(exc)}), 500


# ── Delete job ────────────────────────────────────────────────────────────────
@app.route('/api/delete/<job_id>', methods=['DELETE'])
def api_delete(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            return jsonify({'status': 'error', 'message': 'Job not found'}), 404
        if job.process and job.status == 'running':
            try:
                job.process.terminate()
                job.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                job.process.kill()
            except Exception:
                pass
        del jobs[job_id]
    return jsonify({'status': 'success', 'message': 'Job deleted'})


# ── Telegram config ───────────────────────────────────────────────────────────
@app.route('/api/telegram/config', methods=['GET', 'POST'])
def api_telegram_config():
    if request.method == 'GET':
        with telegram_lock:
            return jsonify({
                'status': 'success',
                'config': {
                    'enabled':    telegram_config['enabled'],
                    'configured': bool(telegram_config['bot_token']
                                       and telegram_config['chat_id']),
                },
            })

    data = request.get_json(silent=True) or {}
    with telegram_lock:
        if 'bot_token' in data:
            telegram_config['bot_token'] = data['bot_token'].strip() or None
        if 'chat_id' in data:
            telegram_config['chat_id']   = data['chat_id'].strip() or None
        if 'enabled' in data:
            telegram_config['enabled']   = bool(data['enabled'])

    if (telegram_config['enabled'] and telegram_config['bot_token']
            and telegram_config['chat_id']):
        ok = send_telegram_message(
            "🔔 <b>John the Ripper Web UI</b>\n\n"
            "Telegram notifications enabled ✅")
        if not ok:
            return jsonify({
                'status':  'error',
                'message': 'Config saved but test message failed – '
                           'check token and chat ID',
            }), 400

    return jsonify({'status': 'success', 'message': 'Configuration saved'})


@app.route('/api/telegram/test', methods=['POST'])
def api_telegram_test():
    ok = send_telegram_message(
        "🧪 <b>Test Message</b>\n\n"
        "This is a test from John the Ripper Web UI.")
    if ok:
        return jsonify({'status': 'success',
                        'message': 'Test message sent successfully'})
    return jsonify({'status': 'error',
                    'message': 'Failed – check your configuration'}), 400


# ── Version ───────────────────────────────────────────────────────────────────
@app.route('/api/version')
def api_version():
    try:
        env = os.environ.copy()
        env['JOHN'] = JOHN_HOME
        r = subprocess.run(
            [JOHN_EXECUTABLE, '--list=build-info'],
            capture_output=True, text=True, timeout=8, env=env,
        )
        raw = (r.stdout or '') + (r.stderr or '')
        ver = 'unknown'
        for ln in raw.splitlines():
            if ln.startswith('Version:'):
                ver = ln.replace('Version:', '').strip()
                break
        return jsonify({
            'status': 'success',
            'version': ver,
            'executable': JOHN_EXECUTABLE,
            'formats_available': True,
        })
    except Exception as exc:
        return jsonify({'status': 'error', 'message': str(exc)}), 500


# ═════════════════════════════════════════════════════════════════════════════
#  Entry point
# ═════════════════════════════════════════════════════════════════════════════
if __name__ == '__main__':
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    print("=" * 60)
    print("  John the Ripper Web UI  –  jumbo edition")
    print("=" * 60)
    print(f"  URL      : http://0.0.0.0:1996")
    print(f"  John     : {JOHN_EXECUTABLE}")
    print(f"  John home: {JOHN_HOME}")
    print(f"  Wordlist : {ROCKYOU if os.path.isfile(ROCKYOU) else FALLBACK_WL}")
    print("=" * 60)
    app.run(host='0.0.0.0', port=1996, debug=False, threaded=True)
