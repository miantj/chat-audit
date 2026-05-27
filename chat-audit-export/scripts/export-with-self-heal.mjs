#!/usr/bin/env node
/**
 * 导出编排：自愈重试、失败补跑、CSV（纯 Node，Electron / CLI 共用）。
 */
if (process.platform === 'win32') {
  process.env.NODE_SKIP_PLATFORM_CHECK = '1';
}
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolveExportOutputPath } from './lib/export-path.js';
import {
  countFailedConversations,
  LARGE_JSON_BYTES
} from './lib/export-json-stats.js';
import { ensureCdpReady, isCdpUp } from './lib/cdp-bootstrap.mjs';
import { logCdpWebSocketBootstrap } from './lib/cdp.js';
import {
  buildRetryRunEnv,
  FAILED_RETRY_MAX,
  failedRetryMetaPath,
  readFailedRetryPassesUsed,
  retryPassStrategy,
  writeFailedRetryPassesUsed
} from './lib/failed-retry-meta.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = __dirname;
const SCRIPT_ROOT = path.dirname(SCRIPT_DIR);
const SKILL_DIR = fs.existsSync(path.join(SCRIPT_ROOT, 'SKILL.md'))
  ? SCRIPT_ROOT
  : '';

const NODE_BIN = process.env.CHAT_AUDIT_NODE_BIN || 'node';
const PYTHON_BIN =
  process.env.CHAT_AUDIT_PYTHON_BIN ||
  (process.platform === 'win32' ? 'python' : 'python3');
const STATE_FILE = path.join(
  os.tmpdir(),
  'chat-audit-self-heal-state.json'
);
const MAX_LOOP = 25;
const MAX_RETRIES = 2;

function log(line) {
  console.log(line);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseCliArgs(argv) {
  const opts = {
    start: '',
    end: '',
    out: '',
    keywords: '',
    skipDateValidation: true,
    paced: false,
    retryFailed: false,
    fast: false,
    fullExport: false,
    allCustomers: false,
    noEffectiveFilter: false
  };
  for (const arg of argv) {
    if (arg.startsWith('--start=')) opts.start = arg.slice(8);
    else if (arg.startsWith('--end=')) opts.end = arg.slice(6);
    else if (arg.startsWith('--out=')) opts.out = arg.slice(6);
    else if (arg.startsWith('--keywords=')) opts.keywords = arg.slice(11);
    else if (arg === '--skip-date-validation') opts.skipDateValidation = true;
    else if (arg === '--paced') opts.paced = true;
    else if (arg === '--no-paced') opts.paced = false;
    else if (arg === '--retry-failed') opts.retryFailed = true;
    else if (arg === '--fast') opts.fast = true;
    else if (arg === '--full-export') opts.fullExport = true;
    else if (arg === '--all-customers') opts.allCustomers = true;
    else if (arg === '--no-effective-filter') opts.noEffectiveFilter = true;
    else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

function isPathInside(child, parent) {
  if (!parent) return false;
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
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

function detectErrorType(errorMsg) {
  const msg = String(errorMsg || '');
  if (msg.includes('企业微信登录会话已过期')) return 'WXWORK_LOGIN_EXPIRED';
  if (
    msg.includes('请在本机 Chrome') &&
    (msg.includes('企业微信') || msg.includes('未检测到企业微信消息区'))
  ) {
    return 'WXWORK_LOGIN_EXPIRED';
  }
  if (
    /CDP|No page target|target not found|pageClient\.evaluate/i.test(msg)
  ) {
    return 'CDP_NO_TARGET';
  }
  if (/RATE_LIMITED|请求过于频繁|操作过于频繁|访问过于频繁|请稍后再试/.test(msg)) {
    return 'RATE_LIMITED';
  }
  if (/cascader|级联选择器|el-cascader__dropdown/i.test(msg)) {
    return 'CASCADER_STUCK_OPEN';
  }
  if (/date.*picker|picker.*date|日期选择器/i.test(msg)) {
    return 'DATE_PICKER_STUCK';
  }
  if (/crash|navigation|net::/i.test(msg)) {
    return 'EXPORT_PAGE_CRASH';
  }
  if (/ENOENT|no such file/i.test(msg)) {
    return 'PATH_ERROR';
  }
  return 'UNKNOWN';
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {
    /* ignore */
  }
  return { error_counts: {}, last_error_type: '' };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
}

function clearState() {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    /* ignore */
  }
}

function incrementRetry(errorId) {
  const s = loadState();
  let error_counts = s.error_counts || {};
  let last_error = s.last_error_type || '';
  if (last_error !== errorId) {
    error_counts = {};
    last_error = errorId;
  }
  error_counts[errorId] = (Number(error_counts[errorId]) || 0) + 1;
  saveState({ error_counts, last_error_type: last_error });
  return error_counts[errorId];
}

function parseExportCompleteSummary(output) {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.event === 'export-complete' || ev.event === 'export-shutdown') {
        return {
          conversations: Number(ev.conversations) || 0,
          failed: Number(ev.failed) || 0,
          shutdown: ev.event === 'export-shutdown' || Boolean(ev.shutdown),
          employeeProgressTotal: Number(ev.employeeProgressTotal) || 0
        };
      }
    } catch {
      /* ignore */
    }
  }
  return {
    conversations: 0,
    failed: 0,
    shutdown: false,
    employeeProgressTotal: 0
  };
}

