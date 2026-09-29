# OpenCode AI - Web Terminal (Docker)

Access the **OpenCode AI CLI** directly from your browser on desktop or mobile through a modern web terminal (`ttyd`), with a fully self-contained environment and persistent local storage.

---

## 📁 File Structure

```text
opencode-web/
├── docker-compose.yml     # Container orchestration and local volume bindings
├── Dockerfile             # Custom image with Node.js, ttyd, git, and OpenCode CLI
├── entrypoint.sh          # Terminal startup script with auto-restart loop
├── .env                   # Port and authentication credentials
├── .env.example           # Example configuration file
├── README.md              # Documentation and usage instructions
├── workspace/             # Directory where OpenCode works (projects saved here)
└── data/
    ├── config/            # OpenCode settings, models, and credentials (~/.config/opencode)
    └── share/             # Conversation history and session data (~/.local/share/opencode)
```

---

## 🚀 Getting Started

1. **Start the Container:**
   ```bash
   docker compose up -d
   ```

2. **Access in Your Browser (Desktop or Smartphone):**
   - **Local URL:** [http://localhost:7681](http://localhost:7681)
   - **Local Network (Wi-Fi):** `http://<YOUR-PC-LOCAL-IP>:7681`
   - **Remote Access (Tailscale):** `http://<YOUR-PC-TAILSCALE-IP>:7681`

3. **Default Login Credentials:**
   - **Username:** `admin`
   - **Password:** `admin123`
   *(You can change or disable this in the `.env` file under `TTYD_AUTH`)*

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

- **Rebuild image (after updates):**
  ```bash
  docker compose build --no-cache
  docker compose up -d
  ```
