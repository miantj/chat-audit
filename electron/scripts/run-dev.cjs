/**
 * 跨平台开发启动：CHAT_AUDIT_DEV=1 + electron .
 * 自动打开 DevTools、监听 renderer 热刷新。
 */
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const env = { ...process.env, CHAT_AUDIT_DEV: '1' };

// require('electron') 在 Node 脚本中返回 electron 可执行文件路径
const electronPath = require('electron');

const child = spawn(electronPath, ['.'], {
  cwd: root,
  env,
  stdio: 'inherit'
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
