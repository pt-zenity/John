#!/usr/bin/env python3
"""
John the Ripper Web UI
A professional web interface for password cracking using John the Ripper
"""

from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_cors import CORS
from werkzeug.utils import secure_filename
import os
import subprocess
import uuid
import time
import json
import requests
from threading import Thread, Lock
from datetime import datetime

app = Flask(__name__)
CORS(app)

# Configuration
app.config['UPLOAD_FOLDER'] = 'static/uploads'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max file size
app.config['ALLOWED_EXTENSIONS'] = {'txt', 'hash', 'passwd', 'shadow'}

# John the Ripper executable path
JOHN_EXECUTABLE = '/usr/sbin/john'
JOHN_HOME = '/usr/share/john'

# Set JOHN environment variable for home directory
os.environ['JOHN'] = JOHN_HOME

# Global storage for running jobs
jobs = {}
jobs_lock = Lock()

# Telegram configuration
telegram_config = {
    'enabled': False,
    'bot_token': None,
    'chat_id': None
}
telegram_lock = Lock()


class CrackJob:
    """Represents a password cracking job"""
    def __init__(self, job_id, hash_file, wordlist=None, mode='default', telegram_notify=False):
        self.job_id = job_id
        self.hash_file = hash_file
        self.wordlist = wordlist
        self.mode = mode
        self.status = 'queued'
        self.progress = 0
        self.output = []
        self.cracked_passwords = []
        self.start_time = None
        self.end_time = None
        self.process = None
        self.telegram_notify = telegram_notify
        # Progress tracking
        self.total_hashes = 0
        self.loaded_hashes = 0
        self.current_password = ''
        self.passwords_tried = 0
        self.speed = '0 p/s'
        self.eta = 'N/A'
        self.progress_percentage = 0
        
    def to_dict(self):
        return {
            'job_id': self.job_id,
            'hash_file': self.hash_file,
            'wordlist': self.wordlist,
            'mode': self.mode,
            'status': self.status,
            'progress': self.progress,
            'output': self.output[-50:],  # Last 50 lines
            'cracked_passwords': self.cracked_passwords,
            'start_time': self.start_time,
            'end_time': self.end_time,
            'duration': self._calculate_duration(),
            # Progress info
            'total_hashes': self.total_hashes,
            'loaded_hashes': self.loaded_hashes,
            'current_password': self.current_password,
            'passwords_tried': self.passwords_tried,
            'speed': self.speed,
            'eta': self.eta,
            'progress_percentage': self.progress_percentage
        }
    
    def _calculate_duration(self):
        if self.start_time:
            end = self.end_time or time.time()
            return round(end - self.start_time, 2)
        return 0


def allowed_file(filename):
    """Check if file extension is allowed"""
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in app.config['ALLOWED_EXTENSIONS']


