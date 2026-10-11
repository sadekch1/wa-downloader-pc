const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
    cmd: (c) => ipcRenderer.invoke('cmd', c),
    onEvent: (cb) => ipcRenderer.on('ev', (_e, o) => cb(o))
});
