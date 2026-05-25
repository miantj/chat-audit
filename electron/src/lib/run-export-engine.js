import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { getScriptsDir, getSkillRoot } from './paths.js';
import { PAUSE_FILE, STOP_FILE } from './signal-files.js';
import { DEFAULT_CDP } from './cdp-probe.js';
import {
  FAILED_RETRY_MAX,
  readFailedRetryPassesUsed
} from './failed-retry-meta.js';
import { getBundledNodeBin, runtimeExportEnv } from './runtime-paths.js';

const exportJsonStats = await import(
  pathToFileURL(
    path.join(getScriptsDir(), 'lib', 'export-json-stats.js')
  ).href
);

const { countFailedConversations: countFailedFromLib, LARGE_JSON_BYTES } =
  exportJsonStats;

export function countFailedConversations(outputPath) {
  return countFailedFromLib(outputPath, getBundledNodeBin());
}

function countExportedConversations(outputPath) {
  const jsonlPath = outputPath.replace(/\.json$/i, '.jsonl');
  if (fs.existsSync(jsonlPath)) {
    const text = fs.readFileSync(jsonlPath, 'utf8');
    const n = text.split('\n').filter((line) => line.trim()).length;
    if (n > 0) {
      return n;
    }
  }
  if (!fs.existsSync(outputPath)) {
    return 0;
  }
  const stat = fs.statSync(outputPath);
  if (stat.size > LARGE_JSON_BYTES) {
    throw new Error(
      '导出 JSON 过大且 JSONL 为空，无法轻量统计会话数。请确认同目录 .jsonl 是否正常写入。'
    );
  }
  const data = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  return data?.conversations?.length ?? 0;
}

