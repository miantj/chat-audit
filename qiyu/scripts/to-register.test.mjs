import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, beforeEach, mock, test } from 'node:test';
import * as register from './to-register.mjs';

const cookie = 'token=test-session';
const user = (id, label = '') => ({
  user_id: id,
  user_labels: { looklike_c_user: { label, color: '' } }
});
const response = (list, total = list.length) => Response.json({ code: '200', data: { total, list } });

const loginResponse = () => Response.json({ code: 200 }, {
  headers: [
    ['Set-Cookie', 'YISHOUSESS=old-session; Domain=.yishouapp.com; Path=/; HttpOnly'],
    ['Set-Cookie', 'YISHOUSESS=new-session; Domain=.yishouapp.com; Path=/; HttpOnly'],
    ['Set-Cookie', 'token=new-token; Domain=.yishouapp.com; Path=/; HttpOnly']
  ]
});
const loginKeys = [
  'QIYU_OS_LOGIN_NAME', 'QIYU_OS_LOGIN_PASSWORD', 'QIYU_OS_LOGIN_PHONE', 'QIYU_OS_COOKIE',
  'QIYU_AI_BASE_URL', 'QIYU_AI_API_KEY', 'QIYU_AI_MODEL'
];
const originalEnv = loginKeys.map((key) => process.env[key]);
function loginEnv() {
  process.env.QIYU_OS_LOGIN_NAME = 'test-user';
  process.env.QIYU_OS_LOGIN_PASSWORD = 'test-password-hash';
  process.env.QIYU_OS_LOGIN_PHONE = 'test-phone';
}

beforeEach(() => { for (const key of loginKeys) delete process.env[key]; });
afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  loginKeys.forEach((key, i) => {
    if (originalEnv[i] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[i];
  });
});

test('批量去重查询，以返回用户 ID 映射是/否，不依赖返回顺序', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://d0k0.yishouapp.com/os/User/Manage/getList');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Cookie, cookie);
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.user_id, '17868245,9720568');
    assert.equal(body.psize, 10);
    assert.deepEqual(body.reg_time, ['', '']);
    return response([user(9720568, ''), user('17868245', '疑似C端')]);
  });
  const flags = await register.getSuspectCByUserId(['17868245', '9720568', '17868245', '--', ''], cookie);
  assert.deepEqual([...flags], [['17868245', '是'], ['9720568', '否']]);
  assert.equal(request.mock.callCount(), 1);
});

test('每批最多十个用户，跨批次仍按 ID 映射', async (t) => {
  const ids = Array.from({ length: 23 }, (_, i) => String(i + 1));
  const batches = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    const body = JSON.parse(options.body);
    const batch = body.user_id.split(',');
    batches.push(batch);
    assert.ok(batch.length <= body.psize);
    return response(batch.toReversed().map((id) => user(id, id === '23' ? '疑似 C 端' : '')));
  });
  const flags = await register.getSuspectCByUserId(ids, cookie);
  assert.deepEqual(batches.map((batch) => batch.length), [10, 10, 3]);
  assert.equal(flags.size, 23);
  assert.equal(flags.get('23'), '是');
});

test('未找到用户保持未知，不把缺失记录当否', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response([user('1')]));
  const flags = await register.getSuspectCByUserId(['1', '2'], cookie);
  assert.equal(flags.get('1'), '否');
  assert.equal(flags.get('2'), '');
});

test('没有有效用户 ID 时不请求接口，也不要求 Cookie', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', () => assert.fail('不应请求'));
  assert.equal((await register.getSuspectCByUserId(['', ' -- ', 'Guest1'], '')).size, 0);
  assert.equal(request.mock.callCount(), 0);
});

test('有效 ID 缺 Cookie 时明确失败，不使用七鱼标签兜底', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', () => assert.fail('不应请求'));
  await assert.rejects(() => register.getSuspectCByUserId(['1'], ''), /QIYU_OS_COOKIE/);
  assert.equal(request.mock.callCount(), 0);
});

test('HTTP 和非 JSON 响应均阻止生成错误数据', async (t) => {
  const responses = [
    new Response('unavailable', { status: 503 }),
    new Response('<html>login</html>')
  ];
  t.mock.method(globalThis, 'fetch', async () => responses.shift());
  await assert.rejects(() => register.getSuspectCByUserId(['1'], cookie), /HTTP 503/);
  await assert.rejects(() => register.getSuspectCByUserId(['1'], cookie), /JSON/);
});