def parse_john_output(job, line):
    """Parse John the Ripper output for progress information"""
    import re
    
    try:
        # Parse loaded hashes: "Loaded 5 password hashes"
        if 'Loaded' in line and 'password hash' in line:
            match = re.search(r'Loaded (\d+) password hash', line)
            if match:
                job.loaded_hashes = int(match.group(1))
                job.total_hashes = job.loaded_hashes
                job.progress_percentage = 5
        
        # Parse speed: "123p/s" or "1234 p/s"
        speed_match = re.search(r'(\d+(?:\.\d+)?[KMG]?)\s*p/s', line)
        if speed_match:
            job.speed = speed_match.group(1) + ' p/s'
            job.progress_percentage = min(95, job.progress_percentage + 1)
        
        # Parse trying: "Trying: password123"
        if line.startswith('Trying:'):
            parts = line.split(':', 1)
            if len(parts) > 1:
                job.current_password = parts[1].strip()
                job.passwords_tried += 1
                # Update progress based on passwords tried
                if job.passwords_tried % 100 == 0:
                    job.progress_percentage = min(80, 10 + (job.passwords_tried // 1000))
        
        # Parse ETA or time remaining
        if 'ETA:' in line:
            match = re.search(r'ETA:\s*([^\s]+)', line)
            if match:
                job.eta = match.group(1)
        
        # Parse percentage if available
        percent_match = re.search(r'(\d+)%', line)
        if percent_match:
            job.progress_percentage = int(percent_match.group(1))
        
        # Update progress bar value
        job.progress = job.progress_percentage
        
    except Exception as e:
        # Silently ignore parsing errors
        pass


def send_telegram_message(message):
    """Send message to Telegram"""
    with telegram_lock:
        if not telegram_config['enabled'] or not telegram_config['bot_token'] or not telegram_config['chat_id']:
            return False
        
        try:
            url = f"https://api.telegram.org/bot{telegram_config['bot_token']}/sendMessage"
            data = {
                'chat_id': telegram_config['chat_id'],
                'text': message,
                'parse_mode': 'HTML'
            }
            response = requests.post(url, json=data, timeout=10)
            return response.status_code == 200
        except Exception as e:
            print(f"Telegram error: {str(e)}")
            return False


def run_john_crack(job_id):
    """Run John the Ripper in a separate thread"""
    with jobs_lock:
        job = jobs.get(job_id)
    
    if not job:
        return
    
    try:
        job.status = 'running'
        job.start_time = time.time()

        # Unique session name per job – avoids john.rec lock conflicts
        session_name = f"session_{job_id[:8]}"

        # Environment: tell jumbo where its home is
        env = os.environ.copy()
        env['JOHN'] = JOHN_HOME

        # ── Build command ──────────────────────────────────────────────
        cpu_threads = os.cpu_count() or 4
        cmd = [JOHN_EXECUTABLE, f'--session={session_name}']

        if job.mode == 'wordlist':
            wl = job.wordlist or '/usr/share/john/password.lst'
            cmd += [f'--wordlist={wl}', '--rules=best64']
        elif job.mode == 'incremental':
            cmd += ['--incremental']
        elif job.mode == 'single':
            cmd += ['--single']
        # default: let john auto-select

        cmd.append(job.hash_file)

        job.output.append(f"[*] Command : {' '.join(cmd)}")
        job.output.append(f"[*] Threads : {cpu_threads} OpenMP")
        job.output.append(f"[*] John    : {JOHN_EXECUTABLE} (jumbo)")

        # ── Launch ─────────────────────────────────────────────────────
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            universal_newlines=True,
            bufsize=1,
            env=env
        )
        job.process = process

        # ── Stream output ──────────────────────────────────────────────
        SKIP = ('Crash recovery file is locked', 'john.rec',
                'fopen:', 'No such file or directory')

        for raw in iter(process.stdout.readline, ''):
            line = raw.strip()
            if not line:
                continue
            # Drop noisy / error lines we don't want to show
            if any(s in line for s in SKIP):
                continue

            job.output.append(line)
            parse_john_output(job, line)

            # ── Detect cracked password ────────────────────────────────
            # John prints:   username:password  (FOUND banner) or bare line
            # We look for a colon-separated line that isn't metadata
            NOISE = ('session', 'loaded', 'remaining', 'status', 'will run',
                     'using', 'press', 'warning', 'note:', 'cost',
                     'node', 'each node', 'delayed', 'openmp', 'failed',
                     'enabled', 'duplic')
            if ':' in line and not any(n in line.lower() for n in NOISE):
                parts = line.split(':')
                username = parts[0].strip()
                password = ':'.join(parts[1:]).strip()
                # Only accept if it looks like real data (non-empty both sides)
                if username and password and len(password) <= 128:
                    if not any(p['username'] == username
                               for p in job.cracked_passwords):
                        job.cracked_passwords.append({
                            'username': username,
                            'password': password,
                            'timestamp': datetime.now().isoformat()
                        })
                        job.progress_percentage = min(95,
                            job.progress_percentage + 10)
                        job.output.append(
                            f"[+] CRACKED → {username}:{password}")

        process.wait()

        # ── --show: collect anything john cached in its pot file ───────
        try:
            show_result = subprocess.run(
                [JOHN_EXECUTABLE, '--show', job.hash_file],
                capture_output=True, text=True, timeout=30, env=env
            )
            job.output.append("\n=== Final Results (--show) ===")
            for line in show_result.stdout.strip().splitlines():
                if ':' not in line:
                    continue
                if 'password hash' in line.lower() or line.startswith('0 '):
                    job.output.append(line)
                    continue
                parts = line.split(':')
                username = parts[0].strip()
                password = ':'.join(parts[1:]).strip()
                if username and password:
                    job.output.append(f"  {username} : {password}")
                    if not any(p['username'] == username
                               for p in job.cracked_passwords):
                        job.cracked_passwords.append({
                            'username': username,
                            'password': password,
                            'timestamp': datetime.now().isoformat()
                        })
        except Exception as e:
            job.output.append(f"[!] --show error: {e}")

        # ── Cleanup session rec file ───────────────────────────────────
        for ext in ('.rec', '.log'):
            p = f"/root/.john/{session_name}{ext}"
            try:
                if os.path.exists(p):
                    os.remove(p)
            except Exception:
                pass

        job.status = 'completed'
        job.progress = 100
        job.progress_percentage = 100
        job.end_time = time.time()

        if job.telegram_notify and job.cracked_passwords:
            send_job_result_telegram(job)

    except Exception as e:
        job.status = 'failed'
        job.output.append(f"[!] Error: {e}")
        job.end_time = time.time()


def send_job_result_telegram(job):
    """Send job results to Telegram"""
    try:
        message = f"🔓 <b>John the Ripper - Job Completed</b>\n\n"
        message += f"📋 <b>Job ID:</b> {job.job_id[:8]}...\n"
        message += f"📁 <b>File:</b> {os.path.basename(job.hash_file)}\n"
        message += f"⚙️ <b>Mode:</b> {job.mode}\n"
        message += f"⏱ <b>Duration:</b> {job._calculate_duration()}s\n"
        message += f"\n🔑 <b>Cracked Passwords ({len(job.cracked_passwords)}):</b>\n\n"
        
        for i, pwd in enumerate(job.cracked_passwords[:20], 1):  # Limit to 20
            message += f"{i}. <code>{pwd['username']}:{pwd['password']}</code>\n"
        
        if len(job.cracked_passwords) > 20:
            message += f"\n... and {len(job.cracked_passwords) - 20} more passwords\n"
        
        message += f"\n✅ <b>Status:</b> Completed successfully"
        
        send_telegram_message(message)
    except Exception as e:
        print(f"Failed to send Telegram notification: {str(e)}")


@app.route('/')
def index():
    """Render the main page"""
    return render_template('index.html')


@app.route('/api/info', methods=['GET'])
def get_info():
    """Get John the Ripper version and system info"""
    try:
        # Get John version/build info
        result = subprocess.run(
            [JOHN_EXECUTABLE],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        # Parse version info from output
        version_info = "John the Ripper 1.9.0"
        if result.stderr:
            for line in result.stderr.split('\n'):
                if 'John' in line:
                    version_info = line.strip()
                    break
        
        return jsonify({
            'status': 'success',
            'version': version_info,
            'executable': JOHN_EXECUTABLE,
            'formats_available': True
        })
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500


@app.route('/api/upload', methods=['POST'])
def upload_file():
    """Upload a hash file"""
    if 'file' not in request.files:
        return jsonify({'status': 'error', 'message': 'No file provided'}), 400
    
    file = request.files['file']
    
    if file.filename == '':
        return jsonify({'status': 'error', 'message': 'No file selected'}), 400
    
    if file and allowed_file(file.filename):
        filename = secure_filename(file.filename)
        # Add timestamp to avoid conflicts
        timestamp = int(time.time())
        filename = f"{timestamp}_{filename}"
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(filepath)
        
        return jsonify({
            'status': 'success',
            'filename': filename,
            'filepath': filepath
        })
    
    return jsonify({
        'status': 'error',
        'message': 'Invalid file type. Allowed: ' + ', '.join(app.config['ALLOWED_EXTENSIONS'])
    }), 400


@app.route('/api/paste', methods=['POST'])
def paste_hashes():
    """Create hash file from pasted content"""
    data = request.get_json()
    
    if not data or 'content' not in data:
        return jsonify({'status': 'error', 'message': 'Content required'}), 400
    
    content = data['content'].strip()
    
    if not content:
        return jsonify({'status': 'error', 'message': 'Content cannot be empty'}), 400
    
    try:
        # Create filename
        timestamp = int(time.time())
        filename = f"paste_{timestamp}.txt"
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        
        # Save content to file
        with open(filepath, 'w') as f:
            f.write(content)
        
        return jsonify({
            'status': 'success',
            'filename': filename,
            'filepath': filepath
        })
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': f'Failed to save content: {str(e)}'
        }), 500


