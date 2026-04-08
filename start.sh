#!/bin/bash

# John the Ripper Web UI Start Script
# This script activates the virtual environment and starts the application

echo "============================================"
echo "Starting John the Ripper Web UI"
echo "============================================"

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "Virtual environment not found!"
    echo "Please run: python3 -m venv venv"
    exit 1
fi

# Activate virtual environment
source venv/bin/activate

# Check if dependencies are installed
python -c "import flask" 2>/dev/null
if [ $? -ne 0 ]; then
    echo "Installing dependencies..."
    pip install -r requirements.txt
fi

# Start the application
echo "Starting server on port 1996..."
python app.py
