#!/bin/bash
# Multi-purpose Linux clipboard helper for OpenCode Web Bridge
# Completely non-blocking (0ms overhead) to ensure OpenCode never hangs or lags

CMD_NAME=$(basename "$0")

# Determine protocol
PROTO="http"
if [ "$ENABLE_HTTPS" = "true" ] || [ "$ENABLE_SSL" = "true" ]; then
    PROTO="https"
fi

# Reading from clipboard (e.g. xclip -o, wl-paste)
if [ "$1" = "-o" ] || [ "$2" = "-o" ] || [ "$3" = "-o" ] || [ "$CMD_NAME" = "wl-paste" ]; then
    TEXT=$(curl -k -s -m 0.5 "$PROTO://127.0.0.1:7681/api/clipboard/text" 2>/dev/null || echo "")
    printf "%s" "$TEXT"
    exit 0
fi

# Writing to clipboard (e.g. xclip -selection clipboard, xsel, wl-copy)
INPUT=$(cat)
if [ -n "$INPUT" ]; then
    # Completely detached asynchronous forward to proxy server (exits in 0ms, never blocks OpenCode)
    (curl -k -s -m 1 -X POST "$PROTO://127.0.0.1:7681/api/clipboard" \
        -H "Content-Type: text/plain; charset=utf-8" \
        --data-binary "$INPUT" >/dev/null 2>&1 &) >/dev/null 2>&1
fi

exit 0