function parseExportError(output) {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t.includes('"event":"export-error"')) continue;
    try {
      const ev = JSON.parse(t);
      if (ev.event === 'export-error' && ev.message) return String(ev.message);
    } catch {
      /* ignore */
    }
  }
  return '';
}

function diagnoseStateName(expectDept, expectDate) {
  try {
    const cdpBase = (process.env.CHAT_AUDIT_CRM_CDP_BASE || 'http://localhost:9222').replace(
      /\/$/,
      ''
    );
    const bin = process.env.CHAT_AUDIT_PREFLIGHT_BIN;
    const cmd = bin || PYTHON_BIN;
    const fullArgs = bin
      ? [
          'diagnose-state',
          '--expect-dept',
          expectDept,
          '--expect-date',
          expectDate,
          '--cdp',
          cdpBase
        ]
      : [
          path.join(SCRIPT_DIR, 'crm-preflight.py'),
          'diagnose-state',
          '--expect-dept',
          expectDept,
          '--expect-date',
          expectDate,
          '--cdp',
          cdpBase
        ];
    const out = execFileSync(cmd, fullArgs, {
      cwd: SCRIPT_DIR,
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });
    const start = out.indexOf('{');
    if (start < 0) return 'UNKNOWN_BLOCKED';
    const d = JSON.parse(out.slice(start));
    return d.state || 'UNKNOWN_BLOCKED';
  } catch {
    return 'UNKNOWN_BLOCKED';
  }
}

async function selfHealCdp() {
  const cdpBase = (process.env.CHAT_AUDIT_CRM_CDP_BASE || 'http://localhost:9222').replace(
    /\/$/,
    ''
  );
  if (await isCdpUp(cdpBase)) {
    log('[self-heal] CDP endpoint up — reopening audit page (no Chrome restart).');
    runPreflight(['navigate-audit']);
    await sleep(3000);
    return true;
  }
  log('[self-heal] CDP endpoint down — cold-start Chrome...');
  return ensureCdpReady(cdpBase);
}

async function pickChatAuditWsUrl(cdpBase) {
  const url = `${cdpBase.replace(/\/$/, '')}/json/list`;
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => {
        try {
          const targets = JSON.parse(data);
          const page = targets.find(
            (t) =>
              t.type === 'page' &&
              t.webSocketDebuggerUrl &&
              (t.url || '').includes('chatAudit')
          );
          resolve(page?.webSocketDebuggerUrl || null);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('CDP /json/list timeout'));
    });
  });
}

