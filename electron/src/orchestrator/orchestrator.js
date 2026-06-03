import {
  ensureAuditChrome,
  cdpUnavailableMessage,
  DEFAULT_CDP
} from '../lib/cdp-probe.js';
import { prepareCrmPage } from '../lib/preflight-runner.js';
import path from 'node:path';
import {
  runExportEngine,
  runTargetListByDayEngine,
  countFailedConversations,
  resolveExportJsonPath
} from '../lib/run-export-engine.js';
import fs from 'node:fs/promises';

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
    const { department, outputDir, targetsFile } = this.options;
    if (!start || !end) {
      throw new Error('请填写开始日期和结束日期');
    }
    if (!outputDir) {
      throw new Error('请先选择输出目录');
    }
    if (targetsFile && this.options.allCustomers) {
      throw new Error('目标名单导出不能与「导出所有外部好友」同时启用');
    }
    if (targetsFile && !path.isAbsolute(targetsFile)) {
      throw new Error('目标名单文件路径无效');
    }

    const cdpReady = await ensureAuditChrome(DEFAULT_CDP, { forceVerify: true });
    if (!cdpReady) {
      throw new Error(cdpUnavailableMessage(DEFAULT_CDP));
    }

    await fs.mkdir(outputDir, { recursive: true });

    const isMultiDayTargetList = Boolean(targetsFile) && start !== end;
    const isTargetList = Boolean(targetsFile);

    if (!isMultiDayTargetList) {
      this.ev.emit('progress', {
        current: 0,
        total: 0,
        message: '正在准备 CRM 页面…'
      });
      await prepareCrmPage({
        startDate: start,
        department,
        onProgress: (p) => {
          if (p?.message) {
            this.ev.emit('progress', {
              current: 0,
              total: 0,
              message: p.message
            });
          }
        }
      });
    } else {
      this.ev.emit('progress', {
        current: 0,
        total: 0,
        message: '目标名单跨日期导出：将按天设置 CRM 日期并逐日导出…'
      });
    }

    const allCustomers = Boolean(this.options.allCustomers);
    const outputPath = isMultiDayTargetList
      ? path.join(
          outputDir,
          `target-list-by-day-${start}_${end}`,
          'chat-audit-target-list-merged.json'
        )
      : resolveExportJsonPath(outputDir, start, {
          allCustomers,
          targetList: isTargetList
        });

    const failedCount = isMultiDayTargetList
      ? 0
      : countFailedConversations(outputPath);

    const modeLabel = isTargetList
      ? '目标名单'
      : allCustomers
        ? '全部外部好友'
        : '有效指标客户';

    this.ev.emit('progress', {
      current: 0,
      total: 0,
      message:
        failedCount > 0 && this.options.fullExport !== true
          ? `正在续传失败会话（${failedCount} 条）…`
          : isMultiDayTargetList
            ? `正在按天导出目标名单（${modeLabel}）…`
            : `正在导出（${modeLabel}；温和加速 paced：等待约为默认一半；若出现「请求过于频繁」请暂停后重试）…`
    });

    const startTime = Date.now();
    const engineOptions = {
      start,
      end,
      department,
      outputDir,
      allCustomers,
      targetsFile: targetsFile || '',
      targetsSheet: this.options.targetsSheet || '',
      targetListStrategy: this.options.targetListStrategy || 'visible'
    };

    const { proc, done } = isMultiDayTargetList
      ? runTargetListByDayEngine(engineOptions, this.ev)
      : runExportEngine(engineOptions, this.ev);
    this._exportProc = proc;

    try {
      const result = await done;
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      this.ev.emit('complete', {
        outputPath: result.outputPath,
        csvPath: result.csvPath ?? null,
        elapsed,
        total: result.conversationCount ?? 0,
        failed: result.failed ?? 0,
        shutdown: result.shutdown ?? false,
        employeeProgressCurrent: result.employeeProgressCurrent ?? 0,
        employeeProgressTotal: result.employeeProgressTotal ?? 0,
        progressUnit: result.progressUnit ?? 'employee',
        outDir: result.outDir ?? null
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

  async resumeAll() {
    /* 继续由删除 pause 文件驱动；export-resumed 事件在脚本退出等待后发出 */
  }
}
