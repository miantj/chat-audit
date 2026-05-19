import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { CDPClient } from './lib/cdp.js';
import { shouldPersistSnapshot } from './lib/chat-loading.js';
import {
  createEmptyCheckpoint,
  getDefaultCheckpointPath,
  isMetricCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
  shouldSkipMainPageBeforeCheckpoint,
  shouldSkipMetricCustomerBeforeCheckpoint,
  shouldSkipRowBeforeCheckpoint
} from './lib/checkpoint.js';
import { extractCustomerId, extractCustomerSearchTerms } from './lib/customer-id.js';
import { normalizeErrorMessage, shouldSkipConversationError, WxworkLoginRequiredError, RateLimitedError } from './lib/export-errors.js';
import { waitForFriendPageReady } from './lib/friend-page.js';
import { appendJsonlRecord, readJsonlRecords } from './lib/jsonl-store.js';
import { getDialogFilterAdjustments, setDialogDateRange, validateDialogFilters } from './lib/dialog-filters.js';
import { openDialogWithRetry } from './lib/dialog-open.js';
import {
  convertConversationToDataset,
  createEmptyDataset,
  upsertDatasetConversation
} from './lib/dataset.js';

let WAIT_MS = 1200;
let STABLE_POLL_MS = 1200;
let STABLE_ATTEMPTS = 12;
const MAX_MESSAGE_SCROLLS = Number(process.env.MAX_MESSAGE_SCROLLS || '80');
const MESSAGE_SCROLL_IDLE_LIMIT = Number(process.env.MESSAGE_SCROLL_IDLE_LIMIT || '3');
let CUSTOMER_DELAY_MIN_MS = Number(process.env.CUSTOMER_DELAY_MIN_MS || '1000');
let CUSTOMER_DELAY_MAX_MS = Number(process.env.CUSTOMER_DELAY_MAX_MS || '3000');
let EMPLOYEE_DELAY_MIN_MS = Number(process.env.EMPLOYEE_DELAY_MIN_MS || '5000');
let EMPLOYEE_DELAY_MAX_MS = Number(process.env.EMPLOYEE_DELAY_MAX_MS || '5000');
const CUSTOMERS_PER_BATCH = Number(process.env.CUSTOMERS_PER_BATCH || '10');
let BATCH_REST_MS = Number(process.env.BATCH_REST_MS || '5000');
let SEARCH_RESULT_DELAY_MIN_MS = Number(process.env.SEARCH_RESULT_DELAY_MIN_MS || '1500');
let SEARCH_RESULT_DELAY_MAX_MS = Number(process.env.SEARCH_RESULT_DELAY_MAX_MS || '4000');
let SELECT_FRIEND_DELAY_MIN_MS = Number(process.env.SELECT_FRIEND_DELAY_MIN_MS || '2000');
let SELECT_FRIEND_DELAY_MAX_MS = Number(process.env.SELECT_FRIEND_DELAY_MAX_MS || '5000');
let MESSAGE_SCROLL_DELAY_MIN_MS = Number(process.env.MESSAGE_SCROLL_DELAY_MIN_MS || '1500');
let MESSAGE_SCROLL_DELAY_MAX_MS = Number(process.env.MESSAGE_SCROLL_DELAY_MAX_MS || '4000');
const SAVE_EVERY = 10;
const EFFECTIVE_METRIC_CATEGORIES = [
  '总有效跟进好友数（人天）',
  '总有效咨询好友数（人天）'
];

/** Check if a file exists (for pause signal). */
async function checkFileExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function shouldStopExport({ shutdownRequested, stopFile }) {
  if (shutdownRequested()) {
    return true;
  }
  if (stopFile && (await checkFileExists(stopFile))) {
    return true;
  }
  return false;
}

function emitExportControlEvent(log, event, message) {
  if (log) {
    log(JSON.stringify({ event, message }));
  }
}

/** 仅扫主表行数，不打开员工弹窗 */
async function countPlannedEmployees(
  pageClient,
  { checkpoint, targetKeywords, maxRows }
) {
  let total = 0;
  let checkpointReached = !checkpoint.employee_name;
  let processedRowCount = 0;
  await closeTransientOverlays(pageClient);
  let mainPager = await getMainPager(pageClient);

  for (let mainPageNo = 1; mainPageNo <= mainPager.totalPages; mainPageNo++) {
    if (shouldSkipMainPageBeforeCheckpoint(checkpoint, mainPageNo)) {
      continue;
    }
    if (mainPager.currentPage !== mainPageNo) {
      const changed = await changeMainPage(pageClient, mainPageNo);
      if (!changed.ok) {
        break;
      }
      await sleep(WAIT_MS);
      mainPager = await getMainPager(pageClient);
    }
    const summaries = await getRowSummaries(pageClient);
    const rows =
      targetKeywords.length > 0
        ? summaries.filter((row) =>
            targetKeywords.some((keyword) => row.employeeName.includes(keyword))
          )
        : summaries;

    for (const row of rows) {
      if (processedRowCount >= maxRows) {
        return total;
      }
      if (shouldSkipRowBeforeCheckpoint(checkpoint, row.employeeName, checkpointReached)) {
        continue;
      }
      processedRowCount += 1;
      total += 1;
      if (!checkpoint.employee_name || row.employeeName === checkpoint.employee_name) {
        checkpointReached = true;
      }
    }
  }
  return total;
}

function conversationWillBeProcessed({
  checkpoint,
  row,
  target,
  dataset,
  checkpointReached,
  isRetryFailedPass,
  retryFailedConversations
}) {
  if (
    shouldSkipMetricCustomerBeforeCheckpoint(
      checkpoint,
      row.employeeName,
      target.metricCategory,
      target.metricPage,
      target.customerId,
      checkpointReached,
      EFFECTIVE_METRIC_CATEGORIES
    )
  ) {
    return false;
  }
  const conversationId = `${row.employeeName}__customer_${target.customerId}`;
  if (conversationAlreadyDone(dataset, conversationId)) {
    return false;
  }
  if (
    isRetryFailedPass &&
    retryFailedConversations &&
    !retryFailedConversations.includes(conversationId)
  ) {
    return false;
  }
  return true;
}

function countProcessableTargets(
  targets,
  row,
  dataset,
  ctx
) {
  let n = 0;
  for (const target of targets) {
    if (conversationWillBeProcessed({ ...ctx, row, target, dataset })) {
      n += 1;
    }
  }
  return n;
}

function employeeProgressPercent(current, total) {
  const n = Math.max(0, Number(current) || 0);
  const t = Number(total);
  if (t <= 0) return 0;
  if (n >= t) return 100;
  return Math.round((n / t) * 100);
}

const PROGRESS_DEBUG = process.env.CHAT_AUDIT_PROGRESS_DEBUG === '1';

function progressDebug(log, tag, detail) {
  if (!PROGRESS_DEBUG || !log) return;
  log(`[progress-debug] ${tag} ${JSON.stringify(detail)}`);
}

function reportExportStats(
  log,
  {
    current,
    total,
    message,
    reset = false,
    unit = 'employee',
    phase = null,
    debug = null
  }
) {
  if (!log) return;
  const n = Math.max(0, Number(current) || 0);
  const t = Number(total);
  const pct = employeeProgressPercent(n, t);
  const isRetry = unit === 'conversation' || phase === 'retry-failed';
  const isResume = phase === 'resume';
  const defaultMessage = isRetry
    ? t > 0
      ? `续传 ${n}/${t}（${pct}%）`
      : `续传 ${n}`
    : isResume
      ? t > 0
        ? `续传 ${n}/${t}（${pct}%）`
        : `续传 ${n}`
      : t > 0
        ? `员工 ${n}/${t}（${pct}%）`
        : `员工 ${n}`;
  const payload = {
    event: 'export-progress',
    current: n,
    total: t > 0 ? t : -1,
    reset: Boolean(reset),
    unit: isRetry ? 'conversation' : 'employee',
    phase: isRetry ? 'retry-failed' : isResume ? 'resume' : phase,
    message: message || defaultMessage
  };
  if (PROGRESS_DEBUG && debug) {
    payload.debug = debug;
  }
  log(JSON.stringify(payload));
}

/** 同一次暂停只向 UI 发一对 paused/resumed（避免分段 sleep 重复通知） */
const pauseGate = { uiPaused: false, depth: 0 };

function resetPauseGate() {
  pauseGate.uiPaused = false;
  pauseGate.depth = 0;
}

async function waitWhilePaused({ pauseFile, stopFile, shutdownRequested, log }) {
  if (!pauseFile) {
    return;
  }
  if (!(await checkFileExists(pauseFile))) {
    return;
  }

  if (!pauseGate.uiPaused) {
    pauseGate.uiPaused = true;
    emitExportControlEvent(log, 'export-paused', '导出已暂停');
  }

  pauseGate.depth += 1;
  let lastHeartbeat = 0;
  const pollMs = 400;

  try {
    while (await checkFileExists(pauseFile)) {
      if (await shouldStopExport({ shutdownRequested, stopFile })) {
        return;
      }
      if (Date.now() - lastHeartbeat >= 30000) {
        log('[pause] 仍在暂停中…');
        lastHeartbeat = Date.now();
      }
      await sleep(pollMs);
    }
  } finally {
    pauseGate.depth = Math.max(0, pauseGate.depth - 1);
    if (pauseGate.depth === 0 && pauseGate.uiPaused) {
      pauseGate.uiPaused = false;
      emitExportControlEvent(log, 'export-resumed', '导出已继续');
    }
  }
}

/** 分段 sleep，便于滚动/等待期间尽快响应暂停 */
async function sleepWithPauseCheck(ms, { pauseFile, stopFile, shutdownRequested, log }) {
  if (!pauseFile || ms <= 0) {
    await sleep(ms);
    return;
  }
  const chunk = 300;
  let left = ms;
  while (left > 0) {
    await waitWhilePaused({ pauseFile, stopFile, shutdownRequested, log });
    const step = Math.min(chunk, left);
    await sleep(step);
    left -= step;
  }
}

