// وضع المتصفح: يشغّل المحرك + الواجهة على http://127.0.0.1:3737 (بدون Electron)
// الاستخدام: npm run web   (يتطلب Node 20+)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const { createEngine } = require('../dist/engine.js');

const PORT = parseInt(process.env.PORT || '3737', 10);
const TOKEN = crypto.randomBytes(12).toString('hex');
const ROOT = path.join(__dirname, '..', 'renderer');
const clients = new Set();

const engine = createEngine({
    dataDir: path.join(os.homedir(), '.wa-downloader'),
    downloadsDir: path.join(os.homedir(), 'Downloads'),
    emit: (o) => { const line = `data: ${JSON.stringify(o)}\n\n`; for (const r of clients) { try { r.write(line); } catch (_) {} } }
});

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function openPath(p) {
    const cmd = process.platform === 'win32' ? `start "" "${p}"` : process.platform === 'darwin' ? `open "${p}"` : `xdg-open "${p}"`;
    exec(cmd, () => {});
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/events') {
        if (url.searchParams.get('t') !== TOKEN) { res.writeHead(403); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(':ok\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
    }

    if (url.pathname === '/api/cmd' && req.method === 'POST') {
        if (req.headers['x-token'] !== TOKEN) { res.writeHead(403); return res.end(); }
        let body = '';
        req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
        req.on('end', async () => {
            let out = null;
            try {
                const c = JSON.parse(body);
                if (c.cmd === 'pickFolder') out = null;
                else if (c.cmd === 'openRec') { const p = await engine.handle({ cmd: 'recPath', id: c.id }); if (p) openPath(p); out = !!p; }
                else if (c.cmd === 'showRec') { const p = await engine.handle({ cmd: 'recPath', id: c.id }); if (p) openPath(path.dirname(p)); out = !!p; }
                else if (c.cmd === 'openFolder') { const d = await engine.handle({ cmd: 'downloadDir' }); fs.mkdirSync(d, { recursive: true }); openPath(d); out = d; }
                else if (c.cmd === 'quit') { setTimeout(() => process.exit(0), 100); }
                else out = await engine.handle(c);
            } catch (e) { out = null; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(out === undefined ? null : out));
        });
        return;
    }

    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    const full = path.normalize(path.join(ROOT, file));
    if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
    const link = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
    console.log('WA Downloader (وضع المتصفح) يعمل على:\n  ' + link);
    engine.handle({ cmd: 'connect' }).catch(() => {});
    openPath(link);
});
process.on('SIGINT', () => { engine.shutdown(); process.exit(0); });
