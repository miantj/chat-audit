import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const TARGET_FILE_CATEGORY = 'target_file';

export function normalizeOwnerName(value) {
  return String(value || '').replace(/\s+/g, '').trim().toLowerCase();
}

export function groupTargetsByOwner(targetList) {
  const grouped = new Map();
  for (const target of targetList?.targets || []) {
    const key = target.normalizedOwnerName || normalizeOwnerName(target.ownerName || target.employeeName);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(target);
  }
  return grouped;
}

/** 与 export-with-self-heal / run-preflight 一致；CHAT_AUDIT_PREFLIGHT_BIN 为 exe，不能用来跑 .py */
export function resolvePythonCommand() {
  return (
    process.env.CHAT_AUDIT_PYTHON_BIN ||
    (process.platform === 'win32' ? 'python' : 'python3')
  );
}

export async function loadTargetList(filePath, { sheetName = '' } = {}) {
  const scriptPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'parse-target-list.py'
  );
  const args = [scriptPath, '--file', filePath];
  if (sheetName) {
    args.push('--sheet', sheetName);
  }

  const pythonCmd = resolvePythonCommand();

  try {
    const { stdout } = await execFileAsync(pythonCmd, args, {
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1'
      }
    });
    return JSON.parse(stdout);
  } catch (error) {
    const stderr = String(error.stderr || '').trim();
    const stdout = String(error.stdout || '').trim();
    const detail = stderr || stdout || error.message || String(error);
    throw new Error(`failed to parse target list: ${detail}`);
  }
}
