import { spawn } from 'node:child_process';
import path from 'node:path';
import { getScriptsDir } from './paths.js';
import { DEFAULT_CDP } from './cdp-probe.js';

const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function runPreflight(args, { cdpBase = DEFAULT_CDP } = {}) {
  const scriptsDir = getScriptsDir();
  const scriptPath = path.join(scriptsDir, 'crm-preflight.py');
  const fullArgs = [scriptPath, ...args, '--cdp', cdpBase];

  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_CMD, fullArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: scriptsDir
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`无法启动 Python（${PYTHON_CMD}）：${err.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr, code });
      else {
        const detail = stderr.trim() || stdout.trim();
        reject(
          new Error(
            `crm-preflight ${args[0]} 失败 (code ${code})${detail ? `: ${detail}` : ''}`
          )
        );
      }
    });
  });
}

const CRM_LOGIN_HINT =
  '请在应用自动打开的专用 Chrome 中登录 CRM（配置目录 ~/.chrome-chat-audit-profile）。' +
  '日常浏览器的登录无效；关闭专用 Chrome 后再次打开，登录态会保留。';

function parseJsonAfterColon(line, label) {
  const idx = line.indexOf(label);
  if (idx < 0) return null;
  const rest = line.slice(idx + label.length).trim();
  const start = rest.indexOf('{') >= 0 ? rest.indexOf('{') : rest.indexOf('[');
  if (start < 0) return null;
  try {
    return JSON.parse(rest.slice(start));
  } catch {
    return null;
  }
}

async function departmentIncludes(expectDept) {
  const { stdout } = await runPreflight(['check-department']);
  for (const line of stdout.split('\n')) {
    const state = parseJsonAfterColon(line, 'Current cascader state:');
    if (state?.tags?.some((t) => String(t).includes(expectDept))) {
      return true;
    }
  }
  return false;
}

async function datesMatch(expectDate) {
  const { stdout } = await runPreflight(['check-dates']);
  for (const line of stdout.split('\n')) {
    const raw = parseJsonAfterColon(line, 'Current date inputs:');
    const vals = Array.isArray(raw) ? raw : null;
    if (!vals || vals.length < 2) continue;
    const norm = (v) =>
      String(v || '')
        .trim()
        .slice(0, 10)
        .replace(/\//g, '-');
    if (norm(vals[0]) === expectDate && norm(vals[1]) === expectDate) {
      return true;
    }
  }
  return false;
}

export async function assertCrmLoggedIn() {
  const { stdout } = await runPreflight(['diagnose-state']);
  const trimmed = stdout.trim();
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart < 0) return;
  const state = JSON.parse(trimmed.slice(jsonStart));
  if (state.state === 'CRM_LOGIN_REQUIRED') {
    const where = state.href || state.reason || '登录页';
    throw new Error(`${CRM_LOGIN_HINT}\n当前页面：${where}`);
  }
}

/**
 * SKILL.md Steps 1–3 + gate-check + gate-start-export（与 Agent 手动预检一致）。
 * export-with-self-heal.sh 会再次做 CDP 探测与 gate-start-export（只能多不能少）。
 */
export async function prepareCrmPage({ startDate, department }) {
  const expectDept = department || '大客私域顾问-总';

  // Step 1：审计页 + 登录态
  await runPreflight(['navigate-audit']);
  const checkPage = await runPreflight(['check-page']);
  if (/STATUS: on login page/i.test(checkPage.stdout)) {
    throw new Error(CRM_LOGIN_HINT);
  }
  await assertCrmLoggedIn();

  // 关员工弹窗后再改主表（Step 3 date gate）
  await runPreflight(['close-dialog']);

  // Step 2：部门先于日期
  if (!(await departmentIncludes(expectDept))) {
    await runPreflight(['set-department', '--group', expectDept]);
  }

  // Step 3：主表日期
  if (startDate && !(await datesMatch(startDate))) {
    await runPreflight(['set-dates', '--date', startDate]);
    await sleep(4000);
  }

  await runPreflight([
    'gate-check',
    '--expect-dept',
    expectDept,
    '--expect-date',
    startDate
  ]);

  await runPreflight([
    'gate-start-export',
    '--expect-dept',
    expectDept,
    '--expect-date',
    startDate
  ]);
}
