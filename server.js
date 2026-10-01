// Suppress Node.js ExperimentalWarning (e.g. node:sqlite) to keep container logs clean
const originalEmitWarning = process.emitWarning;
process.emitWarning = function(warning, ...args) {
    if (typeof warning === 'string' && (warning.includes('ExperimentalWarning') || warning.includes('SQLite'))) return;
    if (warning && typeof warning === 'object' && (warning.name === 'ExperimentalWarning' || warning.message?.includes('SQLite'))) return;
    return originalEmitWarning.call(process, warning, ...args);
};

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const TTYD_PORT = 7680;
const PROXY_PORT = 7681;
const TTYD_AUTH = (process.env.TTYD_AUTH || '').trim();
const VOICE_GROQ_API_KEY = (process.env.VOICE_GROQ_API_KEY || process.env.GROQ_API_KEY || '').trim();
const VOICE_GROQ_MODEL = (process.env.VOICE_GROQ_MODEL || 'whisper-large-v3').trim();
const DEFAULT_VOICE_LANGUAGE = (process.env.VOICE_LANGUAGE || 'EN').toUpperCase().trim();
const RAW_TTS_PROVIDER = (process.env.VOICE_TTS_PROVIDER || process.env.TTS_PROVIDER || 'browser').toLowerCase().trim();
const DEFAULT_TTS_PROVIDER = (RAW_TTS_PROVIDER === 'microsoft' || RAW_TTS_PROVIDER === 'edge' || RAW_TTS_PROVIDER === 'edge-tts') ? 'microsoft' : 'browser';

let MsEdgeTTS, OUTPUT_FORMAT;
try {
    const msedgeModule = require('msedge-tts');
    MsEdgeTTS = msedgeModule.MsEdgeTTS;
    OUTPUT_FORMAT = msedgeModule.OUTPUT_FORMAT;
} catch (e) {
    console.warn('[proxy] msedge-tts module could not be loaded:', e.message);
}

const EDGE_VOICE_MAP = {
    'PT': 'pt-PT-RaquelNeural',
    'PT-PT': 'pt-PT-RaquelNeural',
    'BR': 'pt-BR-FranciscaNeural',
    'PT-BR': 'pt-BR-FranciscaNeural',
    'EN': 'en-US-JennyNeural',
    'EN-US': 'en-US-JennyNeural',
    'ES': 'es-ES-ElviraNeural',
    'FR': 'fr-FR-DeniseNeural',
    'DE': 'de-DE-KatjaNeural',
    'IT': 'it-IT-ElsaNeural'
};

const DB_PATHS = [
    '/root/.local/share/opencode/opencode.db',
    path.join(__dirname, 'data', 'share', 'opencode.db')
];

let openCodeDbInstance = null;
let latestMsgStmt = null;
let partsForMsgStmt = null;

