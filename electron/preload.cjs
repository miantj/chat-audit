const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startExport: (options) => ipcRenderer.invoke('start-export', options),
  pauseExport: () => ipcRenderer.invoke('pause-export'),
  resumeExport: () => ipcRenderer.invoke('resume-export'),
  stopExport: () => ipcRenderer.invoke('stop-export'),
  openDirectory: () => ipcRenderer.invoke('open-directory'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  onExportProgress: (callback) => {
    ipcRenderer.on('export-progress', (_event, data) => callback(data));
  },
  onExportComplete: (callback) => {
    ipcRenderer.on('export-complete', (_event, data) => callback(data));
  },
  onExportError: (callback) => {
    ipcRenderer.on('export-error', (_event, error) => callback(error));
  },
  onChromeStatus: (callback) => {
    ipcRenderer.on('chrome-status', (_event, data) => callback(data));
  }
});