test('疑似 C 端字段缺失或类型变化必须报错，不能写否', async (t) => {
  const responses = [response([{ user_id: '1' }]), response([user('1', false)])];
  t.mock.method(globalThis, 'fetch', async () => responses.shift());
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => register.getSuspectCByUserId(['1'], cookie), /looklike_c_user/);
  }
});

test('返回总数大于当前列表时拒绝把分页截断当作查询完成', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response([user('1')], 2));
  await assert.rejects(() => register.getSuspectCByUserId(['1', '2'], cookie), /不完整/);
});

test('空列表也必须返回有效总数，不能把无效 total 当作查无用户', async (t) => {
  for (const total of [0, '0']) {
    t.mock.method(globalThis, 'fetch', async () => response([], total));
    assert.equal((await register.getSuspectCByUserId(['1'], cookie)).get('1'), '');
  }
  for (const total of [undefined, null, '', ' ', false, [], [0], {}]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 200, data: { list: [], total } }));
    await assert.rejects(() => register.getSuspectCByUserId(['1'], cookie), /不完整/);
  }
});

test('意外用户和重复用户响应必须报错', async (t) => {
  const responses = [response([user('999')]), response([user('1'), user('1')])];
  t.mock.method(globalThis, 'fetch', async () => responses.shift());
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => register.getSuspectCByUserId(['1', '2'], cookie), /用户 ID/);
  }
});

test('过期后登录一次，重查原批次并在后续批次复用新 Cookie', async (t) => {
  loginEnv();
  const ids = Array.from({ length: 21 }, (_, i) => String(i + 1));
  const batches = [];
  let logins = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://erp.yishouapp.com/erp/Admin/login') {
      logins++;
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Origin, 'https://erpweb.yishouapp.com');
      assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('name'), 'test-user');
      assert.equal(form.get('password'), 'test-password-hash');
      assert.equal(form.get('phone'), 'test-phone');
      assert.equal(form.get('login_type'), 'backend');
      assert.equal(form.get('returnUrl'), 'https://osweb.yishouapp.com/newos/user/list');
      return loginResponse();
    }
    const batch = JSON.parse(options.body).user_id.split(',');
    batches.push(batch);
    if (batches.length === 2) return Response.json({ code: '201', msg: '请登录' });
    if (batches.length > 2) {
      assert.match(options.headers.Cookie, /(?:^|; )token=new-token(?:;|$)/);
      assert.match(options.headers.Cookie, /(?:^|; )YISHOUSESS=new-session(?:;|$)/);
      assert.equal(options.headers.Cookie.includes('token=test-session'), false);
    }
    return response(batch.map((id) => user(id)));
  });
  const flags = await register.getSuspectCByUserId(ids, cookie);
  assert.equal(logins, 1);
  assert.deepEqual(batches.map((batch) => batch.length), [10, 10, 10, 1]);
  assert.deepEqual(batches[1], batches[2]);
  assert.equal(flags.size, 21);
});

test('HTTP 401 和业务 401 均能触发一次登录恢复', async (t) => {
  loginEnv();
  for (const expired of [new Response('', { status: 401 }), Response.json({ code: '401' })]) {
    const replies = [expired, loginResponse(), response([user('1')])];
    const request = t.mock.method(globalThis, 'fetch', async () => replies.shift());
    assert.equal((await register.getSuspectCByUserId(['1'], cookie)).get('1'), '否');
    assert.equal(request.mock.callCount(), 3);
    request.mock.restore();
  }
});

test('没有 Cookie 但已配置凭据时先登录再查询', async (t) => {
  loginEnv();
  const replies = [loginResponse(), response([user('1')])];
  const request = t.mock.method(globalThis, 'fetch', async () => replies.shift());
  assert.equal((await register.getSuspectCByUserId(['1'], '')).get('1'), '否');
  assert.equal(request.mock.callCount(), 2);
});

