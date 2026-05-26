if (process.platform === 'win32') {
  process.env.NODE_SKIP_PLATFORM_CHECK = '1';
}
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { exportCurrentPage } from './export-current-page.js';
import { getDefaultCheckpointPath } from './lib/checkpoint.js';
import { resolveExportOutputPath } from './lib/export-path.js';
import {
  applyFailedRetryPassEnv,
  FAILED_RETRY_MAX,
  retryPassStrategy
} from './lib/failed-retry-meta.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      const value = rest.length > 0 ? rest.join('=') : true;
      opts[key] = value;
    }
  }

  return opts;
}

function showUsage() {
  console.error([
    'Usage: node export-date-range.js --start=YYYY-MM-DD --end=YYYY-MM-DD [options]',
    '',
    'Required:',
    '  --start=YYYY-MM-DD     Start date for the export range',
    '  --end=YYYY-MM-DD       End date for the export range',
    '',
    'Options:',
    '  --keywords=name1,name2  Employee name keywords (default: 小米,丽丽,农农,可可)',
    '  --max=2000              Max conversations to export',
    '  --max-rows=50           Max employee rows to process',
    '  --out=./data.json       Output dataset path (default: $PWD/exports/chat-audit-YYYY-MM-DD.json)',
    '  --category=xxx          Expected category filter text',
    '  --tab=xxx               Expected active tab text',
    '  --paced                 Enable paced export delays for small samples',
    '  --no-paced              Disable paced export delays',
    '  --dry-run-targets       Probe metric categories and print target customer IDs without exporting messages',
    '  --retry-failed          Re-export only previously failed conversations from existing output',
    '  --fast                  Aggressive speed mode: minimize delays (used for failed-list retry)',
    '  --help                  Show this message',
    '',
    'Environment variables:',
    '  OUTPUT_PATH             Override default output path',
    '  CHAT_AUDIT_EXPORT_DIR   Default export directory when --out/OUTPUT_PATH is not set',
    '  CHECKPOINT_PATH         Override default checkpoint path',
    '  JSONL_PATH              Override default JSONL path',
    '  STABLE_POLL_MS          Message stability poll interval (default 1200)',
    '  STABLE_ATTEMPTS         Message stability max attempts (default 12)',
    '  CUSTOMER_DELAY_MIN_MS   Paced delay after each customer (default 1000)',
    '  CUSTOMER_DELAY_MAX_MS   Paced delay after each customer (default 3000)',
    '  CUSTOMERS_PER_BATCH     Paced batch size before rest (default 10)',
    '  BATCH_REST_MS           Paced rest after each batch (default 5000)',
    '  DOM_POLL_INTERVAL_MS              DOM poll interval (default 150)',
    '  DOM_SEARCH_READY_TIMEOUT_MS       Search result ready timeout (default 4000)',
    '  DOM_SELECT_READY_TIMEOUT_MS       Friend selected + iframe timeout (default 5000)',
    '  DOM_MESSAGE_CHANGE_TIMEOUT_MS     Message scroll DOM change timeout (default 1200)',
    '',
    'Example:',
    '  node export-date-range.js --start=2026-04-27 --end=2026-04-27 --keywords=小米,丽丽'
  ].join('\n'));
}

const opts = parseArgs();

if (opts.help || opts.h) {
  showUsage();
  process.exit(0);
}

const dateStart = opts.start || opts['date-start'] || '';
const dateEnd = opts.end || opts['date-end'] || '';

if (!dateStart || !dateEnd) {
  console.error('Error: --start and --end are required.');
  console.error('');
  showUsage();
  process.exit(1);
}

// Validate date format
const dateRe = /^\d{4}-\d{2}-\d{2}$/;
if (!dateRe.test(dateStart) || !dateRe.test(dateEnd)) {
  console.error('Error: dates must be in YYYY-MM-DD format.');
  process.exit(1);
}

const cwd = process.cwd();
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const maybeSkillRoot = path.dirname(scriptDir);
const skillRoot = fs.existsSync(path.join(maybeSkillRoot, 'SKILL.md')) ? maybeSkillRoot : '';

