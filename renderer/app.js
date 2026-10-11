'use strict';

// ───────────── جسر الاتصال: Electron أو وضع المتصفح ─────────────
(function setupBridge() {
    if (window.desktop) return;
    const params = new URLSearchParams(location.search);
    const token = params.get('t') || sessionStorage.getItem('wadl_t') || '';
    if (token) sessionStorage.setItem('wadl_t', token);
    window.desktop = {
        cmd: (c) => fetch('/api/cmd', { method: 'POST', headers: { 'x-token': token }, body: JSON.stringify(c) })
            .then((r) => r.json()).catch(() => null),
        onEvent: (cb) => {
            const es = new EventSource('/api/events?t=' + encodeURIComponent(token));
            es.onmessage = (m) => { try { cb(JSON.parse(m.data)); } catch (_) {} };
        }
    };
})();

// ───────────── الثيمات (نفس ثيمات تطبيق الأندرويد) ─────────────
const THEMES = [
    { name: 'داكن', bg: '#0E1014', surface: '#181B22', surface2: '#232733', text: '#F2F4F8', sub: '#98A1B3', dark: true },
    { name: 'أمولد', bg: '#000000', surface: '#0D0D0F', surface2: '#1A1A1F', text: '#FFFFFF', sub: '#8A8F9C', dark: true },
    { name: 'فاتح', bg: '#F3F5F9', surface: '#FFFFFF', surface2: '#E8ECF3', text: '#14171F', sub: '#5B6475', dark: false },
    { name: 'أزرق ليلي', bg: '#0A1224', surface: '#111D38', surface2: '#1B2B4D', text: '#EAF1FF', sub: '#8FA3C7', dark: true }
];
const ACCENTS = ['#3D8BFF', '#8B5CF6', '#10B981', '#F59E0B', '#EF4444', '#EC4899'];

function ls(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

const S = {
    conn: 'idle', registered: false, code: '', err: '', pairing: false, paused: false, engineUp: false,
    jobs: [], history: [], groups: [], mprog: {}, merrs: {}, settings: {}, dlDir: '', fatal: '', logs: [],
    tab: 0, modal: null, phone: '', ready: false,
    theme: Math.min(THEMES.length - 1, parseInt(ls('theme', '0'), 10) || 0),
    accent: Math.min(ACCENTS.length - 1, parseInt(ls('accent', '0'), 10) || 0)
};

// ───────────── أدوات ─────────────
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtSize(b) {
    b = Number(b) || 0;
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024) return Math.round(b / 1024) + ' KB';
    return b + ' B';
}
const fmtSpeed = (b) => (b > 0 ? fmtSize(b) + '/s' : '');
const L = (t) => `<bdi dir="ltr">${esc(t)}</bdi>`;   // يمنع انقلاب الأرقام/الوحدات داخل النص العربي
function fmtEta(s) {
    if (s < 60) return Math.round(s) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}
function ago(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'الآن';
    if (s < 3600) return 'قبل ' + Math.floor(s / 60) + ' د';
    if (s < 86400) return 'قبل ' + Math.floor(s / 3600) + ' س';
    return 'قبل ' + Math.floor(s / 86400) + ' يوم';
}
const connText = (c) => ({
    open: 'متصل', connecting: 'جارٍ الاتصال…', reconnecting: 'إعادة الاتصال…', pairing: 'بانتظار إدخال الرمز',
    replaced: 'فُتحت جلسة أخرى بنفس الحساب', needpair: 'غير مسجّل', loggedout: 'غير مسجّل'
}[c] || 'تشغيل المحرك…');

