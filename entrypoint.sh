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

TTYD_CMD=(ttyd -W -a -I /usr/local/share/ttyd/index.html -p 7681 -t fontSize=14 -t disableLeaveAlert=true)

if [ -n "$TTYD_AUTH" ]; then
    TTYD_CMD+=(-c "$TTYD_AUTH")
fi

TTYD_CMD+=(/start-opencode.sh)

echo "Starting ttyd on port 7681 with OpenCode auto-restart..."
exec "${TTYD_CMD[@]}"
