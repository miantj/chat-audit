/**
 * self-heal.js — Self-iteration and recovery for chat-audit-export
 *
 * Detects blocking errors from export runs, attempts self-healing,
 * and falls back to learned improvements after 3 consecutive failures.
 *
 * Blocking error types and their self-heal actions:
 *
 *  WXWORK_LOGIN_EXPIRED  → user must re-login (blocking; no automation)
 *  CDP_NO_TARGET         → if CDP HTTP is up: reopen audit tab via crm-preflight only;
 *                          if CDP is down: cold-start Chrome with persistent profile (no pkill)
 *  CASCADER_STUCK_OPEN   → remove .el-cascader__dropdown from DOM
 *  DATE_PICKER_STUCK     → click body to close picker, retry set-dates
 *  EXPORT_PAGE_CRASH      → refresh page + re-apply filters
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Repo root (parent of scripts/) so preflight subprocesses work even if cwd differs.
const __dirname = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------
// Error type definitions
// ------------------------------------------------------------------

export const BLOCKING_ERRORS = {
  WXWORK_LOGIN_EXPIRED: {
    id: 'WXWORK_LOGIN_EXPIRED',
    label: '企业微信登录会话已过期',
    selfHeal: false, // requires human re-login
    maxRetries: 3,
  },
  CDP_NO_TARGET: {
    id: 'CDP_NO_TARGET',
    label: 'Chrome CDP 连接中断',
    selfHeal: true,
    maxRetries: 3,
  },
  CASCADER_STUCK_OPEN: {
    id: 'CASCADER_STUCK_OPEN',
    label: '级联选择器面板未关闭',
    selfHeal: true,
    maxRetries: 3,
  },
  DATE_PICKER_STUCK: {
    id: 'DATE_PICKER_STUCK',
    label: '日期选择器面板卡住',
    selfHeal: true,
    maxRetries: 3,
  },
  EXPORT_PAGE_CRASH: {
    id: 'EXPORT_PAGE_CRASH',
    label: 'CRM 页面崩溃',
    selfHeal: true,
    maxRetries: 3,
  },
  UNKNOWN: {
    id: 'UNKNOWN',
    label: '未知错误',
    selfHeal: false,
    maxRetries: 2,
  },
};

export const SKILL_DIR = join(__dirname, '..');

/** TCP port from CHAT_AUDIT_CRM_CDP_BASE (e.g. http://localhost:9333 → 9333). */
function cdpPortFromBase(base) {
  const m = String(base).match(/:(\d+)(?:\/|$)/);
  return m ? m[1] : '9222';
}

// ------------------------------------------------------------------
// Error detection
// ------------------------------------------------------------------

/**
 * Parse an export-error message string and return the matching error type.
 */
export function detectBlockingError(errorMessage) {
  if (!errorMessage) return BLOCKING_ERRORS.UNKNOWN;
  const msg = String(errorMessage);

  if (msg.includes('企业微信登录会话已过期')) return BLOCKING_ERRORS.WXWORK_LOGIN_EXPIRED;
  if (msg.includes('No page target') || msg.includes('chatAudit page target not found') || msg.includes('target not found')) {
    return BLOCKING_ERRORS.CDP_NO_TARGET;
  }
  if (msg.includes('pageClient.evaluate is not a function') || msg.includes('CDP')) {
    return BLOCKING_ERRORS.CDP_NO_TARGET;
  }
  if (msg.includes('级联选择器') || msg.includes('cascader') || msg.includes('el-cascader__dropdown')) {
    return BLOCKING_ERRORS.CASCADER_STUCK_OPEN;
  }
  if (msg.includes('date') && (msg.includes('stuck') || msg.includes('picker'))) {
    return BLOCKING_ERRORS.DATE_PICKER_STUCK;
  }
  if (msg.includes('page crash') || msg.includes('navigation') || msg.includes('net::')) {
    return BLOCKING_ERRORS.EXPORT_PAGE_CRASH;
  }

  return BLOCKING_ERRORS.UNKNOWN;
}

// ------------------------------------------------------------------
// Self-healing actions (return true if fixed, false if cannot self-heal)
// ------------------------------------------------------------------

export async function selfHeal(errorType, dateStart, dateEnd) {
  switch (errorType.id) {
    case 'CDP_NO_TARGET':
      return healChromeCDP();
    case 'CASCADER_STUCK_OPEN':
      return await healCascaderDropdown();
    case 'DATE_PICKER_STUCK':
      return await healDatePicker();
    case 'EXPORT_PAGE_CRASH':
      return healPageCrash(dateStart, dateEnd);
    default:
      return false;
  }
}

