const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { createEngine } = require('../dist/engine.js');

// بعض توزيعات لينكس (وبعض نسخ ويندوز المخففة) لا تدعم sandbox
if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');

if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
let engine = null;

function send(o) { if (win && !win.isDestroyed()) win.webContents.send('ev', o); }

function notify(title, body) {
    try { if (Notification.isSupported()) new Notification({ title, body }).show(); } catch (_) {}
}

function createWindow() {
    win = new BrowserWindow({
        width: 520,
        height: 880,
        minWidth: 380,
        minHeight: 620,
        backgroundColor: '#0E1014',
        title: 'WA Downloader',
        autoHideMenuBar: true,
        show: false,
        icon: path.join(__dirname, '..', 'build', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    win.once('ready-to-show', () => win.show());
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    win.webContents.once('did-finish-load', () => { engine.handle({ cmd: 'connect' }).catch(() => {}); });
    win.on('closed', () => { win = null; });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
    Menu.setApplicationMenu(null);

    engine = createEngine({
        dataDir: app.getPath('userData'),
        downloadsDir: app.getPath('downloads'),
        emit: (o) => {
            send(o);
            if (o.t === 'queueDone') notify('اكتمل التحميل', o.name || '');
            if (o.t === 'mergeDone') notify('اكتمل الدمج', o.name || '');
            if (o.t === 'mergeFail') notify('فشل الدمج', o.msg || o.name || '');
        }
    });

    ipcMain.handle('cmd', async (_e, c) => {
        switch (c.cmd) {
            case 'pickFolder': {
                const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
                return r.canceled ? null : r.filePaths[0];
            }
            case 'openRec': {
                const p = await engine.handle({ cmd: 'recPath', id: c.id });
                if (p) await shell.openPath(p);
                return !!p;
            }
            case 'showRec': {
                const p = await engine.handle({ cmd: 'recPath', id: c.id });
                if (p) shell.showItemInFolder(p);
                return !!p;
            }
            case 'openFolder': {
                const d = await engine.handle({ cmd: 'downloadDir' });
                try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
                await shell.openPath(d);
                return d;
            }
            case 'quit': app.quit(); return null;
            default: return engine.handle(c);
        }
    });

    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => { try { engine && engine.shutdown(); } catch (_) {} });
app.on('window-all-closed', () => { app.quit(); });
