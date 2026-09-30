#!/bin/bash
set -e

export TERM=xterm-256color
export UV_THREADPOOL_SIZE=8
export NODE_OPTIONS="--max-old-space-size=2048 --no-warnings"

# Check and update OpenCode AI to the latest version on container startup
AUTO_UPDATE="${AUTO_UPDATE:-true}"
if [ "$AUTO_UPDATE" = "true" ] || [ "$AUTO_UPDATE" = "1" ]; then
    echo "📦 Checking and updating OpenCode AI to the latest version..."
    npm install -g opencode-ai@latest || echo "⚠️ Could not update OpenCode AI (offline/network error), continuing with installed version."
fi

CURRENT_VERSION=$(opencode --version 2>/dev/null || echo "installed")
echo "✓ OpenCode AI active version: $CURRENT_VERSION"

# Clean uploads directory on startup
mkdir -p /workspace/uploads
rm -rf /workspace/uploads/* 2>/dev/null || true
echo "🧹 Cleaned uploads folder on startup"

# Setup default .opencodeignore and .gitignore to prevent heavy file indexing CPU spikes
if [ ! -f /workspace/.opencodeignore ]; then
    cat << 'EOF_IGNORE' > /workspace/.opencodeignore
node_modules/
.git/
.next/
dist/
build/
vendor/
__pycache__/
.venv/
venv/
uploads/
*.log
*.tmp
*.sqlite
*.sqlite3
*.db
EOF_IGNORE
fi

# Setup tmux configuration for persistent session management
tmux kill-server 2>/dev/null || true
cat << 'EOF' > /root/.tmux.conf
set -g default-terminal "xterm-256color"
set -g mouse on
set -g status off
set -s escape-time 0
set -g history-limit 50000
set -g aggressive-resize on
set -g allow-passthrough on
set -s set-clipboard on
set -as terminal-features ',xterm-256color:clipboard'
set -as terminal-overrides ',xterm*:Ms=\\E]52;%p1%s;%p2%s\\7'
set -g exit-unattached off
set -g destroy-unattached off
set -s exit-empty off
EOF

# Create persistent tmux session wrapper for OpenCode
cat << 'EOF' > /start-opencode.sh
#!/bin/bash
export TERM=xterm-256color
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export UV_THREADPOOL_SIZE=8
export NODE_OPTIONS="--max-old-space-size=2048 --no-warnings"
cd /workspace

# Unset Groq API key inside OpenCode session so it is only used by the voice transcription proxy
unset GROQ_API_KEY
unset VOICE_GROQ_API_KEY
unset VOICE_GROQ_MODEL

# Attach to existing opencode tmux session, or create it if not running
exec tmux -u new-session -A -s opencode "/bin/bash -c 'while true; do clear; echo \"🚀 ===============================================\"; echo \"   OpenCode AI Web Terminal\"; echo \"   Working Directory: /workspace\"; echo \"===============================================\"; echo \"\"; opencode || true; echo \"\"; echo \"🔄 OpenCode session ended. Restarting in 2 seconds...\"; sleep 2; done'"
EOF

chmod +x /start-opencode.sh

TTYD_CMD=(ttyd -W -a -I /usr/local/share/ttyd/index.html -i 127.0.0.1 -p 7680 -P 5 -t fontSize=14 -t disableLeaveAlert=true -t reconnect=2)

if [ -n "$TTYD_AUTH" ]; then
    TTYD_CMD+=(-c "$TTYD_AUTH")
fi

TTYD_CMD+=(/start-opencode.sh)

echo "Starting internal ttyd on 127.0.0.1:7680 with OpenCode auto-restart..."
"${TTYD_CMD[@]}" &
TTYD_PID=$!

# Prepare SSL certificates if HTTPS is enabled
SSL_DIR="/root/.config/opencode/ssl"
if [ "$ENABLE_HTTPS" = "true" ] || [ "$ENABLE_SSL" = "true" ]; then
    if [ ! -f "$SSL_DIR/server.key" ] || [ ! -f "$SSL_DIR/server.crt" ]; then
        echo "Generating self-signed SSL certificate in $SSL_DIR..."
        mkdir -p "$SSL_DIR"
        openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
            -keyout "$SSL_DIR/server.key" \
            -out "$SSL_DIR/server.crt" \
            -subj "/CN=opencode-web/O=OpenCode AI/C=PT" 2>/dev/null || true
    fi
fi

echo "Starting Web Terminal & Voice Server on port 7681..."
node --no-warnings /server.js &
SERVER_PID=$!

# Trap termination signals
trap 'kill -TERM $TTYD_PID $SERVER_PID 2>/dev/null' SIGTERM SIGINT

wait -n $TTYD_PID $SERVER_PID
