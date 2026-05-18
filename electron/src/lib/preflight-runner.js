import { spawn } from 'node:child_process';
import path from 'node:path';
import { getScriptsDir } from './paths.js';
import { DEFAULT_CDP } from './cdp-probe.js';

const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';

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
      if (code === 0) resolve({ stdout, stderr });
      else {
        const detail = stderr.trim() || stdout.trim();
        const hint =
          args[0] === 'navigate-audit' && !detail
            ? 'Chrome 无可用标签页或无法连接 CDP；请确认调试 Chrome 已打开并在浏览器中登录 CRM'
            : '';
        reject(
          new Error(
            `crm-preflight ${args[0]} 失败 (code ${code})${detail ? `: ${detail}` : ''}${hint ? ` — ${hint}` : ''}`
          )
        );
      }
    });
  });
}

const CRM_LOGIN_HINT =
  '请在应用自动打开的专用 Chrome 中登录 CRM（配置目录 ~/.chrome-chat-audit-profile）。' +
  '日常浏览器的登录无效；关闭专用 Chrome 后再次打开，登录态会保留。';

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

export async function prepareCrmPage({ startDate, department }) {
  await runPreflight(['navigate-audit']);
  await assertCrmLoggedIn();
  if (department) {
    await runPreflight(['set-department', '--group', department]);
  }
  if (startDate) {
    await runPreflight(['set-dates', '--date', startDate]);
  }
  const gate = await runPreflight([
    'gate-check',
    '--expect-dept',
    department || '大客私域顾问-总',
    '--expect-date',
    startDate
  ]);
  return gate.stdout;
}
