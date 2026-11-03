#!/usr/bin/env node
/**
 * 本地补跑 HTTP 服务（仅 127.0.0.1）
 *
 *   GET /qiyu/rerun?day=YYYY-MM-DD          触发补跑（默认昨天）
 *   GET /qiyu/rerun?day=YYYY-MM-DD&force=1  强制重导七鱼
 *   GET /qiyu/status                        当前/上次状态
 *   GET /health                            探活
 *
 * 环境变量：
 *   QIYU_RERUN_PORT          默认 18765
 *   QIYU_RERUN_COOLDOWN_MS   默认 300000（5 分钟，距上次成功启动）
 *   QIYU_REGISTER_MAX_RETRY  传给 manual-rerun（额外重试次数）
 *
 * 启动：node scripts/rerun-server.mjs
 * 安装常驻：./scripts/install-rerun-server.sh
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'logs');
const STATE_PATH = path.join(LOG_DIR, 'rerun-server-state.json');
const PORT = Number.parseInt(process.env.QIYU_RERUN_PORT || '18765', 10) || 18765;
const COOLDOWN_MS = Number.parseInt(process.env.QIYU_RERUN_COOLDOWN_MS || '300000', 10) || 300_000;
const HOST = '127.0.0.1';

fs.mkdirSync(LOG_DIR, { recursive: true });

/** @type {{
 *  status: 'idle'|'running'|'success'|'fail',
 *  accepted?: boolean,
 *  day?: string,
 *  forceDownload?: boolean,
 *  startedAt?: string|null,
 *  finishedAt?: string|null,
 *  lastStartAt?: string|null,
 *  error?: string|null,
 *  rows?: number|null,
 *  url?: string|null,
 *  log?: string|null,
 *  pid?: number|null,
 *  message?: string
 * }} */
let state = loadState();
/** @type {import('node:child_process').ChildProcess|null} */
let child = null;

function nowIso() {
  return new Date().toISOString();
}

function shanghaiYmd(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      // 进程重启后，遗留 running 视为 fail
      if (raw?.status === 'running') {
        raw.status = 'fail';
        raw.error = raw.error || '服务重启时任务仍在进行，已标记失败';
        raw.finishedAt = raw.finishedAt || nowIso();
        raw.pid = null;
      }
      return raw;
    }
  } catch {
    /* ignore */
  }
  return {
    status: 'idle',
    day: null,
    startedAt: null,
    finishedAt: null,
    lastStartAt: null,
    error: null,
    rows: null,
    url: null,
    log: null,
    pid: null,
    message: '尚未执行过'
  };
}

