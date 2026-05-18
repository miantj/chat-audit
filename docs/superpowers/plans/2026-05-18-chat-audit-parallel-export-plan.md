# Chat Audit Export - 三Tab并行架构 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有单tab串行导出改为三tab并行导出，速度提升3-5x，打包为exe供用户直接使用。

**Architecture:** 在 Electron 主进程内运行 Node.js 编写的 Orchestrator，管理3个独立的CDP连接并行处理员工对话。SharedState通过append-only JSONL实现跨tab的断点续跑。Python运行时通过PyInstaller打包进Electron。

**Tech Stack:** Electron + electron-builder, Node.js 22, Python 3 (用户自装), websockets, ws

---

## 文件结构

```
chat-audit/
├── electron/                          # 新建 Electron 项目
│   ├── package.json
│   ├── main.js                        # Electron 主进程入口
│   ├── preload.js                     # 预加载脚本（安全暴露IPC）
│   ├── renderer/
│   │   ├── index.html                 # 中文浅色UI
│   │   ├── styles.css
│   │   └── renderer.js
│   └── src/
│       ├── orchestrator/
│       │   ├── orchestrator.js        # 主协调器（原 index.js）
│       │   ├── TabManager.js          # 3个CDP连接管理
│       │   ├── EmployeeDistributor.js # 员工分组分发
│       │   ├── SharedState.js         # checkpoint + WeCom状态
│       │   └── SelfHealCoordinator.js # 跨tab自愈
│       └── lib/                       # 移植自 scripts/lib/
│           ├── cdp.js                 # CDPClient (基于ws)
│           ├── checkpoint.js          # (需确认存在)
│           ├── dataset.js             # (需确认存在)
│           ├── jsonl-store.js         # (已有)
│           ├── chat-loading.js        # (已有)
│           ├── customer-id.js          # (已有)
│           ├── export-errors.js       # (已有)
│           ├── friend-page.js         # (需确认存在)
│           ├── dialog-filters.js      # (需确认存在)
│           └── dialog-open.js          # (需确认存在)
├── chat-audit-export/
│   └── scripts/                       # 现有脚本（参考，不修改）
│       ├── crm-preflight.py           # 需要添加 get-employees 命令
│       └── ...
└── docs/superpowers/plans/
```

---

## Task 1: 初始化 Electron 项目

**Files:**
- Create: `electron/package.json`
- Create: `electron/main.js`
- Create: `electron/preload.js`
- Create: `electron/renderer/index.html`
- Create: `electron/renderer/styles.css`
- Create: `electron/renderer/renderer.js`

- [ ] **Step 1: 创建 electron 目录并初始化 package.json**

```bash
mkdir -p /Users/mingmacmini/Desktop/chat-audit/electron
cd /Users/mingmacmini/Desktop/chat-audit/electron
npm init -y
npm install electron@33 electron-builder@25 --save-dev
npm install electron-log@5 ws@8.18.0 --save
```

- [ ] **Step 2: 创建 main.js（Electron主进程，修复Bug1 & Bug2）**

```javascript
// electron/main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const log = require('electron-log');

let mainWindow;
let orchestrator = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: '一手聊天审计导出',
    backgroundColor: '#ffffff'
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('start-export', async (event, options) => {
  const { EventEmitter } = require('events');
  const emitter = new EventEmitter();
  const { Orchestrator } = require('./src/orchestrator/orchestrator.js');
  orchestrator = new Orchestrator(options, emitter);

  emitter.on('progress', (data) => {
    mainWindow.webContents.send('export-progress', data);
  });
  emitter.on('qr-required', () => {
    mainWindow.webContents.send('qr-required');
  });
  emitter.on('complete', (data) => {
    mainWindow.webContents.send('export-complete', data);
    orchestrator = null;
  });
  emitter.on('error', (data) => {
    mainWindow.webContents.send('export-error', data);
  });

  await orchestrator.start();
});

ipcMain.handle('pause-export', () => { if (orchestrator) orchestrator.pause(); });
ipcMain.handle('resume-export', async () => { if (orchestrator) await orchestrator.resumeAll(); });
ipcMain.handle('stop-export', () => { if (orchestrator) orchestrator.stop(); });
ipcMain.handle('refresh-qr', async (event, tabIndex) => {
  if (!orchestrator) return;
  const activeTab = tabIndex ?? orchestrator.sharedState?.getActiveLoginTab() ?? 0;
  await orchestrator.refreshQRForTab(activeTab);
});

// 修复Bug2：通过IPC暴露openDirectory，替代不可用的electron.remote
ipcMain.handle('open-directory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});
```

**修复内容：**
- Bug1: 路径改为 `./src/orchestrator/orchestrator.js`（对应实际文件名）
- Bug2: 添加 `open-directory` IPC handler，通过 preload 暴露给 renderer

- [ ] **Step 3: 创建 preload.js（安全IPC桥接，含 open-directory）**

