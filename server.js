const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const TTYD_PORT = 7680;
const PROXY_PORT = 7681;
const VOICE_GROQ_API_KEY = (process.env.VOICE_GROQ_API_KEY || process.env.GROQ_API_KEY || '').trim();
const VOICE_GROQ_MODEL = (process.env.VOICE_GROQ_MODEL || 'whisper-large-v3-turbo').trim();
const DEFAULT_VOICE_LANGUAGE = (process.env.VOICE_LANGUAGE || 'EN').toUpperCase().trim();

const DB_PATHS = [
    '/root/.local/share/opencode/opencode.db',
    path.join(__dirname, 'data', 'share', 'opencode.db')
];

function getOpenCodeDb() {
    for (const p of DB_PATHS) {
        if (fs.existsSync(p)) {
            try {
                const { DatabaseSync } = require('node:sqlite');
                return new DatabaseSync(p, { readOnly: true });
            } catch (e) {
                console.error('Failed to open SQLite DB at', p, e.message);
            }
        }
    }
    return null;
}

function handleLatestAiMessage(req, res) {
    try {
        const db = getOpenCodeDb();
        if (!db) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text: null, id: null }));
            return;
        }

        const rows = db.prepare(`
            SELECT p.id, p.data, p.time_created
            FROM part p
            JOIN message m ON p.message_id = m.id
            WHERE json_extract(m.data, '$.role') = 'assistant'
              AND (
                json_extract(p.data, '$.type') = 'text'
                OR json_extract(p.data, '$.tool') = 'question'
                OR json_extract(p.data, '$.type') = 'tool'
              )
            ORDER BY p.time_created DESC
            LIMIT 15
        `).all();

        for (const row of rows) {
            const data = JSON.parse(row.data);
            
            // 1. Question Tool (Multiple choice / selection options)
            if (data.type === 'tool' && data.tool === 'question') {
                const questions = data.state?.input?.questions || [];
                let questionText = '';
                const isPt = (DEFAULT_VOICE_LANGUAGE === 'PT' || DEFAULT_VOICE_LANGUAGE === 'BR');
                const optPrefix = isPt ? 'Opção' : 'Option';
                questions.forEach((q) => {
                    if (q.question) {
                        questionText += (q.header ? `${q.header}: ` : '') + `${q.question}\n`;
                    }
                    if (Array.isArray(q.options) && q.options.length > 0) {
                        q.options.forEach((opt, optIdx) => {
                            const label = typeof opt === 'string' ? opt : (opt.label || opt.title || '');
                            const desc = (typeof opt === 'object' && opt.description) ? ` - ${opt.description}` : '';
                            questionText += `${optPrefix} ${optIdx + 1}: ${label}${desc}\n`;
                        });
                    }
                });
                if (questionText.trim()) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        id: row.id + (data.state?.status || ''),
                        text: questionText.trim(),
                        time: row.time_created,
                        isQuestion: true
                    }));
                    return;
                }
            }

            // 2. Standard Text Part
            if (data.type === 'text' && data.text && data.text.trim()) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    id: row.id,
                    text: data.text,
                    time: row.time_created,
                    isQuestion: false
                }));
                return;
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: null, id: null }));
    } catch (err) {
        console.error('Error in handleLatestAiMessage:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    }
}

function sanitizeVoiceInput(rawText) {
    if (!rawText || typeof rawText !== 'string') return '';
    let text = rawText.trim();

    // 1. Remove wrapping quotes or brackets if speech returned quoted string
    text = text.replace(/^["'`“”«»]+|["'`“”«»]+$/g, '').trim();

    // 2. Loop to aggressively strip any leading command triggers ($, /, \, !), leading punctuation, markdown, dashes, dots, spaces
    let prev = '';
    while (text !== prev) {
        prev = text;
        text = text.replace(/^[\s"'`“”«»\-–—.*_~#$!\/\\:;>|]+/, '').trim();
    }

    return text;
}

async function handleTranscribe(req, res) {
    if (!VOICE_GROQ_API_KEY) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            error: 'GROQ_API_KEY_NOT_CONFIGURED',
            message: 'Please configure VOICE_GROQ_API_KEY in your .env file first!' 
        }));
        return;
    }

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
        try {
            const buffer = Buffer.concat(chunks);
            let language = (req.headers['x-audio-language'] || 'en').toLowerCase();
            if (language === 'br' || language === 'pt') language = 'pt';
            
            const contentType = req.headers['content-type'] || 'audio/webm';

            const formData = new FormData();
            const blob = new Blob([buffer], { type: contentType });
            formData.append('file', blob, 'recording.webm');
            formData.append('model', VOICE_GROQ_MODEL);
            formData.append('language', language);
            formData.append('response_format', 'json');

            const groqResp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${VOICE_GROQ_API_KEY}`
                },
                body: formData
            });

            const data = await groqResp.json();
            if (!groqResp.ok) {
                console.error('Groq transcription error response:', data);
                res.writeHead(groqResp.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: data.error?.message || 'Groq transcription error' }));
                return;
            }

            let rawText = (data.text || '').trim();
            let text = sanitizeVoiceInput(rawText);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text }));
        } catch (err) {
            console.error('Server transcription error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
    });
}

const { Readable } = require('stream');
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/workspace';
const UPLOADS_DIR = path.join(WORKSPACE_DIR, 'uploads');

// Clean uploads folder on startup
try {
    if (fs.existsSync(UPLOADS_DIR)) {
        const files = fs.readdirSync(UPLOADS_DIR);
        for (const file of files) {
            try {
                fs.unlinkSync(path.join(UPLOADS_DIR, file));
            } catch(e) {}
        }
        console.log(`[cleanup] Cleaned ${files.length} file(s) from uploads directory on startup.`);
    } else {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
} catch(err) {
    console.warn('[cleanup] Failed to clean uploads folder on startup:', err.message);
}

async function handleUpload(req, res) {
    try {
        if (!fs.existsSync(UPLOADS_DIR)) {
            fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        }

        const webReq = new Request('http://localhost' + req.url, {
            method: req.method,
            headers: req.headers,
            body: Readable.toWeb(req),
            duplex: 'half'
        });

        const formData = await webReq.formData();
        const uploadedFiles = [];

        for (const [key, value] of formData.entries()) {
            if (typeof value === 'object' && typeof value.arrayBuffer === 'function') {
                const originalName = value.name || 'attachment';
                const safeName = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, '_');
                
                let finalName = safeName;
                let targetPath = path.join(UPLOADS_DIR, finalName);
                let counter = 1;
                const ext = path.extname(safeName);
                const base = path.basename(safeName, ext);
                while (fs.existsSync(targetPath)) {
                    finalName = `${base}_${counter}${ext}`;
                    targetPath = path.join(UPLOADS_DIR, finalName);
                    counter++;
                }

                const buffer = Buffer.from(await value.arrayBuffer());
                fs.writeFileSync(targetPath, buffer);

                uploadedFiles.push({
                    name: finalName,
                    originalName: originalName,
                    relativePath: `uploads/${finalName}`,
                    absolutePath: targetPath,
                    size: buffer.length
                });
            }
        }

        if (uploadedFiles.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'NO_FILES_UPLOADED', message: 'No valid files received.' }));
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, files: uploadedFiles }));
    } catch (err) {
        console.error('Server upload error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Upload failed' }));
    }
}

// Prompts SQLite Database Management
let promptsDbInstance = null;

function getPromptsDb() {
    if (promptsDbInstance) return promptsDbInstance;

    let dbDir = '/root/.local/share/opencode';
    if (!fs.existsSync(dbDir)) {
        dbDir = path.join(__dirname, 'data', 'share');
    }
    if (!fs.existsSync(dbDir)) {
        dbDir = WORKSPACE_DIR;
    }
    try {
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
    } catch(e) {}

    const dbPath = path.join(dbDir, 'prompts.db');

    try {
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(dbPath);
        
        db.exec(`
            CREATE TABLE IF NOT EXISTS prompts (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL
            );
        `);

        const countRow = db.prepare('SELECT COUNT(*) as count FROM prompts').get();
        if (countRow && countRow.count === 0) {
            const insertStmt = db.prepare(`
                INSERT INTO prompts (id, title, content, time_created, time_updated)
                VALUES (?, ?, ?, ?, ?)
            `);
            const now = Date.now();
            const seed = [
                { id: 'p1', title: '⚡ Refatorar Código', content: 'Por favor refatora o seguinte código para torná-lo mais limpo, modular, eficiente e legível:\n\n' },
                { id: 'p2', title: '🧪 Gerar Testes Unitários', content: 'Cria testes unitários abrangentes cobrindo casos normais e extremos para a seguinte implementação:\n\n' },
                { id: 'p3', title: '🐛 Explicar & Corrigir Bug', content: 'Analisa o seguinte erro/comportamento inesperado e explica a causa raiz com a respetiva correção detalhada:\n\n' },
                { id: 'p4', title: '🛡️ Auditoria de Segurança', content: 'Revê este código identificando possíveis vulnerabilidades de segurança, injeções, validações em falta e boas práticas:\n\n' }
            ];
            for (const item of seed) {
                insertStmt.run(item.id, item.title, item.content, now, now);
            }
        }

        promptsDbInstance = db;
        console.log('[db] SQLite prompts database initialized at:', dbPath);
        return db;
    } catch(err) {
        console.error('[db] Failed to initialize SQLite prompts DB:', err);
        return null;
    }
}

function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 2e6) {
                reject(new Error('Payload too large'));
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch(e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

function handleGetPrompts(req, res, parsedUrl) {
    try {
        const db = getPromptsDb();
        if (!db) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'DB_UNAVAILABLE', message: 'Could not connect to SQLite database.' }));
            return;
        }

        const search = (parsedUrl.searchParams.get('search') || '').trim();
        const page = Math.max(1, parseInt(parsedUrl.searchParams.get('page'), 10) || 1);
        const limit = Math.max(1, Math.min(50, parseInt(parsedUrl.searchParams.get('limit'), 10) || 5));
        const offset = (page - 1) * limit;

        let total = 0;
        let prompts = [];

        if (search) {
            const pattern = `%${search}%`;
            const countRow = db.prepare('SELECT COUNT(*) as count FROM prompts WHERE title LIKE ? OR content LIKE ?').get(pattern, pattern);
            total = countRow ? countRow.count : 0;
            prompts = db.prepare('SELECT id, title, content, time_created, time_updated FROM prompts WHERE title LIKE ? OR content LIKE ? ORDER BY time_updated DESC, time_created DESC LIMIT ? OFFSET ?').all(pattern, pattern, limit, offset);
        } else {
            const countRow = db.prepare('SELECT COUNT(*) as count FROM prompts').get();
            total = countRow ? countRow.count : 0;
            prompts = db.prepare('SELECT id, title, content, time_created, time_updated FROM prompts ORDER BY time_updated DESC, time_created DESC LIMIT ? OFFSET ?').all(limit, offset);
        }

        const totalPages = Math.ceil(total / limit) || 1;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            prompts,
            total,
            page,
            limit,
            totalPages
        }));
    } catch(err) {
        console.error('Error fetching prompts from SQLite:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    }
}

async function handleSavePrompt(req, res) {
    try {
        const db = getPromptsDb();
        if (!db) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'DB_UNAVAILABLE' }));
            return;
        }

        const body = await parseJsonBody(req);
        const title = (body.title || '').trim();
        const content = (body.content || '').trim();
        let id = (body.id || '').trim();

        if (!title || !content) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'INVALID_INPUT', message: 'Title and content are required.' }));
            return;
        }

        const now = Date.now();
        if (id) {
            const existing = db.prepare('SELECT id, time_created FROM prompts WHERE id = ?').get(id);
            if (existing) {
                db.prepare('UPDATE prompts SET title = ?, content = ?, time_updated = ? WHERE id = ?').run(title, content, now, id);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, prompt: { id, title, content, time_created: existing.time_created, time_updated: now } }));
                return;
            }
        }

        if (!id) {
            id = 'p_' + now + '_' + Math.random().toString(36).substring(2, 7);
        }
        db.prepare('INSERT INTO prompts (id, title, content, time_created, time_updated) VALUES (?, ?, ?, ?, ?)').run(id, title, content, now, now);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, prompt: { id, title, content, time_created: now, time_updated: now } }));
    } catch(err) {
        console.error('Error saving prompt to SQLite:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    }
}

async function handleDeletePrompt(req, res, parsedUrl) {
    try {
        const db = getPromptsDb();
        if (!db) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'DB_UNAVAILABLE' }));
            return;
        }

        let id = parsedUrl.searchParams.get('id');
        if (!id && (req.method === 'POST' || req.method === 'DELETE')) {
            const body = await parseJsonBody(req);
            id = body.id;
        }

        if (!id) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'MISSING_ID', message: 'Prompt ID is required.' }));
            return;
        }

        db.prepare('DELETE FROM prompts WHERE id = ?').run(id);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, id }));
    } catch(err) {
        console.error('Error deleting prompt from SQLite:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    }
}

// Clipboard synchronization state & SSE management
let currentClipboard = { id: '0', text: '', timestamp: 0 };
let clipboardClients = [];

function broadcastClipboard(data) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    clipboardClients.forEach(client => {
        try {
            client.write(payload);
        } catch(e) {}
    });
}

function handleClipboardPost(req, res) {
    let body = '';
    req.on('data', chunk => {
        body += chunk;
        if (body.length > 5e6) { // 5MB limit
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payload too large' }));
            req.destroy();
        }
    });
    req.on('end', () => {
        let textToSave = '';
        try {
            if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
                const json = JSON.parse(body);
                textToSave = (json.text || '').toString();
            } else {
                textToSave = body.toString();
            }
        } catch(e) {
            textToSave = body.toString();
        }

        if (textToSave) {
            currentClipboard = {
                id: 'clip_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
                text: textToSave,
                timestamp: Date.now()
            };
            broadcastClipboard(currentClipboard);
            console.log(`[clipboard] Received & broadcasted new clipboard content (${textToSave.length} chars)`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, id: currentClipboard.id }));
    });
}

function handleClipboardEvents(req, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    clipboardClients.push(res);

    const keepAliveTimer = setInterval(() => {
        try {
            res.write(': ping\n\n');
        } catch(e) {}
    }, 15000);

    req.on('close', () => {
        clearInterval(keepAliveTimer);
        clipboardClients = clipboardClients.filter(c => c !== res);
    });
}

const PUBLIC_DIR = path.join(__dirname, 'public');

const PWA_MIME_TYPES = {
    '.json': 'application/manifest+json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

function handleStaticPwa(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    
    let fileName = null;
    if (pathname === '/manifest.json' || pathname === '/manifest.webmanifest') fileName = 'manifest.json';
    else if (pathname === '/sw.js' || pathname === '/service-worker.js') fileName = 'sw.js';
    else if (pathname === '/icon-192.png' || pathname === '/apple-touch-icon.png' || pathname === '/apple-touch-icon-precomposed.png') fileName = 'icon-192.png';
    else if (pathname === '/icon-512.png') fileName = 'icon-512.png';
    else if (pathname === '/icon-maskable.png') fileName = 'icon-maskable.png';
    else if (pathname === '/icon.svg') fileName = 'icon.svg';
    else if (pathname === '/favicon.ico') fileName = 'icon-192.png';

    if (!fileName) return false;

    const filePath = path.join(PUBLIC_DIR, fileName);
    if (!fs.existsSync(filePath)) return false;

    try {
        const ext = path.extname(fileName);
        const contentType = PWA_MIME_TYPES[ext] || 'application/octet-stream';
        const stat = fs.statSync(filePath);
        
        const headers = {
            'Content-Type': contentType,
            'Content-Length': stat.size,
            'Cache-Control': fileName === 'sw.js' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=86400'
        };

        if (fileName === 'sw.js') {
            headers['Service-Worker-Allowed'] = '/';
        }

        res.writeHead(200, headers);
        if (req.method === 'HEAD') {
            res.end();
            return true;
        }
        fs.createReadStream(filePath).pipe(res);
        return true;
    } catch (err) {
        console.error('Error serving static PWA file:', err);
        return false;
    }
}

const ENABLE_HTTPS = (process.env.ENABLE_HTTPS === 'true' || process.env.ENABLE_SSL === 'true');
const SSL_KEY_PATH = process.env.SSL_KEY || '/root/.config/opencode/ssl/server.key';
const SSL_CERT_PATH = process.env.SSL_CERT || '/root/.config/opencode/ssl/server.crt';

function requestListener(req, res) {
    // Serve PWA assets (manifest, Service Worker, icons)
    if (handleStaticPwa(req, res)) {
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // Return server configuration (Groq status, default language & HTTPS status)
    if (pathname === '/api/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            hasGroqKey: Boolean(VOICE_GROQ_API_KEY),
            groqModel: VOICE_GROQ_MODEL,
            defaultLanguage: DEFAULT_VOICE_LANGUAGE || 'EN',
            isHttps: isHttps,
            status: Boolean(VOICE_GROQ_API_KEY) ? 'ready' : 'missing_groq_key'
        }));
        return;
    }

    // Return latest clean assistant message for Text-to-Speech
    if (pathname === '/api/latest-ai-message' && req.method === 'GET') {
        handleLatestAiMessage(req, res);
        return;
    }

    // Handle audio transcription
    if (pathname === '/api/transcribe' && req.method === 'POST') {
        handleTranscribe(req, res);
        return;
    }

    // Handle file upload attachments
    if (pathname === '/api/upload' && req.method === 'POST') {
        handleUpload(req, res);
        return;
    }

    // Handle SQLite Prompts API
    if (pathname === '/api/prompts' && req.method === 'GET') {
        handleGetPrompts(req, res, parsedUrl);
        return;
    }

    if ((pathname === '/api/prompts' || pathname === '/api/prompts/save') && (req.method === 'POST' || req.method === 'PUT')) {
        handleSavePrompt(req, res);
        return;
    }

    if ((pathname === '/api/prompts/delete' || pathname === '/api/prompts') && (req.method === 'DELETE' || (pathname === '/api/prompts/delete' && req.method === 'POST'))) {
        handleDeletePrompt(req, res, parsedUrl);
        return;
    }

    // Handle Clipboard Sync APIs
    if (pathname === '/api/clipboard' && req.method === 'POST') {
        handleClipboardPost(req, res);
        return;
    }
    if (pathname === '/api/clipboard' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(currentClipboard));
        return;
    }
    if (pathname === '/api/clipboard/text' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(currentClipboard.text || '');
        return;
    }
    if (pathname === '/api/clipboard-events' && req.method === 'GET') {
        handleClipboardEvents(req, res);
        return;
    }

    // Proxy standard HTTP requests to internal ttyd
    const options = {
        hostname: '127.0.0.1',
        port: TTYD_PORT,
        path: req.url,
        method: req.method,
        headers: req.headers
    };

    const proxyReq = http.request(options, proxyRes => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', err => {
        res.writeHead(502);
        res.end('Bad Gateway');
    });

    req.pipe(proxyReq, { end: true });
}

let isHttps = false;
let server;

if (ENABLE_HTTPS && fs.existsSync(SSL_KEY_PATH) && fs.existsSync(SSL_CERT_PATH)) {
    try {
        const https = require('https');
        server = https.createServer({
            key: fs.readFileSync(SSL_KEY_PATH),
            cert: fs.readFileSync(SSL_CERT_PATH)
        }, requestListener);
        isHttps = true;
    } catch (e) {
        console.error('[proxy] SSL initialization failed, falling back to HTTP:', e.message);
        server = http.createServer(requestListener);
    }
} else {
    server = http.createServer(requestListener);
}

// Proxy WebSocket upgrades to internal ttyd
server.on('upgrade', (req, socket, head) => {
    const proxySocket = net.connect(TTYD_PORT, '127.0.0.1', () => {
        proxySocket.write(
            `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
            Object.entries(req.headers)
                .map(([k, v]) => `${k}: ${v}\r\n`)
                .join('') +
            '\r\n'
        );
        if (head.length > 0) proxySocket.write(head);
        socket.pipe(proxySocket);
        proxySocket.pipe(socket);
    });

    proxySocket.on('error', () => {
        socket.destroy();
    });
    socket.on('error', () => {
        proxySocket.destroy();
    });
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
    const proto = isHttps ? 'https' : 'http';
    console.log(`[proxy] Web Terminal & Voice Server listening on ${proto}://0.0.0.0:${PROXY_PORT} -> ttyd :${TTYD_PORT}`);
    console.log(`[proxy] Default Voice Language: ${DEFAULT_VOICE_LANGUAGE}`);
    if (VOICE_GROQ_API_KEY) {
        console.log(`[proxy] Groq Whisper Cloud API enabled (${VOICE_GROQ_MODEL})`);
    } else {
        console.log(`[proxy] VOICE_GROQ_API_KEY not configured in .env`);
    }
});
