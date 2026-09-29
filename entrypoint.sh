#!/bin/bash
set -e

export TERM=xterm-256color

# Create infinite loop script for OpenCode auto-restart
cat << 'EOF' > /start-opencode.sh
#!/bin/bash
export TERM=xterm-256color
cd /workspace

# Unset Groq API key inside OpenCode session so it is only used by the voice transcription proxy
unset GROQ_API_KEY
unset VOICE_GROQ_API_KEY

while true; do
    clear
    echo "🚀 ==============================================="
    echo "   OpenCode AI Web Terminal"
    echo "   Working Directory: /workspace"
    echo "==============================================="
    echo ""
    opencode || true
    echo ""
    echo "🔄 OpenCode session ended. Restarting automatically in 2 seconds..."
    sleep 2
done
EOF

chmod +x /start-opencode.sh

TTYD_CMD=(ttyd -W -a -I /usr/local/share/ttyd/index.html -i 127.0.0.1 -p 7680 -t fontSize=14 -t disableLeaveAlert=true)

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
node /server.js &
SERVER_PID=$!

# Trap termination signals
trap 'kill -TERM $TTYD_PID $SERVER_PID 2>/dev/null' SIGTERM SIGINT

wait -n $TTYD_PID $SERVER_PID
