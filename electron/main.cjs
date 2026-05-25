// Electron 22 主进程用 require() 加载入口；ESM 逻辑在 main.mjs（.mjs 避免 unpacked 下 .js 被当 CJS）。
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

function writeBootstrapLog(payload) {
  try {
    const logDir = path.join(process.env.APPDATA || process.cwd(), 'chat-audit-export', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'bootstrap.log'),
      `${new Date().toISOString()}\n${payload}\n\n`,
      'utf8'
    );
  } catch {
    // ignore
  }
}

function resolveMainEntry() {
  // 优先从 app.asar 加载：node_modules（electron-log 等）在 asar 内，unpacked 入口解析不到
  const asarMain = path.join(process.resourcesPath, 'app.asar', 'main.mjs');
  const devMain = path.join(__dirname, 'main.mjs');
  const candidates = [asarMain, devMain];
  const probe = candidates.map((candidate) => `${candidate} => ${fs.existsSync(candidate)}`);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      writeBootstrapLog(
        [
          'resolveMainEntry ok (bootstrap v3: asar-first)',
          `execPath=${process.execPath}`,
          `resourcesPath=${process.resourcesPath}`,
          `cwd=${process.cwd()}`,
          `chosen=${candidate}`,
          ...probe
        ].join('\n')
      );
      return candidate;
    }
  }
  writeBootstrapLog(
    [
      'resolveMainEntry FAILED (bootstrap v3)',
      `execPath=${process.execPath}`,
      `resourcesPath=${process.resourcesPath}`,
      `__dirname=${__dirname}`,
      `cwd=${process.cwd()}`,
      ...probe
    ].join('\n')
  );
  return devMain;
}

import(pathToFileURL(resolveMainEntry()).href).catch((err) => {
  writeBootstrapLog(String(err && (err.stack || err)));
  console.error(err);
  process.exit(1);
});
