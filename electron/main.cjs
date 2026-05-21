// Electron 22 主进程用 require() 加载入口；项目为 ESM，通过 CJS 引导动态导入。
import('./main.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
