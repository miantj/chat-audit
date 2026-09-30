#!/usr/bin/env node
/**
 * 售前登记 CSV → 飞书「2026售前登记」知识库表格
 * - 按下载日建/覆盖同名子表（如 2026-09-27）
 * - 仅 9 列：AI咨询分类/七鱼咨询分类/日期/会话结束时间/一手用户id/会话id/是否疑似c端/货号/用户问题
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REGISTER_HEADERS } from './to-register.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_URL =
  process.env.QIYU_LARK_SHEET_URL ||
  'https://yb7ao262ru.feishu.cn/wiki/Y8niwzMiliLdyUkb21VcMVqHnMe?sheet=ej5BzF';
const WIKI_NODE = 'Y8niwzMiliLdyUkb21VcMVqHnMe';
const TEMPLATE_SHEET_ID = 'ej5BzF';
const TEMPLATE_ROWS = 102;
const OPTIONS_SHEET_NAME = 'Sheet2';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2];
  }
}

function runLark(args) {
  const result = spawnSync('lark-cli', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') {
    throw new Error(
      '未找到 lark-cli。请先安装并登录：npm i -g @larksuite/cli && lark-cli auth login'
    );
  }
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() ||
        result.stdout?.trim() ||
        `lark-cli 失败（exit ${result.status}）：${args.join(' ')}`
    );
  }
  return JSON.parse(result.stdout);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell || row.length) rows.push([...row, cell.replace(/\r$/, '')]);
  return rows;
}

function splitCategories(raw, options) {
  const exact = new Set(options);
  const sorted = [...options].sort((a, b) => b.length - a.length);
  if (exact.has(raw)) return [raw];
  const parts = [];
  for (const commaPart of raw.split(',')) {
    const chunk = commaPart.trim();
    if (!chunk) continue;
    if (exact.has(chunk)) {
      parts.push(chunk);
      continue;
    }
    for (let index = 0; index < chunk.length;) {
      if (chunk[index] === '/') {
        index++;
        continue;
      }
      const known = sorted.find((option) => chunk.startsWith(option, index));
      if (known) {
        parts.push(known);
        index += known.length;
        continue;
      }
      let end = index;
      while (end < chunk.length && chunk[end] !== '/') end++;
      parts.push(chunk.slice(index, end).trim());
      index = end;
    }
  }
  return [...new Set(parts.filter(Boolean))];
}

function numericId(value, name) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) throw new Error(`${name} 不是纯数字：${text}`);
  const number = Number(text);
  if (!Number.isSafeInteger(number)) throw new Error(`${name} 超出安全整数范围：${text}`);
  return number;
}

function numericOrText(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) return text; // 多货号单元格内换行，必须保留原值
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : text;
}

function datetimeValue(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?$/);
  return match ? `${match[1]}T${match[2]}:00` : '';
}

function main() {
  loadEnv();
  const inputArg = arg('--in');
  if (!inputArg) throw new Error('缺少 --in CSV 文件');
  const input = path.resolve(inputArg);
  if (!fs.existsSync(input)) throw new Error(`文件不存在：${input}`);
  const baseName = path.basename(input, path.extname(input));
  const dateName = arg('--date') || baseName.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (!dateName) throw new Error('缺少下载日：传 --date 或文件名带 YYYY-MM-DD');
  const targetUrl = arg('--url') || process.env.QIYU_LARK_SHEET_URL || DEFAULT_URL;
  const sheetName = dateName;

  const rows = parseCsv(fs.readFileSync(input, 'utf8'));
  const headers = rows.shift() || [];
  const records = rows.filter((row) => row.some((value) => String(value || '').trim()));
  if (!records.length) throw new Error('CSV 没有数据');

  const data = records.map((row) => {
    const obj = Object.fromEntries(headers.map((name, i) => [name, row[i] || '']));
    return REGISTER_HEADERS.map((name) => {
      if (name === '一手用户id' || name === '会话id') return numericId(obj[name], name);
      if (name === '货号') return numericOrText(obj[name]);
      if (name === '会话结束时间') return datetimeValue(obj[name]) || String(obj[name] || '').trim();
      return obj[name] || '';
    });
  });
  // 缺结束时间的行无法整列用 datetime；有值的写成 ISO，缺的保留空串/原文，整列走 object
  const completeSessionEndTime = data.every((row) => {
    const v = String(row[3] ?? '').trim();
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v);
  });
  const tableData = completeSessionEndTime
    ? data
    : data.map((row) =>
        row.map((value, index) =>
          index === 3 ? String(value || '').replace('T', ' ').replace(/:00$/, '') : value
        )
      );

  const info = runLark([
    'sheets',
    '+workbook-info',
    '--as',
    'user',
    '--url',
    targetUrl,
    '--format',
    'json'
  ]);
  const optionsSheet = (info.data?.sheets || []).find((sheet) => sheet.sheet_name === OPTIONS_SHEET_NAME);
  if (!optionsSheet?.sheet_id) throw new Error(`未找到分类选项表：${OPTIONS_SHEET_NAME}`);
  const optionsOut = runLark([
    'sheets',
    '+csv-get',
    '--as',
    'user',
    '--url',
    targetUrl,
    '--sheet-id',
    optionsSheet.sheet_id,
    '--range',
    'C1:C200',
    '--format',
    'json'
  ]);
  const optionRows = (optionsOut.data?.annotated_csv || '').split(/\r?\n/);
  const options = optionRows
    .map((line) => line.split(']', 2).pop()?.trim() || '')
    .filter(Boolean);
  const categoryParts = data.map(([category]) => splitCategories(category, options));
  const missingOptions = [...new Set(categoryParts.flat().filter((part) => !options.includes(part)))];
  if (missingOptions.length) {
    const lastOptionRow = optionRows.reduce((last, line) => {
      const match = line.match(/^\[row=(\d+)\]/);
      return match && line.split(']', 2).pop()?.trim() ? Number(match[1]) : last;
    }, 0);
    const startRow = lastOptionRow + 1;
    runLark([
      'sheets',
      '+cells-set',
      '--as',
      'user',
      '--url',
      targetUrl,
      '--sheet-id',
      optionsSheet.sheet_id,
      '--range',
      `C${startRow}:C${startRow + missingOptions.length - 1}`,
      '--cells',
      JSON.stringify(missingOptions.map((value) => [{ value }])),
      '--format',
      'json'
    ]);
  }
  const existing = (info.data?.sheets || []).find((s) => s.sheet_name === sheetName);
  if (existing?.sheet_id) {
    runLark([
      'sheets',
      '+sheet-delete',
      '--as',
      'user',
      '--url',
      targetUrl,
      '--sheet-id',
      existing.sheet_id,
      '--yes',
      '--format',
      'json'
    ]);
  }

  runLark([
    'sheets',
    '+sheet-copy',
    '--as',
    'user',
    '--url',
    targetUrl,
    '--sheet-id',
    TEMPLATE_SHEET_ID,
    '--title',
    sheetName,
    '--format',
    'json'
  ]);

  const sheetsPayload = {
    sheets: [
      {
        name: sheetName,
        columns: REGISTER_HEADERS,
        dtypes: {
          AI咨询分类: 'object',
          七鱼咨询分类: 'object',
          日期: 'datetime64[ns]',
          会话结束时间: completeSessionEndTime ? 'datetime64[ns]' : 'object',
          一手用户id: 'Int64',
          会话id: 'Int64',
          是否疑似c端: 'object',
          // 多货号记录以单元格内换行保留；单货号按数字写入。
          货号: 'object',
          用户问题: 'object'
        },
        formats: {
          日期: 'yyyy/MM/dd',
          ...(completeSessionEndTime ? { 会话结束时间: 'yyyy/MM/dd HH:mm' } : {}),
          一手用户id: '0',
          会话id: '0',
          货号: '0'
        },
        data: tableData,
        header: true,
        allow_overwrite: true
      }
    ]
  };

  const sheetsFile = path.join(ROOT, 'exports', `._lark-sheets-${dateName}.json`);
  const categoriesFile = path.join(ROOT, 'exports', `._lark-categories-${dateName}.json`);
  fs.mkdirSync(path.dirname(sheetsFile), { recursive: true });
  fs.writeFileSync(sheetsFile, JSON.stringify(sheetsPayload), 'utf8');

  try {
    runLark([
      'sheets',
      '+table-put',
      '--as',
      'user',
      '--url',
      targetUrl,
      '--sheets',
      `@${path.relative(ROOT, sheetsFile)}`,
      '--format',
      'json'
    ]);
  } finally {
    fs.rmSync(sheetsFile, { force: true });
  }

  const after = runLark([
    'sheets',
    '+workbook-info',
    '--as',
    'user',
    '--url',
    targetUrl,
    '--format',
    'json'
  ]);
  const sheet = (after.data?.sheets || []).find((s) => s.sheet_name === sheetName);
  const sheetId = sheet?.sheet_id || '';
  if (!sheetId) throw new Error(`未找到新建子表：${sheetName}`);

  const dataEnd = data.length + 1;
  // sheet-copy 会带上模板样例行；table-put 只覆盖写入块，多出来的行要删掉，否则残留假数据。
  if (dataEnd < TEMPLATE_ROWS) {
    runLark([
      'sheets',
      '+dim-delete',
      '--as',
      'user',
      '--url',
      targetUrl,
      '--sheet-id',
      sheetId,
      '--range',
      `${dataEnd + 1}:${TEMPLATE_ROWS}`,
      '--yes',
      '--format',
      'json'
    ]);
  }

  fs.writeFileSync(
    categoriesFile,
    JSON.stringify(
      categoryParts.map((parts) => [{ multiple_values: parts.map((value) => ({ value })) }])
    ),
    'utf8'
  );
  try {
    runLark([
      'sheets',
      '+cells-set',
      '--as',
      'user',
      '--url',
      targetUrl,
      '--sheet-id',
      sheetId,
      '--range',
      `A2:A${dataEnd}`,
      '--cells',
      `@${path.relative(ROOT, categoriesFile)}`,
      '--format',
      'json'
    ]);
  } finally {
    fs.rmSync(categoriesFile, { force: true });
  }

  const formatEnd = Math.min(TEMPLATE_ROWS, dataEnd);
  runLark([
    'sheets',
    '+range-copy',
    '--as',
    'user',
    '--url',
    targetUrl,
    '--sheet-id',
    TEMPLATE_SHEET_ID,
    '--target-sheet-id',
    sheetId,
    '--source-range',
    `A1:I${formatEnd}`,
    '--target-range',
    `A1:I${formatEnd}`,
    '--paste-type',
    'formats',
    '--format',
    'json'
  ]);
  const bodyStyles = [
    { range: `C2:C${dataEnd}`, number_format: 'yyyy/MM/dd' },
    { range: `D2:D${dataEnd}`, number_format: 'yyyy/MM/dd HH:mm' },
    { range: `E2:F${dataEnd}`, number_format: '0' },
    { range: `H2:H${dataEnd}`, number_format: '0' }
  ];
  if (dataEnd >= 103) {
    bodyStyles.push(
      { range: `A103:F${dataEnd}`, font_family: '微软雅黑', font_size: 13, font_color: 'rgb(0, 0, 0)', horizontal_alignment: 'center', vertical_alignment: 'middle' },
      { range: `G103:G${dataEnd}`, font_family: '微软雅黑', font_size: 13, font_color: 'rgb(31, 35, 41)', horizontal_alignment: 'center', vertical_alignment: 'middle' },
      { range: `H103:H${dataEnd}`, font_family: '微软雅黑', font_size: 13, font_color: 'rgb(0, 0, 0)', horizontal_alignment: 'center', vertical_alignment: 'middle' },
      { range: `I103:I${dataEnd}`, font_family: '微软雅黑', font_size: 13, font_color: 'rgb(31, 35, 41)', horizontal_alignment: 'center', vertical_alignment: 'middle' }
    );
  }
  runLark([
    'sheets',
    '+styles-put',
    '--as',
    'user',
    '--url',
    targetUrl,
    '--styles',
    JSON.stringify({
      styles: [{
        name: sheetName,
        cell_styles: bodyStyles,
        row_sizes: dataEnd >= 103 ? [{ range: `103:${dataEnd}`, type: 'pixel', size: 78 }] : []
      }]
    }),
    '--format',
    'json'
  ]);
  runLark(['sheets', '+dropdown-set', '--as', 'user', '--url', targetUrl, '--sheet-id', sheetId, '--range', `A2:A${dataEnd}`, '--source-range', "'Sheet2'!C1:C200", '--multiple', '--highlight', '--format', 'json']);
  runLark(['sheets', '+dropdown-set', '--as', 'user', '--url', targetUrl, '--sheet-id', sheetId, '--range', `G2:G${dataEnd}`, '--options', '["是","否"]', '--colors', '["#bacefd","#fed4a4"]', '--highlight', '--format', 'json']);
  runLark(['sheets', '+dropdown-delete', '--as', 'user', '--url', targetUrl, '--ranges', JSON.stringify([`${sheetName}!E2:F${dataEnd}`]), '--yes', '--format', 'json']);
  runLark(['sheets', '+cells-set', '--as', 'user', '--url', targetUrl, '--sheet-id', sheetId, '--range', 'C2', '--cells', '[[{"data_validation":{"type":"date"}}]]', '--copy-to-range', `C2:C${dataEnd}`, '--format', 'json']);

  const url = sheetId
    ? `https://yb7ao262ru.feishu.cn/wiki/${WIKI_NODE}?sheet=${sheetId}`
    : targetUrl;

  let written = data.length;
  if (sheetId) {
    const probe = runLark([
      'sheets',
      '+csv-get',
      '--as',
      'user',
      '--url',
      targetUrl,
      '--sheet-id',
      sheetId,
      '--range',
      `A1:A${data.length + 1}`,
      '--format',
      'json'
    ]);
    const csv = probe.data?.annotated_csv || '';
    written = csv
      .split(/\n/)
      .map((line) => line.split(']', 2).pop() || '')
      .filter((line, idx) => idx > 0 && line.replace(/,/g, '').trim()).length;
  }
  if (written !== data.length) {
    throw new Error(`写入行数不符：expected=${data.length} actual=${written}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        input,
        downloadDate: dateName,
        sheetName,
        sheetId,
        rows: data.length,
        url
      },
      null,
      2
    )
  );
}

main();
