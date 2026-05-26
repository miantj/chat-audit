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

/** 官方 Node 14+ 在 Win7 会 exit 216；导出子进程须带此变量（Win10+ 无害） */
export function applyWin7NodePlatformWorkaround() {
  if (process.platform === 'win32') {
    process.env.NODE_SKIP_PLATFORM_CHECK = '1';
  }
}

/** 开发态用 PATH；打包后用 resources/runtime/node-{platform}-{arch} */
export function getBundledNodeBin() {
  if (!app?.isPackaged) {
    return 'node';
  }
  const runtimeDir = packagedRuntimeDir(`node-${runtimeKey()}`);
  const p =
    process.platform === 'win32'
      ? path.join(runtimeDir, 'node.exe')
      : path.join(runtimeDir, 'bin', 'node');
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
  if (process.platform === 'win32') {
    env.NODE_SKIP_PLATFORM_CHECK = '1';
  }
  if (app?.isPackaged) {
    env.CHAT_AUDIT_RESOURCES_PATH = process.resourcesPath;
    const wsDir = path.join(
      process.resourcesPath,
      'scripts',
      'node_modules',
      'ws'
    );
    const wsIndex = path.join(wsDir, 'index.js');
    if (fs.existsSync(wsIndex)) {
      env.CHAT_AUDIT_WS_PATH = wsDir;
    }
  }
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
  const wsPath = path.join(
    process.resourcesPath,
    'scripts',
    'node_modules',
    'ws',
    'index.js'
  );
  if (!fs.existsSync(wsPath)) {
    issues.push(
      `CDP 依赖 ws 未打入安装包（${wsPath}），请重新执行 pnpm build（会运行 copy-ws-to-scripts）`
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