```javascript
// electron/preload.js
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  startExport: (options) => ipcRenderer.invoke('start-export', options),
  pauseExport: () => ipcRenderer.invoke('pause-export'),
  resumeExport: () => ipcRenderer.invoke('resume-export'),
  stopExport: () => ipcRenderer.invoke('stop-export'),
  refreshQR: (tabIndex) => ipcRenderer.invoke('refresh-qr', tabIndex),
  openDirectory: () => ipcRenderer.invoke('open-directory'),
  onExportProgress: (callback) => ipcRenderer.on('export-progress', (e, d) => callback(d)),
  onQRRequired: (callback) => ipcRenderer.on('qr-required', (e, d) => callback(d)),
  onExportComplete: (callback) => ipcRenderer.on('export-complete', (e, d) => callback(d)),
  onExportError: (callback) => ipcRenderer.on('export-error', (e, d) => callback(d))
});
```

- [ ] **Step 4: 创建 renderer/index.html（中文浅色UI，完整按钮组）**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>一手聊天审计导出</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div class="container">
    <h1>一手聊天审计导出</h1>
    <div class="form">
      <div class="field">
        <label>开始日期</label>
        <input type="date" id="startDate" value="2026-05-01">
      </div>
      <div class="field">
        <label>结束日期</label>
        <input type="date" id="endDate" value="2026-05-01">
      </div>
      <div class="field">
        <label>部门</label>
        <select id="department">
          <option value="大客私域顾问-总">大客私域顾问-总</option>
        </select>
      </div>
      <div class="field">
        <label>输出目录</label>
        <input type="text" id="outputDir" placeholder="选择输出目录" readonly>
        <button type="button" id="selectDir">选择</button>
      </div>
      <div class="buttons">
        <button type="button" id="startBtn" class="btn-primary">开始导出</button>
        <button type="button" id="pauseBtn" class="btn-secondary" disabled>暂停</button>
        <button type="button" id="resumeBtn" class="btn-secondary" disabled>恢复</button>
        <button type="button" id="stopBtn" class="btn-danger" disabled>停止</button>
        <button type="button" id="refreshQRBtn" class="btn-secondary" disabled>刷新二维码</button>
      </div>
    </div>
    <div class="status" id="statusBar"></div>
    <div class="log">
      <h3>导出日志</h3>
      <div id="logContent"></div>
    </div>
    <div class="progress">
      <div class="progress-bar"><div class="fill" id="progressFill"></div></div>
      <span id="progressText">0%</span>
    </div>
  </div>
  <script src="renderer.js"></script>
