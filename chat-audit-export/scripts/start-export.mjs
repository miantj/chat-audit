#!/usr/bin/env node
/**
 * 一键导出：与 Electron「开始导出」等价（CDP → prepare-export → export-with-self-heal）。
 *
 * 用法：
 *   node scripts/start-export.mjs
 *   node scripts/start-export.mjs --start=2026-05-21
 *   node scripts/start-export.mjs --start=2026-05-20 --end=2026-05-21 --output-dir=./exports
 */
if (process.platform === 'win32') {
  process.env.NODE_SKIP_PLATFORM_CHECK = '1';
}
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCdpReady, DEFAULT_CDP } from './lib/cdp-bootstrap.mjs';
import { resolveExportOutputPath } from './lib/export-path.js';
import { countFailedConversations } from './lib/export-json-stats.js';
import {
  FAILED_RETRY_MAX,
  readFailedRetryPassesUsed
} from './lib/failed-retry-meta.js';
import { MODERATE_PACED_ENV } from './lib/moderate-paced-env.js';
import { runPreflight } from './lib/run-preflight.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = __dirname;
const SKILL_ROOT = path.dirname(SCRIPTS_DIR);

const PAUSE_FILE = path.join(os.tmpdir(), 'chat-audit-export-pause');
const STOP_FILE = path.join(os.tmpdir(), 'chat-audit-export-stop');
const DEFAULT_DEPT = '大客私域顾问-总';
const NODE_BIN = process.env.CHAT_AUDIT_NODE_BIN || 'node';

function isPathInside(child, parent) {
  if (!parent) return false;
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function getSkillInstallDir() {
  return fs.existsSync(path.join(SKILL_ROOT, 'SKILL.md'))
    ? path.resolve(SKILL_ROOT)
    : '';
}

/** 默认输出目录：cwd/exports；若在 skill 目录内运行则改为上级工作区的 exports/ */
function resolveDefaultOutputDir(cwd) {
  if (process.env.CHAT_AUDIT_EXPORT_DIR) {
    return path.resolve(process.env.CHAT_AUDIT_EXPORT_DIR);
  }
  const skill = getSkillInstallDir();
  const cwdExports = path.resolve(cwd, 'exports');
  if (skill && isPathInside(cwdExports, skill)) {
    return path.resolve(skill, '..', 'exports');
  }
  return cwdExports;
}

function assertOutputNotInSkill(outputPath) {
  const skill = getSkillInstallDir();
  if (skill && isPathInside(path.resolve(outputPath), skill)) {
    console.error(
      '错误: 不能将导出文件写入 skill 安装目录内。\n' +
        `  当前路径: ${outputPath}\n` +
        `  Skill 目录: ${skill}\n` +
        '请使用 --output-dir=../exports 或设置 CHAT_AUDIT_EXPORT_DIR 指向工作区目录。'
    );
    process.exit(1);
  }
}

function localDateStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function defaultExportDate() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDateStr(d);
}

function printHelp() {
  console.log(`聊天审计一键导出（等同 Electron「开始导出」）

用法:
  node scripts/start-export.mjs [选项]

选项:
  --start=YYYY-MM-DD       开始日期（默认：昨天，本地时区）
  --end=YYYY-MM-DD         结束日期（默认：与开始相同）
  --department=名称        部门（默认：${DEFAULT_DEPT}）
  --output-dir=路径        输出目录（默认：cwd/exports；在 skill 目录内运行时为 ../exports）
  --out=路径.json          指定输出 JSON 文件（优先于 --output-dir）
  --full-export            全量导出（清除指标 checkpoint，不续传失败列表）
  --help, -h               显示帮助

环境变量:
  CHAT_AUDIT_EXPORT_DIR    默认输出目录
  CHAT_AUDIT_CRM_CDP_BASE  Chrome CDP 地址（默认 http://localhost:9222）

示例:
  cd chat-audit-export && node scripts/start-export.mjs
  node scripts/start-export.mjs --start=2026-05-21 --output-dir=../exports

前提: 专用 Chrome（~/.chrome-chat-audit-profile）已用 CDP 9222 登录 CRM。
`);
}

