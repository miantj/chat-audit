const { contextBridge, ipcRenderer } = require('electron');

function isWin11OrLater() {
  if (process.platform !== 'win32') return false;
  try {
    const build = parseInt(String(process.getSystemVersion()).split('.')[2], 10);
    return Number.isFinite(build) && build >= 22000;
  } catch {
    return false;
  }
}

const isDev =
  process.env.CHAT_AUDIT_DEV === '1' ||
  process.argv.includes('--chat-audit-dev=1');

contextBridge.exposeInMainWorld('electronAPI', {
  isDev,
  platform: process.platform,
  winTitleBarOverlay: isWin11OrLater(),
  startExport: (options) => ipcRenderer.invoke('start-export', options),
  pauseExport: () => ipcRenderer.invoke('pause-export'),
  resumeExport: () => ipcRenderer.invoke('resume-export'),
  stopExport: () => ipcRenderer.invoke('stop-export'),
  openDirectory: () => ipcRenderer.invoke('open-directory'),
  openTargetsFile: () => ipcRenderer.invoke('open-targets-file'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  onExportProgress: (callback) => {
    ipcRenderer.on('export-progress', (_event, data) => callback(data));
  },
  onExportPaused: (callback) => {
    ipcRenderer.on('export-paused', (_event, data) => callback(data));
  },
  onExportResumed: (callback) => {
    ipcRenderer.on('export-resumed', (_event, data) => callback(data));
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
