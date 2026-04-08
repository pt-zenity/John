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

# Global storage for running jobs
jobs = {}
jobs_lock = Lock()


class CrackJob:
    """Represents a password cracking job"""
    def __init__(self, job_id, hash_file, wordlist=None, mode='default'):
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
            'duration': self._calculate_duration()
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


def run_john_crack(job_id):
    """Run John the Ripper in a separate thread"""
    with jobs_lock:
        job = jobs.get(job_id)
    
    if not job:
        return
    
    try:
        job.status = 'running'
        job.start_time = time.time()
        
        # Build command
        cmd = [JOHN_EXECUTABLE]
        
        # Add mode-specific options
        if job.mode == 'wordlist' and job.wordlist:
            cmd.extend(['--wordlist=' + job.wordlist])
        elif job.mode == 'incremental':
            cmd.extend(['--incremental'])
        elif job.mode == 'single':
            cmd.extend(['--single'])
        
        # Add hash file
        cmd.append(job.hash_file)
        
        job.output.append(f"Starting John the Ripper with command: {' '.join(cmd)}")
        
        # Run the process
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            universal_newlines=True,
            bufsize=1
        )
        
        job.process = process
        
        # Read output
        for line in iter(process.stdout.readline, ''):
            if line:
                job.output.append(line.strip())
                # Parse for cracked passwords
                if ':' in line and not line.startswith('Loaded'):
                    parts = line.split(':')
                    if len(parts) >= 2:
                        job.cracked_passwords.append({
                            'username': parts[0].strip(),
                            'password': parts[1].strip(),
                            'timestamp': datetime.now().isoformat()
                        })
        
        process.wait()
        
        # Get the results using --show
        try:
            show_cmd = [JOHN_EXECUTABLE, '--show', job.hash_file]
            result = subprocess.run(
                show_cmd,
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.stdout:
                job.output.append("\n=== Cracked Passwords ===")
                for line in result.stdout.strip().split('\n'):
                    if line and ':' in line and not line.startswith('0 password'):
                        job.output.append(line)
                        parts = line.split(':')
                        if len(parts) >= 2:
                            # Check if not already added
                            username = parts[0].strip()
                            password = parts[1].strip()
                            if not any(p['username'] == username for p in job.cracked_passwords):
                                job.cracked_passwords.append({
                                    'username': username,
                                    'password': password,
                                    'timestamp': datetime.now().isoformat()
                                })
        except Exception as e:
            job.output.append(f"Error getting results: {str(e)}")
        
        job.status = 'completed'
        job.progress = 100
        job.end_time = time.time()
        
    except Exception as e:
        job.status = 'failed'
        job.output.append(f"Error: {str(e)}")
        job.end_time = time.time()


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


@app.route('/api/crack', methods=['POST'])
def start_crack():
    """Start a password cracking job"""
    data = request.get_json()
    
    if not data or 'hash_file' not in data:
        return jsonify({'status': 'error', 'message': 'Hash file required'}), 400
    
    # Generate job ID
    job_id = str(uuid.uuid4())
    
    # Create job
    job = CrackJob(
        job_id=job_id,
        hash_file=data['hash_file'],
        wordlist=data.get('wordlist'),
        mode=data.get('mode', 'default')
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
        'message': 'Cracking job started'
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
