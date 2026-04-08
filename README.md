# John the Ripper Web UI

A professional web interface for John the Ripper password cracking tool running on port 1996.

## Features

- 🎨 **Modern Professional UI** - Dark theme with responsive design
- 🚀 **Real-time Job Monitoring** - Live updates of cracking progress
- 📊 **Dashboard Statistics** - Overview of jobs and cracked passwords
- 🔧 **Multiple Cracking Modes** - Support for default, single, wordlist, and incremental modes
- 📁 **File Upload** - Easy hash file upload interface
- 📜 **Job History** - Track all completed and failed jobs
- 🔍 **Detailed Job View** - View full output and cracked passwords
- 💾 **Export Results** - View and copy cracked passwords

## Installation

### Prerequisites

- Python 3.8+
- John the Ripper installed on system
- Modern web browser

### Setup

1. **Clone or navigate to the project directory:**
   ```bash
   cd /home/john/webapp
   ```

2. **Install John the Ripper (if not installed):**
   ```bash
   apt-get update
   apt-get install -y john
   ```

3. **Create and activate virtual environment:**
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   ```

4. **Install Python dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

## Usage

### Starting the Server

```bash
# Activate virtual environment
source venv/bin/activate

# Run the application
python app.py
```

The server will start on `http://0.0.0.0:1996`

### Using the Web Interface

1. **Access the UI:**
   - Open your browser and navigate to `http://localhost:1996`

2. **Upload Hash File:**
   - Click the upload area or drag and drop a hash file
   - Supported formats: .txt, .hash, .passwd, .shadow

3. **Configure Cracking Options:**
   - Select cracking mode (Default, Single, Wordlist, Incremental)
   - For Wordlist mode, optionally specify wordlist path

4. **Start Cracking:**
   - Click "Start Cracking" button
   - Job will appear in Active Jobs section

5. **Monitor Progress:**
   - View real-time status updates
   - Check cracked passwords as they are discovered
   - View detailed output logs

6. **Manage Jobs:**
   - Stop running jobs
   - View job details
   - Delete completed jobs

## API Endpoints

### System Information
- `GET /api/info` - Get John the Ripper version and system info

### File Operations
- `POST /api/upload` - Upload hash file

### Job Management
- `POST /api/crack` - Start new cracking job
- `GET /api/jobs` - List all jobs
- `GET /api/status/<job_id>` - Get job status
- `POST /api/stop/<job_id>` - Stop running job
- `DELETE /api/delete/<job_id>` - Delete job

## Cracking Modes

### Default Mode
- Automatically tries different attack modes
- Good for general purpose cracking

### Single Crack Mode
- Uses information from the username
- Fast and efficient for simple passwords

### Wordlist Mode
- Uses a dictionary/wordlist file
- Most common mode for password cracking
- Default wordlist: `/usr/share/wordlists/rockyou.txt`

### Incremental Mode
- Brute-force attack
- Tries all possible combinations
- Can be very time-consuming

## Security Notes

⚠️ **Important Security Considerations:**

- This tool is for **authorized security testing only**
- Only test passwords you own or have explicit permission to test
- Store hash files securely
- Use HTTPS in production environments
- Implement authentication for production use
- Limit file upload sizes and types
- Monitor resource usage

## Project Structure

```
/home/john/webapp/
├── app.py                  # Flask backend application
├── requirements.txt        # Python dependencies
├── static/
│   ├── css/
│   │   └── style.css      # Professional UI styles
│   ├── js/
│   │   └── app.js         # Frontend JavaScript
│   └── uploads/           # Uploaded hash files
├── templates/
│   └── index.html         # Main HTML template
└── venv/                  # Python virtual environment
```

## Technical Details

### Backend
- **Framework:** Flask 3.1.3
- **Language:** Python 3
- **Threading:** Multi-threaded job execution
- **Process Management:** Subprocess for John the Ripper

### Frontend
- **Design:** Modern dark theme with gradients
- **Icons:** Font Awesome 6.4.0
- **JavaScript:** Vanilla JS with Fetch API
- **Real-time Updates:** Auto-refresh every 3 seconds

### Features Implementation
- Thread-safe job management with locks
- Real-time output streaming
- Progress tracking
- Result parsing and display
- Job history and statistics

## Troubleshooting

### Server won't start
- Check if port 1996 is available
- Ensure virtual environment is activated
- Verify Python dependencies are installed

### John not found
- Install John the Ripper: `apt-get install john`
- Check if `/usr/sbin/john` exists
- Update `JOHN_EXECUTABLE` in app.py if needed

### Upload fails
- Check file format (must be .txt, .hash, .passwd, or .shadow)
- Verify file size is under 16MB
- Ensure upload directory exists and is writable

### Job not starting
- Verify hash file format is correct
- Check John the Ripper is working: `john --test`
- Review job output logs for errors

## License

This web interface is provided as-is for educational and authorized security testing purposes.

## Credits

- **John the Ripper:** Openwall Project
- **Web UI:** Custom professional interface
- **Icons:** Font Awesome

## Support

For issues or questions:
1. Check the troubleshooting section
2. Review job output logs
3. Verify John the Ripper installation
4. Check system resources

---

**Version:** 1.0.0  
**Port:** 1996  
**Last Updated:** April 2026
