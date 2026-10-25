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
const RAW_GROQ_BASE_URL = (process.env.VOICE_GROQ_BASE_URL || process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').trim().replace(/\/+$/, '');
const VOICE_GROQ_BASE_URL = RAW_GROQ_BASE_URL.endsWith('/openai/v1') ? RAW_GROQ_BASE_URL : (RAW_GROQ_BASE_URL.endsWith('/v1') ? RAW_GROQ_BASE_URL : `${RAW_GROQ_BASE_URL}/openai/v1`);
const DEFAULT_VOICE_LANGUAGE = (process.env.VOICE_LANGUAGE || 'EN').toUpperCase().trim();
const RAW_TTS_PROVIDER = (process.env.VOICE_TTS_PROVIDER || process.env.TTS_PROVIDER || 'microsoft').toLowerCase().trim();
const DEFAULT_TTS_PROVIDER = (RAW_TTS_PROVIDER === 'browser') ? 'browser' : 'microsoft';
const VOICE_CONVERSATION_PROMPT = (process.env.VOICE_CONVERSATION_PROMPT || '').trim();

const crypto = require('crypto');
const { execSync } = require('child_process');
const { PassThrough } = require('stream');

let WebSocket;
try {
    WebSocket = require('ws');
} catch (e) {
    console.warn('[proxy] ws module could not be loaded:', e.message);
}

// Microsoft Edge Read Aloud TTS DRM v2 Configuration
const EDGE_TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_CHROMIUM_FULL_VERSION = '143.0.3650.75';
const EDGE_CHROMIUM_MAJOR_VERSION = '143';
const EDGE_SEC_MS_GEC_VERSION = `2-${EDGE_CHROMIUM_FULL_VERSION}`;

let cachedDrmToken = null;
let cachedDrmTokenExpiry = 0;
let serverClockSkewSeconds = 0.0;

function getSecMsGecToken() {
    const now = Date.now();
    if (cachedDrmToken && now < cachedDrmTokenExpiry) {
        return cachedDrmToken;
    }

    const scriptCandidates = [
        path.join(__dirname, 'edge-drm.py'),
        '/edge-drm.py',
        path.join(process.cwd(), 'edge-drm.py')
    ];
    const scriptPath = scriptCandidates.find(p => fs.existsSync(p));

    if (scriptPath) {
        try {
            const out = execSync(`python3 "${scriptPath}" ${serverClockSkewSeconds.toFixed(3)}`, { timeout: 3000 }).toString().trim();
            if (out && out.includes('-')) {
                cachedDrmToken = out;
                cachedDrmTokenExpiry = now + 4 * 60 * 1000;
                return out;
            }
        } catch (err) {
            console.error('[tts] Failed to generate DRM token via edge-drm.py:', err.message);
        }
    }

    return cachedDrmToken || '';
}

function synthesizeSpeechV2(text, voice) {
    if (!WebSocket) {
        throw new Error('WebSocket (ws) module is not installed.');
    }

    const token = getSecMsGecToken();
    const connectId = crypto.randomUUID().replace(/-/g, '');
    const muid = crypto.randomBytes(16).toString('hex').toUpperCase();

    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TRUSTED_CLIENT_TOKEN}&ConnectionId=${connectId}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${EDGE_SEC_MS_GEC_VERSION}`;

    const stream = new PassThrough();

    const ws = new WebSocket(url, {
        headers: {
            'Pragma': 'no-cache',
            'Cache-Control': 'no-cache',
            'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
            'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${EDGE_CHROMIUM_MAJOR_VERSION}.0.0.0`,
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cookie': `muid=${muid};`
        }
    });

    let hasReceivedAudio = false;

    ws.on('open', () => {
        const timestamp = new Date().toISOString();
        const configMsg = `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
            `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":false,"wordBoundaryEnabled":false},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;
        ws.send(configMsg);

        const requestId = crypto.randomUUID().replace(/-/g, '');
        const escapedText = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');

        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">
            <voice name="${voice}">
                <prosody pitch="+0Hz" rate="+0%" volume="+0%">
                    ${escapedText}
                </prosody>
            </voice>
        </speak>`;
        const ssmlMsg = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}\r\nPath:ssml\r\n\r\n${ssml}`;
        ws.send(ssmlMsg);
    });

    ws.on('unexpected-response', (request, response) => {
        if (response.headers && response.headers.date) {
            try {
                const serverTime = new Date(response.headers.date).getTime() / 1000;
                const clientTime = Date.now() / 1000;
                serverClockSkewSeconds = serverTime - clientTime;
                cachedDrmTokenExpiry = 0;
            } catch(e) {}
        }
        stream.emit('error', new Error(`Edge TTS WebSocket error: Unexpected server response: ${response.statusCode}`));
        try { request.destroy(); } catch(e) {}
        try { response.destroy(); } catch(e) {}
    });

    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            const headerLen = data.readUInt16BE(0);
            const header = data.slice(2, 2 + headerLen).toString();
            const audio = data.slice(2 + headerLen);
            if (header.includes('Path:audio') && audio.length > 0) {
                hasReceivedAudio = true;
                stream.write(audio);
            }
        } else {
            const str = data.toString();
            if (str.includes('Path:turn.end')) {
                stream.end();
                try { ws.close(); } catch(e) {}
            }
        }
    });

    ws.on('error', (err) => {
        stream.emit('error', err);
        try { ws.close(); } catch(e) {}
    });

    ws.on('close', () => {
        if (!hasReceivedAudio) {
            stream.emit('error', new Error('No audio received from Edge TTS service'));
        }
        if (!stream.writableEnded) {
            stream.end();
        }
    });

    return { stream, ws };
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
let openCodeDbPath = null;
let latestMsgStmt = null;
let partsForMsgStmt = null;
let latestV2MsgStmt = null;
let cachedTables = null;