function parseArgs(argv) {
  const opts = {
    start: '',
    end: '',
    department: DEFAULT_DEPT,
    outputDir: '',
    out: '',
    fullExport: false,
    help: false
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--start=')) opts.start = arg.slice(8);
    else if (arg.startsWith('--end=')) opts.end = arg.slice(6);
    else if (arg.startsWith('--department=')) opts.department = arg.slice(13);
    else if (arg.startsWith('--dept=')) opts.department = arg.slice(7);
    else if (arg.startsWith('--output-dir=')) opts.outputDir = arg.slice(13);
    else if (arg.startsWith('--out=')) opts.out = arg.slice(6);
    else if (arg === '--full-export') opts.fullExport = true;
    else {
      console.error(`未知参数: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }
  return opts;
}

function clearExportSignals() {
  for (const f of [PAUSE_FILE, STOP_FILE]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}

function logProgress(p) {
  if (p?.message) {
    console.log(`[预检] ${p.message}`);
  }
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    process.exit(0);
  }

  const start = cli.start || defaultExportDate();
  const end = cli.end || start;
  if (end < start) {
    console.error('错误: 结束日期不能早于开始日期');
    process.exit(1);
  }

  const cwd = process.cwd();
  const outputDir = path.resolve(
    cli.outputDir || resolveDefaultOutputDir(cwd)
  );
  const outputPath = cli.out
    ? resolveExportOutputPath(cli.out, { cwd, dateStart: start })
    : path.join(outputDir, `chat-audit-${start}.json`);

  assertOutputNotInSkill(outputPath);

  clearExportSignals();

  console.log(
    `[start-export] 日期 ${start}${start === end ? '' : ` ~ ${end}`}，部门 ${cli.department}`
  );
  console.log(`[start-export] 输出 ${outputPath}`);

  const cdpBase = (process.env.CHAT_AUDIT_CRM_CDP_BASE || DEFAULT_CDP).replace(
    /\/$/,
    ''
  );
  console.log('[start-export] 检查 Chrome CDP…');
  if (!(await ensureCdpReady(cdpBase))) {
    console.error(
      `无法连接或启动 Chrome CDP（${cdpBase}）。\n` +
        '请用专用配置启动 Chrome：~/.chrome-chat-audit-profile，端口 9222，并在其中登录 CRM。'
    );
    process.exit(1);
  }

  console.log('[start-export] 准备 CRM 页面（prepare-export）…');
  try {
    await runPreflight(
      ['prepare-export', '--expect-dept', cli.department, '--expect-date', start],
      { cdpBase, onProgress: logProgress }
    );
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const runner = path.join(SCRIPTS_DIR, 'export-with-self-heal.mjs');
  const runnerArgs = [
    runner,
    `--start=${start}`,
    `--end=${end}`,
    `--out=${outputPath}`,
    '--keywords=',
    '--skip-date-validation'
  ];

  const failedCount = countFailedConversations(outputPath, NODE_BIN);
  const retryPassesUsed = readFailedRetryPassesUsed(outputPath);
  const retryBudgetLeft =
    FAILED_RETRY_MAX - Math.min(retryPassesUsed, FAILED_RETRY_MAX);
  const resumeFailedOnly =
    failedCount > 0 && !cli.fullExport && retryBudgetLeft > 0;

  if (failedCount > 0 && !cli.fullExport && retryBudgetLeft <= 0) {
    console.log(
      `[start-export] 仍有 ${failedCount} 条失败会话，已补跑 ${FAILED_RETRY_MAX} 次，本次全量导出`
    );
  }
  if (resumeFailedOnly) {
    runnerArgs.push('--retry-failed');
    console.log(
      `[start-export] 续传失败会话 ${failedCount} 条（剩余补跑 ${retryBudgetLeft}/${FAILED_RETRY_MAX}）`
    );
  }

  const clearMetricCheckpoint =
    cli.fullExport ||
    (failedCount > 0 && !cli.fullExport && retryBudgetLeft <= 0 && !resumeFailedOnly);

  const exportEnv = {
    ...process.env,
    ...MODERATE_PACED_ENV,
    CHAT_AUDIT_CRM_CDP_BASE: cdpBase,
    CHAT_AUDIT_PAUSE_FILE: PAUSE_FILE,
    CHAT_AUDIT_STOP_FILE: STOP_FILE,
    CHAT_AUDIT_EXPECT_DEPT: cli.department,
    CHAT_AUDIT_START_GATE_DONE: '1',
    CHAT_AUDIT_CALLER_CWD: path.dirname(outputPath),
    CHAT_AUDIT_EXPORT_DIR: path.dirname(outputPath),
    OUTPUT_PATH: outputPath,
    ...(clearMetricCheckpoint
      ? { CHAT_AUDIT_CLEAR_METRIC_CHECKPOINT: '1' }
      : {})
  };

  console.log('[start-export] 开始导出（export-with-self-heal）…\n');

  const code = await new Promise((resolve) => {
    const proc = spawn(NODE_BIN, runnerArgs, {
      cwd: SKILL_ROOT,
      env: exportEnv,
      stdio: 'inherit'
    });
    proc.on('error', (err) => {
      console.error(`无法启动导出: ${err.message}`);
      resolve(1);
    });
    proc.on('close', (c) => resolve(c ?? 1));
  });

  process.exit(code);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
