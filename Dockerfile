FROM node:22-bookworm-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ripgrep \
    ca-certificates \
    procps \
    python3 \
    nano \
    vim \
    tmux \
    && rm -rf /var/lib/apt/lists/*

# Install standalone ttyd binary (web terminal)
RUN curl -fsSL https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd

# Install OpenCode AI CLI globally
RUN npm install -g opencode-ai@latest

# Default working directory for projects
WORKDIR /workspace

# Copy mobile-optimized web terminal template
COPY index.html /usr/local/share/ttyd/index.html

# Copy PWA assets
COPY public /public

# Copy voice transcription proxy server
COPY server.js /server.js

# Entrypoint startup script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Default web terminal port
EXPOSE 7681

ENTRYPOINT ["/entrypoint.sh"]