@app.route('/api/crack', methods=['POST'])
def start_crack():
    """Start a password cracking job"""
    data = request.get_json()
    
    if not data or 'hash_file' not in data:
        return jsonify({'status': 'error', 'message': 'Hash file required'}), 400
    
    # Choose best available wordlist
    wordlist = data.get('wordlist')
    if not wordlist:
        ROCKYOU = '/usr/share/wordlists/rockyou.txt'
        JOHN_WL = '/usr/share/john/password.lst'
        wordlist = ROCKYOU if os.path.exists(ROCKYOU) else JOHN_WL

    # Generate job ID
    job_id = str(uuid.uuid4())
    
    # Create job
    job = CrackJob(
        job_id=job_id,
        hash_file=data['hash_file'],
        wordlist=wordlist,
        mode=data.get('mode', 'default'),
        telegram_notify=data.get('telegram_notify', False)
    )
    
    # Store job
    with jobs_lock:
        jobs[job_id] = job
    
    # Start cracking in background thread
    thread = Thread(target=run_john_crack, args=(job_id,))
    thread.daemon = True
    thread.start()
    
    return jsonify({
        'status': 'success',
        'job_id': job_id,
        'message': 'Cracking job started',
        'wordlist': wordlist
    })


@app.route('/api/status/<job_id>', methods=['GET'])
def get_status(job_id):
    """Get status of a cracking job"""
    with jobs_lock:
        job = jobs.get(job_id)
    
    if not job:
        return jsonify({'status': 'error', 'message': 'Job not found'}), 404
    
    return jsonify({
        'status': 'success',
        'job': job.to_dict()
    })