const visibleDialogExpr = `
(() => {
  const dialogs = Array.from(document.querySelectorAll('.el-dialog.v-chat-moadl'));
  return dialogs.find((el) => {
    const rect = el.getBoundingClientRect();
    const text = el.innerText || '';
    return rect.width > 300 && rect.height > 300 && text.includes('沟通内容');
  }) || null;
})()
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  const lower = Math.max(0, Math.floor(Number(min) || 0));
  const upper = Math.max(lower, Math.floor(Number(max) || lower));
  return lower + Math.floor(Math.random() * (upper - lower + 1));
}

async function pacedSleep({ enabled, minMs, maxMs, label, log }) {
  if (!enabled) return 0;
  const ms = randomInt(minMs, maxMs);
  if (ms > 0 && log) {
    log(`[paced] wait ${ms}ms${label ? ` ${label}` : ''}`);
  }
  await sleep(ms);
  return ms;
}

async function loadDataset(filePath, jsonlPath) {
  let dataset;
  try {
    const text = await fs.readFile(filePath, 'utf8');
    dataset = JSON.parse(text);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      dataset = createEmptyDataset();
    } else {
      throw error;
    }
  }

  const jsonlRecords = await readJsonlRecords(jsonlPath);
  for (const conversation of jsonlRecords) {
    upsertDatasetConversation(dataset, conversation);
  }

  return dataset;
}

async function saveDataset(filePath, dataset) {
  dataset.dataset_meta.exported_at = new Date().toISOString();
  await fs.writeFile(filePath, JSON.stringify(dataset, null, 2), 'utf8');
}

function getTargets() {
  // URL must use 'localhost' not '127.0.0.1' — Chrome CDP may only listen on IPv6 ([::1])
  // after a bind() failure on the IPv4 socket (port conflict).
  return new Promise((resolve, reject) => {
    http.get('http://localhost:9222/json/list', (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('CDP JSON parse failed: ' + e.message)); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function findMessageIframeParentId(targets) {
  return targets.find((item) => item.type === 'iframe' && item.url.includes('ww-open-data-frame'))?.parentId || null;
}

async function getClient(predicate) {
  const target = (await getTargets()).find(predicate);
  if (!target) {
    throw new Error('target not found');
  }
  const client = new CDPClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable');
  return client;
}

async function inspectPageState(target) {
  const client = new CDPClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable');
  try {
    return await evalJson(
      client,
      `(() => {
        const dialog = ${visibleDialogExpr};
        const tableRows = document.querySelectorAll('.el-table__body-wrapper tbody tr').length;
        return {
          href: location.href,
          title: document.title,
          hasFocus: document.hasFocus(),
          visibilityState: document.visibilityState,
          rowCount: tableRows,
          dialogVisible: !!dialog
        };
      })()`
    );
  } finally {
    await client.close();
  }
}

async function getPageSession() {
  const allTargets = await getTargets();
  const candidates = allTargets.filter((item) => item.type === 'page' && item.url.includes('chatAudit'));
  if (!candidates.length) {
    throw new Error('chatAudit page target not found');
  }
  const iframeParentId = findMessageIframeParentId(allTargets);

  const states = [];
  for (const target of candidates) {
    try {
      const state = await inspectPageState(target);
      states.push({ target, state });
    } catch {
      // ignore broken targets and continue with others
    }
  }

  const selected =
    states.find((entry) => entry.state.dialogVisible) ||
    states.find((entry) => entry.target.id === iframeParentId) ||
    states.find((entry) => entry.state.visibilityState === 'visible') ||
    states.find((entry) => entry.state.hasFocus) ||
    states.find((entry) => entry.state.rowCount > 0) ||
    states[0];

  if (!selected) {
    throw new Error('active chatAudit page not found');
  }

  const client = new CDPClient(selected.target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable');
  return { client, target: selected.target, state: selected.state };
}

async function checkWxworkLoginState(parentPageId) {
  const allTargets = await getTargets();
  const dataIframe = allTargets.find(
    (item) =>
      item.type === 'iframe' &&
      item.url.includes('ww-open-data-frame') &&
      (!parentPageId || item.parentId === parentPageId)
  );
  if (dataIframe) {
    return;
  }

  const loginIframe = allTargets.find(
    (item) =>
      item.type === 'iframe' &&
      item.url.includes('login.work.weixin.qq.com') &&
      (!parentPageId || item.parentId === parentPageId)
  );
  if (loginIframe) {
    throw new WxworkLoginRequiredError();
  }
}

async function checkRateLimitState(pageClient) {
  const state = await evalJson(
    pageClient,
    `(() => {
      const text = (document.body?.innerText || '').replace(/\\s+/g, ' ');
      const match = text.match(/请求过于频繁|操作过于频繁|访问过于频繁|频繁操作|请稍后再试/);
      return { limited: !!match, message: match ? match[0] : '' };
    })()`
  );
  if (state.limited) {
    throw new RateLimitedError(`RATE_LIMITED: ${state.message || '页面提示请求过于频繁'}，已保存进度，请稍后从断点继续`);
  }
  return state;
}

async function getIframeClient(parentPageId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    const targets = (await getTargets()).filter(
      (item) =>
        item.type === 'iframe' &&
        item.url.includes('ww-open-data-frame') &&
        (!parentPageId || item.parentId === parentPageId)
    );

    for (const target of targets) {
      const client = new CDPClient(target.webSocketDebuggerUrl);
      await client.connect();
      await client.send('Runtime.enable');

      try {
        const probe = await evalJson(
          client,
          `(() => ({
            msgWraps: document.querySelectorAll('.qw-msg-wrap').length,
            hasTask: !!document.querySelector('.task')
          }))()`
        );

        if (probe.msgWraps > 0 || !probe.hasTask) {
          return client;
        }
      } catch {
        // keep probing other iframe targets
      }

      await client.close();
    }

    await sleep(500);
  }
  await checkWxworkLoginState(parentPageId);
  throw new Error('message iframe target not found');
}

async function evalJson(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression: `JSON.stringify(${expression})`,
    returnByValue: true,
    awaitPromise: true
  });
  return JSON.parse(result.result.value);
}

async function getRowSummaries(pageClient) {
  return evalJson(
    pageClient,
    `(() => Array.from(document.querySelectorAll('.el-table__body-wrapper tbody tr')).map((row, rowIndex) => {
      const lines = (row.innerText || '')
        .split(/\\n+/)
        .map((value) => value.trim())
        .filter(Boolean);

      return {
        rowIndex,
        employeeName: (row.querySelector('.cell:first-child')?.innerText || lines[0] || '').trim(),
        department: (row.querySelectorAll('.cell')[1]?.innerText || lines[1] || '').trim(),
        friendCount: (row.querySelectorAll('.cell')[2]?.innerText || lines[2] || '').trim(),
        lastChatAt: (row.querySelectorAll('.cell')[3]?.innerText || lines[3] || '').trim()
      };
    }))()`
  );
}

async function getMainPager(pageClient) {
  return evalJson(
    pageClient,
    `(() => {
      const vm = document.querySelector('.el-table')?.__vue__?.$parent;
      const pagination = vm?.pagination || {};
      return {
        currentPage: Number(pagination.pageNo || 1),
        pageSize: Number(pagination.pageSize || 50),
        totalCount: Number(pagination.totalCount || 0),
        totalPages: Math.max(1, Math.ceil(Number(pagination.totalCount || 0) / Number(pagination.pageSize || 50)))
      };
    })()`
  );
}

async function changeMainPage(pageClient, pageNo) {
  return evalJson(
    pageClient,
    `(() => {
      const vm = document.querySelector('.el-table')?.__vue__?.$parent;
      if (!vm || typeof vm.changePageNo !== 'function') return { ok: false };
      vm.changePageNo(${pageNo});
      return { ok: true };
    })()`
  );
}

async function closeTransientOverlays(pageClient) {
  await pageClient.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
  await pageClient.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
  await sleep(300);
}

async function openRowDialog(pageClient, rowIndex) {
  return evalJson(
    pageClient,
    `(() => {
      const rows = Array.from(document.querySelectorAll('.el-table__body-wrapper tbody tr'));
      const row = rows[${rowIndex}];
      if (!row) return { ok: false, reason: 'row-missing', length: rows.length };

      const table = document.querySelector('.el-table');
      const vm = table?.__vue__?.$parent;
      const rowData = vm?.dataList?.[${rowIndex}];
      if (rowData && typeof vm?.goToContent === 'function') {
        vm.goToContent(rowData);
        return { ok: true, method: 'goToContent' };
      }

      const clickTarget =
        row.querySelector('.text-btn.v-operation') ||
        Array.from(row.querySelectorAll('*')).find((el) => /聊天内容/.test((el.textContent || '').trim()));

      if (clickTarget) {
        clickTarget.click();
        return { ok: true, method: 'click' };
      }
      if (!vm) return { ok: false, reason: 'component-missing' };
      if (!rowData) return { ok: false, reason: 'rowdata-missing', length: vm.dataList?.length || 0 };
      return { ok: false, reason: 'open-action-missing' };
    })()`
  );
}

async function waitForChatDialog(pageClient, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await evalJson(
      pageClient,
      `(() => {
        const dialog = ${visibleDialogExpr};
        return {
          exists: !!dialog,
          friendCount: dialog ? dialog.querySelectorAll('.friend-li').length : 0
        };
      })()`
    );
    if (result.exists && result.friendCount > 0) {
      return result;
    }
    await sleep(500);
  }
  return { exists: false, friendCount: 0 };
}

async function closeRowDialog(pageClient) {
  await evalJson(
    pageClient,
    `(() => {
      const dialog = ${visibleDialogExpr};
      const button = dialog?.querySelector('.el-dialog__headerbtn');
      if (!button) return { ok: false };
      button.click();
      return { ok: true };
    })()`
  );
}

async function getFriendPager(pageClient) {
  return evalJson(
    pageClient,
    `(() => {
      const dialog = ${visibleDialogExpr};
      const text = (dialog?.querySelector('.pagination-text')?.textContent || '').trim();
      const totalText = (dialog?.querySelector('.total-text')?.textContent || '').trim();
      const pageMatch = text.match(/(\\d+)\\s*／\\s*(\\d+)/);
      const totalMatch = totalText.match(/共\\s*(\\d+)\\s*条/);
      return {
        currentPage: pageMatch ? Number(pageMatch[1]) : 1,
        totalPages: pageMatch ? Number(pageMatch[2]) : 1,
        totalItems: totalMatch ? Number(totalMatch[1]) : null
      };
    })()`
  );
}

async function getDialogFilters(pageClient) {
  return evalJson(
    pageClient,
    `(() => {
      const dialog = ${visibleDialogExpr};
      const activeNode = Array.from(dialog?.querySelectorAll('.menu-li-active, .tab-li-active') || []);
      return {
        title: (dialog?.querySelector('.el-dialog__title')?.textContent || '').trim(),
        dateRange: Array.from(dialog?.querySelectorAll('input') || [])
          .map((el) => (el.value || '').trim())
          .filter(Boolean)
          .slice(0, 2),
        categoryText: (activeNode.find((el) => el.classList.contains('menu-li-active'))?.textContent || '').trim(),
        activeTabText: (activeNode.find((el) => el.classList.contains('tab-li-active'))?.textContent || '').trim(),
        pagerText: (dialog?.querySelector('.pagination-text')?.textContent || '').trim(),
        totalText: (dialog?.querySelector('.total-text')?.textContent || '').trim()
      };
    })()`
  );
}

async function clickDialogCategory(pageClient, categoryIncludes) {
  return evalJson(
    pageClient,
    `(() => {
      const dialog = ${visibleDialogExpr};
      const items = Array.from(dialog?.querySelectorAll('li.menu-li') || []);
      const target = items.find((el) => (el.textContent || '').includes(${JSON.stringify(categoryIncludes)}));
      if (!target) return { ok: false, reason: 'category-missing' };
      target.click();
      return { ok: true, text: (target.textContent || '').trim() };
    })()`
  );
}

async function clickDialogTab(pageClient, tabText) {
  return evalJson(
    pageClient,
    `(() => {
      const dialog = ${visibleDialogExpr};
      const items = Array.from(dialog?.querySelectorAll('li.tab-li') || []);
      const target = items.find((el) => (el.textContent || '').trim() === ${JSON.stringify(tabText)});
      if (!target) return { ok: false, reason: 'tab-missing' };
      target.click();
      return { ok: true, text: (target.textContent || '').trim() };
    })()`
  );
}

async function getFriendItems(pageClient) {
  return evalJson(
    pageClient,
    `(() => {
      const dialog = ${visibleDialogExpr};
      return Array.from(dialog?.querySelectorAll('.friend-li') || []).map((el, friendIndex) => ({
        friendIndex,
        text: (el.innerText || '').replace(/\\n+/g, ' | ').trim(),
        active: el.classList.contains('friend-li-active')
      }));
    })()`
  );
}

async function clickFriendItem(pageClient, friendIndex) {
  return evalJson(
    pageClient,
    `(() => {
      const dialog = ${visibleDialogExpr};
      const items = dialog?.querySelectorAll('.friend-li') || [];
      const target = items[${friendIndex}];
      if (!target) return { ok: false, reason: 'friend-missing' };
      target.click();
      return { ok: true, text: (target.innerText || '').replace(/\\n+/g, ' | ').trim() };
    })()`
  );
}

async function clickFriendNextPage(pageClient) {
  return evalJson(
    pageClient,
    `(() => {
      const dialog = ${visibleDialogExpr};
      const angles = dialog?.querySelectorAll('.pagination-angle') || [];
      const target = angles[1];
      if (!target) return { ok: false, reason: 'next-missing' };
      target.click();
      return { ok: true };
    })()`
  );
}

async function waitForFriendPageItems(pageClient, targetPage) {
  return waitForFriendPageReady({
    targetPage,
    getPager: async () => getFriendPager(pageClient),
    getItems: async () => getFriendItems(pageClient),
    sleep,
    maxAttempts: 10,
    intervalMs: 500
  });
}

function parseCountFromText(text) {
  const match = String(text || '').match(/[(（]\s*(\d+)\s*[)）]/);
  return match ? Number(match[1]) : null;
}

async function waitForMetricTable(pageClient, metricCategory, previousSignature = '', timeoutMs = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await evalJson(
      pageClient,
      `(() => {
        const dialog = ${visibleDialogExpr};
        const activeMenu = Array.from(dialog?.querySelectorAll('.menu-li-active') || [])
          .map((el) => (el.textContent || '').trim())
          .find((text) => text.includes(${JSON.stringify(metricCategory)})) || '';
        const menuText = Array.from(dialog?.querySelectorAll('li.menu-li') || [])
          .map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim())
          .find((text) => text.includes(${JSON.stringify(metricCategory)})) || '';
        const rows = Array.from(dialog?.querySelectorAll('.el-table__body-wrapper tbody tr') || []);
        const headerText = Array.from(dialog?.querySelectorAll('.el-table__header-wrapper th') || [])
          .map((el) => (el.textContent || '').trim())
          .join('|');
        const rowSignature = rows.slice(0, 3).map((row) => (row.innerText || '').replace(/\\s+/g, ' ').trim()).join('||');
        const totalText = (dialog?.querySelector('.total-text')?.textContent || '').trim();
        return {
          exists: !!dialog,
          activeMenu,
          menuText,
          rowCount: rows.length,
          headerText,
          rowSignature,
          totalText
        };
      })()`
    );
    const expectedCount = parseCountFromText(result.menuText);
    const totalMatch = String(result.totalText || '').match(/共\s*(\d+)\s*条/);
    const totalItems = totalMatch ? Number(totalMatch[1]) : null;
    const activeOk = result.activeMenu.includes(metricCategory);
    const tableOk = result.headerText.includes('客户信息') && (result.rowCount > 0 || expectedCount === 0);
    const countOk = expectedCount == null || totalItems == null || totalItems === expectedCount;
    const changedOk =
      !previousSignature ||
      result.rowSignature !== previousSignature ||
      expectedCount === 0 ||
      Date.now() - startedAt > 1500;
    if (result.exists && activeOk && tableOk && countOk && changedOk) {
      return result;
    }
    await sleep(500);
  }
  return { exists: false, rowCount: 0, headerText: '', activeMenu: '', menuText: '', totalText: '' };
}

async function clickMetricCategory(pageClient, categoryText) {
  const before = await evalJson(
    pageClient,
    `(() => {
      const dialog = ${visibleDialogExpr};
      const rows = Array.from(dialog?.querySelectorAll('.el-table__body-wrapper tbody tr') || []);
      return rows.slice(0, 3).map((row) => (row.innerText || '').replace(/\\s+/g, ' ').trim()).join('||');
    })()`
  );
  const clicked = await clickDialogCategory(pageClient, categoryText);
  if (!clicked.ok) {
    return { ...clicked, ready: false };
  }
  const ready = await waitForMetricTable(pageClient, categoryText, before);
  return {
    ...clicked,
    ready: ready.exists,
    rowCount: ready.rowCount,
    headerText: ready.headerText,
    activeMenu: ready.activeMenu,
    menuText: ready.menuText,
    totalText: ready.totalText
  };
}

async function getMetricPager(pageClient) {
  return getFriendPager(pageClient);
}

async function clickMetricNextPage(pageClient) {
  return clickFriendNextPage(pageClient);
}

async function getMetricCustomerRows(pageClient, metricCategory, metricPage) {
  const rows = await evalJson(
    pageClient,
    `(() => {
      const dialog = ${visibleDialogExpr};
      const table = dialog?.querySelector('.el-table');
      const bodyRows = Array.from(table?.querySelectorAll('.el-table__body-wrapper tbody tr') || []);
      return bodyRows.map((row, rowIndex) => {
        const cells = Array.from(row.querySelectorAll('.cell')).map((cell) =>
          (cell.innerText || cell.textContent || '').replace(/\\n+/g, ' ').trim()
        );
        const lines = (row.innerText || '')
          .split(/\\n+/)
          .map((value) => value.trim())
          .filter(Boolean);
        const customerInfo = cells[0] || lines[0] || '';
        return {
          rowIndex,
          customerInfo,
          rowText: (row.innerText || '').replace(/\\n+/g, ' | ').trim()
        };
      });
    })()`
  );

  return rows.map((row) => ({
    ...row,
    metricCategory,
    metricPage,
    customerId: extractCustomerId(row.customerInfo)
  }));
}

async function waitForMetricPageRows(pageClient, metricCategory, targetPage) {
  return waitForFriendPageReady({
    targetPage,
    getPager: async () => getMetricPager(pageClient),
    getItems: async () => getMetricCustomerRows(pageClient, metricCategory, targetPage),
    sleep,
    maxAttempts: 10,
    intervalMs: 500
  });
}

async function switchToCommunicationExternalFriends(pageClient) {
  const category = await clickDialogCategory(pageClient, '沟通内容');
  await sleep(500);
  const tab = await clickDialogTab(pageClient, '外部好友');
  await sleep(800);
  const searchReady = await waitForFriendSearchInput(pageClient);
  return { ok: category.ok && tab.ok && searchReady, category, tab, searchReady };
}

function findFriendListMatch(items, customerId) {
  const id = String(customerId || '');
  if (!id) return undefined;
  return items.find((item) => (item.text || '').includes(id));
}

async function dispatchEnterKey(pageClient) {
  await pageClient.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  });
  await pageClient.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  });
}

async function waitForFriendSearchInput(pageClient, maxMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxMs) {
    const state = await evalJson(
      pageClient,
      `(() => {
        const dialog = ${visibleDialogExpr};
        if (!dialog) return { ok: false, reason: 'dialog-missing' };
        const inputs = Array.from(dialog.querySelectorAll('input'));
        const input =
          inputs.find((el) => /搜索好友|好友昵称|备注/.test(el.getAttribute('placeholder') || '')) ||
          inputs.find(
            (el) =>
              !/年|月|日|date|YYYY/i.test(el.getAttribute('placeholder') || '') &&
              el.type !== 'hidden'
          );
        return { ok: !!input, placeholder: input?.getAttribute('placeholder') || '' };
      })()`
    );
    if (state.ok) return true;
    await sleep(300);
  }
  return false;
}

async function fillFriendSearchInput(pageClient, query) {
  const q = String(query);
  const filled = await evalJson(
    pageClient,
    `(() => {
      const dialog = ${visibleDialogExpr};
      if (!dialog) return { ok: false, reason: 'dialog-missing' };
      const inputs = Array.from(dialog.querySelectorAll('input'));
      const input =
        inputs.find((el) => /搜索好友|好友昵称|备注/.test(el.getAttribute('placeholder') || '')) ||
        inputs.find(
          (el) =>
            !/年|月|日|date|YYYY/i.test(el.getAttribute('placeholder') || '') &&
            el.type !== 'hidden'
        );
      if (!input) return { ok: false, reason: 'search-input-missing' };

      input.focus();
      input.click();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      const text = ${JSON.stringify(q)};
      if (setter) setter.call(input, '');
      else input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (setter) setter.call(input, text);
      else input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));

      return {
        ok: true,
        value: input.value || '',
        placeholder: input.getAttribute('placeholder') || ''
      };
    })()`
  );
  if (!filled.ok) {
    return filled;
  }

  await sleep(200);
  await dispatchEnterKey(pageClient);
  await sleep(200);

  const clicked = await evalJson(
    pageClient,
    `(() => {
      const dialog = ${visibleDialogExpr};
      const inputs = Array.from(dialog?.querySelectorAll('input') || []);
      const input =
        inputs.find((el) => (el.value || '') === ${JSON.stringify(q)}) ||
        inputs.find((el) => /搜索好友|好友昵称|备注/.test(el.getAttribute('placeholder') || ''));
      const root = input?.closest('.el-input') || input?.parentElement;
      const suffix = root?.querySelector('.el-input__suffix, .el-input__suffix-inner');
      const searchIcon =
        suffix?.querySelector('.el-icon-search, [class*="search"]') ||
        root?.querySelector('.el-icon-search, [class*="search"]');
      const appendBtn = input?.closest('.el-input-group')?.querySelector(
        '.el-input-group__append button, .el-input-group__append .el-button'
      );
      const target = searchIcon || appendBtn;
      if (target) {
        target.click();
        return { ok: true, clickedSearchIcon: true };
      }
      return { ok: true, clickedSearchIcon: false };
    })()`
  );

  return {
    ok: true,
    value: filled.value,
    placeholder: filled.placeholder,
    clickedSearchIcon: clicked.clickedSearchIcon
  };
}

async function searchExternalFriendByCustomerId(pageClient, customerId, customerInfo = '') {
  const searchTerms = extractCustomerSearchTerms(customerInfo, customerId);
  if (searchTerms.length === 0) {
    return { ok: false, reason: 'search-term-missing' };
  }

  let lastItems = [];
  for (const term of searchTerms) {
    const typed = await fillFriendSearchInput(pageClient, term);
    if (!typed.ok) {
      return typed;
    }
    await sleep(600);

    const startedAt = Date.now();
    while (Date.now() - startedAt < 15000) {
      const results = await getFriendItems(pageClient);
      lastItems = results;
      const match = findFriendListMatch(results, customerId);
      if (match) {
        return { ok: true, items: results, match, searchTerm: term };
      }
      await sleep(500);
    }
  }

  return {
    ok: false,
    reason: 'search-result-missing',
    items: lastItems,
    searchTerms,
    sampleItems: lastItems.slice(0, 5).map((item) => item.text)
  };
}

async function selectSearchedFriend(pageClient, customerId, friendIndex = null) {
  if (friendIndex != null && Number.isFinite(friendIndex)) {
    const clicked = await clickFriendItem(pageClient, friendIndex);
    if (clicked.ok) {
      await sleep(WAIT_MS);
    }
    return clicked;
  }

  const idJson = JSON.stringify(String(customerId || ''));
  const result = await evalJson(
    pageClient,
    `(() => {
      const dialog = ${visibleDialogExpr};
      const items = Array.from(dialog?.querySelectorAll('.friend-li') || []);
      const target = items.find((el) => {
        const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ');
        return ${idJson} && text.includes(${idJson});
      });
      if (!target) return { ok: false, reason: 'friend-missing' };
      target.click();
      return {
        ok: true,
        text: (target.innerText || '').replace(/\\n+/g, ' | ').trim()
      };
    })()`
  );
  if (result.ok) {
    await sleep(WAIT_MS);
  }
  return result;
}

function mergeMetricCustomerTargets(targets) {
  const map = new Map();
  for (const target of targets) {
    if (!target.customerId) continue;
    const key = `${target.employeeName}__${target.customerId}`;
    const existing = map.get(key);
    if (existing) {
      if (!existing.sourceMetricCategories.includes(target.metricCategory)) {
        existing.sourceMetricCategories.push(target.metricCategory);
      }
      existing.metricRows.push({
        metricCategory: target.metricCategory,
        metricPage: target.metricPage,
        rowIndex: target.rowIndex,
        customerInfo: target.customerInfo,
        rowText: target.rowText
      });
      continue;
    }

    map.set(key, {
      ...target,
      sourceMetricCategories: [target.metricCategory],
      metricRows: [{
        metricCategory: target.metricCategory,
        metricPage: target.metricPage,
        rowIndex: target.rowIndex,
        customerInfo: target.customerInfo,
        rowText: target.rowText
      }]
    });
  }
  return Array.from(map.values());
}

async function collectMetricCustomerTargets(pageClient, employeeName, log) {
  const targets = [];

  for (const metricCategory of EFFECTIVE_METRIC_CATEGORIES) {
    const clicked = await clickMetricCategory(pageClient, metricCategory);
    log(`[metric] category=${metricCategory} ok=${clicked.ok} ready=${clicked.ready} rows=${clicked.rowCount || 0}`);
    if (!clicked.ok || !clicked.ready) {
      continue;
    }

    let pager = await getMetricPager(pageClient);
    for (let metricPage = 1; metricPage <= pager.totalPages; metricPage++) {
      const pageState = await waitForMetricPageRows(pageClient, metricCategory, metricPage);
      const rows = pageState.items || [];
      log(`[metric] ${metricCategory} page=${metricPage}/${pageState.pager.totalPages} rows=${rows.length}`);

      for (const row of rows) {
        if (!row.customerId) {
          log(`[metric] skip row without customer id category=${metricCategory} text=${row.customerInfo || row.rowText}`);
          continue;
        }
        targets.push({
          ...row,
          employeeName
        });
      }

      if (metricPage < pageState.pager.totalPages) {
        const next = await clickMetricNextPage(pageClient);
        log(`[metric] next ok=${next.ok}`);
        await sleep(WAIT_MS);
        pager = await getMetricPager(pageClient);
      } else {
        pager = pageState.pager;
      }
    }
  }

  return mergeMetricCustomerTargets(targets);
}

async function extractIframeMessages(iframeClient) {
  return evalJson(
    iframeClient,
    `(() => ({
      scroll: (() => {
        const candidates = [
          document.scrollingElement,
          document.documentElement,
          document.body,
          ...Array.from(document.querySelectorAll('*')).filter((el) => {
            const style = getComputedStyle(el);
            return /(auto|scroll)/.test(style.overflowY || '') && el.scrollHeight > el.clientHeight + 20;
          })
        ].filter(Boolean);
        const el = candidates
          .filter((item, index, arr) => arr.indexOf(item) === index)
          .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0] || document.scrollingElement || document.documentElement || document.body;
        return {
          top: el.scrollTop || 0,
          height: el.scrollHeight || 0,
          clientHeight: el.clientHeight || 0,
          atBottom: (el.scrollTop || 0) + (el.clientHeight || 0) >= (el.scrollHeight || 0) - 4
        };
      })(),
      messages: Array.from(document.querySelectorAll('.qw-msg-wrap')).map((node) => {
        const msgBox = node.querySelector('.qw-msg');
        const typeClass = Array.from(node.classList).find((name) => name.startsWith('qw-') && !['qw-msg-wrap', 'qw-msg-wrap-left', 'qw-msg-wrap-right'].includes(name)) || 'unknown';
        return {
          direction: node.classList.contains('qw-msg-wrap-right') ? 'right' : 'left',
          type: typeClass.replace(/^qw-/, ''),
          sender: (node.querySelector('.qw-name-wrap')?.textContent || '').trim(),
          time: (node.querySelector('.qw-time-wrap')?.textContent || '').trim(),
          text: (msgBox?.innerText || '').trim(),
          html: (msgBox?.innerHTML || '').slice(0, 1200),
          links: Array.from(node.querySelectorAll('a')).map((el) => ({
            text: (el.textContent || '').trim(),
            href: el.href || ''
          })),
          images: Array.from(msgBox?.querySelectorAll('img') || []).map((el) => ({
            alt: el.alt || '',
            src: el.src || ''
          })),
          videos: Array.from(msgBox?.querySelectorAll('video') || []).map((el) => ({
            src: el.src || el.getAttribute('data-src') || '',
            poster: el.poster || ''
          }))
        };
      })
    }))()`
  );
}

async function scrollIframeMessagesForward(iframeClient, { paced = false } = {}) {
  const scrollFactor = paced ? (0.35 + Math.random() * 0.3) : 0.85;
  return evalJson(
    iframeClient,
    `(() => {
      const candidates = [
        document.scrollingElement,
        document.documentElement,
        document.body,
        ...Array.from(document.querySelectorAll('*')).filter((el) => {
          const style = getComputedStyle(el);
          return /(auto|scroll)/.test(style.overflowY || '') && el.scrollHeight > el.clientHeight + 20;
        })
      ].filter(Boolean);
      const el = candidates
        .filter((item, index, arr) => arr.indexOf(item) === index)
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0] || document.scrollingElement || document.documentElement || document.body;
      const before = {
        top: el.scrollTop || 0,
        height: el.scrollHeight || 0,
        clientHeight: el.clientHeight || 0
      };
      el.scrollBy(0, Math.max(${paced ? 240 : 600}, Math.floor((el.clientHeight || window.innerHeight || 800) * ${scrollFactor})));
      const after = {
        top: el.scrollTop || 0,
        height: el.scrollHeight || 0,
        clientHeight: el.clientHeight || 0
      };
      return {
        before,
        after,
        moved: before.top !== after.top || before.height !== after.height,
        atBottom: (after.top || 0) + (after.clientHeight || 0) >= (after.height || 0) - 4
      };
    })()`
  );
}

function normalizeMessageTimeText(value) {
  return (value || '')
    .replace(/[年/]/g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMessageTime(value) {
  const normalized = normalizeMessageTimeText(value);
  const match = normalized.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '0'] = match;
  const pad = (item) => String(item).padStart(2, '0');
  return {
    value: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`,
    date: `${year}-${pad(month)}-${pad(day)}`
  };
}

