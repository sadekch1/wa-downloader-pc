'use strict';
// ────────────────────────────────────────────────────────────────
// محرك WA Downloader لسطح المكتب (Windows / Linux)
// يحمّل الملفات من واتساب مباشرة إلى المجلد، ويدمج الأجزاء المتتالية.
// ────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

let P = null, baileys = {}, loadError = null;
try {
    P = require('pino');
    baileys = require('@whiskeysockets/baileys');
} catch (e) { loadError = e; }

const makeWASocket = baileys.makeWASocket || baileys.default;
const {
    useMultiFileAuthState,
    downloadContentFromMessage,
    fetchLatestBaileysVersion,
    DisconnectReason = {}
} = baileys;

// ───────────────────────── ثوابت ─────────────────────────
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 60000;
const STALL_MS = 25000;
const ATTEMPT_MAX_MS = 60 * 60 * 1000;
const RECONNECT_BASE = 2000;
const RECONNECT_MAX = 60000;
const BOOT_TOLERANCE = 10;
const PAIR_MAX_TRIES = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

function toNum(v) {
    if (v == null) return 0;
    if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function sanitizeFileName(name) {
    let n = String(name || '').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').trim();
    if (!n) n = `file_${Date.now()}`;
    if (n.length > 120) {
        const ext = path.extname(n).slice(0, 15);
        n = n.slice(0, 120 - ext.length) + ext;
    }
    return n;
}

function cleanFolderName(raw) {
    const n = String(raw || '').replace(/[\\/:*?"<>|]/g, '_').trim().replace(/^\.+|\.+$/g, '');
    return (n || 'my downloading file').slice(0, 80);
}

function safeUnlink(p) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} }

function uniquePath(dir, name) {
    let p = path.join(dir, name);
    if (!fs.existsSync(p)) return p;
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    let i = 1;
    while (fs.existsSync(p)) { p = path.join(dir, `${base} (${i})${ext}`); i++; }
    return p;
}

function freeBytes(dir) {
    try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch (_) { return -1; }
}

function withTimeout(promise, ms, message) {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(message)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function isExpiredError(err) {
    const code = (err && err.output && err.output.statusCode) || (err && err.statusCode);
    const msg = String((err && err.message) || '');
    return code === 404 || code === 410 || /\b(404|410)\b/.test(msg) || /empty media key|media key|expired/i.test(msg);
}

// ───────────────────────── تحليل أسماء الأجزاء ─────────────────────────
const dotNum = /^(.+)\.(\d{2,4})$/;
const partRe = /^(.*?)[\s._-]*(?:part|pt)?[\s._-]*(\d+)$/i;

/** → { key, num, mergedName } أو null */
function parsePart(name) {
    let m = dotNum.exec(name);
    if (m) {
        const b = m[1];
        const dot = b.lastIndexOf('.');
        const merged = dot > 0 ? b.slice(0, dot) + '-merged' + b.slice(dot) : b + '-merged';
        return { key: b.toLowerCase(), num: parseInt(m[2], 10), mergedName: merged };
    }
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    m = partRe.exec(stem);
    if (!m) return null;
    const base = m[1].replace(/[ ._-]+$/, '');
    if (!base) return null;
    const num = parseInt(m[2], 10);
    if (!Number.isFinite(num)) return null;
    return { key: (base + ext).toLowerCase(), num, mergedName: `${base}-merged${ext}` };
}

function computeGroups(history) {
    const map = new Map();
    for (const r of history) {
        if (r.merged || r.used) continue;
        const p = parsePart(r.name);
        if (!p) continue;
        if (!map.has(p.key)) map.set(p.key, []);
        map.get(p.key).push({ rec: r, num: p.num, mergedName: p.mergedName });
    }
    const out = [];
    for (const [key, list] of map) {
        const byNum = new Map();
        for (const t of list) {
            const old = byNum.get(t.num);
            if (!old || t.rec.at > old.rec.at) byNum.set(t.num, t);
        }
        if (byNum.size < 2) continue;
        const nums = [...byNum.keys()].sort((a, b) => a - b);
        const missing = [];
        for (let n = nums[0]; n <= nums[nums.length - 1] && missing.length < 500; n++) if (!byNum.has(n)) missing.push(n);
        const parts = nums.map((n) => ({ num: n, rec: byNum.get(n).rec }));
        out.push({
            key,
            mergedName: byNum.get(nums[0]).mergedName,
            parts: parts.map((p) => ({ num: p.num, id: p.rec.id, name: p.rec.name, size: p.rec.size })),
            firstNum: nums[0],
            lastNum: nums[nums.length - 1],
            missing,
            complete: parts.length >= 2 && missing.length === 0,
            total: parts.reduce((a, p) => a + (p.rec.size || 0), 0),
            lastAt: Math.max(...parts.map((p) => p.rec.at))
        });
    }
    return out.sort((a, b) => b.lastAt - a.lastAt);
}

// ───────────────────────── المحرك ─────────────────────────
function createEngine({ dataDir, downloadsDir, emit: emitCb }) {
    const AUTH_DIR = path.join(dataDir, 'auth');
    const SETTINGS_FILE = path.join(dataDir, 'settings.json');
    const HISTORY_FILE = path.join(dataDir, 'history.json');
    const ERROR_LOG = path.join(dataDir, 'engine-errors.log');
    fs.mkdirSync(dataDir, { recursive: true });

    const BOOT_TIME = Math.floor(Date.now() / 1000);

    function logError(err) {
        try { fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${(err && err.stack) || err}\n`); } catch (_) {}
    }
    if (loadError) logError(loadError);

    // ── الأحداث ──
    const logs = [];
    function emit(o) { try { emitCb(o); } catch (_) {} }
    function log(msg) { logs.push(String(msg)); if (logs.length > 150) logs.shift(); emit({ t: 'log', msg: String(msg) }); }

    // ── الإعدادات ──
    const defaults = {
        baseDir: downloadsDir,
        folderName: 'my downloading file',
        target: '',
        gapMin: 3,
        gapMax: 10,
        maxSizeMb: 0,
        exts: '',
        mergeMode: 0,        // 0 يدوي، 1 عند عدد، 2 عند توقف الوصول
        expectedCount: 3,
        idleSec: 60,
        deleteAfterMerge: false
    };
    let settings = { ...defaults };
    try { settings = { ...defaults, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch (_) {}
    settings.folderName = cleanFolderName(settings.folderName);

    const downloadDir = () => path.join(settings.baseDir, settings.folderName);
    const extList = () => String(settings.exts || '').toLowerCase().split(/[,\s]+/).map((s) => s.replace(/^\./, '')).filter(Boolean);

    function saveSettings(patch) {
        const p = { ...patch };
        if ('folderName' in p) p.folderName = cleanFolderName(p.folderName);
        for (const k of ['gapMin', 'gapMax', 'maxSizeMb', 'expectedCount', 'idleSec', 'mergeMode']) if (k in p) p[k] = Number(p[k]) || 0;
        if ('target' in p) p.target = String(p.target || '').replace(/[^0-9]/g, '');
        settings = { ...settings, ...p };
        if (settings.gapMax < settings.gapMin) settings.gapMax = settings.gapMin;
        try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (e) { logError(e); }
        emit({ t: 'settings', settings, downloadDir: downloadDir() });
    }

    // ── السجل ──
    let history = [];
    try {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')).filter((r) => r && r.path && fs.existsSync(r.path));
    } catch (_) {}
    function saveHistory() {
        try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history)); } catch (e) { logError(e); }
        emit({ t: 'history', history });
        emitMerge();
    }

    // ── الدمج: حالة ──
    const merging = new Set();
    const mergeFailed = new Set();
    const mergeProg = {};
    const mergeErr = {};
    let mergeChain = Promise.resolve();
    function emitMerge() {
        emit({ t: 'merge', groups: computeGroups(history), progress: mergeProg, errors: mergeErr });
    }

    // ── المهام ──
    const jobs = new Map();
    const queue = [];
    const seenIds = new Set();
    let running = false;
    let userPaused = false;
    let counter = 0;

    const pubJob = (j) => ({
        id: j.id, name: j.name, size: j.size, from: j.from, status: j.status,
        done: j.done || 0, speed: j.speed || 0, attempt: j.attempt || 0, error: j.error || ''
    });
    const emitJobs = () => emit({ t: 'jobs', jobs: [...jobs.values()].map(pubJob) });

    // ── واتساب ──
    let conn = 'idle';
    let pairingCode = '';
    let currentSock = null;
    let reconnectTimer = null;
    let reconnectAttempts = 0;
    let pairingPhone = null;
    let pairTries = 0;
    let stopReconnect = false;
    let pairTimer = null;

    function isRegistered() {
        try { return !!JSON.parse(fs.readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf8')).registered; }
        catch (_) { return false; }
    }
    function setConn(c) { conn = c; emit({ t: 'state', conn: c, registered: isRegistered() }); }

    function snapshot() {
        return {
            conn, registered: isRegistered(), code: pairingCode, paused: userPaused,
            jobs: [...jobs.values()].map(pubJob), history, groups: computeGroups(history),
            progress: mergeProg, errors: mergeErr, settings, downloadDir: downloadDir(),
            fatal: loadError ? `فشل تحميل مكتبة واتساب: ${loadError.message}` : '', logs
        };
    }

    // ───────────── التحميل ─────────────
    function enqueue(job) {
        jobs.set(job.id, job);
        queue.push(job);
        emitJobs();
        processQueue();
    }

    async function processQueue() {
        if (running) return;
        running = true;
        try {
            while (!userPaused && queue.length > 0) {
                const job = queue.shift();
                if (job.status === 'canceled') continue;
                await handleJob(job);
                if (!userPaused && queue.length > 0) {
                    const lo = Math.max(0, settings.gapMin), hi = Math.max(lo, settings.gapMax);
                    const until = Date.now() + rand(lo * 1000, hi * 1000);
                    while (Date.now() < until && !userPaused) await sleep(300);
                }
            }
        } finally { running = false; }
    }

    function downloadWithProgress(job, stream, partPath) {
        return new Promise((resolve, reject) => {
            const out = fs.createWriteStream(partPath);
            let downloaded = 0, settled = false, stallTimer = null;
            let lastEmit = 0, lastBytes = 0, lastTime = Date.now(), speed = 0;

            const resetStall = () => {
                clearTimeout(stallTimer);
                stallTimer = setTimeout(() => fail(new Error('توقف التنزيل (لا استجابة)')), STALL_MS);
            };
            const fail = (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(stallTimer);
                job.abort = null;
                try { stream.destroy(); } catch (_) {}
                out.destroy();
                reject(err);
            };
            job.abort = () => fail(new Error('canceled'));
            resetStall();

            stream.on('data', (chunk) => {
                downloaded += chunk.length;
                job.done = downloaded;
                resetStall();
                const now = Date.now();
                if (now - lastEmit >= 300) {
                    const dt = (now - lastTime) / 1000;
                    if (dt > 0) {
                        const inst = (downloaded - lastBytes) / dt;
                        speed = speed ? speed * 0.6 + inst * 0.4 : inst;
                    }
                    job.speed = Math.round(speed);
                    lastBytes = downloaded; lastTime = now; lastEmit = now;
                    emit({ t: 'progress', id: job.id, done: downloaded, total: job.size, speed: job.speed });
                }
            });
            stream.on('error', fail);
            out.on('error', fail);
            out.on('finish', () => {
                if (settled) return;
                settled = true;
                clearTimeout(stallTimer);
                job.abort = null;
                resolve(downloaded);
            });
            stream.pipe(out);
        });
    }

    async function handleJob(job) {
        const dir = downloadDir();
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
            job.status = 'failed'; job.error = 'تعذّر إنشاء المجلد: ' + e.message;
            emitJobs(); return;
        }
        const partPath = path.join(dir, `.${job.id}.part`);

        if (job.size > 0) {
            const free = freeBytes(dir);
            if (free >= 0 && free < job.size * 1.05 + 20 * 1048576) {
                job.status = 'failed'; job.error = 'مساحة غير كافية في القرص';
                emitJobs(); return;
            }
        }

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (job.status === 'canceled') { safeUnlink(partPath); return; }
            job.status = 'active'; job.attempt = attempt; job.done = 0; job.speed = 0; job.error = '';
            emitJobs();

            try {
                const stream = await withTimeout(
                    job.testStream ? job.testStream() : downloadContentFromMessage(job.docMsg, 'document'),
                    60000, 'انتهت مهلة بدء الاتصال بالملف'
                );
                await withTimeout(downloadWithProgress(job, stream, partPath), ATTEMPT_MAX_MS, 'انتهت مهلة التحميل');

                const actual = fs.statSync(partPath).size;
                if (actual === 0) throw new Error('الملف المحمّل فارغ');
                if (job.size > 0 && actual !== job.size) throw new Error(`الحجم غير مطابق (${actual} من ${job.size})`);

                const finalPath = uniquePath(dir, job.name);
                fs.renameSync(partPath, finalPath);
                const rec = { id: job.id, name: path.basename(finalPath), size: actual, path: finalPath, at: Date.now(), merged: false, used: false };
                jobs.delete(job.id);
                history.unshift(rec);
                saveHistory();
                emitJobs();
                emit({ t: 'done', rec });
                if (![...jobs.values()].some((j) => j.status === 'active' || j.status === 'queued')) {
                    emit({ t: 'queueDone', name: rec.name });
                }
                return;
            } catch (err) {
                logError(err);
                safeUnlink(partPath);
                if (job.status === 'canceled' || (err && err.message === 'canceled')) {
                    jobs.delete(job.id); emitJobs(); return;
                }
                if (isExpiredError(err)) {
                    job.status = 'expired'; job.error = 'انتهت صلاحية الملف على خوادم واتساب';
                    emitJobs(); return;
                }
                job.error = err.message;
                if (attempt < MAX_ATTEMPTS) {
                    emitJobs();
                    const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1)) + rand(0, 1500);
                    const until = Date.now() + wait;
                    while (Date.now() < until && job.status !== 'canceled') await sleep(300);
                }
            }
        }
        job.status = 'failed';
        emitJobs();
    }

    // ───────────── الدمج ─────────────
    function mergeGroup(key, manual) {
        const g = computeGroups(history).find((x) => x.key === key);
        if (!g || !g.complete || merging.has(key)) return;
        merging.add(key);
        if (manual) { mergeFailed.delete(key); delete mergeErr[key]; }
        mergeProg[key] = { done: 0, total: g.total };
        emitMerge();

        mergeChain = mergeChain.then(async () => {
            const dir = downloadDir();
            const outPath = uniquePath(dir, g.mergedName);
            const tmp = outPath + '.part';
            let out = null;
            try {
                fs.mkdirSync(dir, { recursive: true });
                const free = freeBytes(dir);
                if (free >= 0 && free < g.total * 1.02 + 50 * 1048576) throw new Error('مساحة غير كافية للدمج');

                const recs = g.parts.map((p) => history.find((r) => r.id === p.id));
                for (const r of recs) if (!r || !fs.existsSync(r.path)) throw new Error(`الجزء غير موجود: ${r ? r.name : '؟'}`);

                out = fs.createWriteStream(tmp);
                let written = 0, lastEmit = 0;
                for (const r of recs) {
                    let copied = 0;
                    await new Promise((resolve, reject) => {
                        const onErr = (e) => reject(e);
                        out.once('error', onErr);
                        const rs = fs.createReadStream(r.path, { highWaterMark: 1 << 20 });
                        rs.on('data', (c) => {
                            copied += c.length; written += c.length;
                            const now = Date.now();
                            if (now - lastEmit > 250) {
                                lastEmit = now;
                                mergeProg[key] = { done: written, total: g.total };
                                emitMerge();
                            }
                        });
                        rs.on('error', reject);
                        rs.on('end', () => { out.removeListener('error', onErr); resolve(); });
                        rs.pipe(out, { end: false });
                    });
                    if (r.size > 0 && copied !== r.size) throw new Error(`حجم ${r.name} غير مطابق (${copied} من ${r.size})`);
                }
                await new Promise((resolve, reject) => { out.once('error', reject); out.end(resolve); });
                if (g.total > 0 && written !== g.total) throw new Error('الحجم النهائي غير مطابق');
                fs.renameSync(tmp, outPath);

                const rec = { id: 'm' + Date.now().toString(36), name: path.basename(outPath), size: written, path: outPath, at: Date.now(), merged: true, used: false };
                const ids = new Set(g.parts.map((p) => p.id));
                if (settings.deleteAfterMerge) {
                    for (const r of recs) safeUnlink(r.path);
                    history = [rec, ...history.filter((r) => !ids.has(r.id))];
                } else {
                    history = [rec, ...history.map((r) => (ids.has(r.id) ? { ...r, used: true } : r))];
                }
                delete mergeProg[key];
                saveHistory();
                emit({ t: 'mergeDone', name: rec.name });
            } catch (e) {
                logError(e);
                try { if (out) out.destroy(); } catch (_) {}
                safeUnlink(tmp);
                mergeErr[key] = e.message || 'فشل الدمج';
                mergeFailed.add(key);
                delete mergeProg[key];
                emitMerge();
                emit({ t: 'mergeFail', name: g.mergedName, msg: mergeErr[key] });
            } finally {
                merging.delete(key);
            }
        });
        return mergeChain;
    }

    function autoMergeTick() {
        const mode = settings.mergeMode;
        if (!mode) return;
        const busy = [...jobs.values()].some((j) => j.status === 'active' || j.status === 'queued');
        for (const g of computeGroups(history)) {
            if (!g.complete || g.firstNum > 1 || mergeFailed.has(g.key) || merging.has(g.key)) continue;
            const ok = mode === 1 ? g.parts.length >= settings.expectedCount
                : mode === 2 ? (!busy && Date.now() - g.lastAt > settings.idleSec * 1000) : false;
            if (ok) mergeGroup(g.key, false);
        }
    }
    const autoTimer = setInterval(autoMergeTick, 5000);

    // ───────────── واتساب ─────────────
    function destroySock(s) {
        if (!s) return;
        for (const ev of ['connection.update', 'messages.upsert', 'creds.update']) { try { s.ev.removeAllListeners(ev); } catch (_) {} }
        try { s.end(undefined); } catch (_) {}
    }

    function scheduleReconnect(fast = false) {
        if (reconnectTimer || stopReconnect) return;
        reconnectAttempts++;
        const delayMs = fast ? 1000 : Math.min(RECONNECT_MAX, RECONNECT_BASE * 2 ** (reconnectAttempts - 1)) + rand(0, 1000);
        setConn('reconnecting');
        log(`إعادة الاتصال بعد ${(delayMs / 1000).toFixed(1)}ث (محاولة ${reconnectAttempts})`);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect().catch((e) => { logError(e); scheduleReconnect(); });
        }, delayMs);
    }

    function matchesTarget(msg) {
        const target = settings.target;
        if (!target) return true;
        if (msg.key.fromMe) return true;
        const jids = [msg.key.remoteJid, msg.key.remoteJidAlt, msg.key.participant, msg.key.participantAlt].filter(Boolean);
        if (jids.some((j) => j.includes(target))) return true;
        return jids.some((j) => j.endsWith('@lid'));
    }

    function extractDocument(message) {
        let m = message;
        for (let i = 0; i < 4 && m; i++) {
            if (m.ephemeralMessage) m = m.ephemeralMessage.message;
            else if (m.viewOnceMessage) m = m.viewOnceMessage.message;
            else if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
            else if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
            else break;
        }
        return (m && m.documentMessage) || null;
    }

    async function connect() {
        destroySock(currentSock);
        stopReconnect = false;
        setConn('connecting');

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        let version;
        try { ({ version } = await fetchLatestBaileysVersion()); } catch (e) { logError(e); }

        const sock = makeWASocket({
            auth: state,
            ...(version ? { version } : {}),
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            syncFullHistory: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            logger: P({ level: 'silent' })
        });
        currentSock = sock;
        const isCurrent = () => sock === currentSock;
        sock.ev.on('creds.update', saveCreds);

        let codeRequested = false;
        async function requestCode() {
            if (codeRequested || !pairingPhone || sock.authState.creds.registered) return;
            codeRequested = true;
            try {
                await sleep(1500);
                if (!isCurrent()) return;
                const code = await sock.requestPairingCode(pairingPhone);
                pairingCode = code && code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : String(code);
                clearTimeout(pairTimer);
                emit({ t: 'code', code: pairingCode });
                log('تم الحصول على رمز الربط — أدخله في واتساب');
                setConn('pairing');
            } catch (err) {
                logError(err);
                pairTries++;
                log(`فشل طلب الرمز (${pairTries}/${PAIR_MAX_TRIES}): ${err.message}`);
                if (pairTries >= PAIR_MAX_TRIES) {
                    pairingPhone = null;
                    emit({ t: 'error', msg: 'تعذّر الحصول على رمز الربط. تحقق من الإنترنت والرقم ثم أعد المحاولة.' });
                    setConn('needpair');
                    return;
                }
                try { sock.end(undefined); } catch (_) {}
                if (isCurrent()) scheduleReconnect();
            }
        }

        sock.ev.on('connection.update', (update) => {
            if (!isCurrent()) return;
            const { connection, lastDisconnect, qr } = update;
            if (qr) { log('وصل الاتصال بواتساب — جارٍ طلب رمز الربط'); requestCode(); }

            if (connection === 'open') {
                reconnectAttempts = 0; pairingPhone = null; pairingCode = '';
                setConn('open');
            }
            if (connection === 'close') {
                const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
                    ? lastDisconnect.error.output.statusCode : undefined;
                log(`انقطع الاتصال: code=${code} ${(lastDisconnect && lastDisconnect.error && lastDisconnect.error.message) || ''}`);

                if (code === DisconnectReason.loggedOut) {
                    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
                    if (pairingPhone && pairTries < PAIR_MAX_TRIES) {
                        pairTries++;
                        log(`لم يُقبل الرمز أو انتهت صلاحيته (${pairTries}/${PAIR_MAX_TRIES}) — رمز جديد...`);
                        scheduleReconnect(true);
                        return;
                    }
                    pairingPhone = null;
                    setConn('loggedout');
                    return;
                }
                if (code === DisconnectReason.connectionReplaced) {
                    stopReconnect = true;
                    setConn('replaced');
                    return;
                }
                scheduleReconnect(code === DisconnectReason.restartRequired);
            }
        });

        sock.ev.on('messages.upsert', ({ messages, type }) => {
            if (!isCurrent() || type !== 'notify') return;
            const sorted = [...messages].sort((a, b) => toNum(a.messageTimestamp) - toNum(b.messageTimestamp));
            for (const msg of sorted) {
                if (!msg.message) continue;
                const ts = toNum(msg.messageTimestamp);
                if (ts && ts < BOOT_TIME - BOOT_TOLERANCE) continue;
                if (!matchesTarget(msg)) continue;
                const docMsg = extractDocument(msg.message);
                if (!docMsg) continue;
                const mid = msg.key.id;
                if (mid) { if (seenIds.has(mid)) continue; seenIds.add(mid); }

                const name = sanitizeFileName(docMsg.fileName || `file_${Date.now()}`);
                const size = toNum(docMsg.fileLength);
                const id = `${Date.now().toString(36)}${(counter++).toString(36)}`;
                const job = { id, docMsg, name, size, from: (msg.key.remoteJid || '').split('@')[0],
                              status: 'queued', done: 0, speed: 0, attempt: 0, error: '' };

                const ext = path.extname(name).slice(1).toLowerCase();
                const exts = extList();
                if (exts.length && !exts.includes(ext)) {
                    job.status = 'skipped'; job.error = 'نوع الملف غير مسموح';
                    jobs.set(id, job); emitJobs(); continue;
                }
                if (settings.maxSizeMb > 0 && size > settings.maxSizeMb * 1048576) {
                    job.status = 'skipped'; job.error = `أكبر من ${settings.maxSizeMb} MB`;
                    jobs.set(id, job); emitJobs(); continue;
                }
                enqueue(job);
            }
        });
    }

    // ───────────── فحص الاتصال ─────────────
    async function runDiag() {
        log(`— فحص —  Node ${process.version} ${process.platform}/${process.arch}`);
        log('الوقت: ' + new Date().toISOString());
        const dns = require('dns');
        try {
            const addr = await new Promise((res, rej) => dns.lookup('web.whatsapp.com', (e, a) => (e ? rej(e) : res(a))));
            log('DNS ✓ ' + addr);
        } catch (e) { log('DNS ✗ ' + (e.code || '') + ' ' + e.message); }
        try {
            await new Promise((res, rej) => {
                const tls = require('tls');
                const s = tls.connect({ host: 'web.whatsapp.com', port: 443, servername: 'web.whatsapp.com' }, () => {
                    log(`TLS ✓ ${s.getProtocol()} authorized=${s.authorized}${s.authorizationError ? ' ' + s.authorizationError : ''}`);
                    s.end(); res();
                });
                s.on('error', rej);
                s.setTimeout(10000, () => s.destroy(new Error('timeout')));
            });
        } catch (e) { log('TLS ✗ ' + e.message); }
        try {
            const v = await withTimeout(fetchLatestBaileysVersion(), 15000, 'timeout');
            log('نسخة واتساب: ' + JSON.stringify(v).slice(0, 160));
        } catch (e) { log('جلب النسخة ✗ ' + e.message); }
        log('— انتهى الفحص —');
    }

    // ───────────── الأوامر ─────────────
    async function handle(c) {
        const needsWA = ['connect', 'pair', 'diag'];
        if (loadError && needsWA.includes(c.cmd)) {
            emit({ t: 'error', msg: `فشل تحميل مكتبة واتساب: ${loadError.message}` });
            return null;
        }
        switch (c.cmd) {
            case 'getState': return snapshot();

            case 'connect':
                if (currentSock) return snapshot();
                if (isRegistered()) await connect(); else setConn('needpair');
                return null;

            case 'pair': {
                const phone = String(c.phone || '').replace(/[^0-9]/g, '');
                if (phone.length < 8) { emit({ t: 'error', msg: 'رقم غير صالح' }); return null; }
                destroySock(currentSock); currentSock = null;
                clearTimeout(reconnectTimer); reconnectTimer = null;
                try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
                pairingPhone = phone; pairTries = 0; pairingCode = ''; reconnectAttempts = 0;
                clearTimeout(pairTimer);
                pairTimer = setTimeout(() => {
                    if (pairingPhone && !pairingCode) emit({ t: 'error', msg: 'لم يتم الاتصال بواتساب خلال 40 ثانية. اضغط «فحص الاتصال» لمعرفة السبب.' });
                }, 40000);
                log('بدء الربط…');
                await connect();
                return null;
            }

            case 'diag': await runDiag(); return null;

            case 'logout':
                try { if (currentSock) await currentSock.logout(); } catch (_) {}
                destroySock(currentSock); currentSock = null;
                clearTimeout(reconnectTimer); reconnectTimer = null;
                try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
                pairingPhone = null; pairingCode = '';
                setConn('needpair');
                return null;

            case 'setPause':
                userPaused = !!c.user;
                emit({ t: 'paused', paused: userPaused });
                if (!userPaused) processQueue();
                return null;

            case 'cancel': {
                const j = jobs.get(c.id);
                if (!j) return null;
                const wasActive = j.status === 'active';
                j.status = 'canceled';
                if (wasActive && j.abort) j.abort(); else { jobs.delete(j.id); emitJobs(); }
                return null;
            }

            case 'retry': {
                const j = jobs.get(c.id);
                if (!j || (j.status !== 'failed' && j.status !== 'expired')) return null;
                j.status = 'queued'; j.error = ''; j.attempt = 0;
                queue.push(j); emitJobs(); processQueue();
                return null;
            }

            case 'clearJob': jobs.delete(c.id); emitJobs(); return null;

            case 'saveSettings': saveSettings(c.settings || {}); return null;

            case 'merge': await mergeGroup(c.key, true); return null;

            case 'deleteRec': {
                const r = history.find((x) => x.id === c.id);
                if (r) { safeUnlink(r.path); history = history.filter((x) => x.id !== c.id); saveHistory(); }
                return null;
            }

            case 'recPath': {
                const r = history.find((x) => x.id === c.id);
                return r ? r.path : null;
            }

            case 'downloadDir': return downloadDir();

            default: return null;
        }
    }

    function shutdown() {
        clearInterval(autoTimer);
        clearTimeout(reconnectTimer); clearTimeout(pairTimer);
        destroySock(currentSock);
    }

    return {
        handle, shutdown, snapshot,
        _test: {
            enqueue, jobs,
            get history() { return history; },
            setHistory(h) { history = h; saveHistory(); }
        }
    };
}

module.exports = { createEngine, parsePart, computeGroups, cleanFolderName };
