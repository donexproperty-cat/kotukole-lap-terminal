const http = require('http');
const https = require('https');
const { spawn, execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

// Securely load local .env without external dependencies
function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        try {
            const content = fs.readFileSync(envPath, 'utf8');
            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx > 0) {
                    const key = trimmed.substring(0, eqIdx).trim();
                    let val = trimmed.substring(eqIdx + 1).trim();
                    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                        val = val.slice(1, -1);
                    }
                    if (!process.env[key]) {
                        process.env[key] = val;
                    }
                }
            }
        } catch (e) {
            console.error('[Security] Failed to read .env file:', e.message);
        }
    }
}
loadEnv();

const PORT = process.env.PORT || 3880;

// Security: Resolve ACCESS_PASSWORD strictly from private environment or .env
let ACCESS_PASSWORD = (process.env.LAP_PASSWORD || '').trim();
if (!ACCESS_PASSWORD) {
    const generated = crypto.randomBytes(12).toString('hex');
    const envPath = path.join(__dirname, '.env');
    try {
        fs.writeFileSync(envPath, `# K-Term Security Configuration\n# Keep this private - never commit to Git!\nLAP_PASSWORD=${generated}\nPORT=3880\n`, { mode: 0o600 });
        ACCESS_PASSWORD = generated;
        process.env.LAP_PASSWORD = generated;
        console.log('[Security] Auto-generated strong LAP_PASSWORD and saved to local .env (0600 mode)');
    } catch (e) {
        ACCESS_PASSWORD = generated;
        process.env.LAP_PASSWORD = generated;
    }
}

// IP & Brute Force Rate Limiting
const loginAttempts = new Map(); // ip -> { count, firstAttempt, lockedUntil }
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minute lockout
const WINDOW_MS = 10 * 60 * 1000;  // 10 minute attempt window

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
}

function checkLoginRateLimit(ip) {
    const record = loginAttempts.get(ip);
    if (!record) return { allowed: true };
    const now = Date.now();
    if (record.lockedUntil && now < record.lockedUntil) {
        const remainingMinutes = Math.ceil((record.lockedUntil - now) / 60000);
        return {
            allowed: false,
            error: `ආරක්ෂක හේතු මත මෙම IP ලිපිනය විනාඩි ${remainingMinutes}කට තාවකාලිකව අවහිර කර ඇත (Too many failed attempts).`
        };
    }
    if (now - record.firstAttempt > WINDOW_MS) {
        loginAttempts.delete(ip);
        return { allowed: true };
    }
    return { allowed: true };
}

function recordFailedLogin(ip) {
    const now = Date.now();
    const record = loginAttempts.get(ip) || { count: 0, firstAttempt: now, lockedUntil: null };
    record.count += 1;
    if (record.count >= MAX_FAILED_ATTEMPTS) {
        record.lockedUntil = now + LOCKOUT_MS;
        console.warn(`[SECURITY ALERT] IP ${ip} temporarily locked out after ${record.count} failed login attempts.`);
        sendAlert('🔒 K-Term Security Alert', `IP ${ip} locked out for 15 minutes after ${record.count} failed login attempts.`);
    }
    loginAttempts.set(ip, record);
}

function resetLoginRateLimit(ip) {
    loginAttempts.delete(ip);
}

// Constant-time password verification to prevent timing attacks
function verifyPassword(inputPassword, actualPassword) {
    if (typeof inputPassword !== 'string' || typeof actualPassword !== 'string') return false;
    if (!actualPassword || actualPassword.length === 0) return false;
    const inputHash = crypto.createHash('sha256').update(inputPassword).digest();
    const actualHash = crypto.createHash('sha256').update(actualPassword).digest();
    return crypto.timingSafeEqual(inputHash, actualHash);
}

// Upload directory for webcam captures
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Hardened Multer storage for webcam and audio uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname || '.jpg').toLowerCase();
        const safeExt = ['.jpg', '.jpeg', '.png', '.wav'].includes(ext) ? ext : '.jpg';
        const randomName = 'snap-' + crypto.randomBytes(12).toString('hex') + safeExt;
        cb(null, randomName);
    }
});

const uploadWebcamMiddleware = multer({
    storage: storage,
    limits: { fileSize: 15 * 1024 * 1024 }, // 15MB limit
    fileFilter: function (req, file, cb) {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const allowedExts = ['.jpg', '.jpeg', '.png', '.wav'];
        const allowedMimes = ['image/jpeg', 'image/png', 'audio/wav', 'audio/x-wav', 'application/octet-stream'];
        if (allowedExts.includes(ext) || allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type: only JPG, PNG, and WAV files are allowed.'));
        }
    }
}).single('webcamPhoto');

// SSE clients for real-time webcam & dashboard updates
let sseClients = [];
let agentCommandQueue = [];