test('登录后仍过期时停止，不能循环登录或生成默认否', async (t) => {
  loginEnv();
  const expired = () => Response.json({ code: '201', msg: '请登录' });
  const replies = [expired(), loginResponse(), expired()];
  const request = t.mock.method(globalThis, 'fetch', async () => replies.shift());
  await assert.rejects(() => register.getSuspectCByUserId(['1'], cookie), /登录后.*失效/);
  assert.equal(request.mock.callCount(), 3);
});

test('登录失败、非 JSON、HTTP 失败或缺少新会话时停止且错误不泄露响应', async (t) => {
  loginEnv();
  for (const failed of [
    Response.json({ code: 500, msg: 'sensitive-response-value' }),
    new Response('sensitive-response-value', { status: 503 }),
    new Response('sensitive-response-value'),
    new Error('sensitive-response-value'),
    Response.json({ code: 200 }),
    Response.json({ code: 200 }, { headers: { 'Set-Cookie': 'token=new-token' } })
  ]) {
    const replies = [Response.json({ code: '201', msg: '请登录' }), failed];
    const request = t.mock.method(globalThis, 'fetch', async () => {
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    });
    await assert.rejects(() => register.getSuspectCByUserId(['1'], cookie), (error) => {
      assert.match(error.message, /OS 自动登录/);
      assert.equal(error.message.includes('sensitive-response-value'), false);
      return true;
    });
    assert.equal(request.mock.callCount(), 2);
    request.mock.restore();
  }
});

test('过期但缺少登录凭据时明确报错，不发送不完整的登录请求', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => Response.json({ code: '201', msg: '请登录' }));
  await assert.rejects(() => register.getSuspectCByUserId(['1'], cookie), /QIYU_OS_LOGIN/);
  assert.equal(request.mock.callCount(), 1);
});

test('普通业务错误和权限不足不能触发重新登录', async (t) => {
  loginEnv();
  for (const failed of [
    Response.json({ code: '201', msg: '查询参数错误' }),
    Response.json({ code: '500', msg: '服务错误' }),
    new Response('', { status: 403 }),
    new Response('', { status: 503 })
  ]) {
    const request = t.mock.method(globalThis, 'fetch', async () => failed);
    await assert.rejects(() => register.getSuspectCByUserId(['1'], cookie), /OS 用户查询失败/);
    assert.equal(request.mock.callCount(), 1);
    request.mock.restore();
  }
});

test('网络超时直接失败，不生成默认的否', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('timed out', 'TimeoutError'); });
  await assert.rejects(() => register.getSuspectCByUserId(['1'], cookie), /timed out/);
});

function aiEnv() {
  process.env.QIYU_OS_COOKIE = cookie;
  process.env.QIYU_AI_BASE_URL = 'https://model.test/v1/';
  process.env.QIYU_AI_API_KEY = 'test-ai-key';
  process.env.QIYU_AI_MODEL = 'gpt-6.1-sol';
}
const aiResponse = (content) => Response.json({ choices: [{ message: { content } }] });

test('全部会话仅调用一次模型，high 推理且按会话 ID 对应结果而非返回顺序', async (t) => {
  aiEnv();
  const sessions = [
    { sessionId: '100', conversation: '访客：我要买一件自己穿。\n客服：请问身高体重？' },
    { sessionId: '101', conversation: '访客：拿到直播间卖。' }
  ];
  const request = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://model.test/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-ai-key');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-6.1-sol');
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.stream, false);
    assert.deepEqual(JSON.parse(body.messages[1].content), sessions);
    assert.match(body.messages[0].content, /采购目的/);
    assert.match(body.messages[0].content, /客户/);
    assert.doesNotMatch(body.messages[0].content, /B端/);
    return aiResponse(JSON.stringify({ results: [
      { sessionId: 101, type: '无法判定' }, { sessionId: '100', type: 'C端' }
    ] }));
  });
  const types = await register.classifyCustomers(sessions);
  assert.equal(types.get('100'), 'C端');
  assert.equal(types.get('101'), '无法判定');
  assert.equal(request.mock.callCount(), 1);
});

test('没有会话时不请求，非空批次缺少配置时失败', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', () => assert.fail('不应请求'));
  assert.equal((await register.classifyCustomers([])).size, 0);
  await assert.rejects(() => register.classifyCustomers([{ sessionId: '1', conversation: '访客：自己穿' }]), /QIYU_AI/);
  assert.equal(request.mock.callCount(), 0);
});