function getDateRangeBounds(dateStart, dateEnd) {
  return {
    start: `${dateStart} 00:00:00`,
    end: `${dateEnd} 23:59:59`
  };
}

function buildRawMessageKey(message) {
  return JSON.stringify({
    direction: message.direction || '',
    type: message.type || '',
    sender: message.sender || '',
    time: message.time || '',
    text: message.text || ''
  });
}

function filterMessagesByDateRange(messages, dateStart, dateEnd) {
  const bounds = getDateRangeBounds(dateStart, dateEnd);
  const inRange = [];
  let beforeRangeCount = 0;
  let afterRangeCount = 0;
  let unparsedCount = 0;
  let sawAfterRange = false;

  for (const message of messages || []) {
    const parsed = parseMessageTime(message.time);
    if (!parsed) {
      unparsedCount += 1;
      continue;
    }

    if (parsed.value < bounds.start) {
      beforeRangeCount += 1;
      continue;
    }

    if (parsed.value > bounds.end) {
      afterRangeCount += 1;
      sawAfterRange = true;
      continue;
    }

    inRange.push(message);
  }

  return {
    messages: inRange,
    filteredOutMessageCount: beforeRangeCount + afterRangeCount + unparsedCount,
    beforeRangeCount,
    afterRangeCount,
    unparsedCount,
    sawAfterRange
  };
}

