/**
 * CDP 探测与 Chrome 冷启动（纯 Node，供 export-with-self-heal.mjs / CLI 使用）。
 */
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
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

function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('CDP HTTP timeout'));
    });
  });
}

export function getChatAuditProfileDir() {
  return path.join(os.homedir(), '.chrome-chat-audit-profile');
}

export async function isCdpUp(cdpBase = DEFAULT_CDP) {
  try {
    const body = await httpGet(`${cdpBase.replace(/\/$/, '')}/json/version`);
    return /chrome/i.test(body);
  } catch {
    return false;
  }
}

function findChromeExecutable() {
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

async function listCdpTargets(cdpBase) {
  const body = await httpGet(`${cdpBase.replace(/\/$/, '')}/json/list`);
  return JSON.parse(body);
}

function hasPageTarget(targets) {
  return targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

function putNewCdpTab(cdpBase, url) {
  const base = cdpBase.replace(/\/$/, '');
  const reqPath = `/json/new?${encodeURIComponent(url)}`;
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${reqPath}`, { method: 'PUT' }, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => {
        try {
          const trimmed = data.trim();
          const jsonStart = trimmed.indexOf('{');
          resolve(
            JSON.parse(jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed)
          );
        } catch {
          reject(new Error('CDP /json/new response parse failed'));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function ensureCdpPage(cdpBase, openUrl = CRM_URL) {
  if (!(await isCdpUp(cdpBase))) return false;
  let targets = await listCdpTargets(cdpBase);
  if (hasPageTarget(targets)) return true;
  await putNewCdpTab(cdpBase, openUrl);
  await new Promise((r) => setTimeout(r, 800));
  targets = await listCdpTargets(cdpBase);
  return hasPageTarget(targets);
}

/** 无 pkill：仅在 CDP 不可达时启动专用 Chrome */
export async function coldStartChrome(cdpBase = DEFAULT_CDP) {
  const port = cdpPort(cdpBase);
  const profile = getChatAuditProfileDir();
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    return false;
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
    stdio: 'ignore'
  });
  child.unref();

  const up = await waitForCdp(cdpBase, 20000);
  if (up) await ensureCdpPage(cdpBase, CRM_URL);
  return up;
}

export async function ensureCdpReady(cdpBase = DEFAULT_CDP) {
  if (await isCdpUp(cdpBase)) {
    await ensureCdpPage(cdpBase, CRM_URL);
    return true;
  }
  console.log(
    `[cdp] No debugger at ${cdpBase}; starting Chrome (profile ${getChatAuditProfileDir()}).`
  );
  return coldStartChrome(cdpBase);
}