function getOpenCodeDb() {
    if (openCodeDbInstance) return openCodeDbInstance;
    for (const p of DB_PATHS) {
        if (fs.existsSync(p)) {
            try {
                const { DatabaseSync } = require('node:sqlite');
                openCodeDbInstance = new DatabaseSync(p, { readOnly: true });
                return openCodeDbInstance;
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

        if (!latestMsgStmt || !partsForMsgStmt) {
            try {
                latestMsgStmt = db.prepare(`
                    SELECT m.id, m.data, m.time_created, m.time_updated
                    FROM message m
                    WHERE json_extract(m.data, '$.role') = 'assistant'
                    ORDER BY m.time_created DESC
                    LIMIT 3
                `);
                partsForMsgStmt = db.prepare(`
                    SELECT p.id, p.data, p.time_created
                    FROM part p
                    WHERE p.message_id = ?
                    ORDER BY p.time_created ASC
                `);
            } catch (stmtErr) {
                openCodeDbInstance = null;
                latestMsgStmt = null;
                partsForMsgStmt = null;
                throw stmtErr;
            }
        }

        const messages = latestMsgStmt.all();
        if (!messages || messages.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text: null, id: null }));
            return;
        }

        const latestMsg = messages[0];
        let msgData = {};
        try {
            msgData = JSON.parse(latestMsg.data || '{}');
        } catch(e) {}

        const parts = partsForMsgStmt.all(latestMsg.id);

        // 1. Check for interactive question tool prompt waiting for user response
        for (const part of parts) {
            let partData = {};
            try { partData = JSON.parse(part.data || '{}'); } catch(e) {}

            if (partData.type === 'tool' && partData.tool === 'question') {
                const questions = partData.state?.input?.questions || [];
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
                        id: part.id + (partData.state?.status || ''),
                        text: questionText.trim(),
                        time: part.time_created,
                        isQuestion: true,
                        isComplete: true
                    }));
                    return;
                }
            }
        }

        // 2. Check if the assistant turn is still active/processing (tools running, search, etc.)
        const isFinished = (msgData.finish === 'stop' || msgData.time?.completed != null);

        if (!isFinished) {
            // Message is still streaming or running background tools (web search, reading files, etc.)
            // Do NOT trigger speech or open the microphone yet!
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text: null, id: null, isProcessing: true }));
            return;
        }

        // 3. Collect final text parts of the completed message
        let fullText = '';
        for (const part of parts) {
            let partData = {};
            try { partData = JSON.parse(part.data || '{}'); } catch(e) {}
            if (partData.type === 'text' && partData.text && partData.text.trim()) {
                fullText += (fullText ? '\n' : '') + partData.text.trim();
            }
        }

        if (fullText.trim()) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id: latestMsg.id,
                text: fullText.trim(),
                time: msgData.time?.completed || latestMsg.time_updated || latestMsg.time_created,
                isQuestion: false,
                isComplete: true
            }));
            return;
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

let groqValidationCache = {
    checkedAt: 0,
    isValid: false,
    error: null,
    errorMessage: null
};

async function checkGroqStatus(forceRecheck = false) {
    if (!VOICE_GROQ_API_KEY) {
        groqValidationCache = {
            checkedAt: Date.now(),
            isValid: false,
            error: 'MISSING_GROQ_KEY',
            errorMessage: 'VOICE_GROQ_API_KEY is not configured in .env file'
        };
        return groqValidationCache;
    }

    if (!forceRecheck && (Date.now() - groqValidationCache.checkedAt < 45000)) {
        return groqValidationCache;
    }

    try {
        const modelResp = await fetch(`https://api.groq.com/openai/v1/models/${encodeURIComponent(VOICE_GROQ_MODEL)}`, {
            headers: {
                'Authorization': `Bearer ${VOICE_GROQ_API_KEY}`
            },
            signal: AbortSignal.timeout(5000)
        });

        if (modelResp.status === 401 || modelResp.status === 403) {
            const errData = await modelResp.json().catch(() => ({}));
            groqValidationCache = {
                checkedAt: Date.now(),
                isValid: false,
                error: 'INVALID_GROQ_KEY',
                errorMessage: errData.error?.message || 'Invalid or unauthorized VOICE_GROQ_API_KEY in Groq API.'
            };
            return groqValidationCache;
        }

        if (modelResp.status === 404 || !modelResp.ok) {
            const errData = await modelResp.json().catch(() => ({}));
            groqValidationCache = {
                checkedAt: Date.now(),
                isValid: false,
                error: 'INVALID_GROQ_MODEL',
                errorMessage: errData.error?.message || `Voice model '${VOICE_GROQ_MODEL}' does not exist in Groq API.`
            };
            return groqValidationCache;
        }

        groqValidationCache = {
            checkedAt: Date.now(),
            isValid: true,
            error: null,
            errorMessage: null
        };
    } catch (err) {
        groqValidationCache = {
            checkedAt: Date.now(),
            isValid: false,
            error: 'GROQ_NETWORK_ERROR',
            errorMessage: `Connection error to Groq API: ${err.message}`
        };
    }
    return groqValidationCache;
}

