#!/usr/bin/env node
/**
 * 售前登记 CSV → 飞书「2026售前登记」知识库表格
 * - 按下载日建/覆盖同名子表（如 2026-09-27）
 * - 12 列：原登记字段 + 没有疑似c端标签但是是c端/有疑似c端标签确认是c端/无法判断
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REGISTER_HEADERS, CUSTOMER_CHECK_HEADERS } from './to-register.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_URL =
  'https://yb7ao262ru.feishu.cn/wiki/Y8niwzMiliLdyUkb21VcMVqHnMe?sheet=ej5BzF';
const WIKI_NODE = 'Y8niwzMiliLdyUkb21VcMVqHnMe';
const TEMPLATE_SHEET_ID = 'ej5BzF';
const OPTIONS_SHEET_NAME = 'Sheet2';
const SHEET_COLUMNS = 'ABCDEFGHIJKL';
const STYLE_KEYS = [
  'background_color', 'font_color', 'font_family', 'font_line', 'font_size',
  'font_style', 'font_weight', 'horizontal_alignment', 'number_format',
  'vertical_alignment', 'word_wrap'
];
if (SHEET_COLUMNS.length !== REGISTER_HEADERS.length) {
  throw new Error('飞书列范围与登记表头列数不一致');
}

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

export function runLark(args) {
  // 仅重试本脚本的读取、定址覆盖操作；创建子表/删除行可能已生效，不能盲目重放。
  const retryable = args[0] === 'sheets' && [
    '+workbook-info', '+sheet-info', '+cells-get', '+csv-get', '+table-put', '+cells-set',
    '+range-copy', '+styles-put', '+dropdown-set', '+dropdown-delete'
  ].includes(args[1]);
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync('lark-cli', args, { cwd: ROOT, encoding: 'utf8' });
    if (result.error?.code === 'ENOENT') {
      throw new Error(
        '未找到 lark-cli。请先安装并登录：npm i -g @larksuite/cli && lark-cli auth login'
      );
    }
    let apiError;
    for (const text of [result.stderr, result.stdout]) {
      try {
        const output = JSON.parse(text);
        if (output?.ok === false || output?.error) {
          apiError = output;
          break;
        }
      } catch {
        // stderr 可能是普通提示；成功响应仍由下方严格解析。
      }
    }
    if (result.status === 0 && !apiError) return JSON.parse(result.stdout);
    const message = result.stderr?.trim() || result.stdout?.trim() ||
      result.error?.message || `lark-cli 失败（exit ${result.status}）：${args.slice(0, 2).join(' ')}`;
    if (!retryable || attempt >= 3 ||
        apiError?.error?.type !== 'network' || apiError.error.subtype !== 'timeout') {
      throw new Error(message);
    }
    const delay = 2000 * attempt;
    console.error(`[lark] ${args.slice(0, 2).join(' ')} 超时，${delay / 1000} 秒后重试（${attempt + 1}/3）`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  }
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

/** 七鱼偶发用 -- / — 表示无一手用户 id；空与占位都当缺省，不阻断整表写入 */
export function numericId(value, name) {
  const text = String(value || '').trim();
  if (!text || /^-+$/.test(text) || text === '—' || /^n\/?a$/i.test(text)) return null;
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

function rowSpanCovers(span, row) {
  if (typeof span !== 'string' || !/^\d+(:\d+)?$/.test(span)) return false;
  const [start, end = start] = span.split(':').map(Number);
  return start <= row && row <= end;
}

function rowHeightForPut(layout, row) {
  const hit = layout?.row_heights?.find((item) => rowSpanCovers(item?.rows ?? item?.range, row));
  if (hit?.type === 'auto') return { type: 'auto' };
  const size = Number(hit?.height ?? hit?.size);
  if (!Number.isFinite(size) || size <= 0) throw new Error('模板正文行高读取失败，停止覆盖');
  return { type: 'pixel', size };
}

function borderForPut(raw) {
  if (!raw || typeof raw !== 'object') return;
  const border = {};
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const spec = raw[side];
    if (!spec || typeof spec !== 'object') continue;
    const item = {};
    for (const key of ['style', 'weight', 'color']) {
      if (typeof spec[key] === 'string' && spec[key]) item[key] = spec[key];
    }
    if (Object.keys(item).length) border[side] = item;
  }
  if (Object.keys(border).length) return border;
}

function styleForPut(cell) {
  const src = cell?.cell_styles;
  const style = {};
  if (src && typeof src === 'object') {
    for (const key of STYLE_KEYS) {
      const value = src[key];
      if (value == null || value === '') continue;
      if (key === 'font_size') {
        const size = Number(value);
        if (Number.isFinite(size) && size > 0) style.font_size = size;
      } else if (typeof value === 'string') style[key] = value;
    }
  }
  const border = borderForPut(cell?.border_styles) || borderForPut(src?.border_styles);
  if (border) style.border_styles = border;
  if (!Object.keys(style).length) throw new Error('模板正文样式读取不完整，停止覆盖');
  return style;
}