async function selfHealCascader() {
  log('[self-heal] Attempting to close cascader dropdown...');
  const cdpBase = (process.env.CHAT_AUDIT_CRM_CDP_BASE || 'http://localhost:9222').replace(
    /\/$/,
    ''
  );
  try {
    const wsUrl = await pickChatAuditWsUrl(cdpBase);
    if (wsUrl) {
      const { CDPClient } = await import('./lib/cdp.js');
      const client = new CDPClient(wsUrl);
      await client.connect();
      const r = await client.send('Runtime.evaluate', {
        expression: `(function() {
          const dropdown = document.querySelector('.el-cascader__dropdown');
          if (dropdown) { dropdown.remove(); return 'removed'; }
          return 'not found';
        })()`,
        returnByValue: true
      });
      await client.close();
      if (r.result?.value === 'removed') {
        log('[self-heal] Cascader dropdown removed');
        return true;
      }
    }
  } catch (e) {
    log(`[self-heal] Cascader CDP heal failed: ${e.message}`);
  }
  try {
    runPreflight(['close-dialog']);
    return true;
  } catch {
    return false;
  }
}

async function selfHealPageReload(expectDept, dateStart) {
  log('[self-heal] Reloading CRM page and re-applying filters...');
  try {
    runPreflight(['navigate-audit']);
    await sleep(5000);
    runPreflight(['set-department', '--group', expectDept]);
    runPreflight(['set-dates', '--date', dateStart]);
    return true;
  } catch (e) {
    log(`[self-heal] Page reload failed: ${e.message}`);
    return false;
  }
}

