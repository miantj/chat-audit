import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { exportCurrentPage } from './export-current-page.js';
import { getDefaultCheckpointPath } from './lib/checkpoint.js';

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

function getDefaultOutputPath() {
  const exportDir = process.env.CHAT_AUDIT_EXPORT_DIR
    ? path.resolve(cwd, process.env.CHAT_AUDIT_EXPORT_DIR)
    : path.join(cwd, 'exports');
  return path.join(exportDir, `chat-audit-${dateStart}.json`);
}

const outputPath = path.resolve(cwd, process.env.OUTPUT_PATH || opts.out || getDefaultOutputPath());
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

const targetKeywords = (typeof opts.keywords === 'string' ? opts.keywords : '小米,丽丽,农农,可可')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Graceful shutdown state
let shutdownRequested = false;
const PAUSE_FILE =
  process.env.CHAT_AUDIT_PAUSE_FILE ||
  path.join(os.tmpdir(), 'chat-audit-export-pause');

process.on('SIGTERM', () => { shutdownRequested = true; console.error(JSON.stringify({event:'export-signal',signal:'SIGTERM',message:'收到终止信号，完成当前对话后退出…'})); });
process.on('SIGINT', () => { shutdownRequested = true; console.error(JSON.stringify({event:'export-signal',signal:'SIGINT',message:'收到中断信号，完成当前对话后退出…'})); });

// Export the shutdown flag for use in export-current-page.js
export { shutdownRequested, PAUSE_FILE };

const maxConversations = Number(opts.max || '2000');
const maxRows = Number(opts['max-rows'] || '999999');
const expectedCategory = (opts.category || '').trim();
const expectedActiveTab = (opts.tab || '').trim();
const skipDateValidation = opts['skip-date-validation'] === true;
const dryRunTargets = opts['dry-run-targets'] === true;
const paced =
  opts['no-paced'] === true
    ? false
    : (opts.paced === true || (!dryRunTargets && !(maxConversations <= 1 && maxRows <= 1)));

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
    shutdownRequested: () => shutdownRequested,
    pauseFile: PAUSE_FILE,
    log: (msg) => console.log(JSON.stringify({ event: 'export-progress', message: msg }))
  });

  console.log(JSON.stringify({
    event: result.shutdown ? 'export-shutdown' : 'export-complete',
    ...result
  }, null, 2));

  process.exit(0);
} catch (error) {
  console.error(JSON.stringify({
    event: 'export-error',
    message: error.message || String(error)
  }, null, 2));
  process.exit(1);
}
