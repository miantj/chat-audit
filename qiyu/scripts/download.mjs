#!/usr/bin/env node
/**
 * 七鱼会话异步导出（后台 cookie，经 CDP 已登录 Chrome）
 *   1) POST /chat/api/session/download  发起
 *   2) GET  /api/download/task/list     轮询 status=2
 *   3) 下 url → exports/*.xlsx → 售前登记摘录-YYYY-MM-DD.csv
 *
 *   node scripts/download.mjs
 *   node scripts/download.mjs --start 2026-09-28 --end 2026-09-28
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ensureChrome,
  pickPageTarget,
  DEFAULT_CDP,
  QIYU_HISTORY_URL
} from './lib/chrome.mjs';
import { Cdp } from './lib/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'exports');

// 售前商详：面料/尺码/配件/颜色/款式（抓包 category）
const DEFAULT_CATEGORY = [
  '480332462',
  '480332463',
  '480332464',
  '480332465',
  '480332469'
];

const DOWNLOAD_KEYS = [
  'getId',
  'getCreateTime',
  'getStartTime',
  'waitInQueueTime',
  'getFirstMsgTime',
  'getFirstRespTime',
  'getEndTime',
  'getFirstRespDuration',
  'getAvgRespDuration',
  'getQueueDuration',
  'getSessionDuration',
  'getStaffReceptionDuration',
  'getSessionStickDuration',
  'getIsValid',
  'getBeginUser',
  'getCloseUser',
  'getVisitTimes',
  'getStatus',
  'getUserResolvedStatus',
  'getOneOff',
  'getSessionType',
  'aiClassify',
  'getStaffName',
  'getStaffAccount',
  'getCategoryId',
  'getCategoryDescription',
  'getStaffName',
  'getUserName',
  'getUserTags',
  'getVipLevel',
  'getForeignId',
  'getUserEmail',
  'getUserPhone',
  'getSatisfaction',
  'evaSource',
  'inviteSource',
  'getEvaluationInvited',
  'getStaffInvitedEvaluateTime',
  'getUserJoinEvaluateTime',
  'getSatisfactionTags',
  'getSatisfactionRemarks',
  'getRoundNumber',
  'getOverflowFrom',
  'getOverflowRuleName',
  'getOverflowCondition',
  'getIsTransferSession',
  'getTransferType',
  'getTransferSessionId',
  'getTransferFrom',
  'getAlarmCount',
  'getAlarmInfo',
  'getIsHumanReply',
  'startReason',
  'getCloseReason',
  'staffMessageCount',
  'withdrawMessageCount',
  'userMessageCount',
  'fromInvite',
  'preQueue',
  'getFromType',
  'getFromSubType',
  'getUserIp',
  'getFromTitle',
  'getFromPage',
  'getRemark',
  'getOriginPlatform',
  'getEntryName',
  'baiduKeyword',
  'baiduQuery',
  'getSearchKey',
  'getLandPage',
  'getSendWorksheet',
  'getWorkSheetId',
  'getSessionContent',
  'customerInfo',
  'serviceNote',
  'hasVideoCall',
  'videoTime',
  'getSessionContentWithoutLabel',
  'videoRecordUrlList',
  'getWxCsRemark'
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value && !value.startsWith('--') ? value : fallback;
}

function validYmd(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} 必须是 YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00+08:00`);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} 不是有效日期`);
  const actual = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date);
  if (actual !== value) {
    throw new Error(`${label} 不是有效日期`);
  }
  return value;
}

function dayRange(ymdStart, ymdEnd) {
  const start = new Date(`${validYmd(ymdStart, '开始日期')}T00:00:00+08:00`).getTime();
  const end = new Date(`${validYmd(ymdEnd, '结束日期')}T23:59:59.999+08:00`).getTime();
  if (start > end) throw new Error('开始日期不能晚于结束日期');
  return { start, end };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function downloadUrl(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const get = (u, count) => {
      if (count > 5) {
        reject(new Error('下载重定向次数过多'));
        return;
      }
      const parsed = new URL(u);
      const lib = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
      if (!lib) {
        reject(new Error(`不支持的下载协议：${parsed.protocol}`));
        return;
      }
      lib
        .get(u, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            get(new URL(res.headers.location, u).href, count + 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`下载 HTTP ${res.statusCode}`));
            return;
          }
          const temp = `${dest}.part`;
          const file = fs.createWriteStream(temp);
          const fail = (error) => {
            file.destroy();
            fs.rmSync(temp, { force: true });
            reject(error);
          };
          res.on('error', fail);
          file.on('error', fail);
          res.pipe(file);
          file.on('finish', () => {
            file.close((error) => {
              if (error) {
                fail(error);
                return;
              }
              try {
                fs.renameSync(temp, dest);
                resolve(dest);
              } catch (renameError) {
                fail(renameError);
              }
            });
          });
        })
        .on('error', reject);
    };
    get(url, redirects);
  });
}

function isSessionExpired(value) {
  const text = value instanceof Error ? value.message : JSON.stringify(value);
  return /8001|session\s*(?:is\s*)?timeout|无 csrf token|登录页/i.test(text || '');
}

function isBusyDownload(value) {
  const code = Number(value?.code);
  const text = value instanceof Error ? value.message : JSON.stringify(value);
  return code === 8003 || /try later|请稍后|繁忙/i.test(text || '');
}

function autoLogin() {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'browser.mjs'), 'login'],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(
      `七鱼会话已过期，自动登录失败：${result.stderr || result.stdout || '请配置 QIYU_USERNAME/QIYU_PASSWORD'}`
    );
  }
}

/** 登录后进会话页，等 csrf / cookie 就绪再打导出接口 */
async function settleHistoryPage(cdp) {
  await cdp.send('Page.enable');
  await cdp.goto(QIYU_HISTORY_URL);
  await sleep(2500);
  const stillLogin = await cdp.evaluate(`/\\/login/i.test(location.pathname)`);
  if (stillLogin) throw new Error('登录后仍在登录页');
}

