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
├── server.js              # Reverse proxy & Groq Whisper cloud audio transcription server
├── index.html             # Mobile-optimized terminal template with responsive viewport
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

## 🎙️ Cloud Voice Recognition & Speech Synthesis (STT / TTS)

A built-in floating voice toolbar is available directly on the web interface (desktop and mobile/smartphone):
- **⚡ Ultra-Fast Cloud STT:** Powered by Groq's `whisper-large-v3-turbo` via `VOICE_GROQ_API_KEY` for near-instant speech transcription (~200ms).
- **🔊 Automatic Text-to-Speech (TTS):** Toggle `🔊 TTS On` to have OpenCode AI responses automatically read aloud in the selected language.
- **🔒 Dedicated Voice Key:** `VOICE_GROQ_API_KEY` is used exclusively for speech-to-text without cluttering OpenCode AI models.
- **🌐 Multilingual Support:** Easily dictate and listen in Portuguese (`PT`), Brazilian Portuguese (`BR`), or English (`EN`).
- **⚙️ Configurable Default Language:** Set `VOICE_LANGUAGE=EN` (default), `PT`, or `BR` in your `.env` file.
- **↵ Auto-Enter Toggle:** Automatically sends the transcribed prompt to OpenCode or keeps it in the input line for review.
- **📱 Mobile Responsive:** Floating toolbar designed specifically for touchscreen devices and mobile browsers (Chrome, Safari, Firefox, Edge).

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
