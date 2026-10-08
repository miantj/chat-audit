/**
 * 七鱼专用 Chrome：CDP 默认 9333（避开 chat-audit 的 9222）
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const QIYU_HISTORY_URL =
  process.env.QIYU_HISTORY_URL ||
  'https://guangzhoufumikejiyouxiangongsi.qiyukf.com/madmin/session/history';

export const DEFAULT_CDP =
  process.env.QIYU_CDP_BASE || 'http://127.0.0.1:9333';

export function profileDir() {
  return path.join(os.homedir(), '.chrome-qiyu-profile');
}

function portOf(cdpBase) {
  const m = cdpBase.replace(/\/$/, '').match(/:(\d+)(?:\/|$)/);
  return m ? m[1] : '9333';
}

function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('CDP HTTP timeout'));
    });
  });
}

export async function isCdpUp(cdpBase = DEFAULT_CDP) {
  try {
    const body = await httpGet(`${cdpBase.replace(/\/$/, '')}/json/version`);
    return /chrome/i.test(body);
  } catch {
    return false;
  }
}

export async function listTargets(cdpBase = DEFAULT_CDP) {
  const body = await httpGet(`${cdpBase.replace(/\/$/, '')}/json/list`);
  return JSON.parse(body);
}

function findChrome() {
  if (process.platform === 'darwin') {
    const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    return fs.existsSync(p) ? p : null;
  }
  return null;
}

async function waitCdp(cdpBase, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await isCdpUp(cdpBase)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** CDP 不可达时冷启动专用 Chrome（不杀日常 Chrome） */
export async function ensureChrome(cdpBase = DEFAULT_CDP, openUrl = QIYU_HISTORY_URL) {
  if (await isCdpUp(cdpBase)) return true;
  const chrome = findChrome();
  if (!chrome) throw new Error('未找到 Google Chrome');
  const profile = profileDir();
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(
    chrome,
    [
      `--remote-debugging-port=${portOf(cdpBase)}`,
      `--user-data-dir=${profile}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      openUrl
    ],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();
  const ok = await waitCdp(cdpBase);
  if (!ok) throw new Error(`Chrome CDP 未起来: ${cdpBase}`);
  return true;
}

/** 选七鱼相关 page target，没有则 /json/new */
export async function pickPageTarget(cdpBase = DEFAULT_CDP, preferUrl = QIYU_HISTORY_URL) {
  let targets = await listTargets(cdpBase);
  const usable = (t) =>
    t.type === 'page' &&
    t.webSocketDebuggerUrl &&
    !/chrome-error:|chrome:\/\/|devtools:|about:blank/i.test(t.url || '');
  let pages = targets.filter(usable);
  const isLogin = (t) => /\/login/i.test(t.url || '');
  let hit =
    pages.find((t) => /qiyukf\.com/i.test(t.url || '') && !isLogin(t)) ||
    pages.find((t) => /qiyukf\.com/i.test(t.url || '')) ||
    pages.find((t) => (t.url || '').includes('madmin') && !isLogin(t)) ||
    pages.find((t) => (t.url || '').includes('madmin'));
  if (hit) return hit;

  const base = cdpBase.replace(/\/$/, '');
  await new Promise((resolve, reject) => {
    const req = http.request(
      `${base}/json/new?${encodeURIComponent(preferUrl)}`,
      { method: 'PUT' },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    req.end();
  });
  await new Promise((r) => setTimeout(r, 800));
  targets = await listTargets(cdpBase);
  pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  hit = pages.find((t) => /qiyukf\.com/i.test(t.url || '') && !isLogin(t)) ||
    pages.find((t) => /qiyukf\.com/i.test(t.url || ''));
  if (!hit) throw new Error('CDP 无可用 page target');
  return hit;
}
