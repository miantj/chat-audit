#!/usr/bin/env node
/**
 * 将 electron/node_modules/ws 复制到 chat-audit-export/scripts/node_modules/ws，
 * 确保 extraResources 的 scripts 目录自带 ws（不依赖第二条 extraResources 规则）。
 */
const fs = require('node:fs');
const path = require('node:path');

const electronRoot = path.join(__dirname, '..');
const src = path.join(electronRoot, 'node_modules', 'ws');
const dest = path.join(
  electronRoot,
  '..',
  'chat-audit-export',
  'scripts',
  'node_modules',
  'ws'
);

if (!fs.existsSync(path.join(src, 'index.js'))) {
  console.error(
    '[copy-ws-to-scripts] 未找到 electron/node_modules/ws，请先执行: cd electron && pnpm install'
  );
  process.exit(1);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const s = path.join(from, name);
    const d = path.join(to, name);
    if (fs.statSync(s).isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

fs.rmSync(dest, { recursive: true, force: true });
copyDir(src, dest);
console.log(`[copy-ws-to-scripts] ${dest}`);
