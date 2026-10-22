import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, mock, test } from 'node:test';
import { numericId, runLark } from './to-lark-sheet.mjs';

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
