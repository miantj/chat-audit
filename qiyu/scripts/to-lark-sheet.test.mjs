import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, mock, test } from 'node:test';
import * as sheet from './to-lark-sheet.mjs';
import { REGISTER_HEADERS, CUSTOMER_CHECK_HEADERS } from './to-register.mjs';
const { numericId, runLark } = sheet;

const timeout = {
  ok: false,
  error: { type: 'network', subtype: 'timeout', message: 'API call failed: server time out error' }
};
const success = { ok: true, data: { rows: 200 } };
const result = (body, status = 1, channel = 'stderr') => ({
  status, stdout: '', stderr: '', [channel]: JSON.stringify(body)
});

function stub(t, results) {
  let index = 0;
  const execute = t.mock.method(childProcess, 'spawnSync', () => results[Math.min(index++, results.length - 1)]);
  syncBuiltinESMExports();
  const wait = t.mock.method(Atomics, 'wait', () => 'timed-out');
  const log = t.mock.method(console, 'error', () => {});
  return { execute, wait, log };
}

afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

test('数字 ID 保留数值，占位符留空，非法值和超出安全整数范围时报错', () => {
  for (const value of ['', '--', '—', '-', 'N/A', 'na', '  ']) {
    assert.equal(numericId(value, '一手用户id'), null);
  }
  assert.equal(numericId('20390656', '一手用户id'), 20390656);
  assert.equal(numericId(' 20390656 ', '一手用户id'), 20390656);
  assert.throws(() => numericId('Guest1', '一手用户id'), /不是纯数字/);
  assert.throws(() => numericId('9007199254740992', '会话id'), /超出安全整数范围/);
});

test('数字 ID 保留数值，占位符留空，非法值和超出安全整数范围时报错', () => {
  for (const value of ['', '--', '—', '-', 'N/A', 'na', '  ']) {
    assert.equal(numericId(value, '一手用户id'), null);
  }
  assert.equal(numericId('20390656', '一手用户id'), 20390656);
  assert.equal(numericId(' 20390656 ', '一手用户id'), 20390656);
  assert.throws(() => numericId('Guest1', '一手用户id'), /不是纯数字/);
  assert.throws(() => numericId('9007199254740992', '会话id'), /超出安全整数范围/);
});

test('覆盖写入超时后重试原请求，并返回成功结果', (t) => {
  const { execute, wait, log } = stub(t, [result(timeout), result(timeout, 1, 'stdout'), result(success, 0, 'stdout')]);
  const args = ['sheets', '+table-put', '--sheets', '@payload.json'];
  assert.deepEqual(runLark(args), success);
  assert.equal(execute.mock.callCount(), 3);
  for (const call of execute.mock.calls) assert.deepEqual(call.arguments[1], args);
  assert.deepEqual(wait.mock.calls.map((call) => call.arguments[3]), [2000, 4000]);
  assert.equal(log.mock.callCount(), 2);
});

test('连续超时最多尝试三次，保留原始错误', (t) => {
  const { execute, wait } = stub(t, [result(timeout)]);
  assert.throws(() => runLark(['sheets', '+csv-get']), /server time out error/);
  assert.equal(execute.mock.callCount(), 3);
  assert.equal(wait.mock.callCount(), 2);
});

test('退出码为零但 ok=false 的超时同样重试', (t) => {
  const { execute } = stub(t, [result(timeout, 0, 'stdout'), result(success, 0, 'stdout')]);
  assert.deepEqual(runLark(['sheets', '+cells-set']), success);
  assert.equal(execute.mock.callCount(), 2);
});

test('权限或参数错误立即报错，不重试', (t) => {
  const { execute, wait } = stub(t, [result({ ok: false, error: { type: 'permission', message: 'denied' } })]);
  assert.throws(() => runLark(['sheets', '+table-put']), /denied/);
  assert.equal(execute.mock.callCount(), 1);
  assert.equal(wait.mock.callCount(), 0);
});