async function downloadTask(start, end) {
  let loggedIn = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    await ensureChrome(DEFAULT_CDP);
    const target = await pickPageTarget(DEFAULT_CDP);
    let task = null;
    let relogin = false;
    let busy = false;
    const cdp = new Cdp(target.webSocketDebuggerUrl);
    try {
      await cdp.connect();
      await cdp.send('Runtime.enable');
      if (loggedIn || attempt > 0) await settleHistoryPage(cdp);

      let create;
      try {
        create = await cdp.evaluate(`(async () => {
    const m = document.cookie.match(/(?:___csrfToken|__csrfToken)=([^;]+)/);
    const tk = m ? m[1] : '';
    if (!tk) throw new Error('无 csrf token，请先 login');
    const requestedAt = Date.now();
    const body = {
      offset: 0,
      limit: 50,
      startTime: ${start},
      endTime: ${end},
      order: 'descend',
      sortBy: 'et',
      hasRobot: 0,
      launcher: [1, 3],
      category: ${JSON.stringify(DEFAULT_CATEGORY)},
      isValid: 1,
      downloadKey: ${JSON.stringify(DOWNLOAD_KEYS)}
    };
    const res = await fetch('/chat/api/session/download?token=' + encodeURIComponent(tk), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
    return { tkLen: tk.length, json: await res.json(), requestedAt, responseAt: Date.now() };
    })()`);
      } catch (error) {
        if (!loggedIn && isSessionExpired(error)) relogin = true;
        else throw error;
      }

      if (!relogin) {
        console.log('create:', JSON.stringify(create.json));
        if (Number(create.json?.code) !== 200) {
          if (!loggedIn && isSessionExpired(create.json)) relogin = true;
          else if (isBusyDownload(create.json)) busy = true;
          else throw new Error(`发起导出失败：${create.json?.message || JSON.stringify(create.json)}`);
        }
      }

      if (!relogin && !busy) {
        const requestedAt = Number(create.requestedAt) || Date.now();
        let taskId = null;
        for (let i = 0; i < 40; i++) {
          await sleep(3000);
          let list;
          try {
            list = await cdp.evaluate(`(async () => {
      const m = document.cookie.match(/(?:___csrfToken|__csrfToken)=([^;]+)/);
      const tk = m ? m[1] : '';
      const res = await fetch('/api/download/task/list?limit=10&offset=0&token=' + encodeURIComponent(tk), {
        credentials: 'include',
        headers: { Accept: 'application/json' }
      });
      return res.json();
      })()`);
          } catch (error) {
            if (!loggedIn && isSessionExpired(error)) {
              relogin = true;
              break;
            }
            throw error;
          }
          if (Number(list?.code) !== 200) {
            if (isSessionExpired(list)) {
              relogin = true;
              break;
            }
            if (isBusyDownload(list)) {
              busy = true;
              break;
            }
            throw new Error(`轮询导出任务失败：${list?.message || JSON.stringify(list)}`);
          }
          const items = Array.isArray(list.result) ? list.result : [];
          if (taskId == null) {
            // create.result 恒为空；服务端 time 可能略早于客户端 Date.now()
            const skewMs = 30_000;
            const candidates = items
              .filter((item) => Number(item.time) >= requestedAt - skewMs)
              .sort((a, b) => Number(a.time) - Number(b.time));
            if (candidates[0]) taskId = candidates[0].id;
            else if (items.length) {
              taskId = [...items].sort((a, b) => Number(b.time) - Number(a.time))[0].id;
            }
          }
          const latest = items.find((item) => String(item.id) === String(taskId));
          if (!latest) continue;
          process.stderr.write(
            `poll ${i}: id=${latest.id} status=${latest.status} progress=${latest.progress ?? '-'}\n`
          );
          if (latest.status === 2 && latest.url) {
            task = latest;
            break;
          }
          if (latest.status === 3) throw new Error(`导出失败 id=${latest.id}`);
        }
      }
    } finally {
      cdp.close();
    }

    if (relogin) {
      console.error('七鱼会话已过期，正在自动登录并重试导出…');
      autoLogin();
      loggedIn = true;
      await sleep(2000);
      continue;
    }
    if (busy) {
      const waitSec = 5 + attempt * 3;
      console.error(`导出繁忙(8003)，${waitSec}s 后重试（${attempt + 1}/5）…`);
      await sleep(waitSec * 1000);
      continue;
    }
    if (!task) throw new Error('超时：任务未完成');
    return task;
  }
  throw new Error('多次重试后仍无法发起导出（会话或 8003）');
}