async function handleTranscribe(req, res) {
    if (!VOICE_GROQ_API_KEY) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            error: 'GROQ_API_KEY_NOT_CONFIGURED',
            message: 'VOICE_GROQ_API_KEY is not configured in .env file',
            isGroqValid: false
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
                let errCode = 'GROQ_TRANSCRIPTION_ERROR';
                if (groqResp.status === 401 || groqResp.status === 403) {
                    errCode = 'INVALID_GROQ_KEY';
                    groqValidationCache = { checkedAt: Date.now(), isValid: false, error: errCode, errorMessage: data.error?.message || 'Invalid VOICE_GROQ_API_KEY.' };
                } else if (groqResp.status === 400 || groqResp.status === 404) {
                    errCode = 'INVALID_GROQ_MODEL';
                    groqValidationCache = { checkedAt: Date.now(), isValid: false, error: errCode, errorMessage: data.error?.message || `Model '${VOICE_GROQ_MODEL}' does not exist in Groq.` };
                }
                res.writeHead(groqResp.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    error: errCode,
                    message: data.error?.message || 'Transcription error in Groq API',
                    isGroqValid: false
                }));
                return;
            }

            groqValidationCache = { checkedAt: Date.now(), isValid: true, error: null, errorMessage: null };

            let rawText = (data.text || '').trim();
            let text = sanitizeVoiceInput(rawText);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text, isGroqValid: true }));
        } catch (err) {
            console.error('Server transcription error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message, isGroqValid: false }));
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

// Edge TTS (Microsoft Neural Voice) Audio Synthesis Handler
async function handleTTS(req, res, parsedUrl) {
    if (!MsEdgeTTS || !OUTPUT_FORMAT) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'TTS_UNAVAILABLE', message: 'msedge-tts module is not available.' }));
        return;
    }

    if (req.method === 'GET') {
        const text = parsedUrl.searchParams.get('text') || '';
        const lang = parsedUrl.searchParams.get('lang') || DEFAULT_VOICE_LANGUAGE;
        const voice = parsedUrl.searchParams.get('voice') || '';
        await processTTS(text, lang, voice, res);
    } else if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 100000) req.destroy();
        });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body || '{}');
                const text = data.text || '';
                const lang = data.lang || DEFAULT_VOICE_LANGUAGE;
                const voice = data.voice || '';
                await processTTS(text, lang, voice, res);
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'INVALID_JSON', message: err.message }));
            }
        });
    } else {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }));
    }
}

