#!/usr/bin/env node
/**
 * 将 chat-audit-export/scripts/lib 中 Electron 主进程依赖的 .mjs 同步到 src/lib/export-script-lib/，
 * 避免 run-export-engine 从 extraResources 动态 import（安装包 scripts 与 app 版本易不一致）。
 */
const fs = require('node:fs');
const path = require('node:path');

const electronRoot = path.join(__dirname, '..');
const srcLib = path.join(electronRoot, '..', 'chat-audit-export', 'scripts', 'lib');
const destDir = path.join(electronRoot, 'src', 'lib', 'export-script-lib');

const FILES = [
  'export-json-stats.mjs',
  'failed-retry-meta.mjs',
  'moderate-paced-env.mjs',
  'dom-pace-config.mjs'
];

if (!fs.existsSync(srcLib)) {
  console.error(`[sync-export-lib] 未找到 ${srcLib}`);
  process.exit(1);
}

const missing = FILES.filter((name) => !fs.existsSync(path.join(srcLib, name)));
if (missing.length > 0) {
  console.error(
    `[sync-export-lib] 缺少源文件: ${missing.join(', ')}\n` +
      '请拉最新 chat-audit-export/scripts/lib 后再 build。'
  );
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
for (const name of FILES) {
  fs.copyFileSync(path.join(srcLib, name), path.join(destDir, name));
}
console.log(`[sync-export-lib] ${destDir} (${FILES.length} files)`);