for (const template of [{ rows: 3, type: 'custom', height: 160 }, { rows: 102, type: 'custom', height: 78 }, { rows: 2, type: 'auto', height: 27 }]) {
test(`飞书按十二列写入并沿用 ${template.rows} 行模板样式及行高`, () => {
  const csv = [REGISTER_HEADERS.join(','), ...[
    ['是', '', ''], ['', '是', ''], ['', '', '是']
  ].map((checks, i) => ['面料成分咨询', '面料成分咨询', '2026-10-22', '2026-10-22 13:00', '1', String(100 + i), '否', '123456', '什么面料', ...checks].join(','))].join('\n');
  const writes = new Map();
  const commands = [];
  const originalArgv = process.argv;
  process.argv = ['node', 'to-lark-sheet.mjs', '--in', '/tmp/test-2026-10-22.csv'];
  mock.method(fs, 'existsSync', (file) => file === '/tmp/test-2026-10-22.csv');
  mock.method(fs, 'readFileSync', () => csv);
  mock.method(fs, 'writeFileSync', (file, body) => writes.set(file, body));
  mock.method(fs, 'mkdirSync', () => {});
  mock.method(fs, 'rmSync', () => {});
  mock.method(console, 'log', () => {});
  let workbooks = 0;
  mock.method(childProcess, 'spawnSync', (_, args) => {
    commands.push(args);
    let data = {};
    if (args[1] === '+workbook-info') {
      data = { sheets: [{ sheet_name: 'Sheet2', sheet_id: 'options' }, { sheet_name: '模板', sheet_id: 'ej5BzF', row_count: template.rows }, { sheet_name: '2026-10-22', sheet_id: workbooks++ ? 'new-sheet' : 'old-sheet' }] };
    }
    if (args[1] === '+sheet-info') {
      data = { row_heights: [{ rows: `${template.rows}:${template.rows}`, type: template.type, height: template.height }] };
    }
    if (args[1] === '+cells-get') {
      data = { has_more: false, ranges: [{ actual_range: `A${template.rows}:L${template.rows}`, row_indices: [template.rows], col_indices: [...'ABCDEFGHIJKL'], cells: [REGISTER_HEADERS.map((_, index) => ({ cell_styles: { font_size: index < 9 ? 10 : 13, horizontal_alignment: 'center' } }))] }] };
    }
    if (args[1] === '+csv-get') {
      data = { annotated_csv: args.includes('C1:C200') ? '[row=1]面料成分咨询\n[row=2]关于售前其他咨询' : '[row=1]AI咨询分类\n[row=2]面料成分咨询\n[row=3]面料成分咨询\n[row=4]面料成分咨询' };
    }
    return result({ ok: true, data }, 0, 'stdout');
  });
  syncBuiltinESMExports();
  try {
    sheet.main();
    const payload = JSON.parse([...writes].find(([file]) => file.includes('._lark-sheets-'))[1]);
    const table = payload.sheets[0];
    assert.equal(table.columns.length, 12);
    assert.deepEqual(table.columns.slice(-3), CUSTOMER_CHECK_HEADERS);
    assert.deepEqual(table.data.map((row) => row.slice(-3)), [['是', '', ''], ['', '是', ''], ['', '', '是']]);
    for (const name of CUSTOMER_CHECK_HEADERS) assert.equal(table.dtypes[name], 'object');
    const copy = commands.find((args) => args[1] === '+range-copy');
    assert.equal(copy[copy.indexOf('--source-range') + 1], `A1:L${Math.min(template.rows, 4)}`);
    const styleArgs = commands.find((args) => args[1] === '+styles-put');
    const styles = JSON.parse(styleArgs[styleArgs.indexOf('--styles') + 1]).styles[0];
    assert.equal(styles.col_sizes, undefined, '列宽应由 sheet-copy 保留，不再硬编码');
    if (template.rows < 4) {
      assert.ok(styles.cell_styles.some((style) => style.range === `A${template.rows + 1}:A4` && style.font_size === 10));
      assert.ok(styles.cell_styles.some((style) => style.range === `L${template.rows + 1}:L4` && style.font_size === 13));
      assert.deepEqual(styles.row_sizes, [{ range: `${template.rows + 1}:4`, type: template.type === 'auto' ? 'auto' : 'pixel', ...(template.type === 'auto' ? {} : { size: template.height }) }]);
    } else {
      assert.deepEqual(styles.row_sizes, []);
      const trim = commands.find((args) => args[1] === '+dim-delete');
      assert.equal(trim[trim.indexOf('--range') + 1], '5:102');
    }
    for (const command of ['+sheet-info', '+cells-get']) {
      assert.ok(commands.findIndex((args) => args[1] === command) < commands.findIndex((args) => args[1] === '+sheet-delete'), '模板应在删除旧子表前读取');
    }
  } finally {
    process.argv = originalArgv;
  }
});
}

test('创建子表、删除子表和删除行超时不自动重放', (t) => {
  const { execute, wait } = stub(t, [result(timeout)]);
  for (const command of ['+sheet-copy', '+sheet-delete', '+dim-delete']) {
    assert.throws(() => runLark(['sheets', command]), /server time out error/);
  }
  assert.equal(execute.mock.callCount(), 3);
  assert.equal(wait.mock.callCount(), 0);
});