/**
 * Click all "转文字" buttons on voice messages in the iframe.
 * Returns the number of buttons found.
 */
async function clickVoiceTranscribeButtons(iframeClient) {
  const result = await evalJson(
    iframeClient,
    `(() => {
    const buttons = [];
    // Look for buttons/links/elements containing "转文字" text
    const allNodes = document.querySelectorAll('.qw-msg-wrap button, .qw-msg-wrap span, .qw-msg-wrap a, .qw-msg-wrap div');
    for (const node of allNodes) {
      if (/转文字/i.test(node.textContent || '')) {
        buttons.push(node);
        try { node.click(); } catch(e) { /* ignore */ }
      }
    }
    // Also try generic text search within voice messages
    if (buttons.length === 0) {
      const voiceNodes = document.querySelectorAll('[class*="voice"]');
      for (const node of voiceNodes) {
        if (/转文字/i.test(node.textContent || '')) {
          buttons.push(node);
          try { node.click(); } catch(e) { /* ignore */ }
        }
      }
    }
    return { count: buttons.length };
  })()`
  );
  return (result && result.count) || 0;
}

/**
 * Wait for voice transcription to complete: poll until no more "转文字" buttons exist
 * or until max attempts reached.
 */
async function waitForVoiceTranscriptions(
  iframeClient,
  pauseCtx = null,
  maxAttempts = 10,
  intervalMs = 1000
) {
  for (let i = 0; i < maxAttempts; i++) {
    if (pauseCtx) {
      await waitWhilePaused(pauseCtx);
    }
    if (pauseCtx) {
      await sleepWithPauseCheck(intervalMs, pauseCtx);
    } else {
      await sleep(intervalMs);
    }
    const result = await evalJson(
      iframeClient,
      `(() => {
      const nodes = document.querySelectorAll('.qw-msg-wrap button, .qw-msg-wrap span, .qw-msg-wrap a, .qw-msg-wrap div');
      let found = 0;
      for (const node of nodes) {
        if (/转文字/i.test(node.textContent || '')) { found++; }
      }
      return { remaining: found };
    })()`
    );
    if (!result || result.remaining === 0) {
      return { success: true, attempts: i + 1 };
    }
  }
  return { success: false, attempts: maxAttempts };
}

