#!/usr/bin/env node
/**
 * 目标名单按天导出 + 本地合并（纯 Node，Electron / CLI 共用）。
 * 每天单独设置 CRM 主表日期，扫描当日可见外部好友与目标名单交集后导出。
 */
if (process.platform === 'win32') {
  process.env.NODE_SKIP_PLATFORM_CHECK = '1';
}
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = __dirname;
const SCRIPT_ROOT = path.dirname(SCRIPT_DIR);
const NODE_BIN = process.env.CHAT_AUDIT_NODE_BIN || 'node';
const PYTHON_BIN =
  process.env.CHAT_AUDIT_PYTHON_BIN ||
  (process.platform === 'win32' ? 'python' : 'python3');

function parseCliArgs(argv) {
  const opts = {
    start: '',
    end: '',
    targetsFile: '',
    targetsSheet: '',
    outDir: '',
    basename: 'chat-audit-target-list',
    max: '',
    maxRows: '',
    targetListStrategy: 'visible',
    expectDept: '大客私域顾问-总',
    pacedFlag: '--fast-paced',
    skipDateValidation: true,
    mergeOnly: false,
    selfHealWrapper: false,
    forceAllDays: false,
    forceDays: []
  };
  for (const arg of argv) {
    if (arg.startsWith('--start=')) opts.start = arg.slice(8);
    else if (arg.startsWith('--end=')) opts.end = arg.slice(6);
    else if (arg.startsWith('--targets-file=')) opts.targetsFile = arg.slice(15);
    else if (arg.startsWith('--targets-sheet=')) opts.targetsSheet = arg.slice(16);
    else if (arg.startsWith('--out-dir=')) opts.outDir = arg.slice(10);
    else if (arg.startsWith('--basename=')) opts.basename = arg.slice(11);
    else if (arg.startsWith('--max=')) opts.max = arg.slice(6);
    else if (arg.startsWith('--max-rows=')) opts.maxRows = arg.slice(11);
    else if (arg.startsWith('--target-list-strategy=')) {
      opts.targetListStrategy = arg.slice(23);
    }
    else if (arg.startsWith('--expect-dept=')) opts.expectDept = arg.slice(14);
    else if (arg.startsWith('--force-day=')) opts.forceDays.push(arg.slice(12));
    else if (arg === '--force-all-days') opts.forceAllDays = true;
    else if (arg === '--paced') opts.pacedFlag = '--paced';
    else if (arg === '--fast-paced') opts.pacedFlag = '--fast-paced';
    else if (arg === '--no-paced') opts.pacedFlag = '--no-paced';
    else if (arg === '--self-heal-wrapper') opts.selfHealWrapper = true;
    else if (arg === '--no-skip-date-validation') opts.skipDateValidation = false;
    else if (arg === '--merge-only') opts.mergeOnly = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node export-target-list-by-day.mjs --start=YYYY-MM-DD --end=YYYY-MM-DD --targets-file=PATH [options]

Options:
  --targets-sheet=NAME       Worksheet for .xlsx
  --out-dir=DIR              Daily output directory
  --basename=NAME            File prefix (default: chat-audit-target-list)
  --max=N                    Max conversations per daily export
  --max-rows=N               Max employee rows per daily export
  --target-list-strategy=visible|search
                             Default: visible
  --expect-dept=NAME         Department gate
  --force-all-days           Re-export every day even if a prior run completed
  --force-day=YYYY-MM-DD     Re-export one day (repeatable)
  --paced|--fast-paced|--no-paced
  --self-heal-wrapper        Use export-with-self-heal.mjs
  --merge-only               Only merge existing daily files
  --help                     Show this help`);
      process.exit(0);
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

function runPreflight(args) {
  const cdpBase = (process.env.CHAT_AUDIT_CRM_CDP_BASE || 'http://localhost:9222').replace(
    /\/$/,
    ''
  );
  const bin = process.env.CHAT_AUDIT_PREFLIGHT_BIN;
  const cmd = bin || PYTHON_BIN;
  const fullArgs = bin
    ? [...args, '--cdp', cdpBase]
    : [path.join(SCRIPT_DIR, 'crm-preflight.py'), ...args, '--cdp', cdpBase];
  execFileSync(cmd, fullArgs, {
    cwd: SCRIPT_DIR,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1'
    },
    stdio: 'inherit'
  });
}

function enumerateDates(start, end) {
  const dates = [];
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const cur = new Date(sy, sm - 1, sd);
  const last = new Date(ey, em - 1, ed);
  if (last < cur) {
    throw new Error('end date must be on or after start date');
  }
  while (cur <= last) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, '0');
    const d = String(cur.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function dailyExportDonePath(dailyOut) {
  return dailyOut.replace(/\.json$/i, '.export-done');
}

function getTargetsFileFingerprint(targetsFile) {
  if (!targetsFile) {
    return null;
  }
  const resolvedPath = path.resolve(targetsFile);
  if (!fs.existsSync(resolvedPath)) {
    return {
      path: resolvedPath,
      exists: false
    };
  }
  const stat = fs.statSync(resolvedPath);
  return {
    path: fs.realpathSync(resolvedPath),
    basename: path.basename(resolvedPath),
    size: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs)
  };
}

function buildDailyExportFingerprint(opts, day) {
  return {
    version: 1,
    day,
    targetsFile: getTargetsFileFingerprint(opts.targetsFile),
    targetsSheet: opts.targetsSheet || '',
    targetListStrategy: opts.targetListStrategy || 'visible',
    max: opts.max || '',
    maxRows: opts.maxRows || '',
    pacedFlag: opts.pacedFlag || '',
    skipDateValidation: Boolean(opts.skipDateValidation),
    expectDept: opts.expectDept || '',
    selfHealWrapper: Boolean(opts.selfHealWrapper)
  };
}

function readDailyExportDoneMarker(marker) {
  try {
    return JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch {
    return null;
  }
}

function dailyExportMarkerMatches(marker, day, opts) {
  const markerData = readDailyExportDoneMarker(marker);
  if (!markerData?.fingerprint) {
    return false;
  }
  const expected = buildDailyExportFingerprint(opts, day);
  return JSON.stringify(markerData.fingerprint) === JSON.stringify(expected);
}

function isDailyExportComplete(dailyOut, day, opts) {
  const marker = dailyExportDonePath(dailyOut);
  return (
    fs.existsSync(marker) &&
    fs.existsSync(dailyOut) &&
    fs.statSync(dailyOut).size > 0 &&
    dailyExportMarkerMatches(marker, day, opts)
  );
}

function shouldSkipDailyExport(dailyOut, day, opts) {
  if (opts.forceAllDays) {
    return null;
  }
  if (opts.forceDays.includes(day)) {
    return null;
  }
  if (isDailyExportComplete(dailyOut, day, opts)) {
    return 'already complete';
  }
  return null;
}

function hasStaleDailyExportMarker(dailyOut, day, opts) {
  const marker = dailyExportDonePath(dailyOut);
  return (
    fs.existsSync(marker) &&
    fs.existsSync(dailyOut) &&
    fs.statSync(dailyOut).size > 0 &&
    !dailyExportMarkerMatches(marker, day, opts)
  );
}

function removeDailyExportDoneMarker(dailyOut) {
  const marker = dailyExportDonePath(dailyOut);
  if (fs.existsSync(marker)) {
    fs.unlinkSync(marker);
  }
}

function writeDailyExportDoneMarker(dailyOut, day, opts) {
  const marker = dailyExportDonePath(dailyOut);
  const markerData = {
    completedAt: new Date().toISOString(),
    fingerprint: buildDailyExportFingerprint(opts, day)
  };
  fs.writeFileSync(marker, JSON.stringify(markerData, null, 2), 'utf8');
}

function parseDailyExportComplete(stdout) {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    try {
      const ev = JSON.parse(trimmed);
      if (ev.event === 'export-complete' || ev.event === 'export-shutdown') {
        const shutdown = ev.event === 'export-shutdown' || Boolean(ev.shutdown);
        return {
          complete: ev.event === 'export-complete' && !shutdown,
          failed: Number(ev.failed) || 0,
          shutdown
        };
      }
    } catch {
      /* ignore malformed JSON lines */
    }
  }
  return { complete: false, failed: 0, shutdown: false };
}

function spawnAndWaitCollect(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: SCRIPT_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    const forward = (chunk, isErr) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (isErr) process.stderr.write(text);
      else process.stdout.write(text);
    };
    proc.stdout.on('data', (chunk) => forward(chunk, false));
    proc.stderr.on('data', (chunk) => forward(chunk, true));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

async function runDailyExport(opts, day, dailyOut) {
  try {
    runPreflight(['close-dialog']);
  } catch {
    /* ignore */
  }
  runPreflight(['set-department', '--group', opts.expectDept]);
  runPreflight(['set-dates', '--date', day]);
  runPreflight([
    'gate-start-export',
    '--expect-dept',
    opts.expectDept,
    '--expect-date',
    day
  ]);

  const exportArgs = [
    `--start=${day}`,
    `--end=${day}`,
    `--targets-file=${opts.targetsFile}`,
    `--target-list-strategy=${opts.targetListStrategy}`,
    `--out=${dailyOut}`
  ];
  if (opts.targetsSheet) {
    exportArgs.push(`--targets-sheet=${opts.targetsSheet}`);
  }
  if (opts.max) exportArgs.push(`--max=${opts.max}`);
  if (opts.maxRows) exportArgs.push(`--max-rows=${opts.maxRows}`);
  if (opts.skipDateValidation) exportArgs.push('--skip-date-validation');
  if (opts.pacedFlag === '--paced') exportArgs.push('--paced');
  else if (opts.pacedFlag === '--no-paced') exportArgs.push('--no-paced');
  else exportArgs.push('--fast-paced');

  let stdout;
  if (opts.selfHealWrapper) {
    stdout = await spawnAndWaitCollect(NODE_BIN, [
      path.join(SCRIPT_DIR, 'export-with-self-heal.mjs'),
      ...exportArgs
    ]);
  } else {
    stdout = await spawnAndWaitCollect(NODE_BIN, [
      path.join(SCRIPT_DIR, 'export-date-range.js'),
      ...exportArgs
    ]);
  }
  return parseDailyExportComplete(stdout);
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const callerCwd = process.env.CHAT_AUDIT_CALLER_CWD || process.cwd();

  if (!opts.start || !opts.end) {
    console.error('Error: --start and --end are required.');
    process.exit(1);
  }
  if (!opts.targetsFile && !opts.mergeOnly) {
    console.error('Error: --targets-file is required unless --merge-only is used.');
    process.exit(1);
  }

  if (opts.targetsFile && !path.isAbsolute(opts.targetsFile)) {
    opts.targetsFile = path.resolve(callerCwd, opts.targetsFile);
  }

  let outDir = opts.outDir;
  if (!outDir) {
    outDir = path.join(callerCwd, 'exports', `target-list-by-day-${opts.start}_${opts.end}`);
  } else if (!path.isAbsolute(outDir)) {
    outDir = path.resolve(callerCwd, outDir);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const dates = enumerateDates(opts.start, opts.end);
  let skippedDays = 0;
  let batchInterrupted = false;
  let interruptedDay = '';

  if (!opts.mergeOnly) {
    for (let dayIndex = 0; dayIndex < dates.length; dayIndex++) {
      const day = dates[dayIndex];
      const dailyOut = path.join(outDir, `${opts.basename}-${day}.json`);
      const skipReason = shouldSkipDailyExport(dailyOut, day, opts);
      const staleMarker = !skipReason && hasStaleDailyExportMarker(dailyOut, day, opts);

      console.log('');
      console.log(
        JSON.stringify({
          event: 'export-progress',
          current: dayIndex + 1,
          total: dates.length,
          unit: 'day',
          reset: dayIndex > 0,
          phase: skipReason ? 'resume' : null,
          message: skipReason
            ? `续传跳过 ${dayIndex + 1}/${dates.length}：${day}（已完成）`
            : `按天导出 ${dayIndex + 1}/${dates.length}：${day}`
        })
      );

      if (skipReason) {
        console.log(`========== Skip daily target-list export: ${day} (${skipReason}) ==========`);
        console.log(`Output: ${dailyOut}`);
        skippedDays += 1;
        continue;
      }

      console.log(`========== Daily target-list export: ${day} ==========`);
      console.log(`Output: ${dailyOut}`);
      if (staleMarker) {
        console.warn(
          `Warning: completion marker for ${day} does not match current targets/options; re-exporting this day.`
        );
      }
      // 开始导出前清除旧标记，避免 force 重导中断后仍被续传跳过
      removeDailyExportDoneMarker(dailyOut);
      const summary = await runDailyExport(opts, day, dailyOut);
      if (summary.complete && summary.failed === 0) {
        writeDailyExportDoneMarker(dailyOut, day, opts);
      } else if (summary.complete && summary.failed > 0) {
        removeDailyExportDoneMarker(dailyOut);
        console.warn(
          `Warning: daily export for ${day} finished with ${summary.failed} failed conversation(s); will retry on next run.`
        );
      } else {
        removeDailyExportDoneMarker(dailyOut);
        console.warn(
          `Warning: daily export for ${day} ended before completion (shutdown/interrupted); will resume on next run.`
        );
        batchInterrupted = true;
        interruptedDay = day;
        break;
      }
    }
  }

  if (batchInterrupted) {
    console.log('');
    console.log(
      JSON.stringify({
        event: 'export-shutdown',
        shutdown: true,
        interruptedDay,
        message: '按天导出已中断，未生成合并文件；下次运行将从断点续传。'
      })
    );
    process.exit(0);
  }

  const mergeInputs = [];
  let mergeSkippedIncomplete = 0;
  for (const day of dates) {
    const dailyJson = path.join(outDir, `${opts.basename}-${day}.json`);
    if (!fs.existsSync(dailyJson)) {
      console.warn(`Warning: missing daily export, not merging: ${dailyJson}`);
      mergeSkippedIncomplete += 1;
      continue;
    }
    const size = fs.statSync(dailyJson).size;
    if (size === 0) {
      console.warn(`Warning: empty daily export (0 bytes), not merging: ${dailyJson}`);
      mergeSkippedIncomplete += 1;
      continue;
    }
    if (!opts.mergeOnly && !isDailyExportComplete(dailyJson, day, opts)) {
      console.warn(
        `Warning: daily export for ${day} is not marked complete, not merging: ${dailyJson}`
      );
      mergeSkippedIncomplete += 1;
      continue;
    }
    if (opts.mergeOnly && !isDailyExportComplete(dailyJson, day, opts)) {
      console.warn(
        `Warning: daily export for ${day} has no matching .export-done marker; merging anyway (--merge-only).`
      );
    }
    mergeInputs.push(`--in=${dailyJson}`);
  }

  if (mergeInputs.length === 0) {
    console.error('Error: no daily JSON files found to merge.');
    process.exit(1);
  }

  const mergedOut = path.join(outDir, `${opts.basename}-merged.json`);
  const mergedJsonl = path.join(outDir, `${opts.basename}-merged.jsonl`);
  await spawnAndWaitCollect(NODE_BIN, [
    path.join(SCRIPT_DIR, 'merge-daily-exports.js'),
    ...mergeInputs,
    `--out=${mergedOut}`,
    `--jsonl=${mergedJsonl}`
  ]);

  const incompleteDays = dates.length - mergeInputs.length;
  if (!opts.mergeOnly && incompleteDays > 0) {
    console.log('');
    if (mergeSkippedIncomplete > 0) {
      console.log(
        `Excluded ${mergeSkippedIncomplete} incomplete day(s) from merge (missing, empty, or no matching .export-done marker).`
      );
    }
    console.log(
      JSON.stringify({
        event: 'export-error',
        message: `按天合并不完整：${incompleteDays}/${dates.length} 天未纳入合并（失败会话、未完成或缺失导出）。merged.json 不含这些日期的数据，请修复后重新运行以补全。`,
        mergeSkippedIncomplete: incompleteDays,
        incompleteDays,
        mergedDays: mergeInputs.length,
        totalDays: dates.length,
        outputPath: mergedOut
      })
    );
    console.log(`Merged JSON (partial):  ${mergedOut}`);
    console.log(`Merged JSONL (partial): ${mergedJsonl}`);
    process.exit(1);
  }

  console.log('');
  console.log(
    JSON.stringify({
      event: 'export-complete',
      failed: 0,
      outputPath: mergedOut,
      mergedDays: mergeInputs.length,
      totalDays: dates.length
    })
  );
  console.log('✅ Daily target-list export complete');
  if (skippedDays > 0) {
    console.log(`Skipped ${skippedDays} already-complete day(s); merged ${mergeInputs.length} daily file(s).`);
  }
  console.log(`Merged JSON:  ${mergedOut}`);
  console.log(`Merged JSONL: ${mergedJsonl}`);
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
