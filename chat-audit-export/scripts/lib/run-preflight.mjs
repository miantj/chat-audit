import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CDP } from './cdp-bootstrap.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.dirname(__dirname);

const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';

function preflightCommand(args, cdpBase) {
  const base = cdpBase.replace(/\/$/, '');
  const preflightBin = process.env.CHAT_AUDIT_PREFLIGHT_BIN;
  const cmd = preflightBin || PYTHON_CMD;
  const fullArgs = preflightBin
    ? [...args, '--cdp', base]
    : [path.join(SCRIPTS_DIR, 'crm-preflight.py'), ...args, '--cdp', base];
  return { cmd, fullArgs };
}

const preflightEnv = {
  ...process.env,
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1'
};

function drainProgressLines(lineBuf, chunk, onProgress) {
  let buf = lineBuf + chunk;
  const lines = buf.split('\n');
  const rest = lines.pop() ?? '';
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('PROGRESS: ')) {
      continue;
    }
    try {
      onProgress(JSON.parse(t.slice(10)));
    } catch {
      /* ignore */
    }
  }
  return rest;
}

/**
 * 运行 crm-preflight 子命令；可选 onProgress 解析 PROGRESS: 行。
 */
export function runPreflight(args, { cdpBase = DEFAULT_CDP, onProgress } = {}) {
  const { cmd, fullArgs } = preflightCommand(args, cdpBase);

  if (!onProgress) {
    execFileSync(cmd, fullArgs, {
      cwd: SCRIPTS_DIR,
      env: preflightEnv,
      stdio: 'inherit'
    });
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, fullArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: SCRIPTS_DIR,
      env: preflightEnv
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
      const chunk = d.toString('utf8');
      stderr += chunk;
      process.stderr.write(chunk);
    });

    proc.on('error', (err) => {
      reject(new Error(`无法启动预检（${cmd}）：${err.message}`));
    });

    proc.on('close', (code) => {
      if (lineBuf.trim()) {
        drainProgressLines('', `${lineBuf}\n`, onProgress);
      }
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
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