/**
 * Full voice transcribe pipeline: find + click + wait.
 */
async function transcribeVoices(iframeClient, log, pauseCtx = null) {
  if (pauseCtx) {
    await waitWhilePaused(pauseCtx);
  }
  const btnCount = await clickVoiceTranscribeButtons(iframeClient);
  if (btnCount > 0) {
    log(`[voice] found ${btnCount} voice messages, transcribing...`);
    const result = await waitForVoiceTranscriptions(iframeClient, pauseCtx);
    log(`[voice] transcribe ${result.success ? 'done' : 'timeout'} in ${result.attempts} attempts`);
    return btnCount;
  }
  return 0;
}

async function waitForStableMessages(iframeClient, pauseCtx = null) {
  let previousFingerprint = null;
  let lastMessages = [];
  let lastScroll = null;

  for (let attempt = 1; attempt <= STABLE_ATTEMPTS; attempt++) {
    if (pauseCtx) {
      await waitWhilePaused(pauseCtx);
    }
    const extracted = await extractIframeMessages(iframeClient);
    lastMessages = extracted.messages || [];
    lastScroll = extracted.scroll || null;

    const snapshot = shouldPersistSnapshot({
      previousFingerprint,
      currentMessages: lastMessages
    });

    if (snapshot.ready && snapshot.stable) {
      return {
        messages: lastMessages,
        scroll: lastScroll,
        attempts: attempt,
        loaded: true
      };
    }

    previousFingerprint = snapshot.currentFingerprint;

    if (attempt < STABLE_ATTEMPTS) {
      if (pauseCtx) {
        await sleepWithPauseCheck(STABLE_POLL_MS, pauseCtx);
      } else {
        await sleep(STABLE_POLL_MS);
      }
    }
  }

  return {
    messages: lastMessages,
    scroll: lastScroll,
    attempts: STABLE_ATTEMPTS,
    loaded: false
  };
}

async function waitForDateBoundedMessages(
  iframeClient,
  { dateStart, dateEnd, log, paced = false, pauseFile, stopFile, shutdownRequested }
) {
  const pauseCtx = { pauseFile, stopFile, shutdownRequested, log };
  const seen = new Map();
  let stableAttempts = 0;
  let scrolls = 0;
  let lastTotalMessages = -1;
  let lastScrollFingerprint = '';
  let finalStopReason = 'max_scrolls';
  let finalLoaded = false;
  let lastSnapshot = { messages: [], scroll: null };

  for (scrolls = 0; scrolls <= MAX_MESSAGE_SCROLLS; scrolls++) {
    await waitWhilePaused(pauseCtx);
    if (await shouldStopExport({ shutdownRequested, stopFile })) {
      const allMessages = Array.from(seen.values());
      const filtered = filterMessagesByDateRange(allMessages, dateStart, dateEnd);
      return {
        ...filtered,
        attempts: 0,
        loaded: false,
        incomplete: true,
        scrolls,
        scrollStopReason: 'shutdown',
        totalObservedMessageCount: allMessages.length,
        shutdown: true
      };
    }
    await transcribeVoices(iframeClient, log, pauseCtx);
    const stable = await waitForStableMessages(iframeClient, pauseCtx);
    lastSnapshot = stable;

    for (const message of stable.messages || []) {
      const key = buildRawMessageKey(message);
      if (!seen.has(key)) {
        seen.set(key, message);
      }
    }

    const allMessages = Array.from(seen.values());
    const filtered = filterMessagesByDateRange(allMessages, dateStart, dateEnd);

    if (filtered.sawAfterRange) {
      finalStopReason = 'after_date_boundary';
      finalLoaded = true;
      return {
        ...filtered,
        attempts: stable.attempts,
        loaded: true,
        incomplete: false,
        scrolls,
        scrollStopReason: finalStopReason,
        totalObservedMessageCount: allMessages.length
      };
    }

    const scrollState = stable.scroll || {};
    const scrollFingerprint = `${scrollState.top || 0}:${scrollState.height || 0}:${scrollState.clientHeight || 0}`;
    if (allMessages.length === lastTotalMessages && scrollFingerprint === lastScrollFingerprint) {
      stableAttempts += 1;
    } else {
      stableAttempts = 0;
      lastTotalMessages = allMessages.length;
      lastScrollFingerprint = scrollFingerprint;
    }

    if (scrollState.atBottom && stableAttempts >= MESSAGE_SCROLL_IDLE_LIMIT - 1) {
      finalStopReason = 'no_more_messages';
      finalLoaded = true;
      return {
        ...filtered,
        attempts: stable.attempts,
        loaded: true,
        incomplete: false,
        scrolls,
        scrollStopReason: finalStopReason,
        totalObservedMessageCount: allMessages.length
      };
    }

    if (scrolls >= MAX_MESSAGE_SCROLLS) {
      break;
    }

    const moved = await scrollIframeMessagesForward(iframeClient, { paced });
    log(
      `[conversation] scroll ${scrolls + 1}/${MAX_MESSAGE_SCROLLS} moved=${moved.moved} atBottom=${moved.atBottom} observed=${allMessages.length} inRange=${filtered.messages.length}`
    );
    if (paced) {
      const scrollDelay = randomInt(
        MESSAGE_SCROLL_DELAY_MIN_MS,
        MESSAGE_SCROLL_DELAY_MAX_MS
      );
      if (scrollDelay > 0 && log) {
        log(`[paced] wait ${scrollDelay}ms after message scroll`);
      }
      await sleepWithPauseCheck(scrollDelay, pauseCtx);
    } else {
      await sleepWithPauseCheck(STABLE_POLL_MS, pauseCtx);
    }

    if (!moved.moved && moved.atBottom && stableAttempts >= MESSAGE_SCROLL_IDLE_LIMIT - 1) {
      finalStopReason = 'no_more_messages';
      finalLoaded = true;
      return {
        ...filtered,
        attempts: stable.attempts,
        loaded: true,
        incomplete: false,
        scrolls: scrolls + 1,
        scrollStopReason: finalStopReason,
        totalObservedMessageCount: allMessages.length
      };
    }
  }

  const allMessages = Array.from(seen.values());
  const filtered = filterMessagesByDateRange(allMessages, dateStart, dateEnd);
  return {
    ...filtered,
    attempts: lastSnapshot.attempts || STABLE_ATTEMPTS,
    loaded: finalLoaded,
    incomplete: !finalLoaded,
    scrolls,
    scrollStopReason: finalStopReason,
    totalObservedMessageCount: allMessages.length
  };
}

