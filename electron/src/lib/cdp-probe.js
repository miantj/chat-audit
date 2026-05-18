import fs from 'node:fs';
import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CDP =
  process.env.CHAT_AUDIT_CRM_CDP_BASE || 'http://localhost:9222';

const CRM_URL =
  'https://tmscrm.yishouapp.com/#/salesQuality/chatAudit';

const CHROME_EXTRA_ARGS = [
  '--remote-allow-origins=*',
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-session-crashed-bubble',
  '--disable-infobars',
  '--disable-extensions',
  '--disable-popup-blocking'
];

function cdpPort(cdpBase) {
  const m = cdpBase.replace(/\/$/, '').match(/:(\d+)(?:\/|$)/);
  return m ? m[1] : '9222';
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
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

export function getChatAuditProfileDir() {
  return path.join(os.homedir(), '.chrome-chat-audit-profile');
}

/** 确认 9222 上是带专用 user-data-dir 的 Chrome，而非日常浏览器或其它自动化 */
export function isAuditChromeRunning(cdpBase = DEFAULT_CDP) {
  const port = cdpPort(cdpBase);
  const profile = getChatAuditProfileDir();
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        'wmic process where "name=\'chrome.exe\'" get commandline /format:list',
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
      );
      return (
        out.includes(profile) &&
        out.includes(`--remote-debugging-port=${port}`)
      );
    }
    const out = execSync('ps -ax -o args= 2>/dev/null || ps aux', {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
    return (
      out.includes('chrome-chat-audit-profile') &&
      out.includes(`--remote-debugging-port=${port}`)
    );
  } catch {
    return false;
  }
}

export function cdpWrongInstanceMessage(cdpBase = DEFAULT_CDP) {
  const port = cdpPort(cdpBase);
  return (
    `端口 ${port} 已被其它 Chrome 占用（不是聊天审计专用实例）。\n` +
    '请完全退出占用该端口的 Chrome 后重试；应用会启动专用 Chrome（配置目录 ~/.chrome-chat-audit-profile）。\n' +
    '登录也必须在专用窗口完成，日常 Chrome 的登录态不会同步过来。'
  );
}

async function listCdpTargets(cdpBase) {
  const body = await httpGet(`${cdpBase.replace(/\/$/, '')}/json/list`);
  return JSON.parse(body);
}

function hasPageTarget(targets) {
  return targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

/** Chrome /json/new 须用 PUT（GET 返回非 JSON） */
function putNewCdpTab(cdpBase, url) {
  const base = cdpBase.replace(/\/$/, '');
  const reqPath = `/json/new?${encodeURIComponent(url)}`;
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${reqPath}`, { method: 'PUT' }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const trimmed = data.trim();
          const jsonStart = trimmed.indexOf('{');
          resolve(
            JSON.parse(jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed)
          );
        } catch {
          reject(
            new Error(`创建 CRM 标签页失败，CDP 响应无法解析: ${data.slice(0, 120)}`)
          );
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** 调试端口已开但无 page 目标时（例如用户关光了标签），自动新开 CRM 页 */
export async function ensureCdpPage(cdpBase = DEFAULT_CDP, openUrl = CRM_URL) {
  if (!(await isCdpUp(cdpBase))) return false;
  let targets = await listCdpTargets(cdpBase);
  if (hasPageTarget(targets)) return true;

  await putNewCdpTab(cdpBase, openUrl);
  await new Promise((r) => setTimeout(r, 800));
  targets = await listCdpTargets(cdpBase);
  return hasPageTarget(targets);
}

export function findChromeExecutable() {
  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(
        os.homedir(),
        'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      )
    ];
    return candidates.find((p) => fs.existsSync(p)) ?? null;
  }
  if (process.platform === 'win32') {
    const candidates = [
      path.join(
        process.env.PROGRAMFILES || 'C:\\Program Files',
        'Google/Chrome/Application/chrome.exe'
      ),
      path.join(
        process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
        'Google/Chrome/Application/chrome.exe'
      ),
      path.join(
        process.env.LOCALAPPDATA || '',
        'Google/Chrome/Application/chrome.exe'
      )
    ];
    return candidates.find((p) => fs.existsSync(p)) ?? null;
  }
  return null;
}

async function waitForCdp(cdpBase, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpUp(cdpBase)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export async function coldStartChrome(cdpBase = DEFAULT_CDP) {
  const port = cdpPort(cdpBase);
  const profile = getChatAuditProfileDir();
  const chromePath = findChromeExecutable();

  if (!chromePath) {
    return false;
  }

  const logPath = '/tmp/chrome-debug.log';
  let logFd;
  try {
    logFd = fs.openSync(logPath, 'a');
  } catch {
    logFd = 'ignore';
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--new-window',
    ...CHROME_EXTRA_ARGS,
    CRM_URL
  ];

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd]
  });
  child.unref();
  if (typeof logFd === 'number') {
    fs.closeSync(logFd);
  }

  const up = await waitForCdp(cdpBase, 20000);
  if (up) await ensureCdpPage(cdpBase, CRM_URL);
  return up;
}

/** 保证连接的是专用 Chrome + 专用配置目录（登录态写在此 profile） */
export async function ensureAuditChrome(cdpBase = DEFAULT_CDP) {
  if (await isCdpUp(cdpBase)) {
    if (!isAuditChromeRunning(cdpBase)) {
      throw new Error(cdpWrongInstanceMessage(cdpBase));
    }
    return ensureCdpPage(cdpBase, CRM_URL);
  }

  if (isAuditChromeRunning(cdpBase)) {
    const up = await waitForCdp(cdpBase, 15000);
    if (up) return ensureCdpPage(cdpBase, CRM_URL);
  }

  if (!(await coldStartChrome(cdpBase))) return false;
  return ensureCdpPage(cdpBase, CRM_URL);
}

export async function ensureCdp(cdpBase = DEFAULT_CDP) {
  return ensureAuditChrome(cdpBase);
}

export function cdpUnavailableMessage(cdpBase = DEFAULT_CDP) {
  const chromePath = findChromeExecutable();
  const profile = getChatAuditProfileDir();
  const cmd = chromePath
    ? `"${chromePath}" --remote-debugging-port=9222 --user-data-dir="${profile}" --new-window "${CRM_URL}"`
    : `open -a "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="${profile}"`;

  return (
    `无法连接 Chrome 调试端口（${cdpBase}）。\n` +
    '请在终端执行后重试导出：\n' +
    `${cmd}\n` +
    '等待约 6 秒后在弹出的专用 Chrome 窗口登录 CRM（勿用日常 Chrome），再点击「开始导出」。\n' +
    '登录态保存在 ~/.chrome-chat-audit-profile，关闭专用 Chrome 后再次打开仍会保留。\n' +
    '（日志：/tmp/chrome-debug.log）'
  );
}