test('模型失败、截断、遗漏、重复或非法输出均停止，不重试且不泄露响应', async (t) => {
  aiEnv();
  const results = (items) => aiResponse(JSON.stringify({ results: items }));
  for (const reply of [
    new Response('private-chat-and-key', { status: 401 }),
    new Response('private-chat-and-key'),
    aiResponse('这是C端，因为自己穿'),
    aiResponse(''),
    aiResponse('{"results":['),
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: '```json\n{"results":[{"sessionId":"1","type":"C端"}]}\n```' } }] }),
    Response.json({ choices: [{ message: { content: { results: [{ sessionId: '1', type: 'C端' }] } } }] }),
    results([{ sessionId: 1.5, type: 'C端' }]),
    results([{ sessionId: 2, type: 'C端' }]),
    Response.json({ choices: [{ finish_reason: 'length', message: { content: JSON.stringify({ results: [{ sessionId: '1', type: 'C端' }] }) } }] }),
    results([]),
    results([{ sessionId: '1', type: 'C端' }, { sessionId: '1', type: 'B端' }]),
    results([{ sessionId: '999', type: 'C端' }]),
    results([{ sessionId: '1', type: '其他' }]),
    results([{ sessionId: '1', type: 'B端' }]),
    Response.json({ error: { message: 'private-chat-and-key' } }),
    new Error('private-chat-and-key')
  ]) {
    const request = t.mock.method(globalThis, 'fetch', async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    });
    await assert.rejects(() => register.classifyCustomers([{ sessionId: '1', conversation: '访客：自己穿' }]), (error) => {
      assert.match(error.message, /AI/);
      assert.equal(error.message.includes('private-chat-and-key'), false);
      return true;
    });
    assert.equal(request.mock.callCount(), 1);
    request.mock.restore();
  }
});

test('输入缺少会话 ID 或重复 ID 时拒绝请求，避免结果错位', async (t) => {
  aiEnv();
  const request = t.mock.method(globalThis, 'fetch', () => assert.fail('不应请求'));
  for (const sessions of [
    ...['', '--', 'abc', '1e3', ' 1 ', '9007199254740992'].map((sessionId) => [{ sessionId, conversation: '自己穿' }]),
    [{ sessionId: '1', conversation: '自己穿' }, { sessionId: '1', conversation: '直播卖' }]
  ]) {
    await assert.rejects(() => register.classifyCustomers(sessions), /会话 ID/);
  }
  assert.equal(request.mock.callCount(), 0);
});

test('三列每行恰好一项，不能确认C端或标签未知均填无法判断', () => {
  assert.deepEqual(register.customerChecks('C端', '否'), ['是', '', '']);
  assert.deepEqual(register.customerChecks('C端', '是'), ['', '是', '']);
  for (const tag of ['是', '否', '', undefined]) {
    assert.deepEqual(register.customerChecks('无法判定', tag), ['', '', '是']);
    for (const type of ['C端', '无法判定']) {
      const checks = register.customerChecks(type, tag);
      assert.equal(checks.filter((value) => value === '是').length, 1);
      assert.ok(checks.every((value) => value === '是' || value === ''));
    }
  }
  assert.deepEqual(register.customerChecks('C端', ''), ['', '', '是']);
  assert.deepEqual(register.customerChecks('C端', undefined), ['', '', '是']);
  assert.throws(() => register.customerChecks('B端', '否'), /判定/);
  assert.throws(() => register.customerChecks('其他', '否'), /判定/);
});

test('模型会话输入保留客服上下文和长消息，不受问题摘录的 200 字限制', () => {
  const long = '我客户的穿着反馈。'.repeat(30);
  const content = `访客名  2026年10月22日 13:00:00\n${long}\n{"goods_no":123456,"image":"https://private-image.test/a"}\nhttps://private-image.test/b\n客服名  2026年10月22日 13:00:01\n这是给自己穿吗？\n访客名  2026年10月22日 13:00:02\n不是，是拿到直播间卖。`;
  const parsed = register.parseContent(content, '123', '访客名');
  assert.ok(parsed.conversation.includes(`访客：${long}`));
  assert.ok(parsed.conversation.includes('客服：这是给自己穿吗？'));
  assert.ok(parsed.conversation.includes('访客：不是，是拿到直播间卖。'));
  assert.equal(parsed.conversation.includes('访客名'), false);
  assert.equal(parsed.conversation.includes('客服名'), false);
  assert.equal(parsed.conversation.includes('private-image.test'), false);
  assert.equal(parsed.conversation.includes('goods_no'), false);
  assert.equal(parsed.userQuestion.includes(long), false);
});

