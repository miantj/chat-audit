#!/usr/bin/env node
/**
 * 七鱼导出 xlsx → 售前登记摘录 CSV
 * AI咨询分类：优先文档「11. 分类」关键词；无法判断/无关键词 → 七鱼路径的三级分类
 * 七鱼咨询分类：仅展示七鱼路径的三级分类
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

function isSuspectC(tags) {
  return /疑似\s*C\s*端|疑似c端/i.test(tags) ? '是' : '否';
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

function main() {
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

  let fromDoc = 0;
  let fromQiyu = 0;
  const lines = [REGISTER_HEADERS.join(',')];
  for (const row of rows) {
    const sessionId = byHeader(hdr, row, '会话ID');
    const enterTime = byHeader(hdr, row, '访客进入时间');
    const sessionEndTime =
      endFromFirstMessage(
        byHeader(hdr, row, '访客首条消息时间'),
        byHeader(hdr, row, '会话时长')
      ) || byHeader(hdr, row, '会话结束时间');
    const qiyuCategory = byHeader(hdr, row, '咨询分类');
    const userId =
      byHeader(hdr, row, '用户唯一标识') || byHeader(hdr, row, '访客用户名');
    const tags = byHeader(hdr, row, '客户标签');
    const content = byHeader(hdr, row, '会话内容');
    const { goodsNo, userQuestion } = parseContent(content, userId, byHeader(hdr, row, '访客用户名'));
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
        isSuspectC(tags),
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
        categoryFromQiyu: fromQiyu
      },
      null,
      2
    )
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
