const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const required = ['electron', 'electron-log'];

const missing = required.filter((name) => {
  const dir = path.join(root, 'node_modules', name);
  return !fs.existsSync(dir);
});

if (missing.length > 0) {
  console.error(
    `[chat-audit-export] 缺少依赖: ${missing.join(', ')}\n` +
      '请在 electron 目录执行: pnpm install\n' +
      '（不要用 npm install，否则 pnpm 的 node_modules 可能被破坏）'
  );
  process.exit(1);
}