function conversationAlreadyDone(dataset, conversationId) {
  return dataset.progress.completed_conversation_ids.includes(conversationId);
}

function shouldFlushDataset(dataset) {
  return dataset.conversations.length % SAVE_EVERY === 0;
}

async function markConversationCheckpoint({
  checkpointPath,
  mainPageNo,
  employeeName,
  metricCategory,
  metricPage,
  customerId,
  conversationId
}) {
  await saveCheckpoint(checkpointPath, {
    main_page_no: mainPageNo,
    employee_name: employeeName,
    metric_category: metricCategory,
    metric_page: metricPage,
    customer_id: customerId,
    conversation_id: conversationId
  });
}

async function saveRateLimitCheckpoint({
  outputPath,
  dataset,
  checkpointPath,
  mainPageNo,
  employeeName,
  target,
  conversationId
}) {
  await markConversationCheckpoint({
    checkpointPath,
    mainPageNo,
    employeeName,
    metricCategory: target.metricCategory,
    metricPage: target.metricPage,
    customerId: target.customerId,
    conversationId
  });
  await saveDataset(outputPath, dataset);
}

async function assertNoRateLimitForTarget({
  pageClient,
  outputPath,
  dataset,
  checkpointPath,
  mainPageNo,
  employeeName,
  target,
  conversationId
}) {
  try {
    await checkRateLimitState(pageClient);
  } catch (error) {
    if (error instanceof RateLimitedError) {
      await saveRateLimitCheckpoint({
        outputPath,
        dataset,
        checkpointPath,
        mainPageNo,
        employeeName,
        target,
        conversationId
      });
    }
    throw error;
  }
}

async function pacedAfterCustomer({ enabled, log, count }) {
  if (!enabled) return;
  await pacedSleep({
    enabled,
    minMs: CUSTOMER_DELAY_MIN_MS,
    maxMs: CUSTOMER_DELAY_MAX_MS,
    label: `after customer ${count}`,
    log
  });
  if (CUSTOMERS_PER_BATCH > 0 && count > 0 && count % CUSTOMERS_PER_BATCH === 0) {
    await pacedSleep({
      enabled,
      minMs: BATCH_REST_MS,
      maxMs: BATCH_REST_MS,
      label: `batch rest after ${count} customers`,
      log
    });
  }
}

async function pacedAfterEmployee({ enabled, log, employeeName }) {
  await pacedSleep({
    enabled,
    minMs: EMPLOYEE_DELAY_MIN_MS,
    maxMs: EMPLOYEE_DELAY_MAX_MS,
    label: `after employee ${employeeName}`,
    log
  });
}

