import {
  ensureAuditChrome,
  cdpUnavailableMessage,
  DEFAULT_CDP
} from '../lib/cdp-probe.js';
import { prepareCrmPage } from '../lib/preflight-runner.js';
import { runExportEngine } from '../lib/run-export-engine.js';
import { getScriptsDir } from '../lib/paths.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';

const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';

export class Orchestrator {
  constructor(options, eventEmitter) {
    this.options = options;
    this.ev = eventEmitter;
    this._exportProc = null;
    this.aborted = false;
  }

  async start() {
    const start = this.options.start ?? this.options.startDate;
    const end = this.options.end ?? this.options.endDate;
    const { department, outputDir } = this.options;
    if (!start || !end) {
      throw new Error('请填写开始日期和结束日期');
    }
    if (!outputDir) {
      throw new Error('请先选择输出目录');
    }

    const cdpReady = await ensureAuditChrome(DEFAULT_CDP);
    if (!cdpReady) {
      throw new Error(cdpUnavailableMessage(DEFAULT_CDP));
    }

    this.ev.emit('progress', {
      current: 0,
      total: 0,
      message: '正在准备 CRM 页面（导航、日期、部门）…'
    });
    await prepareCrmPage({ startDate: start, department });

    await fs.mkdir(outputDir, { recursive: true });

    this.ev.emit('progress', {
      current: 0,
      total: 0,
      message: '正在导出（打开员工行 → 读取指标客户 → 拉取会话）…'
    });

    const startTime = Date.now();
    const { proc, done, outputPath } = runExportEngine(
      { start, end, department, outputDir },
      this.ev
    );
    this._exportProc = proc;

    try {
      const result = await done;
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      this.ev.emit('complete', {
        outputPath: result.outputPath,
        elapsed,
        total: result.conversationCount ?? 0
      });
    } catch (err) {
      throw err;
    } finally {
      this._exportProc = null;
    }
  }

  stop() {
    this.aborted = true;
    if (this._exportProc && !this._exportProc.killed) {
      this._exportProc.kill('SIGTERM');
    }
  }

  pause() {
    /* 由 main 进程写 pause 文件，export-date-range 轮询 */
  }

  async refreshQRForTab(tabIndex) {
    const scriptsDir = getScriptsDir();
    const scriptPath = path.join(scriptsDir, 'refresh-wecom-qr.py');
    return new Promise((resolve, reject) => {
      const proc = spawn(
        PYTHON_CMD,
        [scriptPath, '--tab', String(tabIndex)],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      proc.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error('QR refresh failed'))
      );
    });
  }

  async resumeAll() {
    this.ev.emit('resumed');
  }
}