// Keep-alive heartbeat for SSE every 15s to prevent proxy timeouts
setInterval(() => {
    sseClients.forEach(client => {
        try {
            client.write(': heartbeat\n\n');
        } catch(e) {}
    });
}, 15000);

// Security & Alert Configuration (all optional in .env for backwards compatibility)
const AGENT_SECRET = (process.env.AGENT_SECRET || '').trim();
const GITHUB_WEBHOOK_SECRET = (process.env.GITHUB_WEBHOOK_SECRET || '').trim();
const PROTECT_UPLOADS = (process.env.PROTECT_UPLOADS || '').trim().toLowerCase() === 'true';
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const DISCORD_WEBHOOK_URL = (process.env.DISCORD_WEBHOOK_URL || '').trim();
const TOTP_SECRET = (process.env.TOTP_SECRET || '').trim();
const AUDIT_LOG_FILE = path.join(os.tmpdir(), 'kterm_audit.log');

function logAudit(action, details, ip = '') {
    try {
        const entry = JSON.stringify({
            time: new Date().toISOString(),
            action,
            details,
            ip
        }) + '\n';
        fs.appendFileSync(AUDIT_LOG_FILE, entry, 'utf8');
    } catch (e) {}
}

function verifyTOTP(code, base32Secret) {
    if (!base32Secret) return true;
    const cleanCode = (code || '').toString().replace(/\s+/g, '');
    if (!/^\d{6}$/.test(cleanCode)) return false;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const ch of base32Secret.toUpperCase().replace(/=+$/, '')) {
        const idx = alphabet.indexOf(ch);
        if (idx === -1) continue;
        bits += idx.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }
    const key = Buffer.from(bytes);
    const nowStep = Math.floor(Date.now() / 1000 / 30);
    for (let offset = -1; offset <= 1; offset++) {
        const counter = Buffer.alloc(8);
        counter.writeUInt32BE(Math.floor((nowStep + offset) / 0x100000000), 0);
        counter.writeUInt32BE((nowStep + offset) >>> 0, 4);
        const hmac = crypto.createHmac('sha1', key).update(counter).digest();
        const pos = hmac[hmac.length - 1] & 0x0f;
        const bin = ((hmac[pos] & 0x7f) << 24) | ((hmac[pos + 1] & 0xff) << 16) | ((hmac[pos + 2] & 0xff) << 8) | (hmac[pos + 3] & 0xff);
        const otp = (bin % 1000000).toString().padStart(6, '0');
        if (otp === cleanCode) return true;
    }
    return false;
}

function isAuthorizedAgent(req, parsedUrl) {
    if (!AGENT_SECRET) return true;
    const provided = (req.headers['x-agent-secret'] || parsedUrl.searchParams.get('secret') || '').toString();
    return verifyPassword(provided, AGENT_SECRET);
}

function verifyGithubSignature(rawBody, signatureHeader) {
    if (!GITHUB_WEBHOOK_SECRET) return true;
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET).update(rawBody).digest('hex');
    const a = Buffer.from(signatureHeader, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function sendAlert(title, message) {
    const text = `${title}\n${message}`;
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        try {
            const payload = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text });
            const req = https.request({
                hostname: 'api.telegram.org',
                path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            });
            req.on('error', () => {});
            req.write(payload);
            req.end();
        } catch (e) {}
    }
    if (DISCORD_WEBHOOK_URL) {
        try {
            const url = new URL(DISCORD_WEBHOOK_URL);
            const payload = JSON.stringify({ content: `**${title}**\n${message}` });
            const req = https.request({
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname + url.search,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            });
            req.on('error', () => {});
            req.write(payload);
            req.end();
        } catch (e) {}
    }
}

// Staged file transfers for File Manager (web <-> agent behind NAT)
const stagedFiles = new Map(); // id -> { name, buffer, mime, createdAt }
const stagedCmds = new Map();  // id -> { cmd, createdAt }
const uploadAnyMiddleware = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }
}).single('file');

setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, item] of stagedFiles.entries()) {
        if (item.createdAt < cutoff) stagedFiles.delete(id);
    }
}, 60 * 1000);

// Active auth sessions (persisted to disk across restarts)
const sessions = new Map();
const SESSIONS_FILE = path.join(os.tmpdir(), 'lap_sessions.json');

function loadSessions() {
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
            for (const [k, v] of Object.entries(data)) {
                if (v > Date.now()) sessions.set(k, v);
            }
        }
    } catch(e) {}
}
loadSessions();

function saveSessions() {
    try {
        const obj = {};
        for (const [k, v] of sessions.entries()) obj[k] = v;
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj));
    } catch(e) {}
}

function generateToken() {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + 24 * 60 * 60 * 1000);
    saveSessions();
    return token;
}