function registerIO(t) {
  const hdr = { A: '用户唯一标识', B: '访客用户名', C: '会话内容', D: '会话ID' };
  const rows = ['自己穿', '拿到直播间卖', '什么面料'].map((text, i) => ({
    A: '1', B: '访客名', C: `访客名  2026年10月22日 13:00:00\n${text}`, D: String(i + 100)
  }));
  t.mock.method(fs, 'existsSync', () => false);
  t.mock.method(fs, 'readdirSync', () => ['test.xlsx']);
  t.mock.method(fs, 'statSync', () => ({ mtimeMs: 1 }));
  t.mock.method(fs, 'mkdirSync', () => {});
  const write = t.mock.method(fs, 'writeFileSync', () => {});
  t.mock.method(console, 'log', () => {});
  t.mock.method(childProcess, 'spawnSync', () => ({ status: 0, stdout: JSON.stringify({ hdr, rows }) }));
  syncBuiltinESMExports();
  return write;
}

test('同一用户不同会话独立判断，全部判断后才查标签，再写入十二列', async (t) => {
  aiEnv();
  const write = registerIO(t);
  const events = [];
  const decisions = ['C端', '无法判定', '无法判定'];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://model.test/v1/chat/completions') {
      events.push('ai');
      const sessions = JSON.parse(JSON.parse(options.body).messages[1].content);
      assert.equal(sessions.length, 3);
      assert.ok(sessions.every((session) => Object.keys(session).sort().join(',') === 'conversation,sessionId'));
      return aiResponse(JSON.stringify({ results: sessions.map((session, i) => ({ sessionId: session.sessionId, type: decisions[i] })) }));
    }
    events.push('tags');
    return response([user('1', '疑似C端')]);
  });
  await register.main();
  assert.deepEqual(events, ['ai', 'tags']);
  assert.equal(write.mock.callCount(), 1);
  const csv = write.mock.calls[0].arguments[1].replace(/^\uFEFF/, '').split('\n');
  assert.deepEqual(csv[0].split(',').slice(-3), ['没有疑似c端标签但是是c端', '有疑似c端标签确认是c端', '无法判断']);
  assert.equal(csv[0].split(',').length, 12);
  assert.deepEqual(csv.slice(1).map((row) => row.split(',').slice(-3)), [['', '是', ''], ['', '', '是'], ['', '', '是']]);
});

test('C端标签未知时保留全部会话并统一填无法判断', async (t) => {
  aiEnv();
  const write = registerIO(t);
  const log = t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://model.test/v1/chat/completions') {
      const sessions = JSON.parse(JSON.parse(options.body).messages[1].content);
      return aiResponse(JSON.stringify({ results: sessions.map(({ sessionId }) => ({ sessionId, type: 'C端' })) }));
    }
    return response([]);
  });
  await register.main();
  const rows = write.mock.calls[0].arguments[1].split('\n').slice(1);
  assert.equal(rows.length, 3);
  for (const row of rows) assert.deepEqual(row.split(',').slice(-3), ['', '', '是']);
  const summary = JSON.parse(log.mock.calls[0].arguments[0]);
  assert.deepEqual(summary.aiCustomerCounts, { C端: 3, 无法判定: 0 });
  assert.equal(summary.cWithUnknownTag, 3);
});

test('任一模型失败时不查标签、不覆盖已有 CSV', async (t) => {
  aiEnv();
  const write = registerIO(t);
  const request = t.mock.method(globalThis, 'fetch', async () => new Response('failed', { status: 503 }));
  await assert.rejects(() => register.main(), /AI/);
  assert.equal(request.mock.callCount(), 1);
  assert.equal(write.mock.callCount(), 0);
});