function saveState() {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function publicState(extra = {}) {
  const lastStartMs = state.lastStartAt ? Date.parse(state.lastStartAt) : 0;
  const since = lastStartMs ? Date.now() - lastStartMs : null;
  const cooldownRemainingMs =
    lastStartMs && since < COOLDOWN_MS ? Math.max(0, COOLDOWN_MS - since) : 0;
  return {
    ok: true,
    service: 'qiyu-rerun',
    cooldownMs: COOLDOWN_MS,
    cooldownRemainingMs,
    cooldownRemainingSec: Math.ceil(cooldownRemainingMs / 1000),
    job: {
      status: state.status,
      day: state.day,
      forceDownload: !!state.forceDownload,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      lastStartAt: state.lastStartAt,
      error: state.error,
      rows: state.rows,
      url: state.url,
      log: state.log,
      pid: state.pid,
      message: state.message
    },
    ...extra
  };
}

function sendJson(res, code, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

function validDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return false;
  const t = Date.parse(`${day}T00:00:00+08:00`);
  return Number.isFinite(t);
}

function parseLogSummary(logPath) {
  let url = null;
  let rows = null;
  let error = null;
  try {
    const text = fs.readFileSync(logPath, 'utf8');
    const urls = text.match(/https:\/\/yb7ao262ru\.feishu\.cn\/wiki\/[^\s"\\]+/g);
    if (urls?.length) url = urls[urls.length - 1];
    const rowHit = [...text.matchAll(/\brows=(\d+)\b/g)];
    if (rowHit.length) rows = Number(rowHit[rowHit.length - 1][1]);
    const failLines = text
      .split(/\n/)
      .map((l) => l.trim())
      .filter((l) => /FAILED|失败|Error|AI 批量判断失败/.test(l));
    if (failLines.length) error = failLines[failLines.length - 1].slice(0, 300);
  } catch {
    /* ignore */
  }
  return { url, rows, error };
}

function startJob({ day, forceDownload, dryRun = false }) {
  if (child || state.status === 'running') {
    return {
      accepted: false,
      reason: 'busy',
      httpStatus: 409,
      body: publicState({
        accepted: false,
        message: '已有补跑任务进行中，请先查 /qiyu/status'
      })
    };
  }

  const lastStartMs = state.lastStartAt ? Date.parse(state.lastStartAt) : 0;
  if (lastStartMs && Date.now() - lastStartMs < COOLDOWN_MS) {
    const remain = Math.ceil((COOLDOWN_MS - (Date.now() - lastStartMs)) / 1000);
    return {
      accepted: false,
      reason: 'rate_limited',
      httpStatus: 429,
      body: publicState({
        accepted: false,
        message: `5 分钟内只能启动一次，还需等待约 ${remain} 秒`
      })
    };
  }

  const stamp = new Date()
    .toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
    .replace(/[-: ]/g, '')
    .slice(0, 14);
  const logPath = path.join(LOG_DIR, `manual-rerun-http-${day}-${stamp}.log`);
  const args = [day];
  if (forceDownload) args.push('--force-download');
  if (dryRun) args.push('--dry-run');

  const startedAt = nowIso();
  state = {
    ...state,
    status: 'running',
    day,
    forceDownload: !!forceDownload,
    dryRun: !!dryRun,
    startedAt,
    finishedAt: null,
    lastStartAt: startedAt,
    error: null,
    rows: null,
    url: null,
    log: logPath,
    pid: null,
    message: '已接受，补跑进行中'
  };
  saveState();

  const out = fs.openSync(logPath, 'a');
  child = spawn(path.join(ROOT, 'scripts', 'manual-rerun.sh'), args, {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.HOME || ''}/.npm-global/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
      QIYU_REGISTER_MAX_RETRY: process.env.QIYU_REGISTER_MAX_RETRY || '2'
    },
    stdio: ['ignore', out, out]
  });
  state.pid = child.pid;
  saveState();

  const running = child;
  running.on('exit', (code, signal) => {
    try {
      fs.closeSync(out);
    } catch {
      /* ignore */
    }
    if (child === running) child = null;
    const summary = parseLogSummary(logPath);
    const ok = code === 0;
    state = {
      ...state,
      status: ok ? 'success' : 'fail',
      finishedAt: nowIso(),
      pid: null,
      rows: summary.rows,
      url: summary.url,
      error: ok ? null : summary.error || `exit=${code}${signal ? ` signal=${signal}` : ''}`,
      message: ok ? '补跑成功' : '补跑失败'
    };
    saveState();
  });

  return {
    accepted: true,
    reason: 'started',
    httpStatus: 202,
    body: publicState({
      accepted: true,
      message: `已启动补跑 day=${day}`
    })
  };
}

function handle(req, res) {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const { pathname, searchParams } = url;

  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, message: '仅支持 GET' });
    return;
  }

  if (pathname === '/health') {
    sendJson(res, 200, { ok: true, status: 'up', time: nowIso() });
    return;
  }

  if (pathname === '/qiyu/status' || pathname === '/status') {
    sendJson(res, 200, publicState());
    return;
  }

  if (pathname === '/qiyu/rerun' || pathname === '/rerun') {
    const day = searchParams.get('day') || shanghaiYmd(-1);
    if (!validDay(day)) {
      sendJson(res, 400, {
        ok: false,
        accepted: false,
        message: 'day 须为 YYYY-MM-DD',
        day
      });
      return;
    }
    const force =
      searchParams.get('force') === '1' ||
      searchParams.get('force-download') === '1' ||
      searchParams.get('forceDownload') === '1';
    const dry = searchParams.get('dry') === '1' || searchParams.get('dry-run') === '1';
    const result = startJob({ day, forceDownload: force, dryRun: dry });
    sendJson(res, result.httpStatus, result.body);
    return;
  }

  sendJson(res, 404, {
    ok: false,
    message: '未知路径。可用: GET /qiyu/rerun?day=YYYY-MM-DD 、GET /qiyu/status 、GET /health'
  });
}

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (err) {
    sendJson(res, 500, { ok: false, message: String(err?.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.error(
    `qiyu rerun server listening http://${HOST}:${PORT}  (cooldown=${COOLDOWN_MS}ms)`
  );
  console.error(`  GET http://${HOST}:${PORT}/qiyu/rerun?day=${shanghaiYmd(-1)}`);
  console.error(`  GET http://${HOST}:${PORT}/qiyu/status`);
});
