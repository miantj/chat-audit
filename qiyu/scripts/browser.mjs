#!/usr/bin/env node
/**
 * 控制本机 Chrome 打开七鱼后台并登录
 *
 *   node scripts/browser.mjs open
 *   node scripts/browser.mjs login --username … --password …   # 或环境变量 / .env
 *   node scripts/browser.mjs status
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CDP,
  QIYU_HISTORY_URL,
  ensureChrome,
  pickPageTarget,
  profileDir
} from './lib/chrome.mjs';
import { Cdp } from './lib/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cmd = process.argv[2] || 'open';

function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

function argVal(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withPage(fn) {
  await ensureChrome(DEFAULT_CDP);
  const target = await pickPageTarget(DEFAULT_CDP);
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  try {
    return await fn(cdp, target);
  } finally {
    cdp.close();
  }
}

async function open() {
  await ensureChrome(DEFAULT_CDP, QIYU_HISTORY_URL);
  const target = await pickPageTarget(DEFAULT_CDP);
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.goto(QIYU_HISTORY_URL);
  await new Promise((r) => setTimeout(r, 2000));
  const info = await cdp.evaluate(`({
    url: location.href,
    title: document.title
  })`);
  cdp.close();
  console.log(
    JSON.stringify(
      {
        ok: true,
        cdp: DEFAULT_CDP,
        profile: profileDir(),
        ...info,
        tip: '若在登录页，请在该 Chrome 窗口手动登录，再跑 status'
      },
      null,
      2
    )
  );
}

async function status() {
  const info = await withPage(async (cdp) =>
    cdp.evaluate(`({
      url: location.href,
      title: document.title,
      hasPassword: !!document.querySelector('input[type="password"]'),
      bodySample: (document.body && document.body.innerText || '').slice(0, 400)
    })`)
  );
  console.log(JSON.stringify({ ok: true, ...info }, null, 2));
}

/** 文档登录：先填帐户/密码，再点登录（勿把密码打进日志） */
async function login() {
  loadEnv();
  const username =
    argVal('--username') || process.env.QIYU_USERNAME || '';
  const password =
    argVal('--password') || process.env.QIYU_PASSWORD || '';
  if (!username || !password) {
    throw new Error(
      '需要账号密码：--username/--password 或 .env 里 QIYU_USERNAME / QIYU_PASSWORD'
    );
  }

  await ensureChrome(DEFAULT_CDP, QIYU_HISTORY_URL);
  const target = await pickPageTarget(DEFAULT_CDP);
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const href = await cdp.evaluate('location.href');
  if (!/\/login/i.test(href)) {
    await cdp.goto(QIYU_HISTORY_URL);
    await sleep(2000);
  }

  const currentHref = await cdp.evaluate('location.href');
  if (!/\/login/i.test(currentHref)) {
    const info = await cdp.evaluate(`({
      url: location.href,
      title: document.title,
      stillLogin: false
    })`);
    cdp.close();
    console.log(JSON.stringify({ ok: true, username, alreadyLoggedIn: true, ...info }, null, 2));
    return;
  }

  await cdp.evaluate(`(() => {
    const ok = [...document.querySelectorAll('button')].find(
      (b) => (b.innerText || '').trim() === '确定'
    );
    if (ok) ok.click();
    document.querySelector('.j-toptip')?.remove();
  })()`);
  await sleep(300);

  async function fill(selector, value) {
    const ok = await cdp.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      el.click();
      el.select && el.select();
      return true;
    })()`);
    if (!ok) throw new Error(`未找到输入框: ${selector}`);
    // Cmd/Ctrl+A + Backspace 清空，再 insertText
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      modifiers: 2,
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: 2,
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8
    });
    await cdp.send('Input.insertText', { text: value });
    await cdp.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  }

  async function loginReady() {
    return cdp.evaluate(`(() => {
      const u = document.querySelector('input[name="username"]');
      const p = document.querySelector('input[name="password"]');
      const btn = [...document.querySelectorAll('button')].find(
        (b) => (b.innerText || '').trim() === '登录'
      );
      const disabled =
        !btn || btn.classList.contains('z-disabled') || !!btn.disabled;
      return {
        userLen: (u?.value || '').length,
        passLen: (p?.value || '').length,
        btnDisabled: disabled,
        canLogin: !disabled && !!(u?.value) && !!(p?.value)
      };
    })()`);
  }

  async function clickLogin() {
    const ok = await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find(
        (b) => (b.innerText || '').trim() === '登录'
      );
      if (!btn) return false;
      if (btn.classList.contains('z-disabled') || btn.disabled) return false;
      btn.click();
      return true;
    })()`);
    if (!ok) throw new Error('登录按钮不可点');
  }

  async function waitForVerification() {
    // 先点「点击完成验证」；若变成滑块，必须人在专用 Chrome 里拖完
    const clicked = await cdp.evaluate(`(() => {
      const tip = [...document.querySelectorAll('.yidun_intelli-text')].find(
        (e) => (e.innerText || '').trim() === '点击完成验证'
      );
      if (!tip) return false;
      tip.closest('.yidun_intelli-control')?.click();
      return true;
    })()`);
    if (clicked) await sleep(500);
    console.error('登录按钮不可用，等待安全验证：请到专用 Chrome 完成「点击/滑块」（最长 2 分钟）…');
    for (let i = 0; i < 120; i++) {
      const ready = await loginReady();
      if (ready.canLogin) {
        console.error('登录按钮已可点，正在点击登录…');
        return;
      }
      if (i > 0 && i % 15 === 0) {
        const prompt = await cdp.evaluate(
          `(document.querySelector('.yidun_intelli-text')?.innerText || '').trim()`
        );
        console.error(`仍在等待验证… (${i}s) ${prompt || ''}`);
      }
      await sleep(1000);
    }
    throw new Error('七鱼安全验证未完成，请在 Chrome 页面完成滑块验证后重试');
  }

  async function submitLogin() {
    await fill('input[name="username"]', username);
    await sleep(200);
    await fill('input[name="password"]', password);
    await sleep(300);

    let check = await loginReady();
    if (!check.userLen || !check.passLen) throw new Error('帐户或密码未填入');

    // 能登录就直接点；点不了再走校验，校验通过（按钮可点）后再点
    if (!check.canLogin) await waitForVerification();
    check = await loginReady();
    if (!check.canLogin) throw new Error('登录按钮仍不可用');
    await clickLogin();

    await sleep(3500);
    const info = await cdp.evaluate(`({
      url: location.href,
      title: document.title,
      stillLogin: /\\/login/i.test(location.pathname)
    })`);
    return { info, check };
  }

  let result = await submitLogin();
  if (result.info.stillLogin) {
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(2000);
    await cdp.evaluate(`(() => {
      const ok = [...document.querySelectorAll('button')].find(
        (b) => (b.innerText || '').trim() === '确定'
      );
      if (ok) ok.click();
      document.querySelector('.j-toptip')?.remove();
    })()`);
    await sleep(300);
    result = await submitLogin();
  }

  const { info, check } = result;
  cdp.close();
  console.log(
    JSON.stringify({ ok: !info.stillLogin, username, ...info, filled: check }, null, 2)
  );
  if (info.stillLogin) process.exitCode = 2;
}

const map = {
  open,
  login,
  status
};

if (!map[cmd]) {
  console.error(
    '用法: node scripts/browser.mjs <open|login|status>'
  );
  process.exit(1);
}

map[cmd]().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
