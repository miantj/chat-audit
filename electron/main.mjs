import electron from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';

// 打包后 main.mjs 在 app.asar.unpacked，ESM 无法解析 asar 内 node_modules；用 require 从 app.asar 根加载
function createAppRequire() {
  const asarPkg = path.join(process.resourcesPath, 'app.asar', 'package.json');
  if (fs.existsSync(asarPkg)) {
    return createRequire(pathToFileURL(asarPkg));
  }
  return createRequire(import.meta.url);
}

const log = createAppRequire()('electron-log');
import { Orchestrator } from './src/orchestrator/orchestrator.js';
import { loadSettings, saveSettings } from './src/lib/settings.js';
import {
  clearExportSignals,
  PAUSE_FILE,
  STOP_FILE
} from './src/lib/signal-files.js';
import {
  ensureAuditChrome,
  DEFAULT_CDP
} from './src/lib/cdp-probe.js';
import {
  applyWin7NodePlatformWorkaround,
  verifyBundledRuntime
} from './src/lib/runtime-paths.js';

applyWin7NodePlatformWorkaround();

const { app, BrowserWindow, ipcMain, dialog } = electron;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

log.transports.file.level = 'info';
log.transports.console.level = 'info';

let mainWindow = null;
let activeOrchestrator = null;
let exportRunning = false;

function userDataDir() {
  return app.getPath('userData');
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function normalizeExportOptions(raw) {
  const start = raw.start ?? raw.startDate ?? raw.exportDate;
  const end = raw.end ?? raw.endDate ?? start;
  return {
    start,
    end,
    startDate: start,
    endDate: end,
    department: raw.department,
    outputDir: raw.outputDir
  };
}

function createWindow() {
  // preload 与 main.mjs 同目录，开发态与 app.asar.unpacked 打包后均用 __dirname
  const preloadPath = path.join(__dirname, 'preload.cjs');

  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    },
    title: '一手聊天审计导出',
    backgroundColor: '#ffffff'
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function initChromeInBackground() {
  try {
    sendToRenderer('chrome-status', {
      ready: false,
      message: '正在连接专用 Chrome…'
    });
    const started = await ensureAuditChrome(DEFAULT_CDP);
    sendToRenderer('chrome-status', {
      ready: started,
      message: started
        ? '专用 Chrome 已就绪；若见登录页请在此窗口登录（~/.chrome-chat-audit-profile 会保留登录态）'
        : 'Chrome 启动失败，导出时将重试'
    });
  } catch (err) {
    log.warn('initChromeInBackground:', err);
    sendToRenderer('chrome-status', {
      ready: false,
      message: err.message
    });
  }
}

app.whenReady().then(() => {
  clearExportSignals();
  createWindow();
  mainWindow.webContents.once('did-finish-load', () => {
    const runtime = verifyBundledRuntime();
    if (!runtime.ok && !runtime.dev) {
      sendToRenderer('chrome-status', {
        ready: false,
        message: `运行环境未就绪：${runtime.issues.join('；')}`
      });
      log.error('bundled runtime missing:', runtime.issues);
    }
    initChromeInBackground();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('start-export', async (_event, rawOptions) => {
  if (exportRunning) {
    return { success: false, error: '导出任务正在进行中' };
  }

  const options = normalizeExportOptions(rawOptions);
  log.info('start-export called with options:', options);

  if (!options.outputDir) {
    return { success: false, error: '请先选择输出目录' };
  }
  if (!options.start || !options.end) {
    return { success: false, error: '请填写开始日期和结束日期' };
  }

  clearExportSignals();
  exportRunning = true;

  const emitter = new EventEmitter();

  // 错误收集：在 orchestrator 完成前发生的所有错误都通过这个通道传递
  let startupError = null;
  emitter.on('error', (data) => {
    // 只在 startupError 未设置时才记录第一个错误
    if (!startupError) {
      startupError =
        typeof data === 'string' ? data : data?.message || '导出失败';
    }
  });

  const run = new Orchestrator(options, emitter);
  activeOrchestrator = run;

  const isCurrentRun = () => activeOrchestrator === run;

  emitter.on('progress', (data) => {
    if (!isCurrentRun()) return;
    if (
      process.env.CHAT_AUDIT_PROGRESS_DEBUG === '1' &&
      (data?.debug || String(data?.message || '').includes('[progress-debug]'))
    ) {
      log.info('[progress-debug] main→renderer', data);
    }
    sendToRenderer('export-progress', data);
  });
  emitter.on('paused', (data) => {
    if (isCurrentRun()) sendToRenderer('export-paused', data);
  });
  emitter.on('resumed', (data) => {
    if (isCurrentRun()) sendToRenderer('export-resumed', data);
  });
  emitter.on('complete', (data) => {
    if (!isCurrentRun()) return;
    exportRunning = false;
    activeOrchestrator = null;
    sendToRenderer('export-complete', data);
  });

  // 启动 orchestrator，捕获其抛出的异常
  activeOrchestrator
    .start()
    .then(() => {
      // 正常完成，complete 事件会负责后续处理
    })
    .catch((error) => {
      log.error('start-export error:', error);
      if (!isCurrentRun()) return;
      if (!startupError) {
        startupError = error.message;
      }
      exportRunning = false;
      activeOrchestrator = null;
      sendToRenderer('export-error', { message: startupError });
    });

  // 如果 start() 同步抛异常（比如 prepareCrmPage 同步检查失败），在这里捕获
  if (startupError) {
    exportRunning = false;
    activeOrchestrator = null;
    return { success: false, error: startupError };
  }

  return { success: true, started: true };
});

ipcMain.handle('pause-export', async () => {
  try {
    fs.writeFileSync(PAUSE_FILE, '');
    if (activeOrchestrator) activeOrchestrator.pause();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('resume-export', async () => {
  try {
    if (fs.existsSync(PAUSE_FILE)) fs.unlinkSync(PAUSE_FILE);
    if (activeOrchestrator) await activeOrchestrator.resumeAll();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-export', async () => {
  try {
    fs.writeFileSync(STOP_FILE, '');
    if (activeOrchestrator) {
      activeOrchestrator.stop();
      activeOrchestrator = null;
    }
    exportRunning = false;
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-settings', async () => loadSettings(userDataDir()));

ipcMain.handle('save-settings', async (_event, settings) => {
  await saveSettings(userDataDir(), settings);
  return { success: true };
});

ipcMain.handle('open-directory', async (event) => {
  try {
    const saved = await loadSettings(userDataDir());
    const parent =
      BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
    if (parent && !parent.isDestroyed()) {
      parent.focus();
    }
    const defaultPath =
      saved.outputDir && fs.existsSync(saved.outputDir)
        ? saved.outputDir
        : app.getPath('documents');
    const dialogOptions = {
      title: '选择输出目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || !result.filePaths?.length) {
      return { canceled: true };
    }
    const chosen = result.filePaths[0];
    await saveSettings(userDataDir(), { ...saved, outputDir: chosen });
    return { canceled: false, path: chosen };
  } catch (error) {
    log.error('open-directory error:', error);
    return { canceled: true, error: error.message };
  }
});
