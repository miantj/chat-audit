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
    selfHealWrapper: false
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
  --expect-dept=NAME         Department gate
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

function spawnAndWait(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: SCRIPT_ROOT,
      env: { ...process.env, ...env },
      stdio: 'inherit'
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
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

  if (opts.selfHealWrapper) {
    await spawnAndWait(NODE_BIN, [
      path.join(SCRIPT_DIR, 'export-with-self-heal.mjs'),
      ...exportArgs
    ]);
  } else {
    await spawnAndWait(NODE_BIN, [
      path.join(SCRIPT_DIR, 'export-date-range.js'),
      ...exportArgs
    ]);
  }
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

  if (!opts.mergeOnly) {
    for (const day of dates) {
      const dailyOut = path.join(outDir, `${opts.basename}-${day}.json`);
      console.log('');
      console.log(`========== Daily target-list export: ${day} ==========`);
      console.log(`Output: ${dailyOut}`);
      await runDailyExport(opts, day, dailyOut);
    }
  }

  const mergeInputs = [];
  for (const day of dates) {
    const dailyJson = path.join(outDir, `${opts.basename}-${day}.json`);
    if (fs.existsSync(dailyJson)) {
      mergeInputs.push(`--in=${dailyJson}`);
    } else {
      console.warn(`Warning: missing daily export, not merging: ${dailyJson}`);
    }
  }

  if (mergeInputs.length === 0) {
    console.error('Error: no daily JSON files found to merge.');
    process.exit(1);
  }

  const mergedOut = path.join(outDir, `${opts.basename}-merged.json`);
  const mergedJsonl = path.join(outDir, `${opts.basename}-merged.jsonl`);
  await spawnAndWait(NODE_BIN, [
    path.join(SCRIPT_DIR, 'merge-daily-exports.js'),
    ...mergeInputs,
    `--out=${mergedOut}`,
    `--jsonl=${mergedJsonl}`
  ]);

  console.log('');
  console.log('✅ Daily target-list export complete');
  console.log(`Merged JSON:  ${mergedOut}`);
  console.log(`Merged JSONL: ${mergedJsonl}`);
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