function getOpenCodeDb() {
    for (const p of DB_PATHS) {
        if (fs.existsSync(p)) {
            if (openCodeDbInstance && openCodeDbPath === p) return openCodeDbInstance;
            // DB path changed (or first open) — reset cached statements
            try { openCodeDbInstance?.close?.(); } catch(e) {}
            openCodeDbInstance = null;
            latestMsgStmt = null;
            partsForMsgStmt = null;
            latestV2MsgStmt = null;
            cachedTables = null;
            try {
                const { DatabaseSync } = require('node:sqlite');
                openCodeDbInstance = new DatabaseSync(p, { readOnly: true });
                openCodeDbPath = p;
                return openCodeDbInstance;
            } catch (e) {
                console.error('Failed to open SQLite DB at', p, e.message);
            }
        }
    }
    return openCodeDbInstance;
}

function getOpenCodeTables(db) {
    if (cachedTables) return cachedTables;
    try {
        const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        cachedTables = new Set(rows.map(r => r.name));
    } catch(e) {
        cachedTables = new Set();
    }
    return cachedTables;
}

function formatQuestionText(questions) {
    let questionText = '';
    const isPt = (DEFAULT_VOICE_LANGUAGE === 'PT' || DEFAULT_VOICE_LANGUAGE === 'BR');
    const optPrefix = isPt ? 'Opção' : 'Option';
    (questions || []).forEach((q) => {
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
    return questionText.trim();
}

// OpenCode v2: session_message table — data JSON is { type:'assistant', content:[{type:'text',text}...], time:{completed}, finish }
// Returns { handled:true, payload } when v2 has data, or { handled:false } to fall back to v1.
function tryLatestAiMessageV2(db) {
    const tables = getOpenCodeTables(db);
    if (!tables.has('session_message')) return { handled: false };
    try {
        if (!latestV2MsgStmt) {
            latestV2MsgStmt = db.prepare(`
                SELECT id, session_id, type, data, time_created, time_updated
                FROM session_message
                ORDER BY time_created DESC
                LIMIT 25
            `);
        }
    } catch (stmtErr) {
        latestV2MsgStmt = null;
        return { handled: false };
    }
    let messages = [];
    try {
        messages = latestV2MsgStmt.all();
    } catch(e) {
        latestV2MsgStmt = null;
        cachedTables = null;
        return { handled: false };
    }
    if (!messages || messages.length === 0) return { handled: false };

    // 1. Find the newest user prompt in the active session
    const latestUserMsg = messages.find(m => m.type === 'user');
    if (!latestUserMsg) {
        return { handled: true, payload: { text: null, id: null, isProcessing: false } };
    }

    // If the newest message overall is the user prompt, the AI has just received it and is processing
    if (messages[0].id === latestUserMsg.id) {
        return { handled: true, payload: { text: null, id: null, isProcessing: true } };
    }

    // 2. Check for interactive question tool prompt waiting for user response
    // If the AI asked a question to the user, it paused waiting for an answer before reaching 'idle'
    const asstMsgsAfterUser = messages.filter(m => m.type === 'assistant' && m.time_created >= latestUserMsg.time_created);
    for (const asstMsg of asstMsgsAfterUser) {
        let msgData = {};
        try { msgData = JSON.parse(asstMsg.data || '{}'); } catch(e) {}
        const content = Array.isArray(msgData.content) ? msgData.content : [];
        for (const item of content) {
            if (item && item.type === 'tool' && (item.name === 'question' || item.tool === 'question')) {
                const questions = item.state?.input?.questions || item.input?.questions || [];
                const questionText = formatQuestionText(questions);
                if (questionText) {
                    return { handled: true, payload: {
                        id: asstMsg.id + (item.state?.status || ''),
                        text: questionText,
                        time: asstMsg.time_updated || asstMsg.time_created,
                        isQuestion: true,
                        isComplete: true
                    }};
                }
            }
        }
    }

    // 3. In OpenCode v2, EVERY completed turn strictly emits a message with type: 'idle'
    // If there is no 'idle' message created after the user's prompt, the AI is STILL WORKING
    // (calling tools, reading files, searching web, or generating).
    // Intermediate statements like "Vou procurar..." MUST NOT trigger TTS or open the microphone!
    const idleAfterUser = messages.find(m => m.type === 'idle' && m.time_created >= latestUserMsg.time_created);
    if (!idleAfterUser) {
        return { handled: true, payload: { text: null, id: null, isProcessing: true } };
    }

    // 4. The turn is fully complete (idle reached). Find the final assistant message of this turn
    // (the one created between the user prompt and the idle marker)
    const turnAsstMsgs = messages.filter(m => 
        m.type === 'assistant' && 
        m.time_created >= latestUserMsg.time_created && 
        m.time_created <= idleAfterUser.time_created
    );

    if (turnAsstMsgs.length === 0) {
        return { handled: true, payload: { text: null, id: null, isProcessing: false } };
    }

    // Find the assistant message that has completed text parts (starting from the one closest to idle)
    for (const asstMsg of turnAsstMsgs) {
        let msgData = {};
        try { msgData = JSON.parse(asstMsg.data || '{}'); } catch(e) {}
        const content = Array.isArray(msgData.content) ? msgData.content : [];
        let fullText = '';
        for (const item of content) {
            if (item && item.type === 'text' && item.text && item.text.trim()) {
                fullText += (fullText ? '\n' : '') + item.text.trim();
            }
        }
        if (fullText.trim()) {
            return { handled: true, payload: {
                id: asstMsg.id,
                text: fullText.trim(),
                time: msgData.time?.completed || asstMsg.time_updated || asstMsg.time_created,
                isQuestion: false,
                isComplete: true
            }};
        }
    }

    return { handled: true, payload: { text: null, id: null, isProcessing: false } };
}

function handleLatestAiMessage(req, res) {
    try {
        const db = getOpenCodeDb();
        if (!db) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text: null, id: null }));
            return;
        }

        // Prefer v2 schema (session_message) when it has data; fall back to v1 (message/part)
        try {
            const v2 = tryLatestAiMessageV2(db);
            if (v2.handled) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(v2.payload));
                return;
            }
        } catch (v2Err) {
            console.error('V2 latest-message lookup failed, falling back to V1:', v2Err.message);
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

        // 1. Check for interactive question tool prompt waiting for user response (V1: part type='tool', tool='question')
        for (const part of parts) {
            let partData = {};
            try { partData = JSON.parse(part.data || '{}'); } catch(e) {}

            if (partData.type === 'tool' && partData.tool === 'question') {
                const questions = partData.state?.input?.questions || [];
                const questionText = formatQuestionText(questions);
                if (questionText) {
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

        // 2. Check if the assistant turn is calling tools or still active/processing
        const isToolCallsFinish = (msgData.finish === 'tool-calls' || msgData.finish === 'tool_calls');
        let hasActiveTools = false;
        for (const part of parts) {
            let partData = {};
            try { partData = JSON.parse(part.data || '{}'); } catch(e) {}
            if (partData.type === 'tool' && partData.tool !== 'question') {
                hasActiveTools = true;
                break;
            }
        }

        if (isToolCallsFinish || hasActiveTools) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text: null, id: null, isProcessing: true }));
            return;
        }

        const hasCompletedNormally = (msgData.finish === 'stop' || msgData.finish === 'length') && msgData.time?.completed != null;
        if (!hasCompletedNormally) {
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
        res.end(JSON.stringify({ text: null, id: null, isProcessing: true }));
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
        const modelResp = await fetch(`${VOICE_GROQ_BASE_URL}/models/${encodeURIComponent(VOICE_GROQ_MODEL)}`, {
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

            const groqResp = await fetch(`${VOICE_GROQ_BASE_URL}/audio/transcriptions`, {
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

// Edge TTS (Microsoft Neural Voice DRM v2) Audio Synthesis Handler
async function handleTTS(req, res, parsedUrl) {
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
        const { stream: audioStream, ws } = synthesizeSpeechV2(text, selectedVoice);

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

        res.on('close', () => {
            try { ws.close(); } catch(e) {}
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

        // Clean up legacy/removed quick prompts (git status, git diff, /clear)
        try {
            db.prepare("DELETE FROM prompts WHERE id IN ('qp4', 'qp5', 'qp6') OR (title IN ('git status', 'git diff', '/clear') AND is_quick = 1)").run();
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
                // Full Library Prompts
                { id: 'p1', title: '⚡ Refactor Code', content: 'Please refactor the following code to make it cleaner, more modular, efficient and readable:\n\n', is_quick: 0, auto_enter: 0, sort_order: 4 },
                { id: 'p2', title: '🧪 Generate Unit Tests', content: 'Create comprehensive unit tests covering standard and edge cases for the following implementation:\n\n', is_quick: 0, auto_enter: 0, sort_order: 5 },
                { id: 'p3', title: '🐛 Explain & Fix Bug', content: 'Analyze the following error/unexpected behavior and explain the root cause with a detailed fix:\n\n', is_quick: 0, auto_enter: 0, sort_order: 6 },
                { id: 'p4', title: '🛡️ Security Audit', content: 'Review this code identifying potential security vulnerabilities, injections, missing validations and best practices:\n\n', is_quick: 0, auto_enter: 0, sort_order: 7 }
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

function handleExportPrompts(req, res) {
    try {
        const db = getPromptsDb();
        if (!db) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'DB_UNAVAILABLE', message: 'Could not connect to SQLite database.' }));
            return;
        }

        const prompts = db.prepare('SELECT id, title, content, is_quick, auto_enter, sort_order, time_created, time_updated FROM prompts ORDER BY sort_order ASC, time_created ASC').all();
        const exportData = {
            version: 1,
            exported_at: new Date().toISOString(),
            count: prompts.length,
            prompts: prompts
        };

        const jsonStr = JSON.stringify(exportData, null, 2);
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': 'attachment; filename="opencode-prompts.json"'
        });
        res.end(jsonStr);
    } catch (err) {
        console.error('Error exporting prompts:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    }
}

async function handleImportPrompts(req, res) {
    try {
        const db = getPromptsDb();
        if (!db) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'DB_UNAVAILABLE', message: 'Could not connect to SQLite database.' }));
            return;
        }

        const body = await parseJsonBody(req);
        let promptsToImport = [];
        let mode = body.mode || 'merge'; // 'merge' or 'replace'

        if (Array.isArray(body)) {
            promptsToImport = body;
        } else if (Array.isArray(body.prompts)) {
            promptsToImport = body.prompts;
        } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'INVALID_FORMAT', message: 'Payload must contain a prompts array.' }));
            return;
        }

        if (promptsToImport.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'EMPTY_PROMPTS', message: 'No prompts found to import.' }));
            return;
        }

        // Validate and sanitize prompts
        const validPrompts = [];
        for (const item of promptsToImport) {
            if (!item || typeof item !== 'object') continue;
            const title = String(item.title || item.name || '').trim();
            const content = String(item.content || item.prompt || item.text || '').trim();
            if (!title || !content) continue;

            const is_quick = (item.is_quick || item.isQuick) ? 1 : 0;
            const auto_enter = (item.auto_enter || item.autoEnter) ? 1 : 0;
            const id = (item.id && typeof item.id === 'string' && item.id.trim()) ? item.id.trim() : null;

            validPrompts.push({
                id,
                title,
                content,
                is_quick,
                auto_enter
            });
        }

        if (validPrompts.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'NO_VALID_PROMPTS', message: 'No valid prompts with title and content found.' }));
            return;
        }

        const now = Date.now();

        try {
            db.exec('BEGIN TRANSACTION');

            if (mode === 'replace') {
                db.prepare('DELETE FROM prompts').run();
                const insertStmt = db.prepare('INSERT INTO prompts (id, title, content, is_quick, auto_enter, sort_order, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
                validPrompts.forEach((p, index) => {
                    const pId = p.id || ('p_' + now + '_' + index + '_' + Math.random().toString(36).substring(2, 6));
                    insertStmt.run(pId, p.title, p.content, p.is_quick, p.auto_enter, index + 1, now, now);
                });
            } else {
                // merge mode
                const maxRow = db.prepare('SELECT MAX(sort_order) as maxOrder FROM prompts').get();
                let nextOrder = ((maxRow && maxRow.maxOrder !== null) ? maxRow.maxOrder : 0) + 1;

                const checkStmt = db.prepare('SELECT id, sort_order, time_created FROM prompts WHERE id = ?');
                const updateStmt = db.prepare('UPDATE prompts SET title = ?, content = ?, is_quick = ?, auto_enter = ?, time_updated = ? WHERE id = ?');
                const insertStmt = db.prepare('INSERT INTO prompts (id, title, content, is_quick, auto_enter, sort_order, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

                validPrompts.forEach((p, index) => {
                    let existing = p.id ? checkStmt.get(p.id) : null;
                    if (existing) {
                        updateStmt.run(p.title, p.content, p.is_quick, p.auto_enter, now, p.id);
                    } else {
                        const pId = p.id || ('p_' + now + '_' + index + '_' + Math.random().toString(36).substring(2, 6));
                        insertStmt.run(pId, p.title, p.content, p.is_quick, p.auto_enter, nextOrder++, now, now);
                    }
                });
            }

            db.exec('COMMIT');
        } catch(txErr) {
            try { db.exec('ROLLBACK'); } catch(rbErr) {}
            throw txErr;
        }

        const totalCount = db.prepare('SELECT COUNT(*) as count FROM prompts').get().count;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            mode: mode,
            imported: validPrompts.length,
            total: totalCount
        }));
    } catch(err) {
        console.error('Error importing prompts to SQLite:', err);
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
            hasEdgeTTS: Boolean(WebSocket),
            ttsProvider: DEFAULT_TTS_PROVIDER,
            conversationPrompt: VOICE_CONVERSATION_PROMPT,
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

    if (pathname === '/api/prompts/export' && req.method === 'GET') {
        handleExportPrompts(req, res);
        return;
    }

    if (pathname === '/api/prompts/import' && req.method === 'POST') {
        handleImportPrompts(req, res);
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