@app.route('/api/jobs', methods=['GET'])
def list_jobs():
    """List all jobs"""
    with jobs_lock:
        job_list = [job.to_dict() for job in jobs.values()]
    
    # Sort by start time (most recent first)
    job_list.sort(key=lambda x: x.get('start_time', 0), reverse=True)
    
    return jsonify({
        'status': 'success',
        'jobs': job_list
    })


@app.route('/api/stop/<job_id>', methods=['POST'])
def stop_job(job_id):
    """Stop a running job"""
    with jobs_lock:
        job = jobs.get(job_id)
    
    if not job:
        return jsonify({'status': 'error', 'message': 'Job not found'}), 404
    
    if job.process and job.status == 'running':
        try:
            job.process.terminate()
            job.status = 'stopped'
            job.end_time = time.time()
            job.output.append("Job stopped by user")
            return jsonify({
                'status': 'success',
                'message': 'Job stopped'
            })
        except Exception as e:
            return jsonify({
                'status': 'error',
                'message': f'Failed to stop job: {str(e)}'
            }), 500
    
    return jsonify({
        'status': 'error',
        'message': 'Job is not running'
    }), 400


@app.route('/api/delete/<job_id>', methods=['DELETE'])
def delete_job(job_id):
    """Delete a job"""
    with jobs_lock:
        job = jobs.get(job_id)
        if job:
            # Stop process if running
            if job.process and job.status == 'running':
                job.process.terminate()
            # Remove job
            del jobs[job_id]
            return jsonify({
                'status': 'success',
                'message': 'Job deleted'
            })
    
    return jsonify({'status': 'error', 'message': 'Job not found'}), 404


@app.route('/api/telegram/config', methods=['GET', 'POST'])
def telegram_configuration():
    """Get or set Telegram configuration"""
    if request.method == 'GET':
        with telegram_lock:
            return jsonify({
                'status': 'success',
                'config': {
                    'enabled': telegram_config['enabled'],
                    'configured': bool(telegram_config['bot_token'] and telegram_config['chat_id'])
                }
            })
    
    elif request.method == 'POST':
        data = request.get_json()
        
        if not data:
            return jsonify({'status': 'error', 'message': 'Configuration data required'}), 400
        
        with telegram_lock:
            if 'bot_token' in data:
                telegram_config['bot_token'] = data['bot_token'].strip() or None
            
            if 'chat_id' in data:
                telegram_config['chat_id'] = data['chat_id'].strip() or None
            
            if 'enabled' in data:
                telegram_config['enabled'] = bool(data['enabled'])
        
        # Test connection if enabled
        if telegram_config['enabled'] and telegram_config['bot_token'] and telegram_config['chat_id']:
            test_message = "🔔 <b>John the Ripper Web UI</b>\n\nTelegram notifications enabled successfully!"
            if send_telegram_message(test_message):
                return jsonify({
                    'status': 'success',
                    'message': 'Telegram configured and test message sent'
                })
            else:
                return jsonify({
                    'status': 'error',
                    'message': 'Configuration saved but test message failed. Please check your bot token and chat ID.'
                }), 400
        
        return jsonify({
            'status': 'success',
            'message': 'Configuration saved'
        })


@app.route('/api/telegram/test', methods=['POST'])
def test_telegram():
    """Send test message to Telegram"""
    test_message = "🧪 <b>Test Message</b>\n\nThis is a test message from John the Ripper Web UI."
    
    if send_telegram_message(test_message):
        return jsonify({
            'status': 'success',
            'message': 'Test message sent successfully'
        })
    else:
        return jsonify({
            'status': 'error',
            'message': 'Failed to send test message. Please check your configuration.'
        }), 400


if __name__ == '__main__':
    # Ensure upload directory exists
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    
    # Run the application
    print("=" * 60)
    print("John the Ripper Web UI")
    print("=" * 60)
    print(f"Starting server on http://0.0.0.0:1996")
    print(f"John executable: {JOHN_EXECUTABLE}")
    print("=" * 60)
    
    app.run(host='0.0.0.0', port=1996, debug=False)