function isValidSession(token) {
    if (!token) return false;
    const expires = sessions.get(token);
    if (!expires) return false;
    if (Date.now() > expires) {
        sessions.delete(token);
        saveSessions();
        return false;
    }
    return true;
}

// Clean up expired sessions periodically
setInterval(() => {
    const now = Date.now();
    for (const [token, exp] of sessions.entries()) {
        if (now > exp) sessions.delete(token);
    }
}, 60 * 60 * 1000);

// Background Auto-Sync: Check GitHub every 60s as a fallback to Webhooks
setInterval(() => {
    try {
        execSync('git fetch origin main', { cwd: __dirname, stdio: 'ignore' });
        const statusOut = execSync('git status -uno', { cwd: __dirname, encoding: 'utf8' });
        if (statusOut.includes('Your branch is behind')) {
            console.log('[Auto-Sync] Remote changes detected! Pulling from GitHub...');
            const pullOut = execSync('git pull origin main', { cwd: __dirname, encoding: 'utf8' });
            console.log('[Auto-Sync] Pull result:\n' + pullOut);
            if (pullOut.includes('server.js')) {
                console.log('[Auto-Sync] server.js updated, self-restarting in 1s...');
                setTimeout(() => process.exit(0), 1000);
            }
        }
    } catch (e) {
        // Silently ignore transient network blips
    }
}, 60 * 1000);

// Laptop Agent State (Supports single default + multi-device tracking)
let connectedAgent = null; // { deviceId, hostname, user, os, cores, lastSeen, ... }
const connectedAgents = new Map(); // deviceId -> agentInfo
let pendingCommands = [];  // [ { id, cmd, deviceId, resolve, assigned, timer } ]
let lastWebcamPoll = 0;

function isAgentOnline(deviceId) {
    if (deviceId) {
        const dev = connectedAgents.get(deviceId);
        return !!(dev && (Date.now() - dev.lastSeen < 7000));
    }
    return !!(connectedAgent && (Date.now() - connectedAgent.lastSeen < 7000));
}

function getActiveAgent(deviceId) {
    if (deviceId && connectedAgents.has(deviceId)) {
        const dev = connectedAgents.get(deviceId);
        if (Date.now() - dev.lastSeen < 7000) return { ...dev, online: true };
    }
    if (isAgentOnline()) return { ...connectedAgent, online: true };
    return null;
}

// Periodically detect offline agents for alerts
setInterval(() => {
    const now = Date.now();
    for (const [id, dev] of connectedAgents.entries()) {
        if (dev._onlineAlerted && now - dev.lastSeen > 15000) {
            dev._onlineAlerted = false;
            sendAlert('🔴 K-Term Agent Offline', `Device: ${dev.hostname} (${dev.user})`);
        }
    }
}, 5000);

function isWebcamAgentOnline() {
    return (Date.now() - lastWebcamPoll < 12000);
}

function getSystemStats(requestedDeviceId) {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsagePct = ((usedMem / totalMem) * 100).toFixed(1);

    const cpus = os.cpus();
    const cpuModel = cpus.length > 0 ? cpus[0].model : 'Unknown CPU';
    const cpuCores = cpus.length;

    let diskInfo = { total: '?', used: '?', free: '?', pct: '?' };
    if (process.platform !== 'win32') {
        try {
            const dfOut = execSync("df -h / | awk 'NR==2 {print $2, $3, $4, $5}'", { encoding: 'utf8' }).trim();
            const parts = dfOut.split(/\s+/);
            if (parts.length >= 4) {
                diskInfo = { total: parts[0], used: parts[1], free: parts[2], pct: parts[3] };
            }
        } catch (e) {}
    }

    const uptimeSec = os.uptime();
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const uptimeStr = `${days}d ${hours}h ${minutes}m`;

    const now = Date.now();
    const agentsList = [];
    for (const [id, dev] of connectedAgents.entries()) {
        if (now - dev.lastSeen < 60000) {
            agentsList.push({
                deviceId: id,
                hostname: dev.hostname,
                user: dev.user,
                os: dev.os,
                online: (now - dev.lastSeen < 7000)
            });
        }
    }

    return {
        agent: getActiveAgent(requestedDeviceId),
        agents: agentsList,
        webcamAgent: isWebcamAgentOnline() ? { online: true, lastSeen: lastWebcamPoll } : null,
        hostname: os.hostname(),
        platform: `${os.type()} ${os.release()} (${os.arch()})`,
        uptime: uptimeStr,
        cpu: {
            model: cpuModel,
            cores: cpuCores,
            load: os.loadavg().map(l => l.toFixed(2))
        },
        memory: {
            total: (totalMem / (1024 ** 3)).toFixed(2) + ' GB',
            used: (usedMem / (1024 ** 3)).toFixed(2) + ' GB',
            free: (freeMem / (1024 ** 3)).toFixed(2) + ' GB',
            percent: memUsagePct
        },
        disk: diskInfo,
        user: os.userInfo().username
    };
}

