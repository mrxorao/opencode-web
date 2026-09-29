# OpenCode AI - Web Terminal (Docker)

Access the **OpenCode AI CLI** directly from your browser on desktop or mobile through a modern web terminal (`ttyd`), with a fully self-contained environment and persistent local storage.

[![Docker Hub](https://img.shields.io/docker/pulls/xorao/opencode-web?logo=docker&label=Docker%20Hub)](https://hub.docker.com/r/xorao/opencode-web)

---

## 📁 File Structure

```text
opencode-web/
├── docker-compose.yml     # Container orchestration and local volume bindings
├── Dockerfile             # Custom image with Node.js, ttyd, git, and OpenCode CLI
├── entrypoint.sh          # Terminal startup script with auto-restart loop
├── server.js              # Reverse proxy, PWA static server & Groq transcription
├── index.html             # Mobile-optimized terminal template with responsive viewport
├── public/                # PWA static assets (manifest.json, sw.js, app icons)
├── .env                   # Port, credentials, VOICE_GROQ_API_KEY, and VOICE_LANGUAGE
├── .env.example           # Example configuration file
├── README.md              # Documentation and usage instructions
├── workspace/             # Directory where OpenCode works (projects saved here)
└── data/
    ├── config/            # OpenCode settings, models, and credentials (~/.config/opencode)
    └── share/             # Conversation history and session data (~/.local/share/opencode)
```

---

## 🚀 Quick Start

### Option 1: Run directly with Docker Compose (Pre-built Image)

1. **Start the Container:**
   ```bash
   docker compose up -d
   ```

### Option 2: Run directly with Docker CLI

```bash
docker run -d \
  --name opencode-web \
  --restart unless-stopped \
  -p 7681:7681 \
  -e TTYD_AUTH=admin:admin123 \
  -v $(pwd)/workspace:/workspace \
  -v $(pwd)/data/config:/root/.config/opencode \
  -v $(pwd)/data/share:/root/.local/share/opencode \
  xorao/opencode-web:latest
```

---

## 🌐 Accessing the Web Terminal (Desktop & Mobile)

- **Local Access:** [http://localhost:7681](http://localhost:7681)
- **Local Network (Wi-Fi):** `http://<YOUR-PC-LOCAL-IP>:7681`
- **Remote Access (Tailscale):** `http://<YOUR-PC-TAILSCALE-IP>:7681`

### 🔐 Default Login Credentials
- **Username:** `admin`
- **Password:** `admin123`
*(You can change or disable this in `.env` via `TTYD_AUTH`)*

---

## 🎙️ Cloud Voice Recognition & Conversation Mode (STT / TTS)

A built-in floating voice toolbar is available directly on the web interface (desktop and mobile/smartphone):
- **🎙️ Gravar (Single Dictation):** Click the microphone to dictate your prompt in real-time.
- **💬 Modo Conversa (Interactive Dialogue Loop):** Continuous hands-free conversation — you speak, Groq Whisper transcribes and sends the prompt, OpenCode responds, TTS reads the AI answer aloud, and the microphone automatically reopens for your next reply!
- **⚡ Ultra-Fast Cloud STT:** Powered by Groq's `whisper-large-v3-turbo` via `VOICE_GROQ_API_KEY` (~200ms transcription).
- **🔒 Dedicated Voice Key:** `VOICE_GROQ_API_KEY` is used exclusively for speech-to-text without cluttering OpenCode AI models.
- **⚙️ Configurable Language:** Set `VOICE_LANGUAGE=EN` (default), `PT`, or `BR` in your `.env` file.
- **📱 Mobile Responsive:** Floating toolbar designed specifically for touchscreen devices and mobile browsers (Chrome, Safari, Firefox, Edge).

---

## 📲 Progressive Web App (PWA) - Install as Native App

OpenCode Web can be installed directly as a standalone application on any device:

- **Desktop (Chrome / Edge / Brave):** Click the **Install App** button on the address bar or the toolbar download icon to install OpenCode as a dedicated desktop window without browser borders.
- **Android (Chrome / Samsung Internet / Firefox):** Tap the install prompt or select **"Install app"** / **"Add to Home screen"** from the browser menu.
- **iOS / iPadOS (Safari):** Tap the **Share** button (📤) and select **"Add to Home Screen"** (`Adicionar ao ecrã principal`).
- **Features:**
  - Standalone fullscreen UI optimized for touch and keyboard.
  - Dedicated modern app icon and splash screen.
  - Background Service Worker with instant loading cache.

---

## 🤖 Configuring AI Models

API keys and custom providers (OpenAI, Anthropic Claude, Google Gemini, OpenRouter, LiteLLM, Ollama) are configured **directly inside the OpenCode terminal interface**:
- All configuration and credentials entered inside OpenCode are automatically persisted to [`data/config`](file:///D:/Projetos/opencode-web/data/config).
- Workspace files are saved directly inside [`workspace`](file:///D:/Projetos/opencode-web/workspace).

---

## 🛑 Useful Commands

- **View terminal logs:**
  ```bash
  docker compose logs -f
  ```

- **Stop the service:**
  ```bash
  docker compose down
  ```

- **Pull latest image version:**
  ```bash
  docker compose pull
  docker compose up -d
  ```
