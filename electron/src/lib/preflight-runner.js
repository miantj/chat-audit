import { spawn } from 'node:child_process';
import path from 'node:path';
import { getScriptsDir } from './paths.js';
import { DEFAULT_CDP } from './cdp-probe.js';
import { getBundledPreflightBin } from './runtime-paths.js';

const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';

function drainProgressLines(lineBuf, chunk, onProgress) {
  let buf = lineBuf + chunk;
  const lines = buf.split('\n');
  const rest = lines.pop() ?? '';
  if (onProgress) {
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('PROGRESS: ')) {
        continue;
      }
      try {
        onProgress(JSON.parse(t.slice(10)));
      } catch {
        /* ignore malformed progress */
      }
    }
  }
  return rest;
}

export function runPreflight(args, { cdpBase = DEFAULT_CDP, onProgress } = {}) {
  const scriptsDir = getScriptsDir();
  const preflightBin = getBundledPreflightBin();
  const cmd = preflightBin || PYTHON_CMD;
  const fullArgs = preflightBin
    ? [...args, '--cdp', cdpBase]
    : [path.join(scriptsDir, 'crm-preflight.py'), ...args, '--cdp', cdpBase];

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, fullArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: scriptsDir,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1'
      }
    });

    let stdout = '';
    let stderr = '';
    let lineBuf = '';

    proc.stdout.on('data', (d) => {
      const chunk = d.toString('utf8');
      stdout += chunk;
      lineBuf = drainProgressLines(lineBuf, chunk, onProgress);
    });

    proc.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });

    proc.on('error', (err) => {
      reject(new Error(`无法启动预检（${cmd}）：${err.message}`));
    });

    proc.on('close', (code) => {
      if (lineBuf.trim() && onProgress) {
        drainProgressLines('', `${lineBuf}\n`, onProgress);
      }
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
 * SKILL Steps 1–3 + gate-start-export，单次 Python（prepare-export）完成。
 * export-with-self-heal.mjs 在 CHAT_AUDIT_START_GATE_DONE=1 时跳过重复 gate。
 */
export async function prepareCrmPage({ startDate, department, onProgress } = {}) {
  const expectDept = department || '大客私域顾问-总';
  const args = ['prepare-export', '--expect-dept', expectDept];
  if (startDate) {
    args.push('--expect-date', startDate);
  }
  await runPreflight(args, { onProgress });
}