export async function exportCurrentPage({
  outputPath,
  checkpointPath,
  jsonlPath,
  dateStart,
  dateEnd,
  targetKeywords,
  maxConversations = 2000,
  maxRows = 999999,
  expectedCategory = '',
  expectedActiveTab = '',
  skipDateValidation = false,
  dryRunTargets = false,
  paced = false,
  retryFailedConversations = null,
  shutdownRequested = () => false,
  pauseFile = null,
  stopFile = null,
  log = console.log
}) {
  WAIT_MS = Number(process.env.WAIT_MS || '1200');
  STABLE_POLL_MS = Number(process.env.STABLE_POLL_MS || '1200');
  STABLE_ATTEMPTS = Number(process.env.STABLE_ATTEMPTS || '12');
  CUSTOMER_DELAY_MIN_MS = Number(process.env.CUSTOMER_DELAY_MIN_MS || '1000');
  CUSTOMER_DELAY_MAX_MS = Number(process.env.CUSTOMER_DELAY_MAX_MS || '3000');
  EMPLOYEE_DELAY_MIN_MS = Number(process.env.EMPLOYEE_DELAY_MIN_MS || '5000');
  EMPLOYEE_DELAY_MAX_MS = Number(process.env.EMPLOYEE_DELAY_MAX_MS || '5000');
  BATCH_REST_MS = Number(process.env.BATCH_REST_MS || '5000');
  SEARCH_RESULT_DELAY_MIN_MS = Number(process.env.SEARCH_RESULT_DELAY_MIN_MS || '1500');
  SEARCH_RESULT_DELAY_MAX_MS = Number(process.env.SEARCH_RESULT_DELAY_MAX_MS || '4000');
  SELECT_FRIEND_DELAY_MIN_MS = Number(process.env.SELECT_FRIEND_DELAY_MIN_MS || '2000');
  SELECT_FRIEND_DELAY_MAX_MS = Number(process.env.SELECT_FRIEND_DELAY_MAX_MS || '5000');
  MESSAGE_SCROLL_DELAY_MIN_MS = Number(process.env.MESSAGE_SCROLL_DELAY_MIN_MS || '1500');
  MESSAGE_SCROLL_DELAY_MAX_MS = Number(process.env.MESSAGE_SCROLL_DELAY_MAX_MS || '4000');

  const dataset = await loadDataset(outputPath, jsonlPath);
  let activeRetryList = Array.isArray(retryFailedConversations)
    ? retryFailedConversations
    : null;
  if (
    (!activeRetryList || activeRetryList.length === 0) &&
    process.env.CHAT_AUDIT_RETRY_FAILED === '1'
  ) {
    activeRetryList = dataset.progress?.failed_conversation_ids ?? [];
  }
  const isRetryFailedPass =
    Array.isArray(activeRetryList) && activeRetryList.length > 0;
  progressDebug(log, 'export-init', {
    isRetryFailedPass,
    retryEnv: process.env.CHAT_AUDIT_RETRY_FAILED === '1',
    activeRetryCount: activeRetryList?.length ?? 0,
    paramRetryCount: Array.isArray(retryFailedConversations)
      ? retryFailedConversations.length
      : 0,
    datasetFailedCount:
      dataset.progress?.failed_conversation_ids?.length ?? 0
  });
  if (isRetryFailedPass) {
    await saveCheckpoint(checkpointPath, createEmptyCheckpoint());
    log(
      `[retry-failed] reset checkpoint; will only process ${activeRetryList.length} failed conversation(s)`
    );
  }
  const loadedCheckpoint = await loadCheckpoint(checkpointPath);
  const checkpoint = isMetricCheckpoint(loadedCheckpoint) ? loadedCheckpoint : { main_page_no: 1, employee_name: null };
  if (loadedCheckpoint.employee_name && !isMetricCheckpoint(loadedCheckpoint)) {
    log('[checkpoint] ignoring old friend-list checkpoint; starting metric-driven export from the beginning');
  }
  const pageSession = await getPageSession();
  const pageClient = pageSession.client;
  let checkpointReached = !checkpoint.employee_name;
  let pacedCustomerCount = 0;
  resetPauseGate();
  const emptyEmployeeCheckpoint = { main_page_no: 1, employee_name: null };
  const progressState = {
    mode: isRetryFailedPass ? 'retry-failed' : 'employees',
    totalEmployees: 0,
    completedEmployees: 0,
    /** 续传前已在 checkpoint 之前完成的员工数 */
    completedEmployeesBaseline: 0,
    totalRetryConversations: 0,
    completedRetryConversations: 0
  };
  const touchExportProgress = (options = {}) => {
    const useRetryBranch =
      isRetryFailedPass || progressState.mode === 'retry-failed';
    if (useRetryBranch) {
      const current = Math.min(
        progressState.completedRetryConversations,
        progressState.totalRetryConversations
      );
      reportExportStats(log, {
        current,
        total: progressState.totalRetryConversations,
        unit: 'conversation',
        phase: 'retry-failed',
        reset: options.reset,
        debug: {
          branch: 'retry',
          mode: progressState.mode,
          isRetryFailedPass,
          completedRetry: progressState.completedRetryConversations,
          totalRetry: progressState.totalRetryConversations,
          reset: Boolean(options.reset),
          caller: options.caller || 'touch'
        }
      });
      return;
    }
    const current = Math.min(
      progressState.completedEmployeesBaseline +
        progressState.completedEmployees,
      progressState.totalEmployees
    );
    reportExportStats(log, {
      current,
      total: progressState.totalEmployees,
      unit: 'employee',
      phase:
        progressState.completedEmployeesBaseline > 0 ? 'resume' : null,
      reset: options.reset,
      debug: {
        branch: 'employee',
        mode: progressState.mode,
        isRetryFailedPass,
        current,
        totalEmployees: progressState.totalEmployees,
        completedEmployees: progressState.completedEmployees,
        baseline: progressState.completedEmployeesBaseline,
        reset: Boolean(options.reset),
        caller: options.caller || 'touch'
      }
    });
  };

  await closeTransientOverlays(pageClient);
  if (isRetryFailedPass && activeRetryList) {
    progressState.totalRetryConversations = activeRetryList.length;
    progressState.completedRetryConversations = 0;
    progressState.totalEmployees = 0;
    progressState.completedEmployees = 0;
    progressState.completedEmployeesBaseline = 0;
    log(
      `[progress] 续传失败会话 total=${progressState.totalRetryConversations} 条`
    );
    touchExportProgress({ reset: true, caller: 'retry-init' });
  } else {
    progressState.totalEmployees = await countPlannedEmployees(pageClient, {
      checkpoint: emptyEmployeeCheckpoint,
      targetKeywords,
      maxRows
    });
    const remainingEmployees = await countPlannedEmployees(pageClient, {
      checkpoint,
      targetKeywords,
      maxRows
    });
    progressState.completedEmployeesBaseline = Math.max(
      0,
      progressState.totalEmployees - remainingEmployees
    );
    log(
      `[progress] 按员工计进度 total=${progressState.totalEmployees} 人` +
        (progressState.completedEmployeesBaseline > 0
          ? `（续传：已完成 ${progressState.completedEmployeesBaseline}，本轮待处理 ${remainingEmployees}）`
          : '')
    );
  }
  touchExportProgress({ caller: 'after-init' });
  log(
    `[page] using ${pageSession.target.id} focus=${pageSession.state.hasFocus} visible=${pageSession.state.visibilityState} dialog=${pageSession.state.dialogVisible}`
  );
  if (paced) {
    log(
      `[paced] enabled customerDelay=${CUSTOMER_DELAY_MIN_MS}-${CUSTOMER_DELAY_MAX_MS}ms employeeDelay=${EMPLOYEE_DELAY_MIN_MS}-${EMPLOYEE_DELAY_MAX_MS}ms batch=${CUSTOMERS_PER_BATCH}/${BATCH_REST_MS}ms`
    );
  }

  try {
    await closeTransientOverlays(pageClient);
    let mainPager = await getMainPager(pageClient);
    let processedRowCount = 0;

    for (let mainPageNo = 1; mainPageNo <= mainPager.totalPages; mainPageNo++) {
      if (
        dataset.conversations.length >= maxConversations ||
        (await shouldStopExport({ shutdownRequested, stopFile })) ||
        processedRowCount >= maxRows
      ) {
        break;
      }

      if (shouldSkipMainPageBeforeCheckpoint(checkpoint, mainPageNo)) {
        continue;
      }

      if (mainPager.currentPage !== mainPageNo) {
        log(`[main-page] goto ${mainPageNo}`);
        const changed = await changeMainPage(pageClient, mainPageNo);
        if (!changed.ok) {
          break;
        }
        await sleep(WAIT_MS);
        mainPager = await getMainPager(pageClient);
      }

      const summaries = await getRowSummaries(pageClient);
      const rows = targetKeywords.length > 0
        ? summaries.filter((row) =>
            targetKeywords.some((keyword) => row.employeeName.includes(keyword))
          )
        : summaries;

      for (const row of rows) {
        if (
          dataset.conversations.length >= maxConversations ||
          (await shouldStopExport({ shutdownRequested, stopFile })) ||
          processedRowCount >= maxRows
        ) {
          break;
        }

        if (shouldSkipRowBeforeCheckpoint(checkpoint, row.employeeName, checkpointReached)) {
          continue;
        }
        processedRowCount += 1;

        let rowCountedForProgress = false;
        try {
        log(`[row] open ${row.rowIndex} ${row.employeeName}`);
        await closeTransientOverlays(pageClient);
        const dialogReady = await openDialogWithRetry({
          maxAttempts: 3,
          openDialog: async () => openRowDialog(pageClient, row.rowIndex),
          waitForDialog: async () => waitForChatDialog(pageClient),
          sleep
        });
        log(`[row] dialog ready ${dialogReady.exists} friends=${dialogReady.friendCount}`);
        if (!dialogReady.exists) {
          continue;
        }

        const dialogFilters = await getDialogFilters(pageClient);
        const expectedFilters = {
          employeeName: row.employeeName,
          dateRange: skipDateValidation ? null : (dateStart && dateEnd ? [dateStart, dateEnd] : null),
          categoryIncludes: expectedCategory || null,
          activeTab: expectedActiveTab || null
        };
        const adjustments = getDialogFilterAdjustments(dialogFilters, expectedFilters);
        if (adjustments.dateRange) {
          const dateSet = await setDialogDateRange(pageClient, adjustments.dateRange);
          log(`[row] adjust date ${adjustments.dateRange.join('~')} ok=${dateSet.ok}`);
          await waitForChatDialog(pageClient);
          await sleep(WAIT_MS);
        }
        if (adjustments.category) {
          const clicked = await clickDialogCategory(pageClient, adjustments.category);
          log(`[row] adjust category ${adjustments.category} ok=${clicked.ok}`);
          await waitForChatDialog(pageClient);
          await sleep(WAIT_MS);
        }
        if (adjustments.activeTab) {
          const clicked = await clickDialogTab(pageClient, adjustments.activeTab);
          log(`[row] adjust tab ${adjustments.activeTab} ok=${clicked.ok}`);
          await waitForChatDialog(pageClient);
          await sleep(WAIT_MS);
        }
        const verifiedFilters =
          adjustments.dateRange || adjustments.category || adjustments.activeTab ? await getDialogFilters(pageClient) : dialogFilters;
        const filterCheck = validateDialogFilters(verifiedFilters, expectedFilters);
        log(
          `[row] filters title=${verifiedFilters.title} date=${verifiedFilters.dateRange.join('~')} category=${verifiedFilters.categoryText} tab=${verifiedFilters.activeTabText} pager=${verifiedFilters.pagerText} total=${verifiedFilters.totalText}`
        );
        if (!filterCheck.ok) {
          throw new Error(
            `dialog filters mismatch: ${filterCheck.errors.join(',')} actual=${JSON.stringify(verifiedFilters)}`
          );
        }

          const targets = await collectMetricCustomerTargets(pageClient, row.employeeName, log);
          const processableTargets = countProcessableTargets(targets, row, dataset, {
            checkpoint,
            checkpointReached,
            isRetryFailedPass,
            retryFailedConversations: activeRetryList
          });
          log(
            `[row] metric targets ${targets.length} will_process=${processableTargets}`
          );
          if (dryRunTargets) {
            for (const target of targets) {
              log(
                `[dry-run-target] employee=${row.employeeName} customer=${target.customerId} metrics=${target.sourceMetricCategories.join(',')} info=${target.customerInfo}`
              );
            }
            continue;
          }

          rowCountedForProgress = true;

          for (const target of targets) {
            if (await shouldStopExport({ shutdownRequested, stopFile })) {
              log(
                stopFile && (await checkFileExists(stopFile))
                  ? `[stop] 收到停止信号，保存状态并退出…`
                  : `[shutdown] 保存状态并退出…`
              );
              await saveDataset(outputPath, dataset);
              return {
                conversations: dataset.conversations.length,
                completed: dataset.progress.completed_conversation_ids.length,
                failed: dataset.progress.failed_conversation_ids.length,
                outputPath,
                shutdown: true
              };
            }

            await waitWhilePaused({ pauseFile, stopFile, shutdownRequested, log });
            if (await shouldStopExport({ shutdownRequested, stopFile })) {
              log(`[stop] 暂停期间收到停止，保存状态并退出…`);
              await saveDataset(outputPath, dataset);
              return {
                conversations: dataset.conversations.length,
                completed: dataset.progress.completed_conversation_ids.length,
                failed: dataset.progress.failed_conversation_ids.length,
                outputPath,
                shutdown: true
              };
            }

            if (dataset.conversations.length >= maxConversations) {
              break;
            }

            if (
              shouldSkipMetricCustomerBeforeCheckpoint(
                checkpoint,
                row.employeeName,
                target.metricCategory,
                target.metricPage,
                target.customerId,
                checkpointReached,
                EFFECTIVE_METRIC_CATEGORIES
              )
            ) {
              continue;
            }

            checkpointReached = true;
            const conversationId = `${row.employeeName}__customer_${target.customerId}`;
            if (conversationAlreadyDone(dataset, conversationId)) {
              continue;
            }
            if (
              isRetryFailedPass &&
              activeRetryList &&
              !activeRetryList.includes(conversationId)
            ) {
              continue;
            }

            const isRetryTarget =
              isRetryFailedPass &&
              activeRetryList &&
              activeRetryList.includes(conversationId);

            try {
            log(`[conversation] ${conversationId} metrics=${target.sourceMetricCategories.join(',')}`);
            await assertNoRateLimitForTarget({
              pageClient,
              outputPath,
              dataset,
              checkpointPath,
              mainPageNo,
              employeeName: row.employeeName,
              target,
              conversationId
            });

            const switched = await switchToCommunicationExternalFriends(pageClient);
            if (!switched.ok) {
              log(`[conversation] skipped customer=${target.customerId} error=switch-to-communication-failed`);
              if (!dataset.progress.failed_conversation_ids.includes(conversationId)) {
                dataset.progress.failed_conversation_ids.push(conversationId);
              }
              await markConversationCheckpoint({
                checkpointPath,
                mainPageNo,
                employeeName: row.employeeName,
                metricCategory: target.metricCategory,
                metricPage: target.metricPage,
                customerId: target.customerId,
                conversationId
              });
              await saveDataset(outputPath, dataset);
              pacedCustomerCount += 1;
              await pacedAfterCustomer({ enabled: paced, log, count: pacedCustomerCount });
              continue;
            }

            const searched = await searchExternalFriendByCustomerId(
              pageClient,
              target.customerId,
              target.customerInfo
            );
            await assertNoRateLimitForTarget({
              pageClient,
              outputPath,
              dataset,
              checkpointPath,
              mainPageNo,
              employeeName: row.employeeName,
              target,
              conversationId
            });
            if (!searched.ok) {
              const sampleHint = searched.sampleItems?.length
                ? ` samples=${JSON.stringify(searched.sampleItems)}`
                : '';
              log(
                `[conversation] skipped customer=${target.customerId} error=${searched.reason || 'search-failed'} terms=${JSON.stringify(searched.searchTerms || [])}${sampleHint}`
              );
              if (!dataset.progress.failed_conversation_ids.includes(conversationId)) {
                dataset.progress.failed_conversation_ids.push(conversationId);
              }
              await markConversationCheckpoint({
                checkpointPath,
                mainPageNo,
                employeeName: row.employeeName,
                metricCategory: target.metricCategory,
                metricPage: target.metricPage,
                customerId: target.customerId,
                conversationId
              });
              await saveDataset(outputPath, dataset);
              pacedCustomerCount += 1;
              await pacedAfterCustomer({ enabled: paced, log, count: pacedCustomerCount });
              continue;
            }
            await pacedSleep({
              enabled: paced,
              minMs: SEARCH_RESULT_DELAY_MIN_MS,
              maxMs: SEARCH_RESULT_DELAY_MAX_MS,
              label: `after search ${target.customerId}`,
              log
            });

            const selected = await selectSearchedFriend(
              pageClient,
              target.customerId,
              searched.match?.friendIndex
            );
            await assertNoRateLimitForTarget({
              pageClient,
              outputPath,
              dataset,
              checkpointPath,
              mainPageNo,
              employeeName: row.employeeName,
              target,
              conversationId
            });
            if (!selected.ok) {
              log(`[conversation] skipped customer=${target.customerId} error=${selected.reason || 'select-failed'}`);
              if (!dataset.progress.failed_conversation_ids.includes(conversationId)) {
                dataset.progress.failed_conversation_ids.push(conversationId);
              }
              await markConversationCheckpoint({
                checkpointPath,
                mainPageNo,
                employeeName: row.employeeName,
                metricCategory: target.metricCategory,
                metricPage: target.metricPage,
                customerId: target.customerId,
                conversationId
              });
              await saveDataset(outputPath, dataset);
              pacedCustomerCount += 1;
              await pacedAfterCustomer({ enabled: paced, log, count: pacedCustomerCount });
              continue;
            }
            await pacedSleep({
              enabled: paced,
              minMs: SELECT_FRIEND_DELAY_MIN_MS,
              maxMs: SELECT_FRIEND_DELAY_MAX_MS,
              label: `after select ${target.customerId}`,
              log
            });

            try {
              const iframeClient = await getIframeClient(pageSession.target.id);
              try {
                const extracted = await waitForDateBoundedMessages(iframeClient, {
                  dateStart,
                  dateEnd,
                  log,
                  paced,
                  pauseFile,
                  stopFile,
                  shutdownRequested
                });
                if (extracted.shutdown) {
                  log(`[stop] 消息滚动期间收到停止，保存状态并退出…`);
                  await saveDataset(outputPath, dataset);
                  return {
                    conversations: dataset.conversations.length,
                    completed: dataset.progress.completed_conversation_ids.length,
                    failed: dataset.progress.failed_conversation_ids.length,
                    outputPath,
                    shutdown: true
                  };
                }
                log(
                  `[conversation] messages ${extracted.messages.length}/${extracted.totalObservedMessageCount} filtered=${extracted.filteredOutMessageCount} scrolls=${extracted.scrolls} stop=${extracted.scrollStopReason} stable=${extracted.loaded} attempts=${extracted.attempts}`
                );
                await assertNoRateLimitForTarget({
                  pageClient,
                  outputPath,
                  dataset,
                  checkpointPath,
                  mainPageNo,
                  employeeName: row.employeeName,
                  target,
                  conversationId
                });

                if (!extracted.loaded) {
                  if (!dataset.progress.failed_conversation_ids.includes(conversationId)) {
                    dataset.progress.failed_conversation_ids.push(conversationId);
                    await saveDataset(outputPath, dataset);
                  }
                  await markConversationCheckpoint({
                    checkpointPath,
                    mainPageNo,
                    employeeName: row.employeeName,
                    metricCategory: target.metricCategory,
                    metricPage: target.metricPage,
                    customerId: target.customerId,
                    conversationId
                  });
                  pacedCustomerCount += 1;
                  await pacedAfterCustomer({ enabled: paced, log, count: pacedCustomerCount });
                  continue;
                }

                const conversation = convertConversationToDataset({
                  conversationId,
                  employee: row,
                  friendLabel: selected.text,
                  friendPage: target.metricPage,
                  customerId: target.customerId,
                  sourceCustomerInfo: target.customerInfo,
                  sourceMetricCategories: target.sourceMetricCategories,
                  metricRows: target.metricRows,
                  messages: extracted.messages,
                  messageDateStart: dateStart,
                  messageDateEnd: dateEnd,
                  filteredOutMessageCount: extracted.filteredOutMessageCount,
                  scrollStopReason: extracted.scrollStopReason,
                  scrollIncomplete: extracted.incomplete,
                  totalObservedMessageCount: extracted.totalObservedMessageCount
                });

                upsertDatasetConversation(dataset, conversation);
                await appendJsonlRecord(jsonlPath, conversation);
                if (shouldFlushDataset(dataset)) {
                  await saveDataset(outputPath, dataset);
                }
                await markConversationCheckpoint({
                  checkpointPath,
                  mainPageNo,
                  employeeName: row.employeeName,
                  metricCategory: target.metricCategory,
                  metricPage: target.metricPage,
                  customerId: target.customerId,
                  conversationId
                });
                pacedCustomerCount += 1;
                await pacedAfterCustomer({ enabled: paced, log, count: pacedCustomerCount });
              } finally {
                await iframeClient.close();
              }
            } catch (error) {
              const message = normalizeErrorMessage(error);
              log(`[conversation] skipped error=${message}`);

              if (!shouldSkipConversationError(error)) {
                if (error instanceof RateLimitedError) {
                  await saveRateLimitCheckpoint({
                    outputPath,
                    dataset,
                    checkpointPath,
                    mainPageNo,
                    employeeName: row.employeeName,
                    target,
                    conversationId
                  });
                }
                throw error;
              }

              if (!dataset.progress.failed_conversation_ids.includes(conversationId)) {
                dataset.progress.failed_conversation_ids.push(conversationId);
                await saveDataset(outputPath, dataset);
              }
              await markConversationCheckpoint({
                checkpointPath,
                mainPageNo,
                employeeName: row.employeeName,
                metricCategory: target.metricCategory,
                metricPage: target.metricPage,
                customerId: target.customerId,
                conversationId
              });
              pacedCustomerCount += 1;
              await pacedAfterCustomer({ enabled: paced, log, count: pacedCustomerCount });
              continue;
            }
            } finally {
              if (isRetryTarget) {
                progressState.completedRetryConversations = Math.min(
                  progressState.completedRetryConversations + 1,
                  progressState.totalRetryConversations
                );
                touchExportProgress({
                  caller: 'retry-conversation-done',
                  conversationId
                });
              }
            }
          }
        } finally {
          if (process.env.CHAT_AUDIT_KEEP_DIALOG_OPEN_ON_ERROR !== '1') {
            await closeRowDialog(pageClient);
          }
          await pacedAfterEmployee({ enabled: paced, log, employeeName: row.employeeName });
          if (rowCountedForProgress && !isRetryFailedPass) {
            const remainingThisRun = Math.max(
              0,
              progressState.totalEmployees -
                progressState.completedEmployeesBaseline
            );
            progressState.completedEmployees = Math.min(
              progressState.completedEmployees + 1,
              remainingThisRun
            );
            touchExportProgress({ caller: 'employee-row-done' });
          }
          await sleep(500);
        }
      }
    }
  } finally {
    await pageClient.close();
    await saveDataset(outputPath, dataset);
  }

  if (progressState.mode === 'retry-failed') {
    if (progressState.totalRetryConversations > 0) {
      progressState.completedRetryConversations =
        progressState.totalRetryConversations;
      touchExportProgress({ caller: 'retry-finalize' });
    }
  } else {
    const remainingThisRun = Math.max(
      0,
      progressState.totalEmployees - progressState.completedEmployeesBaseline
    );
    if (progressState.totalEmployees > 0 && remainingThisRun > 0) {
      progressState.completedEmployees = remainingThisRun;
      touchExportProgress({ caller: 'employee-finalize' });
    }
  }

  const progressUnit =
    progressState.mode === 'retry-failed' ? 'conversation' : 'employee';
  const employeeProgressCurrent =
    progressState.mode === 'retry-failed'
      ? Math.min(
          progressState.completedRetryConversations,
          progressState.totalRetryConversations
        )
      : Math.min(
          progressState.completedEmployeesBaseline +
            progressState.completedEmployees,
          progressState.totalEmployees
        );
  const employeeProgressTotal =
    progressState.mode === 'retry-failed'
      ? progressState.totalRetryConversations
      : progressState.totalEmployees;

  return {
    conversations: dataset.conversations.length,
    completed: dataset.progress.completed_conversation_ids.length,
    failed: dataset.progress.failed_conversation_ids.length,
    outputPath,
    employeeProgressCurrent,
    employeeProgressTotal,
    progressUnit
  };
}