export function main() {
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
  if (REGISTER_HEADERS.some((name) => headers.filter((header) => header === name).length !== 1)) {
    throw new Error('CSV 表头缺失或重复，请重新生成完整的十二列登记数据；停止覆盖');
  }
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
  const templateRows = Number(info.data?.sheets?.find((sheet) => sheet.sheet_id === TEMPLATE_SHEET_ID)?.row_count);
  if (!Number.isInteger(templateRows) || templateRows < 2) throw new Error('模板至少需要表头和一行正文样式');
  const dataEnd = data.length + 1;
  const templateRow = `A${templateRows}:${SHEET_COLUMNS.at(-1)}${templateRows}`;
  let templateRange;
  let templateHeight;
  if (dataEnd > templateRows) {
    const templateLayout = runLark([
      'sheets', '+sheet-info', '--as', 'user', '--url', targetUrl,
      '--sheet-id', TEMPLATE_SHEET_ID, '--range', templateRow,
      '--include', 'row_heights', '--format', 'json'
    ]).data;
    const templateCells = runLark([
      'sheets', '+cells-get', '--as', 'user', '--url', targetUrl,
      '--sheet-id', TEMPLATE_SHEET_ID, '--range', templateRow,
      '--include', 'style', '--format', 'json'
    ]).data;
    templateRange = templateCells?.ranges?.[0];
    if (templateCells?.has_more || templateRange?.truncated ||
        templateRange?.actual_range !== templateRow ||
        Number(templateRange?.row_indices?.[0]) !== templateRows ||
        templateRange?.col_indices?.join('') !== SHEET_COLUMNS ||
        templateRange?.cells?.[0]?.length !== REGISTER_HEADERS.length) {
      throw new Error('模板正文样式读取不完整，停止覆盖');
    }
    templateHeight = rowHeightForPut(templateLayout, templateRows);
  }
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
          用户问题: 'object',
          ...Object.fromEntries(CUSTOMER_CHECK_HEADERS.map((name) => [name, 'object']))
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

  // sheet-copy 会带上模板样例行；table-put 只覆盖写入块，多出来的行要删掉，否则残留假数据。
  if (dataEnd < templateRows) {
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
      `${dataEnd + 1}:${templateRows}`,
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

  const formatEnd = Math.min(templateRows, dataEnd);
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
    `A1:${SHEET_COLUMNS.at(-1)}${formatEnd}`,
    '--target-range',
    `A1:${SHEET_COLUMNS.at(-1)}${formatEnd}`,
    '--paste-type',
    'formats',
    '--format',
    'json'
  ]);
  const bodyStyles = [];
  if (dataEnd > templateRows) {
    // 模板最后一行作为新增正文行的样式；现有模板行及列宽由 sheet-copy 保留。
    bodyStyles.push(...templateRange.cells[0].map((cell, index) => ({
      range: `${templateRange.col_indices[index]}${templateRows + 1}:${templateRange.col_indices[index]}${dataEnd}`,
      ...styleForPut(cell)
    })));
  }
  bodyStyles.push(
    { range: `C2:C${dataEnd}`, number_format: 'yyyy/MM/dd' },
    { range: `D2:D${dataEnd}`, number_format: 'yyyy/MM/dd HH:mm' },
    { range: `E2:F${dataEnd}`, number_format: '0' },
    { range: `H2:H${dataEnd}`, number_format: '0' }
  );
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
        row_sizes: dataEnd > templateRows ? [{
          range: `${templateRows + 1}:${dataEnd}`,
          ...templateHeight
        }] : []
      }]
    }),
    '--format',
    'json'
  ]);
  runLark(['sheets', '+dropdown-set', '--as', 'user', '--url', targetUrl, '--sheet-id', sheetId, '--range', `A2:A${dataEnd}`, '--source-range', "'Sheet2'!C1:C200", '--multiple', '--highlight', '--format', 'json']);
  runLark(['sheets', '+dropdown-set', '--as', 'user', '--url', targetUrl, '--sheet-id', sheetId, '--range', `G2:G${dataEnd}`, '--options', '["是","否"]', '--colors', '["#bacefd","#fed4a4"]', '--highlight', '--format', 'json']);
  runLark(['sheets', '+dropdown-delete', '--as', 'user', '--url', targetUrl, '--ranges', JSON.stringify([`${sheetName}!E2:F${dataEnd}`]), '--yes', '--format', 'json']);
  runLark(['sheets', '+cells-set', '--as', 'user', '--url', targetUrl, '--sheet-id', sheetId, '--range', 'C2', '--cells', '[[{"data_validation":{"type":"date"}}]]', '--copy-to-range', `C2:C${dataEnd}`, '--format', 'json']);

  const url = `https://yb7ao262ru.feishu.cn/wiki/${WIKI_NODE}?sheet=${sheetId}`;
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
  const written = (probe.data?.annotated_csv || '')
    .split(/\n/)
    .map((line) => line.split(']', 2).pop() || '')
    .filter((line, idx) => idx > 0 && line.replace(/,/g, '').trim()).length;
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