async function processTTS(rawText, langCode, requestedVoice, res) {
    let text = (rawText || '').trim();
    if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'EMPTY_TEXT', message: 'Text to synthesize not provided.' }));
        return;
    }

    if (text.length > 5000) {
        text = text.substring(0, 5000);
    }

    const normLang = (langCode || 'PT').toUpperCase().trim();
    const selectedVoice = requestedVoice || process.env.VOICE_TTS_NAME || EDGE_VOICE_MAP[normLang] || EDGE_VOICE_MAP['PT'] || 'pt-PT-RaquelNeural';

    try {
        const tts = new MsEdgeTTS();
        await tts.setMetadata(selectedVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        const { audioStream } = tts.toStream(text);

        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'no-cache',
            'X-TTS-Voice': selectedVoice
        });

        audioStream.pipe(res);

        audioStream.on('error', (err) => {
            console.error('[tts] Audio stream error:', err.message);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'TTS_STREAM_ERROR', message: err.message }));
            } else {
                res.end();
            }
        });
    } catch (err) {
        console.error('[tts] Edge TTS generation error:', err);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'TTS_SYNTHESIS_ERROR', message: err.message }));
        } else {
            res.end();
        }
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
                is_quick INTEGER DEFAULT 0,
                auto_enter INTEGER DEFAULT 0,
                sort_order INTEGER DEFAULT 0,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL
            );
        `);

        // Run migrations for existing DBs if columns do not exist
        try { db.exec('ALTER TABLE prompts ADD COLUMN is_quick INTEGER DEFAULT 0;'); } catch(e) {}
        try { db.exec('ALTER TABLE prompts ADD COLUMN auto_enter INTEGER DEFAULT 0;'); } catch(e) {}
        try { db.exec('ALTER TABLE prompts ADD COLUMN sort_order INTEGER DEFAULT 0;'); } catch(e) {}

        // Clean up legacy quick prompts (git status, git diff)
        try {
            db.prepare("DELETE FROM prompts WHERE id IN ('qp5', 'qp6') OR (title IN ('git status', 'git diff') AND is_quick = 1)").run();
        } catch(e) {}

        const countRow = db.prepare('SELECT COUNT(*) as count FROM prompts').get();
        if (countRow && countRow.count === 0) {
            const insertStmt = db.prepare(`
                INSERT INTO prompts (id, title, content, is_quick, auto_enter, sort_order, time_created, time_updated)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const now = Date.now();
            const seed = [
                // Quick Command Bubbles
                { id: 'qp1', title: '/new', content: '/new', is_quick: 1, auto_enter: 1, sort_order: 1 },
                { id: 'qp2', title: '/models', content: '/models', is_quick: 1, auto_enter: 1, sort_order: 2 },
                { id: 'qp3', title: '/compact', content: '/compact', is_quick: 1, auto_enter: 1, sort_order: 3 },
                { id: 'qp4', title: '/clear', content: '/clear', is_quick: 1, auto_enter: 1, sort_order: 4 },
                // Full Library Prompts
                { id: 'p1', title: '⚡ Refactor Code', content: 'Please refactor the following code to make it cleaner, more modular, efficient and readable:\n\n', is_quick: 0, auto_enter: 0, sort_order: 5 },
                { id: 'p2', title: '🧪 Generate Unit Tests', content: 'Create comprehensive unit tests covering standard and edge cases for the following implementation:\n\n', is_quick: 0, auto_enter: 0, sort_order: 6 },
                { id: 'p3', title: '🐛 Explain & Fix Bug', content: 'Analyze the following error/unexpected behavior and explain the root cause with a detailed fix:\n\n', is_quick: 0, auto_enter: 0, sort_order: 7 },
                { id: 'p4', title: '🛡️ Security Audit', content: 'Review this code identifying potential security vulnerabilities, injections, missing validations and best practices:\n\n', is_quick: 0, auto_enter: 0, sort_order: 8 }
            ];
            for (const item of seed) {
                insertStmt.run(item.id, item.title, item.content, item.is_quick, item.auto_enter, item.sort_order, now, now);
            }
        } else {
            // Normalize any 0 sort_orders
            try {
                const unranked = db.prepare('SELECT id FROM prompts WHERE sort_order = 0 ORDER BY is_quick DESC, time_created ASC').all();
                if (unranked && unranked.length > 0) {
                    const updateOrder = db.prepare('UPDATE prompts SET sort_order = ? WHERE id = ?');
                    unranked.forEach((item, idx) => {
                        updateOrder.run(idx + 1, item.id);
                    });
                }
            } catch(e) {}
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

function handleGetQuickPrompts(req, res) {
    try {
        const db = getPromptsDb();
        if (!db) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'DB_UNAVAILABLE' }));
            return;
        }
        const quickPrompts = db.prepare('SELECT id, title, content, is_quick, auto_enter, sort_order, time_created, time_updated FROM prompts WHERE is_quick = 1 ORDER BY sort_order ASC, time_created ASC').all();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ quickPrompts }));
    } catch(err) {
        console.error('Error fetching quick prompts:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    }
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
        const type = parsedUrl.searchParams.get('type'); // 'quick', 'standard', or undefined
        const page = Math.max(1, parseInt(parsedUrl.searchParams.get('page'), 10) || 1);
        const limit = Math.max(1, Math.min(100, parseInt(parsedUrl.searchParams.get('limit'), 10) || 5));
        const offset = (page - 1) * limit;

        let whereClauses = [];
        let params = [];

        if (search) {
            whereClauses.push('(title LIKE ? OR content LIKE ?)');
            const pattern = `%${search}%`;
            params.push(pattern, pattern);
        }

        if (type === 'quick') {
            whereClauses.push('is_quick = 1');
        } else if (type === 'standard') {
            whereClauses.push('is_quick = 0');
        }

        const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

        const countQuery = `SELECT COUNT(*) as count FROM prompts ${whereSql}`;
        const countRow = db.prepare(countQuery).get(...params);
        const total = countRow ? countRow.count : 0;

        const selectQuery = `SELECT id, title, content, is_quick, auto_enter, sort_order, time_created, time_updated FROM prompts ${whereSql} ORDER BY sort_order ASC, time_created ASC LIMIT ? OFFSET ?`;
        const prompts = db.prepare(selectQuery).all(...params, limit, offset);

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
        const is_quick = body.is_quick ? 1 : 0;
        const auto_enter = body.auto_enter ? 1 : 0;
        let id = (body.id || '').trim();

        if (!title || !content) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'INVALID_INPUT', message: 'Title and content are required.' }));
            return;
        }

        const now = Date.now();
        if (id) {
            const existing = db.prepare('SELECT id, sort_order, time_created FROM prompts WHERE id = ?').get(id);
            if (existing) {
                db.prepare('UPDATE prompts SET title = ?, content = ?, is_quick = ?, auto_enter = ?, time_updated = ? WHERE id = ?').run(title, content, is_quick, auto_enter, now, id);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, prompt: { id, title, content, is_quick, auto_enter, sort_order: existing.sort_order, time_created: existing.time_created, time_updated: now } }));
                return;
            }
        }

        if (!id) {
            id = 'p_' + now + '_' + Math.random().toString(36).substring(2, 7);
        }

        const maxRow = db.prepare('SELECT MAX(sort_order) as maxOrder FROM prompts').get();
        const sort_order = ((maxRow && maxRow.maxOrder !== null) ? maxRow.maxOrder : 0) + 1;

        db.prepare('INSERT INTO prompts (id, title, content, is_quick, auto_enter, sort_order, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, title, content, is_quick, auto_enter, sort_order, now, now);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, prompt: { id, title, content, is_quick, auto_enter, sort_order, time_created: now, time_updated: now } }));
    } catch(err) {
        console.error('Error saving prompt to SQLite:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    }
}

async function handleReorderPrompts(req, res) {
    try {
        const db = getPromptsDb();
        if (!db) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'DB_UNAVAILABLE' }));
            return;
        }

        const body = await parseJsonBody(req);
        const { id, direction, ordered_ids } = body;

        if (Array.isArray(ordered_ids) && ordered_ids.length > 0) {
            const updateStmt = db.prepare('UPDATE prompts SET sort_order = ? WHERE id = ?');
            ordered_ids.forEach((pId, idx) => {
                updateStmt.run(idx + 1, pId);
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            return;
        }

        if (!id || !direction) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'MISSING_PARAMS', message: 'id and direction (up/down) required.' }));
            return;
        }

        const allItems = db.prepare('SELECT id, sort_order FROM prompts ORDER BY sort_order ASC, time_created ASC').all();
        const currIdx = allItems.findIndex(x => x.id === id);

        if (currIdx === -1) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'NOT_FOUND', message: 'Prompt not found.' }));
            return;
        }

        const newIdx = direction === 'up' ? Math.max(0, currIdx - 1) : Math.min(allItems.length - 1, currIdx + 1);
        if (newIdx !== currIdx) {
            const [moved] = allItems.splice(currIdx, 1);
            allItems.splice(newIdx, 0, moved);
            const updateStmt = db.prepare('UPDATE prompts SET sort_order = ? WHERE id = ?');
            allItems.forEach((it, idx) => {
                updateStmt.run(idx + 1, it.id);
            });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    } catch(err) {
        console.error('Error reordering prompts:', err);
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

async function requestListener(req, res) {
    // Serve PWA assets (manifest, Service Worker, icons)
    if (handleStaticPwa(req, res)) {
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // Return server configuration (Groq validation status, default language & HTTPS status)
    if (pathname === '/api/config' && req.method === 'GET') {
        const groqStatus = await checkGroqStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            hasGroqKey: Boolean(VOICE_GROQ_API_KEY),
            isGroqValid: Boolean(groqStatus.isValid),
            groqError: groqStatus.error,
            groqErrorMessage: groqStatus.errorMessage,
            groqModel: VOICE_GROQ_MODEL,
            defaultLanguage: DEFAULT_VOICE_LANGUAGE || 'EN',
            hasEdgeTTS: Boolean(MsEdgeTTS),
            ttsProvider: DEFAULT_TTS_PROVIDER,
            isHttps: isHttps,
            status: groqStatus.isValid ? 'ready' : (groqStatus.error || 'disabled')
        }));
        return;
    }

    // Return latest clean assistant message for Text-to-Speech
    if (pathname === '/api/latest-ai-message' && req.method === 'GET') {
        handleLatestAiMessage(req, res);
        return;
    }

    // Handle Edge TTS Text-to-Speech synthesis
    if (pathname === '/api/tts' && (req.method === 'GET' || req.method === 'POST')) {
        await handleTTS(req, res, parsedUrl);
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
    if (pathname === '/api/prompts/quick' && req.method === 'GET') {
        handleGetQuickPrompts(req, res);
        return;
    }

    if (pathname === '/api/prompts' && req.method === 'GET') {
        handleGetPrompts(req, res, parsedUrl);
        return;
    }

    if ((pathname === '/api/prompts' || pathname === '/api/prompts/save') && (req.method === 'POST' || req.method === 'PUT')) {
        handleSavePrompt(req, res);
        return;
    }

    if (pathname === '/api/prompts/reorder' && req.method === 'POST') {
        handleReorderPrompts(req, res);
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

// Disable global socket timeouts to prevent disconnecting long-lived terminal sessions
server.timeout = 0;
server.keepAliveTimeout = 0;
server.headersTimeout = 0;
server.requestTimeout = 0;

// Proxy WebSocket upgrades to internal ttyd
server.on('upgrade', (req, socket, head) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    socket.setTimeout(0);

    const proxySocket = net.connect(TTYD_PORT, '127.0.0.1', () => {
        proxySocket.setNoDelay(true);
        proxySocket.setKeepAlive(true, 5000);
        proxySocket.setTimeout(0);

        proxySocket.write(
            `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
            Object.entries(req.headers)
                .map(([k, v]) => `${k}: ${v}\r\n`)
                .join('') +
            '\r\n'
        );
        if (head && head.length > 0) proxySocket.write(head);
        socket.pipe(proxySocket);
        proxySocket.pipe(socket);
    });

    const cleanup = () => {
        try { socket.destroy(); } catch (e) {}
        try { proxySocket.destroy(); } catch (e) {}
    };

    proxySocket.on('error', cleanup);
    socket.on('error', cleanup);
    proxySocket.on('close', cleanup);
    socket.on('close', cleanup);
    proxySocket.on('end', cleanup);
    socket.on('end', cleanup);
});

server.listen(PROXY_PORT, '0.0.0.0', async () => {
    const proto = isHttps ? 'https' : 'http';
    const authStatus = TTYD_AUTH ? TTYD_AUTH : 'Disabled (Direct access without login)';
    let groqInfo = 'Not configured (Voice dictation & Conversation disabled)';

    if (VOICE_GROQ_API_KEY) {
        const groqStatus = await checkGroqStatus();
        if (groqStatus.isValid) {
            groqInfo = `Active & Valid (${VOICE_GROQ_MODEL})`;
        } else {
            groqInfo = `⚠️ Error: ${groqStatus.errorMessage}`;
        }
    }

    console.log('');
    console.log('===================================================================');
    console.log('🎉 OpenCode AI Web Terminal is ready to use!');
    console.log('-------------------------------------------------------------------');
    console.log(`🌐 Web Endpoint:      ${proto}://0.0.0.0:${PROXY_PORT} (${proto}://localhost:${PROXY_PORT})`);
    console.log(`🔑 Authentication:    ${authStatus}`);
    console.log(`🎙️ Recognition:       ${groqInfo}`);
    console.log(`🔊 TTS Engine:        ${DEFAULT_TTS_PROVIDER} (with bidirectional fallback)`);
    console.log(`🗣️ Voice Language:    ${DEFAULT_VOICE_LANGUAGE}`);
    console.log(`🔒 HTTPS Mode:        ${isHttps ? 'Enabled (Self-signed SSL)' : 'Disabled (HTTP)'}`);
    console.log(`📁 Workspace:         ${WORKSPACE_DIR}`);
    console.log('===================================================================');
    console.log('');
});