function runExportDateRange(opts, exportOut, env) {
  const args = [
    path.join(SCRIPT_DIR, 'export-date-range.js'),
    `--start=${opts.start}`,
    `--end=${opts.end}`,
    `--out=${exportOut}`
  ];
  args.push(`--keywords=${opts.keywords}`);
  if (opts.skipDateValidation) args.push('--skip-date-validation');
  if (opts.paced) args.push('--paced');
  if (opts.retryFailed) args.push('--retry-failed');
  if (opts.fast) args.push('--fast');
  if (opts.allCustomers) args.push('--all-customers');
  if (opts.noEffectiveFilter) args.push('--no-effective-filter');

  return new Promise((resolve) => {
    let output = '';
    const proc = spawn(NODE_BIN, args, {
      cwd: SCRIPT_ROOT,
      env: { ...process.env, ...env, OUTPUT_PATH: exportOut },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const feed = (chunk, isErr) => {
      const text = chunk.toString('utf8');
      output += text;
      if (isErr) process.stderr.write(text);
      else process.stdout.write(text);
    };
    proc.stdout.on('data', (c) => feed(c, false));
    proc.stderr.on('data', (c) => feed(c, true));
    proc.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

function generateBusinessCsv(exportOut) {
  const csvOut = exportOut.replace(/\.json$/i, '.business.csv');
  const jsonlPath = exportOut.replace(/\.json$/i, '.jsonl');
  let input = exportOut;
  if (!fs.existsSync(input) && !fs.existsSync(jsonlPath)) {
    log(`[warn] Skip CSV: no JSON/JSONL at ${exportOut}`);
    return null;
  }
  if (!fs.existsSync(input)) {
    input = jsonlPath;
  } else if (fs.existsSync(jsonlPath)) {
    const jsonBytes = fs.statSync(input).size;
    if (jsonBytes > LARGE_JSON_BYTES) {
      log(`[csv] Large JSON (~${Math.round(jsonBytes / 1048576)}MB), using JSONL`);
      input = jsonlPath;
    }
  }
  log('Generating business CSV...');
  try {
    execFileSync(
      NODE_BIN,
      [
        path.join(SCRIPT_DIR, 'json-to-csv-business.js'),
        `--in=${input}`,
        `--out=${csvOut}`
      ],
      { cwd: SCRIPT_ROOT, stdio: 'inherit' }
    );
    if (fs.existsSync(csvOut)) {
      log(`[OK] CSV written: ${csvOut}`);
      console.log(
        JSON.stringify({ event: 'export-csv-complete', csvPath: csvOut })
      );
      return csvOut;
    }
  } catch (e) {
    log(`[warn] CSV generation failed: ${e.message}`);
  }
  return null;
}

function markDone(exportOut) {
  clearState();
  fs.writeFileSync(
    `${exportOut}.done`,
    `${new Date().toISOString().slice(0, 19).replace('T', ' ')} completed\n`,
    'utf8'
  );
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (!cli.start || !cli.end) {
    console.error(
      'Usage: node export-with-self-heal.mjs --start=YYYY-MM-DD --end=YYYY-MM-DD [--out=path] ...'
    );
    process.exit(1);
  }

  const callerCwd = process.env.CHAT_AUDIT_CALLER_CWD || process.cwd();
  const customerSelectionMode =
    cli.allCustomers || cli.noEffectiveFilter ? 'all' : 'effective';
  const exportOut = resolveExportOutputPath(
    process.env.OUTPUT_PATH || cli.out || null,
    {
      cwd: process.env.CHAT_AUDIT_EXPORT_DIR || callerCwd,
      dateStart: cli.start,
      customerSelectionMode
    }
  );

  if (SKILL_DIR && isPathInside(exportOut, SKILL_DIR)) {
    console.error('Error: refusing to write export artifacts inside the skill directory.');
    console.error(`Output path: ${exportOut}`);
    console.error(`Skill path: ${SKILL_DIR}`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(exportOut), { recursive: true });

  const expectDept = process.env.CHAT_AUDIT_EXPECT_DEPT || '大客私域顾问-总';
  const failedRetryMeta = failedRetryMetaPath(exportOut);
  let retryFailed = cli.retryFailed;
  let exportFast = cli.fast;

  if (!retryFailed) {
    try {
      fs.unlinkSync(failedRetryMeta);
    } catch {
      /* ignore */
    }
  }
  let failedRetryCount = readFailedRetryPassesUsed(exportOut);

  if (cli.retryFailed && failedRetryCount >= FAILED_RETRY_MAX) {
    log(
      `[warn] Failed-list retry budget already used (${failedRetryCount}/${FAILED_RETRY_MAX}); finalizing without another export pass.`
    );
    if (fs.existsSync(exportOut)) {
      generateBusinessCsv(exportOut);
      markDone(exportOut);
    }
    process.exit(0);
  }

  const cdpBase = (process.env.CHAT_AUDIT_CRM_CDP_BASE || 'http://localhost:9222').replace(
    /\/$/,
    ''
  );
  if (!(await ensureCdpReady(cdpBase))) {
    console.error(
      `ERROR: could not reach or start Chrome CDP (${cdpBase}). Install Chrome and log in to CRM.`
    );
    process.exit(1);
  }

  if (!process.env.CHAT_AUDIT_START_GATE_DONE) {
    try {
      runPreflight([
        'gate-start-export',
        '--expect-dept',
        expectDept,
        '--expect-date',
        cli.start
      ]);
    } catch (e) {
      console.error(e?.message || 'gate-start-export failed');
      process.exit(1);
    }
  } else {
    log('[preflight] Electron prepare-export passed, skipping gate-start-export');
  }

  logCdpWebSocketBootstrap();

  let attempt = 0;
  while (true) {
    attempt += 1;
    if (attempt > MAX_LOOP) {
      console.error(`ERROR: exceeded max loop iterations (${MAX_LOOP})`);
      process.exit(1);
    }
    if (retryFailed) {
      const n = countFailedConversations(exportOut);
      const retryPass = failedRetryCount + 1;
      log(
        `========== Retry failed conversations (${n} failed, pass ${retryPass}/${FAILED_RETRY_MAX}, loop ${attempt}) ==========`
      );
    } else {
      log(
        `========== Export attempt ${attempt} (self-heal max ${MAX_RETRIES} per error type) ==========`
      );
    }
    log(`Date: ${cli.start} ~ ${cli.end}`);
    log(`Output: ${exportOut}`);
    log('');

    const retryPass = retryFailed ? failedRetryCount + 1 : 0;
    const runEnv = {
      ...(retryFailed ? buildRetryRunEnv(retryPass) : {}),
      ...(cli.fullExport ? { CHAT_AUDIT_CLEAR_METRIC_CHECKPOINT: '1' } : {})
    };
    if (retryFailed) {
      const strategy = retryPassStrategy(retryPass);
      log(
        `[retry-failed] pass ${retryPass}/${FAILED_RETRY_MAX} strategy=${strategy}${strategy === 'metric-table-direct' ? ' (goToContent, search fallback)' : ''}`
      );
    }
    const { code, output } = await runExportDateRange(
      { ...cli, retryFailed, fast: exportFast },
      exportOut,
      runEnv
    );

    if (code === 0) {
      const summary = parseExportCompleteSummary(output);
      let failedCount = summary.failed;
      if (!failedCount) failedCount = countFailedConversations(exportOut);
      const conversations = summary.conversations;

      if (
        conversations <= 0 &&
        failedCount <= 0 &&
        !summary.shutdown &&
        summary.employeeProgressTotal <= 0
      ) {
        log('');
        log(
          '[warn] Export finished with 0 employees and 0 conversations (check date, department, CRM login).'
        );
        clearState();
        process.exit(1);
      }

      if (failedCount > 0) {
        if (retryFailed) {
          failedRetryCount += 1;
          writeFailedRetryPassesUsed(exportOut, failedRetryCount);
        }
        if (failedRetryCount < FAILED_RETRY_MAX) {
          const nextPass = failedRetryCount + 1;
          log(
            `[warn] ${failedCount} conversation(s) failed; scheduling failed-list retry ${nextPass}/${FAILED_RETRY_MAX}...`
          );
          retryFailed = true;
          exportFast = true;
          continue;
        }
        log(
          `[warn] ${failedCount} conversation(s) still failed after ${FAILED_RETRY_MAX} failed-list retry pass(es); continuing with CSV and completion.`
        );
      }

      log('');
      log('[OK] Export completed successfully!');
      clearState();

      if (failedCount <= 0) {
        try {
          fs.unlinkSync(failedRetryMeta);
        } catch {
          /* ignore */
        }
      }
      if (conversations > 0 || failedCount > 0) {
        generateBusinessCsv(exportOut);
      } else {
        log('[warn] Skip CSV: no conversations exported this run');
      }
      markDone(exportOut);
      process.exit(0);
    }

    const errorMsg = parseExportError(output);
    if (!errorMsg) {
      log('');
      log(`[warn] Export exited with code ${code} but no export-error event.`);
      log('    Checkpoint / JSONL preserved — click Start again to resume.');
      clearState();
      process.exit(1);
    }

    let errorType = detectErrorType(errorMsg);
    const pageState = diagnoseStateName(expectDept, cli.start);
    if (pageState === 'CUSTOMER_SELECTED_WECHAT_LOGIN_REQUIRED') {
      errorType = 'WXWORK_LOGIN_EXPIRED';
    } else if (pageState === 'AUDIT_PAGE_WRONG_FILTERS') {
      errorType = 'EXPORT_PAGE_CRASH';
    } else if (pageState === 'CRM_LOGIN_REQUIRED') {
      errorType = 'CRM_LOGIN_REQUIRED';
    }

    if (errorType === 'WXWORK_LOGIN_EXPIRED') {
      clearState();
      process.exit(1);
    }
    if (errorType === 'CRM_LOGIN_REQUIRED') {
      clearState();
      process.exit(1);
    }
    if (errorType === 'RATE_LIMITED') {
      clearState();
      process.exit(1);
    }

    log(`Export failed: ${errorMsg}`);
    log(`Diagnosed page state: ${pageState}`);
    log(`Detected error type: ${errorType}`);

    const retryCount = incrementRetry(errorType);
    log(`Retry count for ${errorType}: ${retryCount}/${MAX_RETRIES}`);

    if (retryCount >= MAX_RETRIES) {
      console.error(`Task aborted after ${retryCount} attempts: ${errorType}`);
      console.error(errorMsg);
      clearState();
      process.exit(1);
    }

    let healOk = true;
    if (errorType === 'CDP_NO_TARGET') {
      healOk = await selfHealCdp();
    } else if (errorType === 'CASCADER_STUCK_OPEN') {
      healOk = await selfHealCascader();
    } else if (errorType === 'EXPORT_PAGE_CRASH') {
      healOk = await selfHealPageReload(expectDept, cli.start);
    } else {
      log(`[self-heal] No specific action for ${errorType}, retrying...`);
    }

    log(
      `[self-heal] ${healOk ? 'done' : 'partial'}, retrying... (${attempt}/${MAX_RETRIES})`
    );
    await sleep(2000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