function parseExportErrorFromLogs(logText) {
  const lines = logText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{') || !line.includes('"export-error"')) {
      continue;
    }
    try {
      const ev = JSON.parse(line);
      if (ev.event === 'export-error' && ev.message) {
        return String(ev.message);
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function parseExportSummaryFromLogs(logText) {
  const lines = logText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) {
      continue;
    }
    try {
      const ev = JSON.parse(line);
      if (ev.event !== 'export-complete' && ev.event !== 'export-shutdown') {
        continue;
      }
      return {
        conversationCount: Number(ev.conversations ?? 0),
        failed: Number(ev.failed ?? 0),
        shutdown: ev.event === 'export-shutdown' || Boolean(ev.shutdown),
        employeeProgressCurrent: Number(ev.employeeProgressCurrent ?? 0),
        employeeProgressTotal: Number(ev.employeeProgressTotal ?? 0),
        progressUnit: ev.progressUnit === 'conversation' ? 'conversation' : 'employee'
      };
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 温和加速：仍启用 paced；搜索/选中/滚动由 export-current-page DOM 就绪等待 */
export const MODERATE_PACED_ENV = {
  CUSTOMER_DELAY_MIN_MS: '400',
  CUSTOMER_DELAY_MAX_MS: '800',
  BATCH_REST_MS: '2000',
  EMPLOYEE_DELAY_MIN_MS: '1000',
  EMPLOYEE_DELAY_MAX_MS: '2000',
  DOM_POLL_INTERVAL_MS: '150',
  DOM_SEARCH_READY_TIMEOUT_MS: '4000',
  DOM_SELECT_READY_TIMEOUT_MS: '5000',
  DOM_MESSAGE_CHANGE_TIMEOUT_MS: '1200'
};

/**
 * 与 SKILL.md Step 4 一致：export-with-self-heal（CDP、gate-start、重试自愈、export-date-range）。
 * 使用 scripts/export-with-self-heal.mjs（纯 Node）。
 */
export function runExportEngine(options, eventEmitter) {
  const start = options.start ?? options.startDate;
  const end = options.end ?? options.endDate;
  const outputDir = options.outputDir;

  const scriptsDir = getScriptsDir();
  const skillRoot = getSkillRoot();
  const nodeRunner = path.join(scriptsDir, 'export-with-self-heal.mjs');
  const nodeBin = getBundledNodeBin();
  const outputPath = path.resolve(outputDir, `chat-audit-${start}.json`);
  const expectDept = options.department || '大客私域顾问-总';

  const runnerArgs = [
    nodeRunner,
    `--start=${start}`,
    `--end=${end}`,
    `--out=${outputPath}`,
    '--keywords=',
    '--skip-date-validation'
  ];

  const failedCount = countFailedConversations(outputPath);
  const retryPassesUsed = readFailedRetryPassesUsed(outputPath);
  const retryBudgetLeft =
    FAILED_RETRY_MAX - Math.min(retryPassesUsed, FAILED_RETRY_MAX);
  const resumeFailedOnly =
    failedCount > 0 &&
    options.fullExport !== true &&
    retryBudgetLeft > 0;
  if (failedCount > 0 && options.fullExport !== true && retryBudgetLeft <= 0) {
    eventEmitter?.emit('progress', {
      current: 0,
      total: failedCount,
      message:
        `仍有 ${failedCount} 条失败会话，已自动补跑 ${FAILED_RETRY_MAX} 次，本次改为全量导出（不再续传失败列表）。`
    });
  }
  if (resumeFailedOnly) {
    runnerArgs.push('--retry-failed');
    eventEmitter?.emit('progress', {
      current: 0,
      total: failedCount,
      reset: true,
      unit: 'conversation',
      phase: 'retry-failed',
      message: `续传 0/${failedCount}（失败列表补跑剩余 ${retryBudgetLeft}/${FAILED_RETRY_MAX} 次）`
    });
  }

  const clearMetricCheckpoint =
    options.fullExport === true ||
    (failedCount > 0 &&
      options.fullExport !== true &&
      retryBudgetLeft <= 0 &&
      !resumeFailedOnly);

  const exportEnv = {
    ...process.env,
    ...MODERATE_PACED_ENV,
    ...runtimeExportEnv(),
    CHAT_AUDIT_CRM_CDP_BASE: DEFAULT_CDP,
    CHAT_AUDIT_PAUSE_FILE: PAUSE_FILE,
    CHAT_AUDIT_STOP_FILE: STOP_FILE,
    CHAT_AUDIT_EXPECT_DEPT: expectDept,
    CHAT_AUDIT_START_GATE_DONE: '1',
    CHAT_AUDIT_CALLER_CWD: path.resolve(outputDir),
    CHAT_AUDIT_EXPORT_DIR: path.resolve(outputDir),
    OUTPUT_PATH: outputPath,
    ...(clearMetricCheckpoint
      ? { CHAT_AUDIT_CLEAR_METRIC_CHECKPOINT: '1' }
      : {})
  };
  const proc = spawn(nodeBin, runnerArgs, {
    cwd: skillRoot,
    env: exportEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  let lineBuf = '';

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('{')) {
      try {
        const evt = JSON.parse(trimmed);
        if (evt.event === 'export-paused') {
          eventEmitter.emit('paused', {
            message: evt.message || '导出已暂停'
          });
          return;
        }
        if (evt.event === 'export-resumed') {
          eventEmitter.emit('resumed', {
            message: evt.message || '导出已继续'
          });
          return;
        }
        if (evt.event === 'export-progress') {
          if (typeof evt.message === 'string' && evt.message.startsWith('{')) {
            try {
              const inner = JSON.parse(evt.message);
              if (inner.event === 'export-paused') {
                eventEmitter.emit('paused', {
                  message: inner.message || '导出已暂停'
                });
                return;
              }
              if (inner.event === 'export-resumed') {
                eventEmitter.emit('resumed', {
                  message: inner.message || '导出已继续'
                });
                return;
              }
            } catch {
              /* 非嵌套控制事件 */
            }
          }
          const hasStats =
            typeof evt.current === 'number' ||
            (typeof evt.total === 'number' && evt.total > 0);
          eventEmitter.emit('progress', {
            current: evt.current ?? 0,
            total: evt.total ?? -1,
            message: evt.message,
            reset: Boolean(evt.reset),
            unit: evt.unit === 'conversation' ? 'conversation' : 'employee',
            phase:
              evt.phase === 'retry-failed'
                ? 'retry-failed'
                : evt.phase === 'resume'
                  ? 'resume'
                  : null,
            debug: evt.debug ?? null
          });
          if (hasStats || evt.message) {
            return;
          }
        }
        if (evt.event === 'export-error') {
          return;
        }
        if (evt.event === 'export-csv-complete' && evt.csvPath) {
          csvPath = evt.csvPath;
          eventEmitter.emit('progress', {
            current: 0,
            total: -1,
            message: `CSV 已生成: ${evt.csvPath}`
          });
        }
      } catch {
        /* 非 JSON */
      }
    }

    if (
      trimmed.includes('[retry-failed]') ||
      trimmed.includes('Retry failed conversations') ||
      trimmed.includes('retrying failed list') ||
      trimmed.includes('续传失败会话') ||
      trimmed.includes('补跑失败会话') ||
      /续传 \d+\/\d+/.test(trimmed) ||
      /补跑 \d+\/\d+/.test(trimmed)
    ) {
      const retryTotalMatch = trimmed.match(
        /Targeting (\d+) previously failed|续传失败会话 total=(\d+)|补跑失败会话 total=(\d+)|Retry failed conversations \((\d+) failed|(\d+) conversation\(s\) still failed|(\d+) conversation\(s\) failed/
      );
      const retryTotal = retryTotalMatch
        ? Number(
            retryTotalMatch[1] ||
              retryTotalMatch[2] ||
              retryTotalMatch[3] ||
              retryTotalMatch[4] ||
              retryTotalMatch[5] ||
              retryTotalMatch[6] ||
              0
          )
        : 0;
      eventEmitter.emit('progress', {
        current: 0,
        total: retryTotal > 0 ? retryTotal : -1,
        message: trimmed,
        reset: true,
        unit: 'conversation',
        phase: 'retry-failed'
      });
      return;
    }

    if (
      trimmed.startsWith('[') ||
      trimmed.startsWith('[OK]') ||
      trimmed.startsWith('[warn]') ||
      trimmed.startsWith('===') ||
      trimmed.startsWith('Export ') ||
      trimmed.startsWith('[self-heal]') ||
      trimmed.startsWith('Diagnosed ')
    ) {
      eventEmitter.emit('progress', {
        current: 0,
        total: -1,
        message: trimmed
      });
    }
  };

  const feedChunk = (chunk, isStdout) => {
    const text = chunk.toString('utf8');
    if (isStdout) stdoutBuf += text;
    else stderrBuf += text;
    lineBuf += text;
    const parts = lineBuf.split('\n');
    lineBuf = parts.pop() || '';
    parts.forEach(handleLine);
  };

  proc.stdout.on('data', (chunk) => feedChunk(chunk, true));
  proc.stderr.on('data', (chunk) => feedChunk(chunk, false));

  let csvPath = null;

  const done = new Promise((resolve, reject) => {
    proc.on('error', (err) => {
      reject(
        new Error(`无法启动导出脚本（export-with-self-heal.mjs）：${err.message}`)
      );
    });
    proc.on('close', (code) => {
      if (lineBuf.trim()) handleLine(lineBuf.trim());

      if (code === 0) {
        const summary = parseExportSummaryFromLogs(stdoutBuf);
        let conversationCount = summary?.conversationCount ?? 0;
        let failed = summary?.failed ?? 0;
        const shutdown = summary?.shutdown ?? false;
        try {
          if (!conversationCount) {
            conversationCount = countExportedConversations(outputPath);
          }
        } catch (err) {
          reject(err);
          return;
        }
        const employeeTotal = summary?.employeeProgressTotal ?? 0;
        if (conversationCount === 0 && !shutdown) {
          const hint =
            employeeTotal <= 0
              ? '主表未识别到员工行（常见原因：旧 checkpoint 已清除，请重试；或日期/部门与页面不一致）。'
              : '未导出任何会话。';
          reject(
            new Error(
              `导出已结束但未产生任何会话记录。${hint}请确认专用 Chrome 已登录 CRM，日期/部门与页面一致。`
            )
          );
          return;
        }
        resolve({
          outputPath,
          csvPath,
          code,
          conversationCount,
          failed,
          shutdown,
          employeeProgressCurrent: summary?.employeeProgressCurrent ?? 0,
          employeeProgressTotal: summary?.employeeProgressTotal ?? 0,
          progressUnit: summary?.progressUnit ?? 'employee'
        });
      } else {
        const logText = (stderrBuf || stdoutBuf).trim();
        const exportError = parseExportErrorFromLogs(logText);
        reject(
          new Error(
            exportError ||
              `导出失败 (exit ${code})\n${logText}`.slice(0, 1200)
          )
        );
      }
    });
  });

  return { proc, done, outputPath };
}
