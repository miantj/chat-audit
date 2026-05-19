import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const app = electron?.app ?? electron?.default?.app;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function runtimeKey() {
  return `${process.platform}-${process.arch}`;
}

function packagedRuntimeDir(...segments) {
  if (!app?.isPackaged) {
    return path.join(__dirname, '..', '..', 'runtime', ...segments);
  }
  return path.join(process.resourcesPath, 'runtime', ...segments);
}

export function isPackagedApp() {
  return Boolean(app?.isPackaged);
}

/** 开发态用 PATH；打包后用 resources/runtime/node-{platform}-{arch} */
export function getBundledNodeBin() {
  if (!app?.isPackaged) {
    return 'node';
  }
  const bin = process.platform === 'win32' ? 'node.exe' : 'node';
  const p = path.join(packagedRuntimeDir(`node-${runtimeKey()}`, 'bin', bin));
  return fs.existsSync(p) ? p : 'node';
}

/** PyInstaller 单文件预检；开发态返回 null（走 python + .py） */
export function getBundledPreflightBin() {
  if (!app?.isPackaged) {
    return null;
  }
  const name =
    process.platform === 'win32' ? 'crm-preflight.exe' : 'crm-preflight';
  const p = path.join(packagedRuntimeDir(`python-${runtimeKey()}`, name));
  return fs.existsSync(p) ? p : null;
}

export function runtimeExportEnv() {
  const nodeBin = getBundledNodeBin();
  const preflightBin = getBundledPreflightBin();
  const env = {
    CHAT_AUDIT_NODE_BIN: nodeBin,
    CHAT_AUDIT_RUNTIME_PACKAGED: app?.isPackaged ? '1' : '0'
  };
  if (preflightBin) {
    env.CHAT_AUDIT_PREFLIGHT_BIN = preflightBin;
  }
  return env;
}

export function verifyBundledRuntime() {
  if (!app?.isPackaged) {
    return { ok: true, dev: true, message: '开发模式：使用系统 Node / Python' };
  }
  const issues = [];
  const nodeBin = getBundledNodeBin();
  if (!fs.existsSync(nodeBin)) {
    issues.push(
      `内嵌 Node 未找到（${nodeBin}），请执行 pnpm run prepare-runtime 后重新打包`
    );
  }
  const preflightBin = getBundledPreflightBin();
  if (!preflightBin) {
    issues.push(
      '内嵌 crm-preflight 未找到，请安装 Python 3 + pip install pyinstaller websockets 后执行 pnpm run prepare-runtime'
    );
  }
  return {
    ok: issues.length === 0,
    dev: false,
    issues,
    nodeBin,
    preflightBin
  };
}
