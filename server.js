const http = require('http');
const { spawn, execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3880;
const ACCESS_PASSWORD = process.env.LAP_PASSWORD || 'DINUJAYA';

// Active auth sessions (persisted to disk across restarts)
const sessions = new Map();
const SESSIONS_FILE = '/tmp/lap_sessions.json';

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

// Laptop Agent State
let connectedAgent = null; // { hostname, user, os, cores, lastSeen }
let pendingCommands = [];  // [ { id, cmd, resolve, assigned, timer } ]

function isAgentOnline() {
    return connectedAgent && (Date.now() - connectedAgent.lastSeen < 7000);
}

function getSystemStats() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsagePct = ((usedMem / totalMem) * 100).toFixed(1);

    const cpus = os.cpus();
    const cpuModel = cpus.length > 0 ? cpus[0].model : 'Unknown CPU';
    const cpuCores = cpus.length;

    let diskInfo = 'N/A';
    try {
        const dfOut = execSync("df -h / | awk 'NR==2 {print $2, $3, $4, $5}'", { encoding: 'utf8' }).trim();
        const parts = dfOut.split(/\s+/);
        if (parts.length >= 4) {
            diskInfo = { total: parts[0], used: parts[1], free: parts[2], pct: parts[3] };
        }
    } catch (e) {
        diskInfo = { total: '?', used: '?', free: '?', pct: '?' };
    }

    const uptimeSec = os.uptime();
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const uptimeStr = `${days}d ${hours}h ${minutes}m`;

    return {
        agent: isAgentOnline() ? { ...connectedAgent, online: true } : null,
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

    // CORS & Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');

    // ==========================================
    // AGENT ENDPOINTS (Called by KotuKoleAgent.exe)
    // ==========================================

    // Agent Poll Endpoint: Heartbeat & Command Fetching
    if (req.method === 'POST' && pathname === '/api/agent/poll') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                connectedAgent = {
                    hostname: data.hostname || 'Physical Laptop',
                    user: data.user || 'User',
                    os: data.os || 'Windows',
                    cores: data.cores || '1',
                    cpuModel: data.cpuModel || '',
                    ramTotal: data.ramTotal || '',
                    ramUsed: data.ramUsed || '',
                    ramPercent: data.ramPercent || '',
                    diskTotal: data.diskTotal || '',
                    diskFree: data.diskFree || '',
                    diskPercent: data.diskPercent || '',
                    lastSeen: Date.now()
                };

                // Check if any command is queued for execution
                const nextCmd = pendingCommands.find(c => !c.assigned);
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
    // GITHUB AUTO-DEPLOY & WEBHOOK ENDPOINTS
    // ==========================================

    // GitHub Webhook Endpoint: Auto-pulls within seconds of any commit on GitHub
    if (pathname === '/api/webhook/github') {
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'ok', message: 'GitHub Webhook endpoint active' }));
        }

        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
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

    // API: Login
    if (req.method === 'POST' && pathname === '/api/login') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const userPass = (data.password || '').toString().trim();
                if (userPass.toUpperCase() === 'DINUJAYA' || userPass === 'kotukole123') {
                    const token = generateToken();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, token }));
                } else {
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

    // API: System Stats
    if (pathname === '/api/stats') {
        if (!isValidSession(token)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getSystemStats()));
    }

    // API: Execute command with live SSE streaming
    if (pathname === '/api/exec') {
        if (!isValidSession(token)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }

        const cmd = parsedUrl.searchParams.get('cmd');
        if (!cmd) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            return res.end('No command provided');
        }

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

        // IF PHYSICAL LAPTOP AGENT IS ONLINE -> EXECUTE ON LAPTOP!
        if (isAgentOnline()) {
            sendEvent('stdout', `[⚡ EXECUTING ON PHYSICAL LAPTOP (${connectedAgent.hostname}) via KotuKoleAgent.exe]\n`);
            
            const cmdId = crypto.randomBytes(8).toString('hex');
            const timer = setTimeout(() => {
                const idx = pendingCommands.findIndex(c => c.id === cmdId);
                if (idx !== -1) {
                    pendingCommands.splice(idx, 1);
                    sendEvent('stderr', '\n[ERROR] Laptop command timed out after 30 seconds.\n');
                    sendEvent('exit', { code: 1 });
                    res.end();
                }
            }, 30000);

            pendingCommands.push({
                id: cmdId,
                cmd: cmd,
                assigned: false,
                timer: timer,
                resolve: (output) => {
                    sendEvent('stdout', output + '\n');
                    sendEvent('exit', { code: 0 });
                    res.end();
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
        sendEvent('stdout', `[Notice: Laptop Agent not running. Executing on Cloud VPS (${os.hostname()})]\n[Tip: Run KotuKoleAgent.exe (8KB) on your laptop to execute directly on your physical laptop!]\n\n`);

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
            res.end();
        });

        child.on('close', code => {
            sendEvent('exit', { code: code ?? 0 });
            res.end();
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

    // Serve Downloads / Static Files (e.g. KotuKole-Agent-Fixed.exe, KotuKoleAgent.exe)
    const requestedFile = path.basename(pathname);
    const staticFilePath = path.join(__dirname, 'public', requestedFile);
    if (fs.existsSync(staticFilePath) && fs.statSync(staticFilePath).isFile()) {
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${requestedFile}"`,
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        fs.createReadStream(staticFilePath).pipe(res);
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[KotuKole Lap Terminal] running on http://127.0.0.1:${PORT}`);
    console.log(`[KotuKole Lap Terminal] Password: ${ACCESS_PASSWORD}`);
});
