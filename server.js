const http = require('http');
const net = require('net');

const TTYD_PORT = 7680;
const PROXY_PORT = 7681;
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();
const DEFAULT_VOICE_LANGUAGE = (process.env.VOICE_LANGUAGE || 'EN').toUpperCase().trim();

async function handleTranscribe(req, res) {
    if (!GROQ_API_KEY) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            error: 'GROQ_API_KEY_NOT_CONFIGURED',
            message: 'Please configure GROQ_API_KEY in your .env file first!' 
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
                    'Authorization': `Bearer ${GROQ_API_KEY}`
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

const server = http.createServer((req, res) => {
    // Return server configuration (Groq status & default language)
    if (req.url === '/api/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            hasGroqKey: Boolean(GROQ_API_KEY),
            defaultLanguage: DEFAULT_VOICE_LANGUAGE || 'EN',
            status: Boolean(GROQ_API_KEY) ? 'ready' : 'missing_groq_key'
        }));
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
    if (GROQ_API_KEY) {
        console.log(`[proxy] Groq Whisper Cloud API enabled (whisper-large-v3-turbo)`);
    } else {
        console.log(`[proxy] GROQ_API_KEY not configured in .env`);
    }
});
