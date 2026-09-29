const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const TTYD_PORT = 7680;
const PROXY_PORT = 7681;
const VOICE_GROQ_API_KEY = (process.env.VOICE_GROQ_API_KEY || process.env.GROQ_API_KEY || '').trim();
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

        const row = db.prepare(`
            SELECT p.id, p.data, p.time_created
            FROM part p
            JOIN message m ON p.message_id = m.id
            WHERE json_extract(m.data, '$.role') = 'assistant'
              AND json_extract(p.data, '$.type') = 'text'
            ORDER BY p.time_created DESC
            LIMIT 1
        `).get();

        if (row) {
            const data = JSON.parse(row.data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id: row.id,
                text: data.text,
                time: row.time_created
            }));
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text: null, id: null }));
        }
    } catch (err) {
        console.error('Error in handleLatestAiMessage:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    }
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
            formData.append('model', 'whisper-large-v3-turbo');
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

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text: data.text }));
        } catch (err) {
            console.error('Server transcription error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
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

const server = http.createServer((req, res) => {
    // Serve PWA assets (manifest, Service Worker, icons)
    if (handleStaticPwa(req, res)) {
        return;
    }

    // Return server configuration (Groq status & default language)
    if (req.url === '/api/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            hasGroqKey: Boolean(VOICE_GROQ_API_KEY),
            defaultLanguage: DEFAULT_VOICE_LANGUAGE || 'EN',
            status: Boolean(VOICE_GROQ_API_KEY) ? 'ready' : 'missing_groq_key'
        }));
        return;
    }

    // Return latest clean assistant message for Text-to-Speech
    if (req.url === '/api/latest-ai-message' && req.method === 'GET') {
        handleLatestAiMessage(req, res);
        return;
    }

    // Handle audio transcription
    if (req.url === '/api/transcribe' && req.method === 'POST') {
        handleTranscribe(req, res);
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
});

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
    console.log(`[proxy] Web Terminal & Voice Server listening on port ${PROXY_PORT} -> ttyd :${TTYD_PORT}`);
    console.log(`[proxy] Default Voice Language: ${DEFAULT_VOICE_LANGUAGE}`);
    if (VOICE_GROQ_API_KEY) {
        console.log(`[proxy] Groq Whisper Cloud API enabled (whisper-large-v3-turbo)`);
    } else {
        console.log(`[proxy] VOICE_GROQ_API_KEY not configured in .env`);
    }
});