async function runRange(startYmd, endYmd) {
  const { start, end } = dayRange(startYmd, endYmd);
  const dateLabel = startYmd === endYmd ? startYmd : `${startYmd}至${endYmd}`;
  const task = await downloadTask(start, end);
  fs.mkdirSync(OUT, { recursive: true });
  const rawName = path.basename(String(task.name || `session-${task.id}.xlsx`));
  const filename = rawName.toLowerCase().endsWith('.xlsx') ? rawName : `${rawName}.xlsx`;
  const dest = path.join(OUT, filename);
  await downloadUrl(task.url, dest);
  const registerFile = path.join(OUT, `售前登记摘录-${dateLabel}.csv`);
  const register = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'to-register.mjs'), '--in', dest, '--out', registerFile],
    { encoding: 'utf8' }
  );
  if (register.status !== 0) {
    throw new Error(`售前登记摘录生成失败：${register.stderr || register.stdout || '未知错误'}`);
  }
  const uploadArgs = [
    path.join(ROOT, 'scripts', 'to-lark-sheet.mjs'),
    '--in',
    registerFile,
    '--date',
    startYmd
  ];
  const upload = spawnSync(process.execPath, uploadArgs, { encoding: 'utf8' });
  if (upload.status !== 0) {
    throw new Error(`飞书表格文档写入失败：${upload.stderr || upload.stdout || '未知错误'}`);
  }
  return {
    ok: true,
    id: task.id,
    file: dest,
    size: fs.statSync(dest).size,
    register: registerFile,
    registerResult: JSON.parse(register.stdout),
    larkSheetResult: JSON.parse(upload.stdout)
  };
}

function dateList(startYmd, endYmd) {
  const { start, end } = dayRange(startYmd, endYmd);
  const days = [];
  for (let time = start; time <= end; time += 24 * 60 * 60 * 1000) {
    days.push(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(time)));
  }
  return days;
}

async function main() {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const startYmd = arg('--start', yesterday);
  const endYmd = arg('--end', yesterday);
  const days = dateList(startYmd, endYmd);
  const results = [];
  for (const day of days) results.push(await runRange(day, day));
  console.log(JSON.stringify(days.length > 1 ? { ok: true, split: true, results } : results[0], null, 2));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
