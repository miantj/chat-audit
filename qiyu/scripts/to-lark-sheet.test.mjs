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

test('读取模板行高和单元格样式超时时重试', (t) => {
  const { execute, wait } = stub(t, [
    result(timeout), result(success, 0, 'stdout'),
    result(timeout), result(success, 0, 'stdout')
  ]);
  assert.deepEqual(runLark(['sheets', '+sheet-info']), success);
  assert.deepEqual(runLark(['sheets', '+cells-get']), success);
  assert.equal(execute.mock.callCount(), 4);
  assert.equal(wait.mock.callCount(), 2);
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

test('CSV 缺少判定列或含重复表头时，在任何飞书请求前停止', (t) => {
  const originalArgv = process.argv;
  t.after(() => { process.argv = originalArgv; });
  process.argv = ['node', 'to-lark-sheet.mjs', '--in', '/tmp/test-2026-10-22.csv'];
  t.mock.method(fs, 'existsSync', (file) => file === '/tmp/test-2026-10-22.csv');
  const execute = t.mock.method(childProcess, 'spawnSync', () => assert.fail('不应访问飞书'));
  syncBuiltinESMExports();
  for (const headers of [REGISTER_HEADERS.slice(0, 9), [...REGISTER_HEADERS, '无法判断']]) {
    t.mock.method(fs, 'readFileSync', () => `${headers.join(',')}\n${headers.map(() => '1').join(',')}`);
    assert.throws(() => sheet.main(), /CSV 表头/);
  }
  assert.equal(execute.mock.callCount(), 0);
});

for (const template of [{ rows: 3, type: 'custom', height: 160 }, { rows: 102, type: 'custom', height: 78 }, { rows: 2, type: 'auto' }]) {
test(`飞书按十二列写入并沿用 ${template.rows} 行模板样式及行高`, () => {
  const csv = [REGISTER_HEADERS.join(','), ...[
    ['是', '', ''], ['', '是', ''], ['', '', '是']
  ].map((checks, i) => ['面料咨询', '面料咨询', '2026-10-22', '2026-10-22 13:00', '1', String(100 + i), '否', '123456', '什么面料', ...checks].join(','))].join('\n');
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
      const covered = template.rows === 3
        ? { range: `${template.rows}:${template.rows}`, type: template.type, size: template.height }
        : { rows: `${template.rows}:${template.rows}`, type: template.type, ...(template.height ? { height: template.height } : {}) };
      data = { row_heights: [{ rows: '1:1', type: 'custom', height: 30 }, covered] };
    }
    if (args[1] === '+cells-get') {
      data = { has_more: false, ranges: [{ actual_range: `A${template.rows}:L${template.rows}`, row_indices: [String(template.rows)], col_indices: [...'ABCDEFGHIJKL'], cells: [REGISTER_HEADERS.map((_, index) => ({
        cell_styles: { font_size: index < 9 ? '10' : 13, horizontal_alignment: 'center', clean: false, font: { bold: true } },
        ...(index === 11 ? { border_styles: { bottom: { style: 'solid', color: '#dddddd', extra: true } } } : {})
      }))] }] };
    }
    if (args[1] === '+csv-get') {
      data = { annotated_csv: args.includes('C1:C200') ? '[row=1]面料咨询' : '[row=1]AI咨询分类\n[row=2]面料咨询\n[row=3]面料咨询\n[row=4]面料咨询' };
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
    assert.ok(styles.cell_styles.some((style) => style.range === 'C2:C4' && style.number_format === 'yyyy/MM/dd'));
    assert.ok(styles.cell_styles.some((style) => style.range === 'E2:F4' && style.number_format === '0'));
    assert.ok(styles.cell_styles.some((style) => style.range === 'H2:H4' && style.number_format === '0'));
    const dropdowns = commands.filter((args) => args[1] === '+dropdown-set');
    assert.deepEqual(dropdowns.map((args) => args[args.indexOf('--range') + 1]), ['A2:A4', 'G2:G4']);
    if (template.rows < 4) {
      assert.deepEqual(styles.cell_styles.find((style) => style.range === `A${template.rows + 1}:A4`), {
        range: `A${template.rows + 1}:A4`, font_size: 10, horizontal_alignment: 'center'
      });
      assert.deepEqual(styles.cell_styles.find((style) => style.range === `L${template.rows + 1}:L4`), {
        range: `L${template.rows + 1}:L4`,
        font_size: 13,
        horizontal_alignment: 'center',
        border_styles: { bottom: { style: 'solid', color: '#dddddd' } }
      });
      assert.deepEqual(styles.row_sizes, [{ range: `${template.rows + 1}:4`, type: template.type === 'auto' ? 'auto' : 'pixel', ...(template.type === 'auto' ? {} : { size: template.height }) }]);
    } else {
      assert.deepEqual(styles.row_sizes, []);
      const trim = commands.find((args) => args[1] === '+dim-delete');
      assert.equal(trim[trim.indexOf('--range') + 1], '5:102');
    }
    for (const command of ['+sheet-info', '+cells-get']) {
      const index = commands.findIndex((args) => args[1] === command);
      if (template.rows < 4) {
        assert.ok(index >= 0 && index < commands.findIndex((args) => args[1] === '+sheet-delete'), '扩展行所需模板样式应在删除旧子表前读取');
      } else {
        assert.equal(index, -1, '未超出模板时直接复制，无需额外读取末行样式和行高');
      }
    }
  } finally {
    process.argv = originalArgv;
  }
});
}

test('--url 优先于环境变量，环境变量优先于默认表格', (t) => {
  const originalArgv = process.argv;
  const original = process.env.QIYU_LARK_SHEET_URL;
  t.after(() => {
    process.argv = originalArgv;
    if (original === undefined) delete process.env.QIYU_LARK_SHEET_URL;
    else process.env.QIYU_LARK_SHEET_URL = original;
  });
  const csv = `${REGISTER_HEADERS.join(',')}\n${REGISTER_HEADERS.map(() => '1').join(',')}`;
  t.mock.method(fs, 'existsSync', (file) => file === '/tmp/test-2026-10-22.csv');
  t.mock.method(fs, 'readFileSync', () => csv);
  const urls = [];
  t.mock.method(childProcess, 'spawnSync', (_, args) => {
    urls.push(args[args.indexOf('--url') + 1]);
    return result({ ok: false, error: { message: 'stop' } });
  });
  syncBuiltinESMExports();
  const cases = [
    { argv: ['--url', 'https://flag.example/sheet'], env: 'https://env.example/sheet', url: 'https://flag.example/sheet' },
    { argv: [], env: 'https://env.example/sheet', url: 'https://env.example/sheet' },
    { argv: [], env: undefined, url: 'https://yb7ao262ru.feishu.cn/wiki/Y8niwzMiliLdyUkb21VcMVqHnMe?sheet=ej5BzF' }
  ];
  for (const item of cases) {
    if (item.env === undefined) delete process.env.QIYU_LARK_SHEET_URL;
    else process.env.QIYU_LARK_SHEET_URL = item.env;
    process.argv = ['node', 'to-lark-sheet.mjs', '--in', '/tmp/test-2026-10-22.csv', ...item.argv];
    assert.throws(() => sheet.main(), /stop/);
  }
  assert.deepEqual(urls, cases.map((item) => item.url));
});
