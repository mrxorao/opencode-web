#!/bin/bash
set -e

export TERM=xterm-256color

# Create infinite loop script for OpenCode auto-restart
cat << 'EOF' > /start-opencode.sh
#!/bin/bash
export TERM=xterm-256color
cd /workspace

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

echo "Starting Web Terminal & Voice Server on port 7681..."
node /server.js &
SERVER_PID=$!

# Trap termination signals
trap 'kill -TERM $TTYD_PID $SERVER_PID 2>/dev/null' SIGTERM SIGINT

wait -n $TTYD_PID $SERVER_PID
