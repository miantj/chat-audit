import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  startExport: (options) => ipcRenderer.invoke('start-export', options),
  pauseExport: () => ipcRenderer.invoke('pause-export'),
  resumeExport: () => ipcRenderer.invoke('resume-export'),
  stopExport: () => ipcRenderer.invoke('stop-export'),
  refreshQR: () => ipcRenderer.invoke('refresh-qr'),

  openDirectory: () => ipcRenderer.invoke('open-directory'),

  onExportProgress: (callback) => {
    ipcRenderer.on('export-progress', (event, data) => callback(data));
  },
  onQRRequired: (callback) => {
    ipcRenderer.on('qr-required', () => callback());
  },
  onExportComplete: (callback) => {
    ipcRenderer.on('export-complete', (event, data) => callback(data));
  },
  onExportError: (callback) => {
    ipcRenderer.on('export-error', (event, error) => callback(error));
  }
});
