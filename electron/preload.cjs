const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('piiDesktop', {
  setActiveWork(key, active) {
    return ipcRenderer.invoke('pii:set-active-work', { key, active });
  },
  platform: process.platform,
});
