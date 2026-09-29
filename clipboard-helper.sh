#!/bin/bash
# Multi-purpose Linux clipboard helper for OpenCode Web Bridge
# Acts as a transparent drop-in replacement for xclip, xsel, wl-copy, wl-paste

CMD_NAME=$(basename "$0")

# Determine protocol (HTTP or HTTPS)
PROTO="http"
if [ "$ENABLE_HTTPS" = "true" ] || [ "$ENABLE_SSL" = "true" ]; then
    PROTO="https"
fi

# Check if reading or writing
IS_READ=0
for arg in "$@"; do
    if [ "$arg" = "-o" ] || [ "$arg" = "--output" ] || [ "$CMD_NAME" = "wl-paste" ]; then
        IS_READ=1
        break
    fi
done

if [ "$IS_READ" -eq 1 ]; then
    # Reading from clipboard
    TEXT=$(curl -k -s -m 1 "$PROTO://127.0.0.1:7681/api/clipboard/text" 2>/dev/null || echo "")
    printf "%s" "$TEXT"
    exit 0
else
    # Writing to clipboard
    INPUT=$(cat)
    if [ -n "$INPUT" ]; then
        # 1. Forward to Node.js proxy server
        curl -k -s -m 1 -X POST "$PROTO://127.0.0.1:7681/api/clipboard" \
            -H "Content-Type: text/plain; charset=utf-8" \
            --data-binary "$INPUT" >/dev/null 2>&1 || true

        # 2. Emit OSC 52 sequence safely via node (catches all TTY errors without shell abort)
        node -e "
            try {
                const fs = require('fs');
                const b64 = Buffer.from(process.argv[1]).toString('base64');
                const seq = '\x1b]52;c;' + b64 + '\x07';
                try {
                    const fd = fs.openSync('/dev/tty', 'w');
                    fs.writeSync(fd, seq);
                    fs.closeSync(fd);
                } catch(e) {}
            } catch(e) {}
        " "$INPUT" 2>/dev/null || true
    fi
    exit 0
fi