test('成功请求只执行一次', (t) => {
  const { execute, wait } = stub(t, [result(success, 0, 'stdout')]);
  assert.deepEqual(runLark(['sheets', '+workbook-info']), success);
  assert.equal(execute.mock.callCount(), 1);
  assert.equal(wait.mock.callCount(), 0);
});

test('CLI 缺失与无效 JSON 仍然报错，不重试', (t) => {
  const { execute, wait } = stub(t, [
    { status: null, error: { code: 'ENOENT' } },
    { status: 0, stdout: 'not json', stderr: '' }
  ]);
  assert.throws(() => runLark(['sheets', '+table-put']), /未找到 lark-cli/);
  assert.throws(() => runLark(['sheets', '+workbook-info']), SyntaxError);
  assert.equal(execute.mock.callCount(), 2);
  assert.equal(wait.mock.callCount(), 0);
});

test('飞书按十二列写入三种勾选结果，并为新增 J:L 列设置样式', () => {
  const csv = [REGISTER_HEADERS.join(','), ...[
    ['是', '', ''], ['', '是', ''], ['', '', '是']
  ].map((checks, i) => ['面料成分咨询', '面料成分咨询', '2026-10-22', '2026-10-22 13:00', '1', String(100 + i), '否', '123456', '什么面料', ...checks].join(','))].join('\n');
  const writes = new Map();
  const commands = [];
  const originalArgv = process.argv;
  process.argv = ['node', 'to-lark-sheet.mjs', '--in', '/tmp/test-2026-10-22.csv'];
  mock.method(fs, 'existsSync', (file) => file === '/tmp/test-2026-10-22.csv');
  mock.method(fs, 'readFileSync', () => csv);
  mock.method(fs, 'writeFileSync', (file, body) => writes.set(file, body));
  mock.method(fs, 'mkdirSync', () => {});
  mock.method(fs, 'rmSync', () => {});
  mock.method(console, 'log', () => {});
  let workbooks = 0;
  mock.method(childProcess, 'spawnSync', (_, args) => {
    commands.push(args);
    let data = {};
    if (args[1] === '+workbook-info') {
      data = { sheets: [{ sheet_name: 'Sheet2', sheet_id: 'options' }, { sheet_name: '模板', sheet_id: 'ej5BzF', row_count: 102 }, ...(workbooks++ ? [{ sheet_name: '2026-10-22', sheet_id: 'new-sheet' }] : [])] };
    }
    if (args[1] === '+sheet-info') {
      data = { row_heights: [{ rows: '102:102', type: 'pixel', height: 40 }] };
    }
    if (args[1] === '+cells-get') {
      data = { has_more: false, ranges: [{ actual_range: 'A102:L102', row_indices: [102], col_indices: [...'ABCDEFGHIJKL'], cells: [REGISTER_HEADERS.map((_, index) => ({ cell_styles: { font_size: index < 9 ? 10 : 13, horizontal_alignment: 'center' } }))] }] };
    }
    if (args[1] === '+csv-get') {
      data = { annotated_csv: args.includes('C1:C200') ? '[row=1]面料成分咨询\n[row=2]关于售前其他咨询' : '[row=1]AI咨询分类\n[row=2]面料成分咨询\n[row=3]面料成分咨询\n[row=4]面料成分咨询' };
    }
    return result({ ok: true, data }, 0, 'stdout');
  });
  syncBuiltinESMExports();
  try {
    sheet.main();
    const payload = JSON.parse([...writes].find(([file]) => file.includes('._lark-sheets-'))[1]);
    const table = payload.sheets[0];
    assert.equal(table.columns.length, 12);
    assert.deepEqual(table.columns.slice(-3), CUSTOMER_CHECK_HEADERS);
    assert.deepEqual(table.data.map((row) => row.slice(-3)), [['是', '', ''], ['', '是', ''], ['', '', '是']]);
    for (const name of CUSTOMER_CHECK_HEADERS) assert.equal(table.dtypes[name], 'object');
    const styleArgs = commands.find((args) => args[1] === '+styles-put');
    assert.ok(styleArgs, '应写入样式');
    const dim = commands.find((args) => args[1] === '+dim-delete');
    assert.equal(dim[dim.indexOf('--range') + 1], '5:102');
  } finally {
    process.argv = originalArgv;
  }
});