let toastTimer = null;
function toast(msg) {
    const t = $('#toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

function applyTheme() {
    const t = THEMES[S.theme], r = document.documentElement.style;
    r.setProperty('--bg', t.bg); r.setProperty('--surface', t.surface); r.setProperty('--surface2', t.surface2);
    r.setProperty('--text', t.text); r.setProperty('--sub', t.sub); r.setProperty('--accent', ACCENTS[S.accent]);
    document.documentElement.style.colorScheme = t.dark ? 'dark' : 'light';
}

const cmd = (c) => window.desktop.cmd(c);
const save = (patch) => cmd({ cmd: 'saveSettings', settings: patch });

// ───────────── القوالب ─────────────
function showLogin() {
    return S.pairing || ['needpair', 'loggedout', 'pairing'].includes(S.conn) || (S.conn === 'idle' && !S.registered);
}

function loginHTML() {
    const diag = `
      <div class="card" style="margin-top:16px">
        <div class="row"><div class="grow title" style="margin:0">التشخيص</div>
          <span class="pill ${S.engineUp ? 'green' : 'red'}">${S.engineUp ? 'المحرك يعمل' : 'المحرك لم يبدأ'}</span></div>
        <div class="sub" style="margin-top:6px">الحالة: ${connText(S.conn)}</div>
        <div class="logs" id="loginLogs">${S.logs.slice(-10).map((l) => `<div>${esc(l)}</div>`).join('')}</div>
        <button class="out block" data-act="diag" style="margin-top:8px">🔍 فحص الاتصال بواتساب</button>
      </div>`;
    const err = S.err ? `<div class="err" style="margin-top:10px;font-size:13px">${esc(S.err)}</div>` : '';
    let card;
    if (!S.code) {
        card = `<div class="card">
          <div class="title" style="margin-bottom:4px">ربط الواتساب</div>
          <div class="sub">أدخل رقمك مع رمز الدولة بدون +</div>
          <label class="f" for="phone">مثال: 213562396663</label>
          <input id="phone" type="tel" inputmode="numeric" value="${esc(S.phone)}" ${S.pairing ? 'disabled' : ''}>
          <button class="block big" data-act="pair" style="margin-top:14px" ${S.pairing ? 'disabled' : ''}>${S.pairing ? 'جارٍ طلب الرمز…' : 'طلب رمز الربط'}</button>
          ${S.pairing ? '<button class="out block" data-act="cancelPair" style="margin-top:8px">إلغاء</button>' : ''}
          ${err}</div>`;
    } else {
        card = `<div class="card">
          <div class="title">رمز الربط</div>
          <div class="code">${esc(S.code)}</div>
          <div class="sub" style="margin-top:14px">1) افتح واتساب ← الأجهزة المرتبطة<br>2) اختر «ربط جهاز»<br>3) اختر «الربط برقم الهاتف بدلاً من ذلك»<br>4) أدخل الرمز أعلاه</div>
          <div class="btns" style="margin-top:14px">
            <button data-act="copyCode">نسخ الرمز</button><button class="out" data-act="cancelPair">إلغاء</button></div>
          <div class="sub" style="margin-top:8px">الحالة: ${connText(S.conn)}</div>${err}</div>`;
    }
    return `<div class="login"><div class="logo">⬇</div><h1>WA Downloader</h1>
      <div class="sub">سجّل الدخول مرة واحدة وتُحفظ الجلسة</div>${card}${diag}</div>`;
}

const STATUS_PILL = {
    active: ['جاري', 'accent'], queued: ['منتظر', 'amber'], failed: ['فشل', 'red'], expired: ['منتهي', 'red'], skipped: ['متخطّى', 'sub']
};

function jobHTML(j) {
    const [pt, pc] = STATUS_PILL[j.status] || ['', 'sub'];
    let body;
    if (j.status === 'active') {
        const p = j.size > 0 ? Math.min(1, j.done / j.size) : 0;
        body = `<div class="bar ${j.size > 0 ? '' : 'indet'}"><i style="width:${(p * 100).toFixed(1)}%"></i></div>
          <div class="meta" data-meta>${jobMeta(j)}</div>
          ${j.attempt > 1 ? `<div class="warn">المحاولة ${j.attempt}</div>` : ''}
          ${j.error ? `<div class="warn">${esc(j.error)}</div>` : ''}`;
    } else {
        body = `<div class="meta" style="margin-top:8px">${j.size > 0 ? L(fmtSize(j.size)) : 'حجم غير معروف'}${j.from ? '  •  ' + L(j.from) : ''}</div>
          ${j.error ? `<div class="err">${esc(j.error)}</div>` : ''}`;
    }
    let actions = '';
    if (j.status === 'active' || j.status === 'queued') actions = `<button class="text red" data-act="cancel" data-id="${j.id}">إلغاء</button>`;
    else if (j.status === 'failed' || j.status === 'expired') {
        actions = `${j.status === 'failed' ? `<button class="text" data-act="retry" data-id="${j.id}">إعادة المحاولة</button>` : ''}
                   <button class="text" data-act="remove" data-id="${j.id}">إزالة</button>`;
    } else actions = `<button class="text" data-act="remove" data-id="${j.id}">إزالة</button>`;
    return `<div class="card" data-jid="${j.id}"><div class="row"><div class="grow name">${esc(j.name)}</div><span class="pill ${pc}">${pt}</span></div>
      ${body}<div class="actions">${actions}</div></div>`;
}

function jobMeta(j) {
    const p = j.size > 0 ? Math.min(1, j.done / j.size) : 0;
    const eta = j.speed > 0 && j.size > j.done ? '  •  ' + L(fmtEta((j.size - j.done) / j.speed)) : '';
    return `${j.size > 0 ? L(Math.round(p * 100) + '%') + '  •  ' : ''}${L(fmtSize(j.done) + ' / ' + (j.size > 0 ? fmtSize(j.size) : '؟'))}${j.speed > 0 ? '  •  ' + L(fmtSpeed(j.speed)) : ''}${eta}`;
}

function recHTML(r) {
    return `<div class="card click" data-act="open" data-id="${r.id}"><div class="row">
      <div class="grow"><div class="name">${esc(r.name)}</div><div class="meta">${L(fmtSize(r.size))}  •  ${ago(r.at)}</div></div>
      ${r.merged ? '<span class="pill accent">مدموج</span>' : r.used ? '<span class="pill sub">دُمج</span>' : ''}
      <button class="text" data-act="show" data-id="${r.id}">المجلد</button>
      <button class="text red" data-act="delrec" data-id="${r.id}">حذف</button></div></div>`;
}

function downloadsHTML() {
    const order = { active: 0, queued: 1, failed: 2, expired: 2, skipped: 3 };
    const jobs = [...S.jobs].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
    const cnt = (f) => S.jobs.filter(f).length;
    const speed = S.jobs.filter((j) => j.status === 'active').reduce((a, j) => a + (j.speed || 0), 0);
    const empty = !jobs.length && !S.history.length
        ? `<div class="card"><div class="name">لا توجد ملفات بعد</div><div class="sub">أي ملف يصل إلى الشات يبدأ تحميله هنا تلقائياً.</div></div>` : '';
    return `
      <div class="head"><div><h1>التحميلات</h1><div class="sub" id="totalSpeed">${speed > 0 ? L(fmtSpeed(speed)) : '—'}</div></div>
        <span class="pill ${S.conn === 'open' ? 'green' : 'amber'}">${connText(S.conn)}</span></div>
      <div class="card"><div class="stats">
          <div class="stat"><b>${cnt((j) => j.status === 'active')}</b><span>جاري</span></div>
          <div class="stat"><b>${cnt((j) => j.status === 'queued')}</b><span>منتظر</span></div>
          <div class="stat"><b>${cnt((j) => j.status === 'failed' || j.status === 'expired')}</b><span>فاشل</span></div>
          <div class="stat"><b>${S.history.filter((r) => !r.merged).length}</b><span>مكتمل</span></div></div>
        <div class="btns"><button class="out" data-act="pause">${S.paused ? '▶  استئناف التحميل' : '⏸  إيقاف مؤقت (بعد الملف الحالي)'}</button>
          <button class="out" data-act="openFolder" style="flex:0 0 auto">📂 فتح المجلد</button></div></div>
      ${empty}${jobs.map(jobHTML).join('')}
      ${S.history.length ? `<div class="title" style="margin:6px 0 0">المكتملة</div>${S.history.slice(0, 60).map(recHTML).join('')}` : ''}`;
}

function groupHTML(g) {
    const prog = S.mprog[g.key], error = S.merrs[g.key];
    const pill = prog ? '<span class="pill accent">جارٍ الدمج</span>'
        : g.missing.length ? `<span class="pill amber">ناقص #${g.missing[0]}</span>` : '<span class="pill green">جاهز</span>';
    const p = prog && prog.total > 0 ? Math.min(1, prog.done / prog.total) : 0;
    return `<div class="card" data-gkey="${esc(g.key)}"><div class="row"><div class="grow name">${esc(g.mergedName)}</div>${pill}</div>
      <div class="meta" style="margin-top:6px">${g.parts.length} أجزاء  •  ${L('#' + g.firstNum)} إلى ${L('#' + g.lastNum)}  •  ${L(fmtSize(g.total))}</div>
      ${g.firstNum > 1 ? `<div class="warn">تنبيه: يبدأ من الجزء #${g.firstNum} وليس 1</div>` : ''}
      ${g.missing.length ? `<div class="warn">الأجزاء الناقصة: ${g.missing.slice(0, 8).map((n) => L('#' + n)).join('، ')}${g.missing.length > 8 ? ' …' : ''}</div>` : ''}
      ${error ? `<div class="err" style="margin-top:4px">${esc(error)}</div>` : ''}
      ${prog ? `<div class="bar"><i style="width:${(p * 100).toFixed(1)}%"></i></div><div class="meta" data-gmeta>${L(Math.round(p * 100) + '%')}  •  ${L(fmtSize(prog.done) + ' / ' + fmtSize(prog.total))}</div>`
        : `<button class="block" style="margin-top:10px" data-act="merge" data-key="${esc(g.key)}" ${g.complete ? '' : 'disabled'}>🧩  دمج الآن</button>`}
    </div>`;
}

function mergeHTML() {
    return `<div><h1>دمج الأجزاء</h1><div class="sub">الملفات المتشابهة مثل file-part1 و file-part2 تُجمَّع هنا وتُوصَل بالترتيب الرقمي.</div></div>
      ${S.groups.length ? S.groups.map(groupHTML).join('')
        : `<div class="card"><div class="name">لا توجد مجموعات</div><div class="sub">تظهر المجموعة عندما يصل جزءان على الأقل بنفس الاسم الأساسي.</div></div>`}`;
}

function chips(opts, sel, key) {
    return `<div class="chips">${opts.map((o, i) => `<div class="chip ${i === sel ? 'on' : ''}" data-act="set" data-key="${key}" data-val="${o.v}">${esc(o.l)}</div>`).join('')}</div>`;
}

function settingsHTML() {
    const st = S.settings, g = (k, d) => (st[k] === undefined ? d : st[k]);
    const gapMin = g('gapMin', 3), gapMax = g('gapMax', 10), mode = g('mergeMode', 0), idle = g('idleSec', 60);
    const idleOpts = [30, 60, 120, 300].map((v) => ({ v, l: v + 'ث' }));
    return `
      <h1>الإعدادات</h1>
      <div class="card"><div class="title">مجلد الحفظ</div>
        <label class="f" for="folderName" style="margin-top:0">اسم المجلد</label>
        <input id="folderName" type="text" value="${esc(g('folderName', 'my downloading file'))}">
        <div class="sub" style="margin:6px 0 8px">المسار: ${L(S.dlDir)}</div>
        <div class="btns"><button data-act="saveFolder">حفظ الاسم</button><button class="out" data-act="resetFolder">الافتراضي</button></div>
        <button class="soft block" data-act="pickBase" style="margin-top:8px">📁 اختيار موقع آخر…</button>
        <div class="sub" style="margin-top:6px">الملفات الجديدة فقط تُحفظ في الموقع الجديد.</div></div>

      <div class="card"><div class="title">المصدر والفلترة</div>
        <label class="f" style="margin-top:0">رقم المحادثة (فارغ = الكل)</label>
        <input type="tel" data-set="target" value="${esc(g('target', ''))}">
        <label class="f">أقصى حجم بالميغابايت (فارغ = بلا حد)</label>
        <input type="number" min="0" data-set="maxSizeMb" value="${g('maxSizeMb', 0) || ''}">
        <label class="f">الأنواع المسموحة مثل: zip,rar,001</label>
        <input type="text" data-set="exts" value="${esc(g('exts', ''))}"></div>

      <div class="card"><div class="title">التحميل</div>
        <div class="sub" style="font-size:13px;color:var(--text)">الفاصل العشوائي بين الملفات: <b id="gapLabel">${gapMin} – ${gapMax}</b> ثانية</div>
        <label class="f">الحد الأدنى</label><input type="range" id="gapMin" min="1" max="30" value="${gapMin}">
        <label class="f">الحد الأقصى</label><input type="range" id="gapMax" min="1" max="30" value="${gapMax}"></div>

      <div class="card"><div class="title">الدمج التلقائي</div>
        ${chips([{ v: 0, l: 'يدوي فقط' }, { v: 1, l: 'عند اكتمال العدد' }, { v: 2, l: 'عند توقف الوصول' }], mode, 'mergeMode')}
        ${mode === 1 ? `<div class="row" style="margin-top:10px"><div class="grow">عدد الأجزاء: ${g('expectedCount', 3)}</div>
            <button class="out" data-act="step" data-d="-1">−</button><button class="out" data-act="step" data-d="1">+</button></div>` : ''}
        ${mode === 2 ? `<div class="sub" style="margin:10px 0 6px">يدمج عندما لا يصل جزء جديد خلال:</div>${chips(idleOpts, idleOpts.findIndex((o) => o.v === idle), 'idleSec')}` : ''}
        <div class="sub" style="margin-top:8px">الدمج التلقائي يتطلب أجزاء متتالية تبدأ من 1 بلا فجوات.</div>
        <div class="toggle"><span>حذف الأجزاء بعد نجاح الدمج</span><label class="switch"><input type="checkbox" data-set="deleteAfterMerge" ${g('deleteAfterMerge', false) ? 'checked' : ''}><b></b></label></div></div>

      <div class="card"><div class="title">المظهر</div>
        ${chips(THEMES.map((t, i) => ({ v: i, l: t.name })), S.theme, 'theme')}
        <div class="sub" style="margin:12px 0 8px">لون التمييز</div>
        <div class="swatches">${ACCENTS.map((c, i) => `<div class="sw" style="background:${c}" data-act="accent" data-i="${i}">${i === S.accent ? '✓' : ''}</div>`).join('')}</div></div>

      <div class="card"><div class="title">النظام والحساب</div><div class="stack">
        <button class="out" data-act="logs">📄 سجل الأحداث</button>
        <button class="out" data-act="diag">🔍 فحص الاتصال بواتساب</button>
        <button class="out" data-act="logout" style="color:var(--red)">🚪 تسجيل الخروج</button>
        <button class="out" data-act="quit">⏻ إغلاق التطبيق</button></div></div>`;
}

function navHTML() {
    const items = [['⬇', 'التحميلات'], ['🧩', 'الدمج'], ['⚙', 'الإعدادات']];
    return `<div class="nav">${items.map((it, i) => `<a class="${S.tab === i ? 'on' : ''}" data-act="tab" data-i="${i}"><span class="ic">${it[0]}</span>${it[1]}</a>`).join('')}</div>`;
}

function modalHTML() {
    if (S.modal !== 'logs') return '';
    return `<div class="modal-bg" data-act="closeModal"><div class="modal" data-stop><div class="title">سجل الأحداث</div>
      <div class="body logs">${S.logs.length ? S.logs.slice().reverse().map((l) => `<div>${esc(l)}</div>`).join('') : '<div>لا توجد أحداث</div>'}</div>
      <button data-act="closeModal">إغلاق</button></div></div>`;
}

// ───────────── العرض ─────────────
function render() {
    const app = $('#app'); if (!app) return;
    if (!S.ready) { app.innerHTML = ''; return; }
    const old = $('.content', app) || $('.login', app);
    const scroll = old ? old.scrollTop : 0;
    const fatal = S.fatal ? `<div class="banner" data-act="copyFatal">${esc(S.fatal)}\n(اضغط للنسخ)</div>` : '';
    if (showLogin()) {
        app.innerHTML = fatal + loginHTML() + modalHTML();
        const ph = $('#phone'); if (ph) ph.addEventListener('input', () => { S.phone = ph.value.replace(/[^0-9]/g, ''); });
    } else {
        const body = [downloadsHTML, mergeHTML, settingsHTML][S.tab]();
        app.innerHTML = fatal + `<div class="content">${body}</div>${navHTML()}${modalHTML()}`;
        bindSettingsInputs();
    }
    const nw = $('.content', app) || $('.login', app);
    if (nw) nw.scrollTop = scroll;
}

function bindSettingsInputs() {
    const a = $('#gapMin'), b = $('#gapMax');
    if (!a || !b) return;
    const label = () => { $('#gapLabel').textContent = `${a.value} – ${b.value}`; };
    a.addEventListener('input', () => { if (+a.value > +b.value) b.value = a.value; label(); });
    b.addEventListener('input', () => { if (+b.value < +a.value) a.value = b.value; label(); });
    const commit = () => save({ gapMin: +a.value, gapMax: +b.value });
    a.addEventListener('change', commit); b.addEventListener('change', commit);
}

function refresh(kind) {
    if (showLogin()) { if (['state', 'log', 'code', 'error', 'engine'].includes(kind)) render(); return; }
    if (S.tab === 0 && ['jobs', 'history', 'state', 'paused'].includes(kind)) render();
    else if (S.tab === 1 && ['merge', 'history'].includes(kind)) render();
    else if (S.tab === 2 && ['settings'].includes(kind)) render();
    if (S.modal === 'logs' && kind === 'log') render();
}

function patchProgress(id) {
    const j = S.jobs.find((x) => x.id === id); if (!j) return;
    const card = $(`[data-jid="${id}"]`); if (!card) return;
    const fill = $('.bar i', card), meta = $('[data-meta]', card);
    if (fill && j.size > 0) fill.style.width = (Math.min(1, j.done / j.size) * 100).toFixed(1) + '%';
    if (meta) meta.innerHTML = jobMeta(j);
    const sp = $('#totalSpeed');
    if (sp) { const tot = S.jobs.filter((x) => x.status === 'active').reduce((a, x) => a + (x.speed || 0), 0); sp.innerHTML = tot > 0 ? L(fmtSpeed(tot)) : '—'; }
}

let lastMergeSig = '';
function onMerge(o) {
    S.groups = o.groups || []; S.mprog = o.progress || {}; S.merrs = o.errors || {};
    const sig = JSON.stringify(S.groups) + JSON.stringify(S.merrs) + Object.keys(S.mprog).join(',');
    if (sig !== lastMergeSig) { lastMergeSig = sig; refresh('merge'); return; }
    if (S.tab === 1 && !showLogin()) {
        for (const g of S.groups) {
            const p = S.mprog[g.key]; const card = $(`[data-gkey="${CSS.escape(g.key)}"]`);
            if (!p || !card) continue;
            const f = $('.bar i', card), m = $('[data-gmeta]', card), pr = p.total > 0 ? Math.min(1, p.done / p.total) : 0;
            if (f) f.style.width = (pr * 100).toFixed(1) + '%';
            if (m) m.innerHTML = `${L(Math.round(pr * 100) + '%')}  •  ${L(fmtSize(p.done) + ' / ' + fmtSize(p.total))}`;
        }
    }
}

// ───────────── أحداث المحرك ─────────────
function onEvent(o) {
    switch (o.t) {
        case 'state':
            S.conn = o.conn; S.registered = !!o.registered; S.engineUp = true;
            if (o.conn === 'open') { S.pairing = false; S.code = ''; S.err = ''; }
            if (o.conn === 'needpair' || o.conn === 'loggedout') { S.pairing = false; S.code = ''; }
            render(); break;
        case 'code': S.code = o.code; refresh('code'); render(); break;
        case 'error': S.err = o.msg; S.pairing = false; render(); break;
        case 'log': S.logs.push(o.msg); if (S.logs.length > 150) S.logs.shift(); refresh('log'); break;
        case 'jobs': S.jobs = o.jobs; refresh('jobs'); break;
        case 'progress': {
            const j = S.jobs.find((x) => x.id === o.id);
            if (j) { j.done = o.done; j.speed = o.speed; if (o.total > 0) j.size = o.total; patchProgress(o.id); }
            break;
        }
        case 'history': S.history = o.history; refresh('history'); break;
        case 'merge': onMerge(o); break;
        case 'settings': S.settings = o.settings; S.dlDir = o.downloadDir; refresh('settings'); break;
        case 'paused': S.paused = o.paused; refresh('paused'); break;
        case 'done': toast('✓ ' + o.rec.name); break;
        case 'mergeDone': toast('✓ اكتمل الدمج: ' + o.name); break;
        case 'mergeFail': toast('✗ فشل الدمج: ' + (o.msg || '')); break;
        default: break;
    }
}

// ───────────── التفاعل ─────────────
document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    if (el.dataset.act === 'closeModal' && e.target.closest('[data-stop]') && !e.target.closest('button')) return;
    const a = el.dataset.act, id = el.dataset.id;
    if (el.tagName === 'BUTTON' && el.closest('[data-act="open"]') && a !== 'open') e.stopPropagation();

    switch (a) {
        case 'tab': S.tab = +el.dataset.i; render(); break;
        case 'pair': {
            const ph = $('#phone'); if (ph) S.phone = ph.value.replace(/[^0-9]/g, '');
            if (S.phone.length < 8) { S.err = 'أدخل رقماً صحيحاً مع رمز الدولة'; render(); break; }
            S.pairing = true; S.err = ''; S.code = ''; render();
            cmd({ cmd: 'pair', phone: S.phone }); break;
        }
        case 'cancelPair': S.pairing = false; S.code = ''; render(); cmd({ cmd: 'logout' }); break;
        case 'copyCode':
            try { await navigator.clipboard.writeText(S.code.replace('-', '')); toast('تم نسخ الرمز'); } catch (_) {} break;
        case 'copyFatal': try { await navigator.clipboard.writeText(S.fatal); toast('تم النسخ'); } catch (_) {} break;
        case 'diag': S.logs.push('…بدء الفحص'); render(); cmd({ cmd: 'diag' }); break;
        case 'pause': cmd({ cmd: 'setPause', user: !S.paused }); break;
        case 'cancel': cmd({ cmd: 'cancel', id }); break;
        case 'retry': cmd({ cmd: 'retry', id }); break;
        case 'remove': S.jobs = S.jobs.filter((j) => j.id !== id); cmd({ cmd: 'clearJob', id }); render(); break;
        case 'open': cmd({ cmd: 'openRec', id }); break;
        case 'show': cmd({ cmd: 'showRec', id }); break;
        case 'delrec': if (confirm('حذف الملف من القرص؟')) cmd({ cmd: 'deleteRec', id }); break;
        case 'openFolder': cmd({ cmd: 'openFolder' }); break;
        case 'merge': cmd({ cmd: 'merge', key: el.dataset.key }); break;
        case 'set': {
            const k = el.dataset.key, v = +el.dataset.val;
            if (k === 'theme') { S.theme = v; lsSet('theme', v); applyTheme(); render(); }
            else save({ [k]: v });
            break;
        }
        case 'step': save({ expectedCount: Math.max(2, Math.min(99, (S.settings.expectedCount || 3) + +el.dataset.d)) }); break;
        case 'accent': S.accent = +el.dataset.i; lsSet('accent', S.accent); applyTheme(); render(); break;
        case 'saveFolder': { const v = $('#folderName').value; save({ folderName: v }); toast('تم الحفظ'); break; }
        case 'resetFolder': save({ folderName: 'my downloading file' }); break;
        case 'pickBase': { const d = await cmd({ cmd: 'pickFolder' }); if (d) save({ baseDir: d }); break; }
        case 'logs': S.modal = 'logs'; render(); break;
        case 'closeModal': S.modal = null; render(); break;
        case 'logout': if (confirm('تسجيل الخروج؟ سيُحذف الربط مع واتساب.')) cmd({ cmd: 'logout' }); break;
        case 'quit': cmd({ cmd: 'quit' }); break;
        default: break;
    }
});

document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-set]'); if (!el) return;
    const k = el.dataset.set;
    if (el.type === 'checkbox') save({ [k]: el.checked });
    else if (el.type === 'number') save({ [k]: Math.max(0, parseInt(el.value, 10) || 0) });
    else save({ [k]: el.value });
});

// ───────────── البدء ─────────────
(async function init() {
    applyTheme();
    render();
    window.desktop.onEvent(onEvent);
    const st = await window.desktop.cmd({ cmd: 'getState' });
    S.ready = true;
    if (st) {
        S.conn = st.conn; S.registered = st.registered; S.code = st.code || ''; S.paused = !!st.paused;
        S.jobs = st.jobs || []; S.history = st.history || []; S.groups = st.groups || [];
        S.mprog = st.progress || {}; S.merrs = st.errors || {}; S.settings = st.settings || {};
        S.dlDir = st.downloadDir || ''; S.fatal = st.fatal || ''; S.logs = st.logs || []; S.engineUp = true;
    }
    render();
    // تحديث الأوقات النسبية كل دقيقة
    setInterval(() => { if (S.tab === 0 && !showLogin()) render(); }, 60000);
})();
