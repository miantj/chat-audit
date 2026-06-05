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
import { countFailedConversations } from './lib/export-json-stats.mjs';
import {
  FAILED_RETRY_MAX,
  readFailedRetryPassesUsed,
  shouldScheduleFailedRetry
} from './lib/failed-retry-meta.mjs';
import { MODERATE_PACED_ENV } from './lib/moderate-paced-env.mjs';
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
  --targets-file=路径      目标名单 Excel/CSV（启用目标名单模式）
  --targets-sheet=名称     Excel 工作表名（默认首 sheet）
  --target-list-strategy=visible|search
                           目标名单策略（默认 visible）
  --full-export            全量导出（清除指标 checkpoint，不续传失败列表）
  --help, -h               显示帮助

环境变量:
  CHAT_AUDIT_EXPORT_DIR    默认输出目录
  CHAT_AUDIT_CRM_CDP_BASE  Chrome CDP 地址（默认 http://localhost:9222）

示例:
  cd chat-audit-export && node scripts/start-export.mjs
  node scripts/start-export.mjs --start=2026-05-21 --output-dir=../exports
  node scripts/start-export.mjs --targets-file=./list.xlsx --start=2026-05-30 --end=2026-06-02

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
    targetsFile: '',
    targetsSheet: '',
    targetListStrategy: 'visible',
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
    else if (arg.startsWith('--targets-file=')) opts.targetsFile = arg.slice(15);
    else if (arg.startsWith('--targets-sheet=')) opts.targetsSheet = arg.slice(16);
    else if (arg.startsWith('--target-list-strategy=')) {
      opts.targetListStrategy = arg.slice(23);
    }
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
  const isTargetList = Boolean(cli.targetsFile);
  const isMultiDayTargetList = isTargetList && start !== end;
  const customerSelectionMode = isTargetList ? 'target-list' : 'effective';
  const outputPath = cli.out
    ? resolveExportOutputPath(cli.out, { cwd, dateStart: start, customerSelectionMode })
    : isMultiDayTargetList
      ? path.join(
          outputDir,
          `target-list-by-day-${start}_${end}`,
          'chat-audit-target-list-merged.json'
        )
      : resolveExportOutputPath(null, {
          cwd: outputDir,
          dateStart: start,
          customerSelectionMode
        });

  assertOutputNotInSkill(outputPath);

  if (isTargetList && !path.isAbsolute(cli.targetsFile)) {
    cli.targetsFile = path.resolve(cwd, cli.targetsFile);
  }
  if (isTargetList && !fs.existsSync(cli.targetsFile)) {
    console.error(`错误: 目标名单文件不存在: ${cli.targetsFile}`);
    process.exit(1);
  }

  clearExportSignals();

  console.log(
    `[start-export] 日期 ${start}${start === end ? '' : ` ~ ${end}`}，部门 ${cli.department}${isTargetList ? '，模式=目标名单' : ''}`
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

  if (!isMultiDayTargetList) {
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
  } else {
    console.log('[start-export] 跨日目标名单：将按天设置 CRM 日期并逐日导出…');
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

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
    OUTPUT_PATH: outputPath
  };

  let runner;
  let runnerArgs;

  if (isMultiDayTargetList) {
    runner = path.join(SCRIPTS_DIR, 'export-target-list-by-day.mjs');
    runnerArgs = [
      runner,
      `--start=${start}`,
      `--end=${end}`,
      `--targets-file=${cli.targetsFile}`,
      `--out-dir=${path.dirname(outputPath)}`,
      '--basename=chat-audit-target-list',
      `--target-list-strategy=${cli.targetListStrategy}`,
      `--expect-dept=${cli.department}`,
      '--self-heal-wrapper',
      '--fast-paced'
    ];
    if (cli.targetsSheet) {
      runnerArgs.push(`--targets-sheet=${cli.targetsSheet}`);
    }
    console.log('[start-export] 开始按天导出（export-target-list-by-day）…\n');
  } else {
    runner = path.join(SCRIPTS_DIR, 'export-with-self-heal.mjs');
    runnerArgs = [
      runner,
      `--start=${start}`,
      `--end=${end}`,
      `--out=${outputPath}`,
      '--keywords=',
      '--skip-date-validation',
      '--fast-paced'
    ];
    if (isTargetList) {
      runnerArgs.push(`--targets-file=${cli.targetsFile}`);
      runnerArgs.push(`--target-list-strategy=${cli.targetListStrategy}`);
      if (cli.targetsSheet) {
        runnerArgs.push(`--targets-sheet=${cli.targetsSheet}`);
      }
    }

    const failedCount = countFailedConversations(outputPath, NODE_BIN);
    const retryPassesUsed = readFailedRetryPassesUsed(outputPath);
    const retryBudgetLeft =
      FAILED_RETRY_MAX - Math.min(retryPassesUsed, FAILED_RETRY_MAX);
    const canScheduleFailedRetry = shouldScheduleFailedRetry({
      targetsFile: isTargetList ? cli.targetsFile : '',
      targetListStrategy: cli.targetListStrategy || 'visible'
    });
    const resumeFailedOnly =
      canScheduleFailedRetry &&
      failedCount > 0 &&
      !cli.fullExport &&
      retryBudgetLeft > 0;

    if (failedCount > 0 && !cli.fullExport && retryBudgetLeft <= 0 && canScheduleFailedRetry) {
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

    if (clearMetricCheckpoint) {
      exportEnv.CHAT_AUDIT_CLEAR_METRIC_CHECKPOINT = '1';
    }

    console.log('[start-export] 开始导出（export-with-self-heal）…\n');
  }

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