function isPathInside(child, parent) {
  if (!parent) return false;
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

const outputPath = resolveExportOutputPath(opts.out, { cwd, dateStart });
if (isPathInside(outputPath, skillRoot)) {
  console.error(
    [
      'Error: refusing to write export artifacts inside the skill directory.',
      `Output path: ${outputPath}`,
      `Skill path: ${skillRoot}`,
      'Run from a project/workspace directory, pass --out=/path/to/exports/file.json,',
      'or set CHAT_AUDIT_EXPORT_DIR=/path/to/exports.'
    ].join('\n')
  );
  process.exit(1);
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const checkpointPath = path.resolve(
  cwd,
  process.env.CHECKPOINT_PATH || getDefaultCheckpointPath(outputPath)
);
const jsonlPath = path.resolve(
  cwd,
  process.env.JSONL_PATH ||
    path.join(path.dirname(outputPath), `${path.basename(outputPath, path.extname(outputPath))}.jsonl`)
);

// 显式 --keywords= 表示不过滤；未传参时才用 Skill 示例默认（便于 CLI 小样本）
const targetKeywords = (
  opts.keywords !== undefined && opts.keywords !== true
    ? String(opts.keywords)
    : '小米,丽丽,农农,可可'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Graceful shutdown state
let shutdownRequested = false;
const PAUSE_FILE =
  process.env.CHAT_AUDIT_PAUSE_FILE ||
  path.join(os.tmpdir(), 'chat-audit-export-pause');
const STOP_FILE =
  process.env.CHAT_AUDIT_STOP_FILE ||
  path.join(os.tmpdir(), 'chat-audit-export-stop');

process.on('SIGTERM', () => { shutdownRequested = true; console.error(JSON.stringify({event:'export-signal',signal:'SIGTERM',message:'收到终止信号，完成当前对话后退出…'})); });
process.on('SIGINT', () => { shutdownRequested = true; console.error(JSON.stringify({event:'export-signal',signal:'SIGINT',message:'收到中断信号，完成当前对话后退出…'})); });

// Export the shutdown flag for use in export-current-page.js
export { shutdownRequested, PAUSE_FILE, STOP_FILE };

const maxConversations = Number(opts.max || '2000');
const maxRows = Number(opts['max-rows'] || '999999');
const expectedCategory = (opts.category || '').trim();
const expectedActiveTab = (opts.tab || '').trim();
const skipDateValidation = opts['skip-date-validation'] === true;
const dryRunTargets = opts['dry-run-targets'] === true;
const retryFailed = opts['retry-failed'] === true;
if (retryFailed) {
  process.env.CHAT_AUDIT_RETRY_FAILED = '1';
  if (!process.env.CHAT_AUDIT_RETRY_PASS) {
    const retryPass = applyFailedRetryPassEnv(outputPath);
    const strategy = retryPassStrategy(retryPass);
    process.stdout.write(
      JSON.stringify({
        event: 'export-progress',
        message: `[retry-failed] pass ${retryPass}/${FAILED_RETRY_MAX} strategy=${strategy}`
      }) + '\n'
    );
  }
}
const fastMode = opts.fast === true;

if (fastMode) {
  process.env.CUSTOMER_DELAY_MIN_MS = '200';
  process.env.CUSTOMER_DELAY_MAX_MS = '400';
  process.env.EMPLOYEE_DELAY_MIN_MS = '300';
  process.env.EMPLOYEE_DELAY_MAX_MS = '600';
  process.env.BATCH_REST_MS = '300';
  process.env.DOM_POLL_INTERVAL_MS = '100';
  process.env.DOM_SEARCH_READY_TIMEOUT_MS = '2500';
  process.env.DOM_SELECT_READY_TIMEOUT_MS = '3500';
  process.env.DOM_MESSAGE_CHANGE_TIMEOUT_MS = '800';
  process.env.STABLE_POLL_MS = '600';
  process.env.STABLE_ATTEMPTS = '6';
}

const paced =
  opts['no-paced'] === true
    ? false
    : (opts.paced === true || (!dryRunTargets && !(maxConversations <= 1 && maxRows <= 1)));

let retryFailedConversations = null;
if (retryFailed) {
  if (!fs.existsSync(outputPath)) {
    process.stdout.write(
      JSON.stringify({
        event: 'export-progress',
        message: '[retry-failed] No output file yet; nothing to retry'
      }) + '\n'
    );
    console.log(
      JSON.stringify({
        event: 'export-complete',
        conversations: 0,
        completed: 0,
        failed: 0,
        outputPath,
        retrySkipped: true
      })
    );
    process.exit(0);
  }
  try {
    const existingDataset = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    const failedIds = existingDataset?.progress?.failed_conversation_ids || [];
    if (failedIds.length > 0) {
      retryFailedConversations = failedIds;
      process.stdout.write(
        JSON.stringify({
          event: 'export-progress',
          phase: 'retry-failed',
          unit: 'conversation',
          reset: true,
          current: 0,
          total: failedIds.length,
          message: `续传 0/${failedIds.length}（0%）`,
          debug: {
            source: 'export-date-range',
            stage: 'retry-start',
            failedIds: failedIds.length,
            sampleId: failedIds[0] || null
          }
        }) + '\n'
      );
    } else {
      process.stdout.write(
        JSON.stringify({
          event: 'export-progress',
          message: '[retry-failed] No failed conversations to retry'
        }) + '\n'
      );
      console.log(
        JSON.stringify({
          event: 'export-complete',
          conversations: existingDataset.conversations?.length ?? 0,
          completed: existingDataset.progress?.completed_conversation_ids?.length ?? 0,
          failed: 0,
          outputPath,
          retrySkipped: true
        })
      );
      process.exit(0);
    }
  } catch (e) {
    console.error(
      JSON.stringify({
        event: 'export-error',
        message: `Failed to load existing output for retry: ${e.message}`
      })
    );
    process.exit(1);
  }
}

console.log(JSON.stringify({
  event: 'export-start',
  dateStart,
  dateEnd,
  outputPath,
  checkpointPath,
  jsonlPath,
  targetKeywords,
  maxConversations,
  paced
}, null, 2));

try {
  const result = await exportCurrentPage({
    outputPath,
    checkpointPath,
    jsonlPath,
    dateStart,
    dateEnd,
    targetKeywords,
    maxConversations,
    maxRows,
    expectedCategory,
    expectedActiveTab,
    skipDateValidation,
    dryRunTargets,
    paced,
    retryFailedConversations,
    shutdownRequested: () => shutdownRequested,
    pauseFile: PAUSE_FILE,
    stopFile: STOP_FILE,
    log: (msg) => {
      // 管道/tee 时 console.log 可能块缓冲，用 write 保证 UI 实时日志
      const text = String(msg).trim();
      if (text.startsWith('{')) {
        try {
          const parsed = JSON.parse(text);
          if (
            parsed.event === 'export-paused' ||
            parsed.event === 'export-resumed'
          ) {
            process.stdout.write(JSON.stringify(parsed) + '\n');
            return;
          }
          if (
            parsed.event === 'export-progress' &&
            (parsed.current != null || (parsed.total != null && parsed.total > 0))
          ) {
            process.stdout.write(JSON.stringify(parsed) + '\n');
            return;
          }
        } catch {
          /* 普通日志 */
        }
      }
      process.stdout.write(
        JSON.stringify({ event: 'export-progress', message: msg }) + '\n'
      );
    }
  });

  console.log(
    JSON.stringify({
      event: result.shutdown ? 'export-shutdown' : 'export-complete',
      ...result
    })
  );

  process.exit(0);
} catch (error) {
  // 必须单行 JSON，供 Electron / export-with-self-heal.mjs 按行解析
  console.error(
    JSON.stringify({
      event: 'export-error',
      message: error.message || String(error)
    })
  );
  process.exit(1);
}