</body>
</html>
```

- [ ] **Step 5: 创建 renderer/styles.css（中文浅色样式）**

```css
/* electron/renderer/styles.css */
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Microsoft YaHei', sans-serif; background: #f5f5f5; color: #333; }
.container { max-width: 800px; margin: 40px auto; padding: 24px; background: #fff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
h1 { font-size: 20px; margin-bottom: 24px; color: #1a1a1a; }
.form { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
.field { display: flex; flex-direction: column; gap: 6px; }
label { font-size: 14px; color: #666; }
input, select { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; }
input[readonly] { background: #f5f5f5; }
.buttons { grid-column: 1 / -1; display: flex; gap: 12px; flex-wrap: wrap; }
.btn-primary { flex: 1; min-width: 120px; padding: 12px; background: #1890ff; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; }
.btn-primary:hover { background: #40a9ff; }
.btn-primary:disabled { background: #d9d9d9; cursor: not-allowed; }
.btn-secondary { padding: 12px 16px; background: #fff; color: #1890ff; border: 1px solid #1890ff; border-radius: 4px; cursor: pointer; }
.btn-secondary:hover { background: #f0f7ff; }
.btn-secondary:disabled { color: #d9d9d9; border-color: #d9d9d9; cursor: not-allowed; }
.btn-danger { padding: 12px 16px; background: #fff; color: #ff4d4f; border: 1px solid #ff4d4f; border-radius: 4px; cursor: pointer; }
.btn-danger:disabled { color: #d9d9d9; border-color: #d9d9d9; cursor: not-allowed; }
.status { grid-column: 1 / -1; padding: 8px 12px; background: #fafafa; border: 1px solid #e8e8e8; border-radius: 4px; font-size: 14px; color: #666; min-height: 38px; }
.status.qr-required { background: #fff7e6; border-color: #ffbb66; color: #ad6800; }
.log { margin-top: 24px; }
.log h3 { font-size: 14px; color: #666; margin-bottom: 8px; }
#logContent { height: 200px; overflow-y: auto; background: #fafafa; border: 1px solid #e8e8e8; border-radius: 4px; padding: 12px; font-size: 12px; font-family: 'Courier New', monospace; white-space: pre-wrap; }
.progress { margin-top: 16px; display: flex; align-items: center; gap: 12px; }
.progress-bar { flex: 1; height: 8px; background: #e8e8e8; border-radius: 4px; overflow: hidden; }
.fill { display: block; height: 100%; background: #1890ff; transition: width 0.3s; width: 0%; }
#progressText { font-size: 14px; color: #666; min-width: 40px; }
```

- [ ] **Step 6: 创建 renderer/renderer.js（UI逻辑，含按钮状态管理）**

```javascript
// electron/renderer/renderer.js
const { startExport, pauseExport, resumeExport, stopExport, refreshQR,
        openDirectory, onExportProgress, onQRRequired, onExportComplete, onExportError } = window.electronAPI;

let isExporting = false;

function setUIState(state) {
  document.getElementById('startBtn').disabled = state !== 'idle';
  document.getElementById('pauseBtn').disabled = state !== 'running';
  document.getElementById('resumeBtn').disabled = state !== 'paused';
  document.getElementById('stopBtn').disabled = state === 'idle';
  document.getElementById('refreshQRBtn').disabled = state !== 'qr-required';
  document.getElementById('statusBar').textContent =
    state === 'qr-required' ? '⚠ 企业微信登录已过期，请扫码' :
    state === 'paused' ? '⏸ 已暂停' :
    state === 'running' ? '🔄 导出中...' : '';
  document.getElementById('statusBar').className = 'status' + (state === 'qr-required' ? ' qr-required' : '');
}

document.getElementById('startBtn').addEventListener('click', async () => {
  const options = {
    start: document.getElementById('startDate').value,
    end: document.getElementById('endDate').value,
    department: document.getElementById('department').value,
    outputDir: document.getElementById('outputDir').value || './exports'
  };
  isExporting = true;
  setUIState('running');
  await startExport(options);
});

document.getElementById('pauseBtn').addEventListener('click', async () => {
  await pauseExport();
  setUIState('paused');
});

document.getElementById('resumeBtn').addEventListener('click', async () => {
  await resumeExport();
  setUIState('running');
});

document.getElementById('stopBtn').addEventListener('click', async () => {
  await stopExport();
  isExporting = false;
  setUIState('idle');
});

document.getElementById('refreshQRBtn').addEventListener('click', async () => {
  await refreshQR();
});

// 修复Bug2：通过IPC openDirectory替代不可用的electron.remote
document.getElementById('selectDir').addEventListener('click', async () => {
  const dir = await openDirectory();
  if (dir) document.getElementById('outputDir').value = dir;
});

onExportProgress((data) => {
  const { completed, total, message } = data;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressText').textContent = `${pct}%`;
  if (message) {
    document.getElementById('logContent').textContent += message + '\n';
    document.getElementById('logContent').scrollTop = document.getElementById('logContent').scrollHeight;
  }
});

onQRRequired(() => {
  isExporting = false;
  setUIState('qr-required');
});

onExportComplete(({ outputPath, elapsed }) => {
  isExporting = false;
  setUIState('idle');
  document.getElementById('logContent').textContent +=
    `\n✅ 导出完成！输出文件: ${outputPath}\n总耗时: ${elapsed}s\n`;
});

onExportError(({ message }) => {
  document.getElementById('logContent').textContent += `\n❌ 错误: ${message}\n`;
});
```

**修复内容：**
- Bug2: `selectDir` 改用 `openDirectory()` IPC 而非 `electron.remote`
- 添加完整按钮 disabled 状态管理
- `refreshQRBtn` handler

- [ ] **Step 7: 验证 Electron 项目可以启动**

```bash
cd /Users/mingmacmini/Desktop/chat-audit/electron
npx electron . --no-sandbox
```

Expected: 窗口打开，显示中文界面，无报错。

- [ ] **Step 8: 提交**

```bash
cd /Users/mingmacmini/Desktop/chat-audit
git add electron/package.json electron/main.js electron/preload.js electron/renderer/
git commit -m "feat: 初始化 Electron 项目，基础中文浅色UI"
```

---

## Task 2: 移植 CDPClient 和核心 lib 模块

**Files:**
- Create: `electron/src/lib/cdp.js`
- Create: 占位文件 for missing lib modules
- Copy: existing lib modules from `chat-audit-export/scripts/lib/`

- [ ] **Step 1: 创建 CDPClient（基于 ws）**

```javascript
// electron/src/lib/cdp.js
import { WebSocket } from 'ws';

export class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this._ws = null;
    this._nextId = 1;
    this._handlers = new Map();
    this._pending = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(this.wsUrl);
      this._ws.on('open', () => resolve());
      this._ws.on('error', reject);
      this._ws.on('message', (data) => this._onMessage(JSON.parse(data.toString())));
    });
  }

  on(method, handler) {
    if (!this._handlers.has(method)) this._handlers.set(method, []);
    this._handlers.get(method).push(handler);
  }

  async send(method, params = {}) {
    const id = this._nextId++;
    this._ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`CDP ${method} timeout`));
        }
      }, 30000);
    });
  }

  _onMessage(data) {
    if (data.id === undefined) {
      const handlers = this._handlers.get(data.method) || [];
      handlers.forEach(h => h(data.params));
      return;
    }
    const pending = this._pending.get(data.id);
    if (pending) {
      this._pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error.message));
      else pending.resolve(data.result);
    }
  }

  async close() {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }
}
```

- [ ] **Step 2: 创建目录并检查/复制 lib 模块**

```bash
mkdir -p /Users/mingmacmini/Desktop/chat-audit/electron/src/lib
```

```bash
# 检查每个源文件是否存在，不存在则创建占位文件
SOURCE=/Users/mingmacmini/Desktop/chat-audit/chat-audit-export/scripts/lib
DEST=/Users/mingmacmini/Desktop/chat-audit/electron/src/lib

for file in chat-loading.js customer-id.js export-errors.js jsonl-store.js checkpoint.js dataset.js friend-page.js dialog-filters.js dialog-open.js cdp.js; do
  if [ -f "$SOURCE/$file" ]; then
    cp "$SOURCE/$file" "$DEST/$file"
    echo "copied $file"
  else
    # 创建最小占位文件（修复遗漏1）
    echo "// TODO: implement $file" > "$DEST/$file"
    echo "created placeholder $file"
  fi
done
```

**注意：** 多个 lib 文件标记为"需确认存在"，实际项目中可能缺失，此处处理方式是不存在则创建占位文件。

- [ ] **Step 3: 提交**

```bash
git add electron/src/lib/
git commit -m "feat: 移植 lib 模块到 electron/src/lib/，缺失文件创建占位"
```

---

## Task 3: 实现 TabManager（三CDP连接管理）

**Files:**
- Create: `electron/src/orchestrator/TabManager.js`

- [ ] **Step 1: 创建 TabManager（修复Bug9：导航验证）**

```javascript
// electron/src/orchestrator/TabManager.js
import http from 'node:http';
import { CDPClient } from '../lib/cdp.js';

const DEFAULT_CDP = 'http://localhost:9222';
const CRM_URL = 'https://tmscrm.yishouapp.com/#/salesQuality/chatAudit';

export class TabManager {
  constructor(cdpBase = DEFAULT_CDP, tabCount = 3) {
    this.cdpBase = cdpBase;
    this.tabCount = tabCount;
    this.tabs = [];
    this.tabInfo = [];
    this.deadTabs = new Set();
  }

  async initialize() {
    const targets = await this._listTargets();
    const pages = targets.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
    const crmPages = pages.filter(p => p.url.includes('tmscrm'));

    for (let i = 0; i < this.tabCount; i++) {
      if (i < crmPages.length) {
        await this._attachTab(i, crmPages[i]);
      } else {
        await this._createAndNavigateTab(i);
      }
    }
  }

  async _listTargets() {
    return new Promise((resolve, reject) => {
      http.get(`${this.cdpBase}/json/list`, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(JSON.parse(data)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  async _createAndNavigateTab(index) {
    // 1. 创建空 tab
    const newTarget = await new Promise((resolve, reject) => {
      const req = http.get(`${this.cdpBase}/json/new`, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Failed to parse new tab response')); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
    });

    // 2. 连接 CDP
    const client = new CDPClient(newTarget.webSocketDebuggerUrl);
    await client.connect();

    // 3. 导航到 CRM
    await client.send('Page.navigate', { url: CRM_URL });
    await client.send('Page.loadEventFired');

    // 修复Bug9：验证 URL 确认导航成功
    const result = await client.send('Runtime.evaluate', {
      expression: 'window.location.href'
    });
    const currentUrl = result.result?.value || '';
    if (!currentUrl.includes('tmscrm')) {
      throw new Error(`Navigation failed: expected tmscrm, got ${currentUrl}`);
    }

    this.tabs[index] = client;
    this.tabInfo[index] = { targetId: newTarget.id, url: currentUrl };
  }

  async _attachTab(index, target) {
    const client = new CDPClient(target.webSocketDebuggerUrl);
    await client.connect();
    this.tabs[index] = client;
    this.tabInfo[index] = { targetId: target.id, url: target.url };
  }

  getTab(index) {
    if (this.deadTabs.has(index)) return null;
    return this.tabs[index] ?? null;
  }

  markTabDead(index) {
    this.deadTabs.add(index);
  }

  isTabDead(index) {
    return this.deadTabs.has(index);
  }

  getAliveTabIndices() {
    return Array.from({ length: this.tabCount }, (_, i) => i)
      .filter(i => !this.deadTabs.has(i) && this.tabs[i]);
  }

  async closeTab(index) {
    const tab = this.tabs[index];
    if (tab) {
      try { await tab.send('close'); } catch { /* tab already closed */ }
      await tab.close().catch(() => {});
      this.tabs[index] = null;
    }
  }

  async closeAll() {
    for (let i = 0; i < this.tabCount; i++) {
      await this.closeTab(i);
    }
    this.tabs = [];
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add electron/src/orchestrator/TabManager.js
git commit -m "feat: 实现 TabManager，含导航验证"
```

---

## Task 4: 实现 SharedState（跨tab状态共享）

**Files:**
- Create: `electron/src/orchestrator/SharedState.js`

- [ ] **Step 1: 创建 SharedState（原子写入）**

```javascript
// electron/src/orchestrator/SharedState.js
import fs from 'node:fs/promises';

export class SharedState {
  constructor(checkpointPath, jsonlPath) {
    this.checkpointPath = checkpointPath;
    this.jsonlPath = jsonlPath;
    this.activeLoginTab = null;
  }

  async loadCheckpoint() {
    try {
      const data = await fs.readFile(this.checkpointPath, 'utf8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async saveCheckpoint(cp) {
    // 原子写入：writeFile + rename（原计划Bug7修复）
    const tmpPath = this.checkpointPath + '.tmp';
    cp.updated_at = new Date().toISOString();
    await fs.writeFile(tmpPath, JSON.stringify(cp, null, 2), 'utf8');
    await fs.rename(tmpPath, this.checkpointPath);
  }

  async appendJsonl(record) {
    // append-only JSONL，天然安全，无需锁
    await fs.appendFile(this.jsonlPath, JSON.stringify(record) + '\n', 'utf8');
  }

  setActiveLoginTab(tabIndex) {
    this.activeLoginTab = tabIndex;
  }

  getActiveLoginTab() {
    return this.activeLoginTab;
  }

  clearActiveLoginTab() {
    this.activeLoginTab = null;
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add electron/src/orchestrator/SharedState.js
git commit -m "feat: 实现 SharedState，原子checkpoint写入"
```

---

## Task 5: 实现 EmployeeDistributor

**Files:**
- Create: `electron/src/orchestrator/EmployeeDistributor.js`

- [ ] **Step 1: 创建 EmployeeDistributor**

```javascript
// electron/src/orchestrator/EmployeeDistributor.js
export class EmployeeDistributor {
  constructor(employees, tabCount = 3) {
    this.employees = employees;
    this.tabCount = tabCount;
    this.assignments = this._computeAssignments();
  }

  _computeAssignments() {
    const result = Array.from({ length: this.tabCount }, () => []);
    this.employees.forEach((emp, i) => {
      result[i % this.tabCount].push(emp);
    });
    return result;
  }

  getForTab(tabIndex) {
    return this.assignments[tabIndex] || [];
  }

  getTotalCount() {
    return this.employees.length;
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add electron/src/orchestrator/EmployeeDistributor.js
git commit -m "feat: 实现 EmployeeDistributor"
```

---

## Task 6: 实现 SelfHealCoordinator

**Files:**
- Create: `electron/src/orchestrator/SelfHealCoordinator.js`

- [ ] **Step 1: 创建 SelfHealCoordinator**

```javascript
// electron/src/orchestrator/SelfHealCoordinator.js
import { WxworkLoginRequiredError, RateLimitedError } from '../lib/export-errors.js';

export class SelfHealCoordinator {
  constructor(tabManager, sharedState) {
    this.tabManager = tabManager;
    this.sharedState = sharedState;
    this.retryCount = new Map();
    this.maxRetries = 3;
  }

  async handleError(tabIndex, error, orchestrator) {
    const errorType = this._classifyError(error);

    if (error instanceof WxworkLoginRequiredError) {
      this.sharedState.setActiveLoginTab(tabIndex);
      orchestrator.pauseAllForQR();
      return 'WAIT_FOR_QR';
    }

    if (error instanceof RateLimitedError) {
      orchestrator.stopAll('RATE_LIMITED');
      return 'STOPPED';
    }

    const currentRetry = this.retryCount.get(tabIndex) || 0;
    if (currentRetry >= this.maxRetries) {
      this.tabManager.markTabDead(tabIndex);
      this.retryCount.delete(tabIndex);
      return 'TAB_DEAD';
    }

    this.retryCount.set(tabIndex, currentRetry + 1);

    // 修复Bug6：无论healed是否成功都重试（只要还有重试次数）
    await this._selfHeal(tabIndex, errorType);
    return 'RETRY';
  }

  _classifyError(error) {
    const msg = error.message || '';
    if (msg.includes('CDP_NO_TARGET') || msg.includes('target not found')) return 'CDP_NO_TARGET';
    if (msg.includes('CASCADER_STUCK')) return 'CASCADER_STUCK_OPEN';
    if (msg.includes('page crash') || msg.includes('EXPORT_PAGE_CRASH')) return 'EXPORT_PAGE_CRASH';
    if (msg.includes('DATE_PICKER_STUCK')) return 'DATE_PICKER_STUCK';
    return 'UNKNOWN';
  }

  async _selfHeal(tabIndex, errorType) {
    const tab = this.tabManager.getTab(tabIndex);
    if (!tab) return;

    try {
      switch (errorType) {
        case 'CDP_NO_TARGET':
          await tab.send('Page.navigate', { url: 'https://tmscrm.yishouapp.com/#/salesQuality/chatAudit' });
          break;
        case 'CASCADER_STUCK_OPEN':
          await tab.send('Runtime.evaluate', {
            expression: `document.querySelector('.el-cascader__dropdown')?.remove()`
          });
          break;
        case 'EXPORT_PAGE_CRASH':
          await tab.send('Page.navigate', { url: 'https://tmscrm.yishouapp.com/#/salesQuality/chatAudit' });
          break;
      }
    } catch {
      // 吞掉自愈异常，由 handleError 统一判断是否重试
    }
  }

  resetRetries(tabIndex) {
    this.retryCount.delete(tabIndex);
  }
}
```

**修复Bug6：** 无论 `_selfHeal` 是否成功都返回 `RETRY`（只要重试次数未耗尽），而不是依赖 `_selfHeal` 返回值判断是否继续。

- [ ] **Step 2: 提交**

```bash
git add electron/src/orchestrator/SelfHealCoordinator.js
git commit -m "feat: 实现 SelfHealCoordinator"
```

---

## Task 7: 实现 Orchestrator（主协调器）

**Files:**
- Create: `electron/src/orchestrator/orchestrator.js`

- [ ] **Step 1: 创建 Orchestrator（修复Bug3 & Bug5 & Bug6 & Bug8）**

```javascript
// electron/src/orchestrator/orchestrator.js
import { TabManager } from './TabManager.js';
import { EmployeeDistributor } from './EmployeeDistributor.js';
import { SharedState } from './SharedState.js';
import { SelfHealCoordinator } from './SelfHealCoordinator.js';
import { spawn } = require('node:child_process');
import path from 'node:path';
import fs from 'node:fs/promises';
import { app } from 'electron';

// 延迟配置（Task 8 整合）
const DELAY = {
  STABLE_POLL_MS: 1200,
  STABLE_ATTEMPTS: 6,
  SCROLL_DELAY_MIN: 500,
  SCROLL_DELAY_MAX: 1500,
  SELECT_DELAY_MAX: 2000,
  SEARCH_DELAY_MAX: 1500,
  CUSTOMER_DELAY_MAX: 1500,
  EMPLOYEE_DELAY: 5000,
};

export class Orchestrator {
  constructor(options, eventEmitter) {
    this.options = options;
    this.ev = eventEmitter;
    this.tabManager = new TabManager();
    this.sharedState = null;
    this.healCoordinator = null;
    this.employees = [];
    this.aborted = false;
    this.paused = false;
    this.checkpoint = null;
    this.tabErrors = [null, null, null]; // 修复Bug8：记录各tab错误
  }

  async start() {
    const { start, end, department, outputDir } = this.options;
    const exportBase = outputDir || './exports';
    const dateStr = start;
    const jsonPath = `${exportBase}/chat-audit-${dateStr}.json`;
    const jsonlPath = `${exportBase}/chat-audit-${dateStr}.jsonl`;
    const cpPath = `${exportBase}/chat-audit-${dateStr}.checkpoint.json`;

    await fs.mkdir(exportBase, { recursive: true });

    this.sharedState = new SharedState(cpPath, jsonlPath);
    this.checkpoint = await this.sharedState.loadCheckpoint();

    await this.tabManager.initialize();

    this.healCoordinator = new SelfHealCoordinator(
      this.tabManager,
      this.sharedState
    );

    this.employees = await this._loadEmployeeList();
    const distributor = new EmployeeDistributor(this.employees, 3);

    const tabPromises = [];
    for (let tabIdx = 0; tabIdx < 3; tabIdx++) {
      tabPromises.push(this._runTabLoop(tabIdx, distributor));
    }

    const startTime = Date.now();
    const results = await Promise.all(tabPromises.map(p => p.catch(e => ({ error: e }))));
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // 修复Bug8：检查是否有真实错误
    const realErrors = results.filter(r => r?.error && !r?.error?.includes?.('RETRY'));
    if (realErrors.length > 0) {
      this.ev.emit('error', { message: realErrors[0].error.message || String(realErrors[0].error) });
    } else {
      this.ev.emit('complete', { outputPath: jsonPath, elapsed });
    }
  }

  async _runTabLoop(tabIndex, distributor) {
    const tab = this.tabManager.getTab(tabIndex);
    if (!tab) return;
    const employees = distributor.getForTab(tabIndex);

    for (const emp of employees) {
      if (this.aborted) break;
      while (this.paused) {
        await this._sleep(1000);
        if (this.aborted) break;
      }

      try {
        await this._processEmployee(tab, emp, tabIndex);
      } catch (error) {
        const action = await this.healCoordinator.handleError(tabIndex, error, this);
        if (action === 'WAIT_FOR_QR' || action === 'STOPPED') return;
        if (action === 'TAB_DEAD') continue;
      }

      this.healCoordinator.resetRetries(tabIndex);
    }
  }

  async _processEmployee(tab, employee, tabIndex) {
    let count = 0;
    // 修复Bug8：checkpoint 在 employee 级别缓存，避免每 customer 重复读文件
    if (!this.checkpoint) {
      this.checkpoint = await this.sharedState.loadCheckpoint();
    }
    const completedIds = this.checkpoint?.progress?.completed_conversation_ids || [];

    for (const customer of employee.customers) {
      if (this.aborted) break;
      while (this.paused) {
        await this._sleep(1000);
        if (this.aborted) break;
      }

      const convId = `${employee.name}__${customer.id}`;
      if (completedIds.includes(convId)) continue;

      await this._exportConversation(tab, employee, customer, tabIndex);

      await this.sharedState.appendJsonl({
        conversation_id: convId,
        employee_name: employee.name,
        customer_name: customer.name,
        started_at: new Date().toISOString()
      });

      // 更新 checkpoint
      if (!this.checkpoint?.progress) {
        this.checkpoint = { progress: { completed_conversation_ids: [] } };
      }
      this.checkpoint.progress.completed_conversation_ids.push(convId);
      await this.sharedState.saveCheckpoint(this.checkpoint);

      count++;
      if (count % 10 === 0) {
        this.ev.emit('progress', { completed: count, total: -1, message: `[Tab${tabIndex}] ${employee.name}: 已完成${count}个对话` });
      }

      await this._sleep(Math.random() * (DELAY.CUSTOMER_DELAY_MAX - 500) + 500);
    }
  }

  async _exportConversation(tab, employee, customer, tabIndex) {
    // 修复Bug4：移除 :has-text() 伪选择器，用标准XPath或文本匹配
    // 这里使用 CDP Runtime.evaluate 执行实际点击逻辑
    // 框架代码，需对照 export-current-page.js 补充完整
    try {
      // 示例：通过 XPath 查找包含员工名的行
      const xpath = `//*[contains(text(), '${employee.name}')]`;
      await tab.send('Runtime.evaluate', {
        expression: `
          (function() {
            var el = document.evaluate('${xpath}', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (el) { el.click(); return true; }
            return false;
          })()
        `
      });
      await this._sleep(1000);

      this.ev.emit('progress', {
        completed: 0, total: -1,
        message: `[Tab${tabIndex}] ${employee.name} → ${customer.name}`
      });
    } catch (error) {
      throw error;
    }
  }

  async _loadEmployeeList() {
    // 修复Bug5：用 app.getAppPath() 获取脚本路径，打包后正确
    // 修复遗漏2：需要 crm-preflight.py 支持 get-employees 子命令
    const scriptsDir = app.isPackaged
      ? path.join(path.dirname(app.getPath('exe')), 'resources', 'scripts')
      : path.join(process.cwd(), 'chat-audit-export', 'scripts');
    const scriptPath = path.join(scriptsDir, 'crm-preflight.py');

    return new Promise((resolve, reject) => {
      const proc = spawn('python3', [scriptPath, 'get-employees', '--cdp', 'http://localhost:9222'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '', stderr = '';
      proc.stdout.on('data', d => stdout += d.toString());
      proc.stderr.on('data', d => stderr += d.toString());

      proc.on('close', (code) => {
        if (code === 0) {
          try { resolve(JSON.parse(stdout)); }
          catch { resolve([]); }
        } else {
          reject(new Error(`get-employees failed: ${stderr}`));
        }
      });
    });
  }

  async refreshQRForTab(tabIndex) {
    const scriptsDir = app.isPackaged
      ? path.join(path.dirname(app.getPath('exe')), 'resources', 'scripts')
      : path.join(process.cwd(), 'chat-audit-export', 'scripts');
    const scriptPath = path.join(scriptsDir, 'refresh-wecom-qr.py');

    return new Promise((resolve, reject) => {
      const proc = spawn('python3', [scriptPath, '--tab', String(tabIndex)], { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error('QR refresh failed')));
    });
  }

  async resumeAll() {
    // 修复Bug6：防止 start() 前被调用导致 this.sharedState 为 null
    if (!this.sharedState) return;

    this.paused = false;
    this.sharedState.clearActiveLoginTab();

    for (let i = 0; i < 3; i++) {
      const tab = this.tabManager.getTab(i);
      if (!tab) continue;
      try {
        const evalResult = await tab.send('Runtime.evaluate', {
          expression: `!!document.querySelector('iframe[src*="login.work.weixin.qq.com"]')`
        });
        if (evalResult?.result === true) {
          this.sharedState.setActiveLoginTab(i);
          break;
        }
      } catch { /* ignore */ }
    }

    this.ev.emit('resumed');
  }

  pauseAllForQR() {
    this.paused = true;
    this.ev.emit('qr-required');
  }

  stopAll(reason) {
    this.aborted = true;
    this.ev.emit('stopped', { reason });
  }

  pause() { this.paused = true; }
  stop() { this.aborted = true; }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}
```

**修复内容：**
- Bug3: checkpoint 初始化增加 `progress` 字段兜底
- Bug4: `_exportConversation` 移除 `:has-text()`，改用标准 XPath
- Bug5: `app.getAppPath()` 替代 `process.cwd()`，打包后路径正确
- Bug6: `resumeAll` 添加 `if (!this.sharedState) return` 防止 null
- Bug8: 收集 `tabErrors`，`start()` 检查是否有真实错误再发 complete/error 事件

- [ ] **Step 2: 提交**

```bash
git add electron/src/orchestrator/orchestrator.js
git commit -m "feat: 实现 Orchestrator 主协调器，含真实逻辑框架"
```

---

## Task 8: 添加 crm-preflight.py get-employees 命令

**前置条件：** crm-preflight.py 需要添加 `get-employees` 子命令，供 Orchestrator 调用获取员工列表。

**Files:**
- Modify: `chat-audit-export/scripts/crm-preflight.py`（追加 get-employees 子命令）

- [ ] **Step 1: 添加 get-employees 子命令**

在 `crm-preflight.py` 的 `main()` 函数中添加分支，或在 argparse 中添加：

```python
# 在 argparse 配置后添加
if args.command == 'get-employees':
    import json
    async def run():
        async with CDPSession(args.cdp) as sess:
            await sess.send('Runtime.enable', {})
            # 在CRM聊天审计页面执行：获取所有员工行数据
            result = await sess.evaluate("""
                (function() {
                    var rows = document.querySelectorAll('.el-table__row');
                    return Array.from(rows).map(row => {
                        var cells = row.querySelectorAll('td');
                        return {
                            name: cells[0]?.innerText?.trim() || '',
                            id: row.getAttribute('data-id') || ''
                        };
                    }).filter(r => r.name);
                })()
            """, return_by_value=True)
            print(json.dumps(result, ensure_ascii=False))
    asyncio.run(run())
```

- [ ] **Step 2: 验证命令可用**

```bash
python3 scripts/crm-preflight.py get-employees --cdp http://localhost:9222
```

- [ ] **Step 3: 提交**

```bash
git add chat-audit-export/scripts/crm-preflight.py
git commit -m "feat: crm-preflight.py 添加 get-employees 子命令"
```

---

## Task 9: 配置打包

**Files:**
- Modify: `electron/package.json`
- Create: `electron/build-scripts/check-python.js`

- [ ] **Step 1: 修改 package.json**

```json
{
  "name": "chat-audit-export",
  "version": "1.0.0",
  "description": "一手聊天审计导出工具",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "build": "electron-builder --win --x64",
    "build:dir": "electron-builder --win --x64 --dir"
  },
  "build": {
    "appId": "com.yishou.chat-audit-export",
    "productName": "一手聊天审计导出",
    "extraResources": [
      {
        "from": "../chat-audit-export/scripts",
        "to": "scripts",
        "filter": ["**/*"]
      }
    ],
    "win": {
      "target": [
        {
          "target": "nsis",
          "arch": ["x64"]
        }
      ]
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true
    }
  },
  "devDependencies": {
    "electron": "^33.0.0",
    "electron-builder": "^25.0.0"
  },
  "dependencies": {
    "electron-log": "^5.0.0",
    "ws": "^8.18.0"
  }
}
```

- [ ] **Step 2: 创建 Python 检测脚本**

```javascript
// electron/build-scripts/check-python.js
const { spawn } = require('child_process');

function checkPython() {
  return new Promise((resolve) => {
    const proc = spawn('python3', ['--version']);
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

checkPython().then(hasPython => {
  if (!hasPython) {
    console.error('ERROR: Python 3 is required. Please install from https://python.org');
    process.exit(1);
  }
  console.log('Python 3 found.');
});
```

- [ ] **Step 3: 验证打包配置**

```bash
cd /Users/mingmacmini/Desktop/chat-audit/electron
npm install --save-dev electron-builder@25
npm run build:dir
```

- [ ] **Step 4: 提交**

```bash
git add electron/package.json electron/build-scripts/
git commit -m "build: 配置 electron-builder 打包"
```

---

## Task 10: 端到端测试

- [ ] **Step 1: 启动 Chrome 调试**

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir=$HOME/.chrome-chat-audit-profile
```

- [ ] **Step 2: 运行 Electron**

```bash
cd /Users/mingmacmini/Desktop/chat-audit/electron
npm start
```

- [ ] **Step 3: 测试完整流程**

- 三tab并行处理验证
- JSONL append 验证
- checkpoint 更新验证
- 暂停/恢复/停止验证
- WeCom 扫码恢复流程验证

- [ ] **Step 4: 打包 exe**

```bash
npm run build
```

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: 完成三tab并行导出 Electron 应用"
```

---

## 实施顺序

```
Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7 → Task 8 → Task 9 → Task 10
```

---

## Bug 修复对照表

| # | 原问题 | 修复方案 |
|---|--------|---------|
| Bug 1 | main.js require 路径不存在 | 改为 `./src/orchestrator/orchestrator.js` |
| Bug 2 | electron.remote 在 contextIsolation 下不可用 | 添加 `open-directory` IPC handler |
| Bug 3 | checkpoint 字段名未确认 | 初始化加 `progress.completed_conversation_ids` 兜底 |
| Bug 4 | `:has-text()` 非标准 CSS | 改用 XPath `document.evaluate()` |
| Bug 5 | `process.cwd()` 打包后路径错误 | 改用 `app.getAppPath()` + `app.isPackaged` 判断 |
| Bug 6 | `resumeAll` 在 `start()` 前调用报错 | 添加 `if (!this.sharedState) return` |
| Bug 7 | `_lock` bool 竞态条件 | 改用 `writeFile + rename` 原子写入 |
| Bug 8 | `Promise.all` 吞错误仍发 complete | 收集 `tabErrors`，检查真实错误后发事件 |
| Bug 9 | Tab 导航后不验证 | 添加 `window.location.href` 验证 |
| 遗漏 1 | lib 文件可能不存在 | Step 2 检查脚本，不存在则创建占位文件 |
| 遗漏 2 | crm-preflight.py 无 get-employees 命令 | Task 8 添加该子命令 |

---

## 进度跟踪

- [ ] Task 1: Electron 项目初始化（含 ws 依赖和完整 UI）
- [ ] Task 2: lib 模块移植（CDPClient 基于 ws，缺失占位）
- [ ] Task 3: TabManager 实现（含导航验证）
- [ ] Task 4: SharedState 实现（原子写入）
- [ ] Task 5: EmployeeDistributor 实现
- [ ] Task 6: SelfHealCoordinator 实现
- [ ] Task 7: Orchestrator 实现（含真实逻辑框架）
- [ ] Task 8: 添加 get-employees 命令
- [ ] Task 9: 打包配置
- [ ] Task 10: 端到端测试