const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // CORS & Robust Security Headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com data: blob:; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' ws: wss:;");
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        return res.end();
    }

    // ==========================================
    // WEBCAM & SSE EVENT STREAM ENDPOINTS
    // ==========================================

    // SSE: Live Webcam & System Event Stream (Secured: requires valid session token)
    if (pathname === '/api/events') {
        const streamToken = parsedUrl.searchParams.get('token') || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
        if (!isValidSession(streamToken)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Unauthorized: Valid session token required for live stream.' }));
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.write(': connected\n\n');
        sseClients.push(res);
        req.on('close', () => {
            sseClients = sseClients.filter(client => client !== res);
        });
        return;
    }

    // Webcam Command Queue (POST /api/command) (Secured: requires valid session token)
    if (req.method === 'POST' && pathname === '/api/command') {
        const cmdToken = parsedUrl.searchParams.get('token') || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
        if (!isValidSession(cmdToken)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Unauthorized: Valid session token required to queue commands.' }));
        }

        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 8192) req.destroy();
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const command = (data.command || '').toString().trim();
                if (command) {
                    agentCommandQueue.push(command);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: "Command queued for agent", command }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: "No command provided" }));
                }
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "Invalid JSON format" }));
            }
        });
        return;
    }

    // Webcam Agent Polling (GET /api/poll)
    if (req.method === 'GET' && pathname === '/api/poll') {
        if (!isAuthorizedAgent(req, parsedUrl)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Unauthorized agent' }));
        }
        lastWebcamPoll = Date.now();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (agentCommandQueue.length > 0) {
            const cmd = agentCommandQueue.shift();
            res.end(JSON.stringify({ command: cmd }));
        } else {
            res.end(JSON.stringify({ command: null }));
        }
        return;
    }

    // Webcam Photo Upload Endpoint (POST /api/upload-webcam)
    if (req.method === 'POST' && pathname === '/api/upload-webcam') {
        if (!isAuthorizedAgent(req, parsedUrl)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: 'Unauthorized agent' }));
        }
        uploadWebcamMiddleware(req, res, (err) => {
            if (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: err.message }));
            }
            if (!req.file) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: 'No webcam photo uploaded.' }));
            }

            const imageUrl = `/lap/uploads/${req.file.filename}`;

            // Notify all connected web dashboards live via SSE
            sseClients.forEach(client => {
                try {
                    client.write(`data: ${JSON.stringify({ type: 'webcam_update', url: imageUrl })}\n\n`);
                } catch(e) {}
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, imageUrl }));
        });
        return;
    }

    // ==========================================
    // AGENT ENDPOINTS (Called by K-Term Agent)
    // ==========================================

    // Agent Version Endpoint (for Auto-OTA checks)
    if (req.method === 'GET' && pathname === '/api/agent/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ version: '1.5.0' }));
    }

    // Agent Poll Endpoint: Heartbeat & Command Fetching
    if (req.method === 'POST' && pathname === '/api/agent/poll') {
        if (!isAuthorizedAgent(req, parsedUrl)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Unauthorized agent' }));
        }
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const hostname = data.hostname || 'Physical Laptop';
                const user = data.user || 'User';
                const deviceId = data.deviceId || `${hostname}@${user}`;
                const prev = connectedAgents.get(deviceId);
                const wasOnline = prev && prev._onlineAlerted;

                const agentInfo = {
                    deviceId,
                    hostname,
                    user,
                    os: data.os || 'Windows',
                    cores: data.cores || '1',
                    version: data.version || '1.1.0',
                    cpuModel: data.cpuModel || '',
                    gpu: data.gpu || '',
                    ssid: data.ssid || '',
                    pendingReboot: !!data.pendingReboot,
                    topProcs: Array.isArray(data.topProcs) ? data.topProcs : [],
                    usbDrives: data.usbDrives || '',
                    ramTotal: data.ramTotal || '',
                    ramUsed: data.ramUsed || '',
                    ramPercent: data.ramPercent || '',
                    diskTotal: data.diskTotal || '',
                    diskFree: data.diskFree || '',
                    diskPercent: data.diskPercent || '',
                    battery: data.battery || '',
                    batteryStatus: data.batteryStatus || '',
                    cpuTemp: data.cpuTemp || '',
                    lastSeen: Date.now(),
                    _onlineAlerted: true,
                    _lastResourceAlert: prev ? (prev._lastResourceAlert || 0) : 0
                };

                if (prev && prev.usbDrives !== undefined && agentInfo.usbDrives !== prev.usbDrives) {
                    sendAlert('🔌 K-Term USB Drive Change', `Device: ${hostname} (${user})\nDrives: ${agentInfo.usbDrives || 'None'}`);
                }
                if (prev && prev.ssid && agentInfo.ssid && agentInfo.ssid !== prev.ssid) {
                    sendAlert('📶 K-Term Wi-Fi Changed', `Device: ${hostname} (${user})\n${prev.ssid} -> ${agentInfo.ssid}`);
                }

                // Resource Threshold Alerting (throttled to once per 15 mins per device)
                const ramNum = parseFloat(agentInfo.ramPercent);
                const diskNum = parseFloat((agentInfo.diskPercent || '').replace('%', ''));
                if ((ramNum >= 92 || diskNum >= 92) && (Date.now() - agentInfo._lastResourceAlert > 15 * 60 * 1000)) {
                    agentInfo._lastResourceAlert = Date.now();
                    sendAlert('⚠️ K-Term Resource Alert', `Device: ${hostname} (${user})\nRAM: ${agentInfo.ramPercent}% | Disk: ${agentInfo.diskPercent}`);
                }

                connectedAgents.set(deviceId, agentInfo);
                connectedAgent = agentInfo;

                if (!wasOnline) {
                    sendAlert('🟢 K-Term Agent Online', `Device: ${hostname} (${user})\nOS: ${agentInfo.os}`);
                }

                // Check if any command is queued for execution (matching deviceId or unassigned)
                const nextCmd = pendingCommands.find(c => !c.assigned && (!c.deviceId || c.deviceId === deviceId));
                if (nextCmd) {
                    nextCmd.assigned = true;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ id: nextCmd.id, cmd: nextCmd.cmd }));
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'idle' }));
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'idle' }));
            }
        });
        return;
    }

    // Agent Result Endpoint: Laptop returns stdout/stderr
    if (req.method === 'POST' && pathname === '/api/agent/result') {
        if (!isAuthorizedAgent(req, parsedUrl)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: 'Unauthorized agent' }));
        }
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                if (data.id) {
                    const idx = pendingCommands.findIndex(c => c.id === data.id);
                    if (idx !== -1) {
                        const item = pendingCommands[idx];
                        clearTimeout(item.timer);
                        pendingCommands.splice(idx, 1);
                        item.resolve(data.output || '');
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false }));
            }
        });
        return;
    }

    // ==========================================
    // FILE MANAGER TRANSFER ENDPOINTS (NAT-SAFE)
    // ==========================================

    // Web UI stages a file to be downloaded by the laptop agent
    if (req.method === 'POST' && pathname === '/api/files/stage') {
        const authHdr = req.headers['authorization'] || '';
        const tok = authHdr.replace(/^Bearer\s+/i, '') || parsedUrl.searchParams.get('token');
        if (!isValidSession(tok)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
        }
        uploadAnyMiddleware(req, res, (err) => {
            if (err || !req.file) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: err ? err.message : 'No file uploaded' }));
            }
            const fileId = crypto.randomBytes(12).toString('hex');
            stagedFiles.set(fileId, {
                name: path.basename(req.file.originalname || 'upload.bin'),
                buffer: req.file.buffer,
                mime: req.file.mimetype || 'application/octet-stream',
                createdAt: Date.now()
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, fileId, name: path.basename(req.file.originalname || 'upload.bin'), size: req.file.size }));
        });
        return;
    }

    // Laptop agent fetches a staged file
    const agentFileMatch = pathname.match(/^\/api\/agent\/file\/([a-f0-9]+)$/);
    if (req.method === 'GET' && agentFileMatch) {
        if (!isAuthorizedAgent(req, parsedUrl)) {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            return res.end('Unauthorized');
        }
        const item = stagedFiles.get(agentFileMatch[1]);
        if (!item) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('File not found or expired');
        }
        res.writeHead(200, {
            'Content-Type': item.mime,
            'Content-Disposition': `attachment; filename="${item.name}"`,
            'Content-Length': item.buffer.length
        });
        res.end(item.buffer);
        return;
    }

    // Laptop agent uploads a requested file for the web user to download
    if (req.method === 'POST' && pathname === '/api/agent/file-upload') {
        if (!isAuthorizedAgent(req, parsedUrl)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
        }
        uploadAnyMiddleware(req, res, (err) => {
            if (err || !req.file) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: err ? err.message : 'No file' }));
            }
            const fileId = crypto.randomBytes(12).toString('hex');
            stagedFiles.set(fileId, {
                name: path.basename(req.file.originalname || 'download.bin'),
                buffer: req.file.buffer,
                mime: req.file.mimetype || 'application/octet-stream',
                createdAt: Date.now()
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, fileId, name: path.basename(req.file.originalname || 'download.bin') }));
        });
        return;
    }

    // Web UI downloads a file uploaded by the laptop agent
    const webFileDlMatch = pathname.match(/^\/api\/files\/download\/([a-f0-9]+)$/);
    if (req.method === 'GET' && webFileDlMatch) {
        const authHdr = req.headers['authorization'] || '';
        const tok = authHdr.replace(/^Bearer\s+/i, '') || parsedUrl.searchParams.get('token');
        if (!isValidSession(tok)) {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            return res.end('Unauthorized');
        }
        const item = stagedFiles.get(webFileDlMatch[1]);
        if (!item) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('File not found or expired');
        }
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${item.name}"`,
            'Content-Length': item.buffer.length
        });
        res.end(item.buffer);
        return;
    }

    // ==========================================
    // GITHUB AUTO-DEPLOY & WEBHOOK ENDPOINTS
    // ==========================================

    // GitHub Webhook Endpoint: Auto-pulls within seconds of any commit on GitHub
    if (pathname === '/api/webhook/github') {
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'ok', message: 'GitHub Webhook endpoint active' }));
        }

        if (req.method === 'POST') {
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                const rawBody = Buffer.concat(chunks);
                const sig = req.headers['x-hub-signature-256'];
                if (!verifyGithubSignature(rawBody, sig)) {
                    console.warn('[GitHub Webhook] Invalid signature rejected.');
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'Invalid webhook signature' }));
                }
                const event = req.headers['x-github-event'] || 'push';
                if (event === 'ping') {
                    console.log('[GitHub Webhook] Ping received from GitHub! Webhook is verified.');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true, message: 'Pong! Webhook verified and active.' }));
                }

                console.log(`[GitHub Webhook] Event "${event}" received! Auto-pulling from GitHub main...`);
                try {
                    const pullOut = execSync('git pull origin main', { cwd: __dirname, encoding: 'utf8' });
                    console.log('[GitHub Webhook] Pulled changes:\n' + pullOut);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, output: pullOut }));

                    if (pullOut.includes('server.js')) {
                        console.log('[GitHub Webhook] server.js updated, self-restarting in 1s...');
                        setTimeout(() => process.exit(0), 1000);
                    }
                } catch (err) {
                    console.error('[GitHub Webhook Error]:', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: err.message }));
                }
            });
            return;
        }
    }

    // Manual GitHub Sync: Triggered from web console
    if (req.method === 'POST' && pathname === '/api/git/sync') {
        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.replace(/^Bearer\s+/i, '') || parsedUrl.searchParams.get('token');
        if (!isValidSession(token)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        try {
            const pullOut = execSync('git pull origin main', { cwd: __dirname, encoding: 'utf8' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, output: pullOut }));
            if (pullOut.includes('server.js')) {
                setTimeout(() => process.exit(0), 1000);
            }
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
    }

    // API: Login (Protected with IP Rate Limiting & Timing-Safe Hash Verification)
    if (req.method === 'POST' && pathname === '/api/login') {
        const clientIp = getClientIp(req);
        const rateCheck = checkLoginRateLimit(clientIp);
        if (!rateCheck.allowed) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: rateCheck.error }));
        }

        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 4096) req.destroy();
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const userPass = (data.password || '').toString();
                const totpCode = (data.totpCode || '').toString();
                if (verifyPassword(userPass, ACCESS_PASSWORD) && verifyTOTP(totpCode, TOTP_SECRET)) {
                    resetLoginRateLimit(clientIp);
                    const token = generateToken();
                    logAudit('LOGIN_SUCCESS', 'Web console unlocked', clientIp);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, token, totpRequired: !!TOTP_SECRET }));
                } else {
                    recordFailedLogin(clientIp);
                    logAudit('LOGIN_FAILED', 'Invalid password or 2FA code', clientIp);
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'වැරදි Password එකක්! කරුණාකර නැවත උත්සාහ කරන්න.' }));
                }
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid JSON request' }));
            }
        });
        return;
    }

    // Auth Middleware for protected endpoints
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '') || parsedUrl.searchParams.get('token');

    // API: Reverse Local Port Tunnel (Fetch http://host:port/path via Laptop Agent)
    if (req.method === 'GET' && pathname === '/api/tunnel/fetch') {
        const authHdr = req.headers['authorization'] || '';
        const tok = authHdr.replace(/^Bearer\s+/i, '') || parsedUrl.searchParams.get('token');
        if (!isValidSession(tok)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        const targetHost = (parsedUrl.searchParams.get('host') || '127.0.0.1').replace(/[^a-zA-Z0-9.\-]/g, '');
        const targetPort = parseInt(parsedUrl.searchParams.get('port') || '80', 10);
        const targetPath = (parsedUrl.searchParams.get('path') || '/').replace(/["`$]/g, '');
        const targetDeviceId = parsedUrl.searchParams.get('deviceId') || '';
        const activeTarget = getActiveAgent(targetDeviceId);
        if (!activeTarget || !targetPort || targetPort < 1 || targetPort > 65535) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Agent offline or invalid port' }));
        }
        const url = `http://${targetHost}:${targetPort}${targetPath.startsWith('/') ? targetPath : '/' + targetPath}`;
        const ps = `try { $r = Invoke-WebRequest -Uri '${url}' -UseBasicParsing -TimeoutSec 10; Write-Output $r.Content } catch { Write-Output ('ERR:' + $_.Exception.Message) }`;
        const b64 = Buffer.from(ps, 'utf16le').toString('base64');
        const cmdId = crypto.randomBytes(8).toString('hex');
        const timer = setTimeout(() => {
            const idx = pendingCommands.findIndex(c => c.id === cmdId);
            if (idx !== -1) {
                pendingCommands.splice(idx, 1);
                res.writeHead(504, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Tunnel request timed out' }));
            }
        }, 15000);
        pendingCommands.push({
            id: cmdId,
            cmd: `powershell -NoProfile -ExecutionPolicy Bypass -enc ${b64}`,
            deviceId: activeTarget.deviceId,
            assigned: false,
            timer,
            resolve: (output) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, url, body: output }));
            }
        });
        return;
    }

    // API: Audit Logs
    if (pathname === '/api/audit') {
        if (!isValidSession(token)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        try {
            if (!fs.existsSync(AUDIT_LOG_FILE)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ logs: [] }));
            }
            const lines = fs.readFileSync(AUDIT_LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
            const logs = lines.slice(-100).reverse().map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ logs }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
    }

    // API: System Stats
    if (pathname === '/api/stats') {
        if (!isValidSession(token)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        const deviceId = parsedUrl.searchParams.get('deviceId') || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getSystemStats(deviceId)));
    }

    // API: Stage long command (avoids Nginx/Cloudflare GET URL length limits for webcam/screenshot/scripts)
    if (req.method === 'POST' && pathname === '/api/exec-stage') {
        if (!isValidSession(token)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 512 * 1024) req.destroy();
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const c = (data.cmd || '').toString();
                if (!c) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'No command provided' }));
                }
                const cid = crypto.randomBytes(10).toString('hex');
                stagedCmds.set(cid, { cmd: c, createdAt: Date.now() });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, cmdId: cid }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // API: Execute command with live SSE streaming
    if (pathname === '/api/exec') {
        if (!isValidSession(token)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }

        let cmd = parsedUrl.searchParams.get('cmd');
        const stagedId = parsedUrl.searchParams.get('cmdId');
        if (!cmd && stagedId && stagedCmds.has(stagedId)) {
            cmd = stagedCmds.get(stagedId).cmd;
            stagedCmds.delete(stagedId);
        }
        const targetDeviceId = parsedUrl.searchParams.get('deviceId') || '';
        if (!cmd) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            return res.end('No command provided');
        }
        logAudit('EXEC_CMD', cmd.length > 180 ? cmd.slice(0, 180) + '...' : cmd, getClientIp(req));

        // Set up SSE for streaming stdout & stderr live
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        const sendEvent = (event, data) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        const activeTarget = getActiveAgent(targetDeviceId);

        // IF PHYSICAL LAPTOP AGENT IS ONLINE -> EXECUTE ON LAPTOP!
        if (activeTarget) {
            sendEvent('stdout', `[⚡ EXECUTING ON PHYSICAL LAPTOP (${activeTarget.hostname}) via K-Term Agent]\n`);
            
            const cmdId = crypto.randomBytes(8).toString('hex');
            const timer = setTimeout(() => {
                const idx = pendingCommands.findIndex(c => c.id === cmdId);
                if (idx !== -1) {
                    pendingCommands.splice(idx, 1);
                    sendEvent('stderr', '\n[ERROR] Laptop command timed out after 30 seconds.\n');
                    sendEvent('exit', { code: 1 });
                    setTimeout(() => { try { res.end(); } catch(e) {} }, 50);
                }
            }, 30000);

            pendingCommands.push({
                id: cmdId,
                cmd: cmd,
                deviceId: activeTarget.deviceId,
                assigned: false,
                timer: timer,
                resolve: (output) => {
                    sendEvent('stdout', output + '\n');
                    sendEvent('exit', { code: 0 });
                    setTimeout(() => { try { res.end(); } catch(e) {} }, 50);
                }
            });

            req.on('close', () => {
                const idx = pendingCommands.findIndex(c => c.id === cmdId);
                if (idx !== -1) {
                    clearTimeout(pendingCommands[idx].timer);
                    pendingCommands.splice(idx, 1);
                }
            });
            return;
        }

        // FALLBACK: NO LAPTOP AGENT CONNECTED -> EXECUTE ON VPS
        sendEvent('stdout', `[Notice: Laptop Agent not running. Executing on Cloud VPS (${os.hostname()})]\n[Tip: Run K-Term Agent on your laptop to execute directly on your physical laptop!]\n\n`);

        const currentDir = process.env.HOME || '/home/dinujaya';
        const child = spawn(cmd, {
            shell: true,
            cwd: currentDir,
            env: { ...process.env, TERM: 'xterm-256color', PAGER: 'cat' }
        });

        child.stdout.on('data', chunk => {
            sendEvent('stdout', chunk.toString('utf8'));
        });

        child.stderr.on('data', chunk => {
            sendEvent('stderr', chunk.toString('utf8'));
        });

        child.on('error', err => {
            sendEvent('stderr', `Execution Error: ${err.message}\n`);
            sendEvent('exit', { code: 1 });
            setTimeout(() => { try { res.end(); } catch(e) {} }, 50);
        });

        child.on('close', code => {
            sendEvent('exit', { code: code ?? 0 });
            setTimeout(() => { try { res.end(); } catch(e) {} }, 50);
        });

        req.on('close', () => {
            if (!child.killed) child.kill();
        });

        return;
    }

    // Serve Static UI (index.html)
    if (pathname === '/' || pathname === '/index.html') {
        const indexPath = path.join(__dirname, 'public', 'index.html');
        fs.readFile(indexPath, 'utf8', (err, html) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                return res.end('Error loading dashboard: ' + err.message);
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        });
        return;
    }

    // Serve Webcam UI (webcam.html)
    if (pathname === '/webcam' || pathname === '/webcam.html') {
        const webcamPath = path.join(__dirname, 'public', 'webcam.html');
        if (fs.existsSync(webcamPath)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            fs.createReadStream(webcamPath).pipe(res);
            return;
        }
    }

    // Serve Uploaded Media (/uploads/snap-xxx.jpg or /lap/uploads/snap-xxx.jpg)
    const uploadMatch = pathname.match(/^(?:\/lap)?\/uploads\/(.+)$/);
    if (uploadMatch) {
        if (PROTECT_UPLOADS && !isValidSession(token)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Unauthorized: Valid session token required' }));
        }
        const imgName = path.basename(uploadMatch[1]);
        const imgPath = path.join(uploadDir, imgName);
        const resolvedPath = path.resolve(imgPath);
        const resolvedUpload = path.resolve(uploadDir);

        if (!resolvedPath.startsWith(resolvedUpload + path.sep)) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            return res.end('Forbidden: Access outside uploads directory');
        }

        if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
            const ext = path.extname(resolvedPath).toLowerCase();
            let mime = 'application/octet-stream';
            if (ext === '.png') mime = 'image/png';
            else if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
            else if (ext === '.wav') mime = 'audio/wav';

            res.writeHead(200, {
                'Content-Type': mime,
                'Cache-Control': 'public, max-age=86400'
            });
            fs.createReadStream(resolvedPath).pipe(res);
            return;
        }
    }

    // Serve Downloads / Static Files (e.g. agent.ps1, webcam-agent.ps1, executables)
    const requestedFile = path.basename(pathname);
    const staticFilePath = path.join(__dirname, 'public', requestedFile);
    const resolvedStaticPath = path.resolve(staticFilePath);
    const resolvedPublicDir = path.resolve(__dirname, 'public');

    // Strict path traversal boundary verification
    if (!resolvedStaticPath.startsWith(resolvedPublicDir + path.sep) && resolvedStaticPath !== resolvedPublicDir) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('Forbidden: Access outside public directory');
    }

    if (fs.existsSync(resolvedStaticPath) && fs.statSync(resolvedStaticPath).isFile()) {
        const ext = path.extname(resolvedStaticPath).toLowerCase();
        let mime = 'application/octet-stream';
        if (ext === '.html') mime = 'text/html; charset=utf-8';
        else if (ext === '.js') mime = 'application/javascript';
        else if (ext === '.css') mime = 'text/css';
        else if (ext === '.json') mime = 'application/json';
        else if (ext === '.png') mime = 'image/png';
        else if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
        else if (ext === '.wav') mime = 'audio/wav';
        else if (ext === '.mp3') mime = 'audio/mpeg';
        else if (ext === '.ps1') mime = 'text/plain; charset=utf-8';
        else if (ext === '.bat') mime = 'text/plain; charset=utf-8';

        res.writeHead(200, {
            'Content-Type': mime,
            'Content-Disposition': (ext === '.exe' || ext === '.zip') ? `attachment; filename="${requestedFile}"` : 'inline',
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
        });
        fs.createReadStream(resolvedStaticPath).pipe(res);
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[K-Term Lap Terminal] running on http://127.0.0.1:${PORT}`);
    console.log(`[K-Term Security] Password authentication active (configured via .env / environment).`);
});