function healChromeCDP() {
  const cdpBase = (process.env.CHAT_AUDIT_CRM_CDP_BASE || 'http://localhost:9222').replace(/\/$/, '');
  const versionUrl = `${cdpBase}/json/version`;
  const cdpPort = cdpPortFromBase(cdpBase);
  const home = process.env.HOME || '';

  try {
    let cdpUp = false;
    try {
      const check = execSync(`curl -sf "${versionUrl}" 2>/dev/null`, { encoding: 'utf8' });
      cdpUp = /chrome/i.test(check);
    } catch (_) {
      /* CDP HTTP down — cold start path below */
    }

    // CDP reachable: only tab-level recovery (preserve WeCom / CRM process state).
    if (cdpUp) {
      console.log('[self-heal] CDP up — reopening audit page via crm-preflight (no Chrome restart).');
      execSync('python3 scripts/crm-preflight.py navigate-audit', {
        cwd: SKILL_DIR,
        env: { ...process.env, CHAT_AUDIT_CRM_CDP_BASE: cdpBase },
        stdio: 'inherit',
      });
      execSync('sleep 3', { stdio: 'ignore' });
      return true;
    }

    // CDP down: cold-start one debug Chrome; do not pkill (per preserve-session spec).
    console.log('[self-heal] CDP down — cold-start Chrome (no pkill).');
    execSync(
      `open -a "Google Chrome" --args --remote-debugging-port=${cdpPort} --user-data-dir=${home}/.chrome-chat-audit-profile 2>/dev/null &`,
      { stdio: 'ignore' }
    );
    execSync('sleep 4', { stdio: 'ignore' });

    const result = execSync(`curl -s "${versionUrl}" 2>/dev/null | head -1`, { encoding: 'utf8' });
    if (/chrome/i.test(result)) {
      console.log('[self-heal] Chrome CDP started successfully');
      return true;
    }
  } catch (e) {
    console.log('[self-heal] Chrome CDP heal failed:', e.message);
  }
  return false;
}

async function healCascaderDropdown() {
  try {
    const { CDPClient } = require('./lib/cdp.js');
    const wsUrl = 'ws://localhost:9222/devtools/page/' + getCurrentPageId();
    const client = new CDPClient(wsUrl);
    await client.connect();

    const r = await client.send('Runtime.evaluate', {
      expression: `
        (function() {
          const dropdown = document.querySelector('.el-cascader__dropdown');
          if (dropdown) { dropdown.remove(); return 'removed'; }
          return 'not found';
        })()
      `,
      returnByValue: true,
    });
    await client.close();
    if (r.result?.value === 'removed') {
      console.log('[self-heal] Cascader dropdown removed');
      return true;
    }
  } catch (e) {
    console.log('[self-heal] Cascader dropdown removal failed:', e.message);
  }
  return false;
}

async function healDatePicker() {
  try {
    const { CDPClient } = require('./lib/cdp.js');
    const wsUrl = 'ws://localhost:9222/devtools/page/' + getCurrentPageId();
    const client = new CDPClient(wsUrl);
    await client.connect();

    const r = await client.send('Runtime.evaluate', {
      expression: `
        (function() {
          // Click body to close any open pickers
          document.body.click();
          return 'clicked body';
        })()
      `,
      returnByValue: true,
    });
    await client.close();
    console.log('[self-heal] Date picker closed');
    return true;
  } catch (e) {
    console.log('[self-heal] Date picker close failed:', e.message);
  }
  return false;
}

function healPageCrash(dateStart, dateEnd) {
  const { execSync } = require('node:child_process');
  const cdpBase = (process.env.CHAT_AUDIT_CRM_CDP_BASE || 'http://localhost:9222').replace(/\/$/, '');
  const pyEnv = { ...process.env, CHAT_AUDIT_CRM_CDP_BASE: cdpBase };
  try {
    // Re-navigate to audit page
    execSync('python3 scripts/crm-preflight.py navigate-audit', { cwd: SKILL_DIR, env: pyEnv, stdio: 'inherit' });
    execSync('sleep 5', { stdio: 'ignore' });

    // Re-apply filters
    execSync("python3 scripts/crm-preflight.py set-department --group '大客私域顾问-总'", {
      cwd: SKILL_DIR,
      env: pyEnv,
      stdio: 'inherit',
    });
    execSync(`python3 scripts/crm-preflight.py set-dates --date ${dateStart}`, {
      cwd: SKILL_DIR,
      env: pyEnv,
      stdio: 'inherit',
    });

    console.log('[self-heal] Page reloaded and filters re-applied');
    return true;
  } catch (e) {
    console.log('[self-heal] Page reload failed:', e.message);
    return false;
  }
}

function getCurrentPageId() {
  try {
    const http = require('node:http');
    const res = execSync('curl -s http://localhost:9222/json/list', { encoding: 'utf8' });
    const targets = JSON.parse(res);
    const page = targets.find(
      (t) => t.type === 'page' && t.url.includes('chatAudit')
    );
    if (page) {
      const match = page.webSocketDebuggerUrl.match(/page\/(.+)$/);
      return match ? match[1] : null;
    }
  } catch (e) { /* ignore */ }
  return null;
}

// ------------------------------------------------------------------
// Retry state persistence
// ------------------------------------------------------------------

const STATE_FILE = '/tmp/chat-audit-self-heal-state.json';

export function loadRetryState() {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return { errorCounts: {}, lastErrorType: null };
}

export function saveRetryState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

export function clearRetryState() {
  try {
    require('node:fs').unlinkSync(STATE_FILE);
  } catch (e) { /* ignore */ }
}

export function incrementRetryCount(state, errorType) {
  if (state.lastErrorType !== errorType.id) {
    // Different error type — reset counts
    state.errorCounts = {};
    state.lastErrorType = errorType.id;
  }
  state.errorCounts[errorType.id] = (state.errorCounts[errorType.id] || 0) + 1;
  saveRetryState(state);
  return state.errorCounts[errorType.id];
}
