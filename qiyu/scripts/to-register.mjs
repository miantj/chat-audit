#!/usr/bin/env node
/**
 * 七鱼导出 xlsx → 售前登记摘录 CSV
 * AI咨询分类：优先文档「11. 分类」关键词；无法判断/无关键词 → 七鱼路径的三级分类
 * 七鱼咨询分类：仅展示七鱼路径的三级分类
 * 是否疑似c端：按用户 ID 批量查询 OS 的 looklike_c_user.label；无 ID/查无用户留空
 *
 *   node scripts/to-register.mjs
 *   node scripts/to-register.mjs --in exports/xxx.xlsx --out exports/售前登记.csv
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { byHeader, latestXlsx, parseSheet } from './lib/xlsx.mjs';
import { resolveCategory, thirdCategory } from './lib/category-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const REGISTER_HEADERS = [
  'AI咨询分类',
  '七鱼咨询分类',
  '日期',
  '会话结束时间',
  '一手用户id',
  '会话id',
  '是否疑似c端',
  '货号',
  '用户问题'
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function dateOnly(s) {
  const m = String(s).match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

function minuteOnly(s) {
  const m = String(s).match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : '';
}

function endFromFirstMessage(firstMessageTime, sessionDuration) {
  const start = String(firstMessageTime).match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  const duration = String(sessionDuration).match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!start || !duration) return '';
  const startedAt = Date.parse(`${start[1]}T${start[2]}+08:00`);
  if (!Number.isFinite(startedAt)) return '';
  const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(startedAt + seconds * 1000));
}

function fileDate(file) {
  return path.basename(file).match(/20\d{2}-\d{2}-\d{2}/)?.[0] ||
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

async function loginOs() {
  const name = process.env.QIYU_OS_LOGIN_NAME;
  const password = process.env.QIYU_OS_LOGIN_PASSWORD;
  const phone = process.env.QIYU_OS_LOGIN_PHONE;
  if (![name, password, phone].every((value) => value?.trim())) {
    throw new Error('OS 自动登录缺少 QIYU_OS_LOGIN_NAME / QIYU_OS_LOGIN_PASSWORD / QIYU_OS_LOGIN_PHONE；请在 qiyu/.env 配置，也可提供有效的 QIYU_OS_COOKIE');
  }
  try {
    const res = await fetch('https://erp.yishouapp.com/erp/Admin/login', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://erpweb.yishouapp.com',
        Referer: 'https://erpweb.yishouapp.com/'
      },
      body: new URLSearchParams({
        name, password, phone,
        login_type: 'backend',
        phoneCode: '',
        returnUrl: 'https://osweb.yishouapp.com/newos/user/list',
        is_pc: '1',
        _url: 'https://erpweb.yishouapp.com/erp/#/?returnUrl=https%3A%2F%2Fosweb.yishouapp.com%2Fnewos%2Fuser%2Flist'
      })
    });
    if (!res.ok) throw new Error();
    const result = await res.json();
    if (String(result?.code) !== '200') throw new Error();
    const cookies = new Map(res.headers.getSetCookie().map((line) => {
      const pair = line.split(';')[0];
      const equals = pair.indexOf('=');
      return [pair.slice(0, equals), pair.slice(equals + 1)];
    }));
    if (!cookies.get('YISHOUSESS') || !cookies.get('token')) throw new Error();
    return [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  } catch {
    // 登录响应可能包含凭据或令牌，错误信息不能原样输出响应及网络异常。
    throw new Error('OS 自动登录失败：请检查登录凭据、网络或验证码要求；停止生成登记');
  }
}

export async function getSuspectCByUserId(userIds, cookie = process.env.QIYU_OS_COOKIE) {
  const ids = [...new Set(userIds.map((id) => String(id ?? '').trim()).filter((id) => /^\d+$/.test(id)))];
  const flags = new Map(ids.map((id) => [id, '']));
  if (!ids.length) return flags;
  let loggedIn = false;
  if (!cookie?.trim()) {
    cookie = await loginOs();
    loggedIn = true;
  }

  // 使用已验证的每页 10 条，每批不超过一页，避免分页漏掉用户。
  for (let offset = 0; offset < ids.length;) {
    const batch = ids.slice(offset, offset + 10);
    const res = await fetch('https://d0k0.yishouapp.com/os/User/Manage/getList', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: 'https://osweb.yishouapp.com',
        Referer: 'https://osweb.yishouapp.com/',
        Cookie: cookie
      },
      body: JSON.stringify({ page: 1, psize: 10, user_id: batch.join(','), reg_time: ['', ''] })
    });
    const result = res.ok ? await res.json().catch(() => {
      throw new Error('OS 用户查询返回非 JSON 响应，停止生成登记');
    }) : null;
    // 生产实测过期为 code=201、msg=请登录；其他 201 或 HTTP 403 不代表过期。
    const expired = res.status === 401 || (res.ok && (
      String(result?.code) === '401' ||
      (String(result?.code) === '201' && result?.msg === '请登录')
    ));
    if (expired) {
      if (loggedIn) throw new Error('OS 自动登录后会话仍失效，停止生成登记');
      cookie = await loginOs();
      loggedIn = true;
      continue; // offset 不变，只重查失败批次；本次任务最多自动登录一次。
    }
    if (!res.ok) throw new Error(`OS 用户查询失败：HTTP ${res.status}`);
    if (String(result?.code) !== '200') {
      throw new Error(`OS 用户查询失败（code=${result?.code ?? '缺失'}），请检查登录状态`);
    }
    const { list, total } = result.data || {};
    if (!Array.isArray(list) ||
        (typeof total !== 'number' && (typeof total !== 'string' || !/^\d+$/.test(total))) ||
        Number(total) !== list.length) {
      throw new Error('OS 用户批量查询返回不完整，停止生成登记以免误判');
    }
    const seen = new Set();
    for (const user of list) {
      const id = String(user?.user_id);
      if (!batch.includes(id) || seen.has(id)) throw new Error('OS 返回非预期或重复的用户 ID');
      seen.add(id);
      const label = user.user_labels?.looklike_c_user?.label;
      if (typeof label !== 'string') throw new Error(`OS 用户 ${id} 缺少有效的 looklike_c_user.label`);
      flags.set(id, label.trim() ? '是' : '否');
    }
    offset += 10;
  }
  return flags;
}

export function parseContent(content, userId, userName = '') {
  const text = String(content || '');
  const goods = new Set();
  for (const m of text.matchAll(/goods_no[=:](\d{6,})/gi)) goods.add(m[1]);

  const userNames = new Set([userId, userName].map((value) => String(value || '').trim()));
  const questions = [];
  const lines = text.split(/\n/);
  let inUser = false;
  for (const line of lines) {
    const s = line.trim();
    const header = line.match(/^(.*?)[ \t]{2,}\d{4}年\d{1,2}月\d{1,2}日[ \t]+\d{2}:\d{2}:\d{2}\s*$/);
    if (header) {
      const sender = header[1].trim();
      // 七鱼导出中的访客姓名可能为空；客服消息仍由具名消息头截断。
      inUser = !sender || userNames.has(sender);
      continue;
    }
    if (!inUser) continue;
    if (!s) continue;
    if (s.startsWith('{') || s.startsWith('<')) continue;
    if (/^https?:\/\//i.test(s)) continue;
    if (/商品ID[:：]/.test(s)) continue;
    if (s.length > 200) continue;
    questions.push(s);
  }

  return {
    goodsNo: [...goods].join('\n'),
    userQuestion: [...new Set(questions)]
      .map((question) => question.endsWith('；') ? question : `${question}；`)
      .join('\n')
  };
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  const inFile = path.resolve(arg('--in', latestXlsx(path.join(ROOT, 'exports'))));
  const { hdr, rows } = parseSheet(inFile);
  const firstDataDate = (rows[0] && dateOnly(byHeader(hdr, rows[0], '访客进入时间'))) || fileDate(inFile);
  const outFile = path.resolve(
    arg(
      '--out',
      path.join(
        ROOT,
        'exports',
        `售前登记摘录-${firstDataDate}.csv`
      )
    )
  );

  const rawUserIds = rows.map((row) =>
    byHeader(hdr, row, '用户唯一标识') || byHeader(hdr, row, '访客用户名')
  );
  const suspectCByUserId = await getSuspectCByUserId(rawUserIds);
  const suspectCCounts = { 是: 0, 否: 0, 未知: 0 };
  let fromDoc = 0;
  let fromQiyu = 0;
  const lines = [REGISTER_HEADERS.join(',')];
  for (const [index, row] of rows.entries()) {
    const sessionId = byHeader(hdr, row, '会话ID');
    const enterTime = byHeader(hdr, row, '访客进入时间');
    const sessionEndTime =
      endFromFirstMessage(
        byHeader(hdr, row, '访客首条消息时间'),
        byHeader(hdr, row, '会话时长')
      ) || byHeader(hdr, row, '会话结束时间');
    const qiyuCategory = byHeader(hdr, row, '咨询分类');
    const rawUserId = rawUserIds[index];
    // 一手用户id 须为数字；七鱼 Guest 常见「--」，写空避免下游飞书 Int64 校验整表失败
    const userId = /^\d+$/.test(String(rawUserId || '').trim())
      ? String(rawUserId).trim()
      : '';
    const suspectC = suspectCByUserId.get(userId) || '';
    suspectCCounts[suspectC || '未知']++;
    const content = byHeader(hdr, row, '会话内容');
    const { goodsNo, userQuestion } = parseContent(
      content,
      rawUserId,
      byHeader(hdr, row, '访客用户名')
    );
    const { category, source } = resolveCategory(userQuestion, qiyuCategory);
    if (source === 'doc') fromDoc++;
    else fromQiyu++;

    lines.push(
      [
        category,
        thirdCategory(qiyuCategory),
        dateOnly(enterTime),
        minuteOnly(sessionEndTime),
        userId,
        sessionId,
        suspectC,
        goodsNo,
        userQuestion
      ]
        .map(csvEscape)
        .join(',')
    );
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, '\uFEFF' + lines.join('\n'), 'utf8');
  console.log(
    JSON.stringify(
      {
        ok: true,
        in: inFile,
        out: outFile,
        rows: lines.length - 1,
        sourceSessions: rows.length,
        categoryFromDoc: fromDoc,
        categoryFromQiyu: fromQiyu,
        suspectCSource: 'OS user_labels.looklike_c_user.label',
        suspectCCounts
      },
      null,
      2
    )
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
