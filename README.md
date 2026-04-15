# John the Ripper Web UI

A professional web interface for John the Ripper password cracking tool running on port 1996.

## Features

### Core Features
- 🎨 **Modern Professional UI** - Dark theme with responsive design
- 🚀 **Real-time Job Monitoring** - Live updates of cracking progress
- 📊 **Dashboard Statistics** - Overview of jobs and cracked passwords
- 🔧 **Multiple Cracking Modes** - Support for default, single, wordlist, and incremental modes
- 📜 **Job History** - Track all completed and failed jobs
- 🔍 **Detailed Job View** - View full output and cracked passwords
- 💾 **Export Results** - View and copy cracked passwords

### Live Progress Tracking
- 📈 **Real-time Progress Bar** - Visual progress indicator (0-100%)
- ⚡ **Live Speed Display** - Passwords per second (p/s) in real-time
- 🔑 **Current Password Display** - See what password is being tried
- 🔢 **Passwords Tried Counter** - Total attempts counter
- ⏱️ **ETA Display** - Estimated time of arrival
- #️⃣ **Hash Count** - Number of loaded hashes
- 📊 **Progress Details Grid** - Comprehensive progress information

### Input Methods
- 📁 **File Upload** - Upload hash files (.txt, .hash, .passwd, .shadow)
- 📋 **Paste Hashes** - Directly paste hashes into text area
- 🔄 **Dual Input Mode** - Toggle between upload and paste modes

### Telegram Integration
- 📱 **Telegram Notifications** - Receive real-time notifications on Telegram
- 🤖 **Bot Configuration** - Easy setup with guided instructions
- ✅ **Auto Results Delivery** - Automatically send cracked passwords to Telegram
- 🧪 **Test Functionality** - Test your Telegram connection
- 📝 **Per-Job Toggle** - Choose which jobs send notifications

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

#### Method 1: Upload Hash File

1. **Access the UI:**
   - Open your browser and navigate to `http://localhost:1996`

2. **Upload Hash File:**
   - Click the "Upload File" tab
   - Click the upload area or drag and drop a hash file
   - Supported formats: .txt, .hash, .passwd, .shadow

#### Method 2: Paste Hashes

1. **Access the UI:**
   - Open your browser and navigate to `http://localhost:1996`

2. **Paste Hashes:**
   - Click the "Paste Hashes" tab
   - Paste your hashes directly into the text area
   - One hash per line, any supported format

#### Configure and Start Cracking

3. **Configure Cracking Options:**
   - Select cracking mode (Default, Single, Wordlist, Incremental)
   - For Wordlist mode, optionally specify wordlist path
   - Check "Send results to Telegram" if you want notifications

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

### Setting Up Telegram Notifications

1. **Click Telegram button** in the header
2. **Create a Telegram Bot:**
   - Open Telegram and search for `@BotFather`
   - Send `/newbot` and follow instructions
   - Copy the Bot Token provided

3. **Get Your Chat ID:**
   - Search for `@userinfobot` in Telegram
   - Send any message to get your Chat ID
   - Copy the Chat ID

4. **Configure in Web UI:**
   - Paste Bot Token and Chat ID
   - Enable notifications
   - Click "Save & Test"
   - You should receive a test message

5. **Enable Per-Job Notifications:**
   - When creating a job, check "Send results to Telegram"
   - Results will be sent automatically when cracking completes

## API Endpoints

### System Information
- `GET /api/info` - Get John the Ripper version and system info

### Input Methods
- `POST /api/upload` - Upload hash file
- `POST /api/paste` - Paste hashes as text

### Job Management
- `POST /api/crack` - Start new cracking job
- `GET /api/jobs` - List all jobs
- `GET /api/status/<job_id>` - Get job status
- `POST /api/stop/<job_id>` - Stop running job
- `DELETE /api/delete/<job_id>` - Delete job

### Telegram Integration
- `GET /api/telegram/config` - Get current Telegram configuration
- `POST /api/telegram/config` - Set Telegram bot token and chat ID
- `POST /api/telegram/test` - Send test message to Telegram

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
- **Telegram Security:** Keep your bot token secret and never share it publicly
- Limit file upload sizes and types
- Monitor resource usage

## Project Structure

```
/home/john/webapp/
├── app.py                  # Flask backend application
├── requirements.txt        # Python dependencies
├── README.md              # Documentation
├── start.sh               # Quick start script
├── demo_hashes.txt        # Demo hash file for testing
├── static/
│   ├── css/
│   │   └── style.css      # Professional UI styles
│   ├── js/
│   │   └── app.js         # Frontend JavaScript
│   └── uploads/           # Uploaded/pasted hash files
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
- **API Integration:** Requests library for Telegram

### Frontend
- **Design:** Modern dark theme with gradients
- **Icons:** Font Awesome 6.4.0
- **JavaScript:** Vanilla JS with Fetch API
- **Real-time Updates:** Auto-refresh every 3 seconds
- **Modals:** Job details and Telegram settings

### Features Implementation
- Thread-safe job management with locks
- Real-time output streaming
- Progress tracking
- Result parsing and display
- Job history and statistics
- Dual input modes (upload/paste)
- Telegram bot integration with HTML formatting
- Per-job notification toggle

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

### Paste not working
- Ensure you're pasting valid hash formats
- Check that content is not empty
- Try uploading a file instead if paste continues to fail

### Telegram notifications not working
- Verify bot token is correct (from @BotFather)
- Confirm chat ID is correct (from @userinfobot)
- Ensure "Enable Telegram Notifications" is checked
- Test connection using "Send Test Message" button
- Check that the job has "Send results to Telegram" enabled
- Verify your bot is not blocked

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
