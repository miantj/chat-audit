import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { getScriptsDir, getSkillRoot } from './paths.js';
import { PAUSE_FILE, STOP_FILE } from './signal-files.js';
import { DEFAULT_CDP } from './cdp-probe.js';

const LARGE_JSON_BYTES = 40 * 1024 * 1024;

export function countFailedConversations(outputPath) {
  if (!fs.existsSync(outputPath)) {
    return 0;
  }
  const stat = fs.statSync(outputPath);
  if (stat.size > LARGE_JSON_BYTES) {
    try {
      const n = execFileSync(
        'python3',
        [
          '-c',
          "import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get('progress',{}).get('failed_conversation_ids',[])))",
          path.resolve(outputPath)
        ],
        { encoding: 'utf8' }
      ).trim();
      return Number(n) || 0;
    } catch {
      return 0;
    }
  }
  const data = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  return data?.progress?.failed_conversation_ids?.length ?? 0;
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

/** 温和加速：仍启用 paced，但将各段等待约为 Skill 默认的一半（降低限流风险） */
export const MODERATE_PACED_ENV = {
  CUSTOMER_DELAY_MIN_MS: '400',
  CUSTOMER_DELAY_MAX_MS: '800',
  SEARCH_RESULT_DELAY_MIN_MS: '500',
  SEARCH_RESULT_DELAY_MAX_MS: '1000',
  SELECT_FRIEND_DELAY_MIN_MS: '800',
  SELECT_FRIEND_DELAY_MAX_MS: '1500',
  MESSAGE_SCROLL_DELAY_MIN_MS: '600',
  MESSAGE_SCROLL_DELAY_MAX_MS: '1200',
  BATCH_REST_MS: '2000',
  EMPLOYEE_DELAY_MIN_MS: '1000',
  EMPLOYEE_DELAY_MAX_MS: '2000'
};

/**
 * 与 SKILL.md Step 4 一致：export-with-self-heal.sh（CDP、gate-start、重试自愈、export-date-range）。
 */
export function runExportEngine(options, eventEmitter) {
  const start = options.start ?? options.startDate;
  const end = options.end ?? options.endDate;
  const outputDir = options.outputDir;

  const scriptsDir = getScriptsDir();
  const skillRoot = getSkillRoot();
  const shellScript = path.join(scriptsDir, 'export-with-self-heal.sh');
  const outputPath = path.join(outputDir, `chat-audit-${start}.json`);
  const expectDept = options.department || '大客私域顾问-总';

  const shellArgs = [
    shellScript,
    `--start=${start}`,
    `--end=${end}`,
    `--out=${outputPath}`,
    '--keywords=',
    '--skip-date-validation'
  ];

  const failedCount = countFailedConversations(outputPath);
  const resumeFailedOnly = failedCount > 0 && options.fullExport !== true;
  if (resumeFailedOnly) {
    shellArgs.push('--retry-failed');
    eventEmitter?.emit('progress', {
      current: 0,
      total: failedCount,
      reset: true,
      unit: 'conversation',
      phase: 'retry-failed',
      message: `续传 0/${failedCount}（仅重试失败会话）`
    });
  }

  // 行缓冲 bash，避免 "========== Export attempt" 等 echo 攒批才到 UI
  const proc = spawn('stdbuf', ['-oL', '-eL', 'bash', ...shellArgs], {
    cwd: skillRoot,
    env: {
      ...process.env,
      ...MODERATE_PACED_ENV,
      CHAT_AUDIT_CRM_CDP_BASE: DEFAULT_CDP,
      CHAT_AUDIT_PAUSE_FILE: PAUSE_FILE,
      CHAT_AUDIT_STOP_FILE: STOP_FILE,
      CHAT_AUDIT_EXPECT_DEPT: expectDept
    },
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
        if (evt.event === 'export-error' && evt.message) {
          eventEmitter.emit('progress', {
            current: 0,
            total: -1,
            message: `错误: ${evt.message}`
          });
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
      trimmed.startsWith('✅') ||
      trimmed.startsWith('⚠️') ||
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
    const text = chunk.toString();
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
        new Error(
          `无法启动导出脚本（需 bash 与 chat-audit-export/scripts/export-with-self-heal.sh）：${err.message}`
        )
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
        if (conversationCount === 0 && !shutdown) {
          reject(
            new Error(
              '导出已结束但未产生任何会话记录。请确认主表有员工行、日期/部门正确，且专用 Chrome 已登录 CRM。'
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
            exportError
              ? `导出失败: ${exportError}`
              : `导出失败 (exit ${code})\n${logText}`.slice(0, 1200)
          )
        );
      }
    });
  });

  return { proc, done, outputPath };
}
