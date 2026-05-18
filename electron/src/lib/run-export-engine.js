import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { getScriptsDir } from './paths.js';
import { PAUSE_FILE, STOP_FILE } from './signal-files.js';

const NODE_CMD = process.platform === 'win32' ? 'node.exe' : 'node';

/**
 * 调用成熟的 export-date-range.js（内部走 export-current-page：点员工行 → 弹窗 → 指标客户列表 → 导出）。
 */
export function runExportEngine(options, eventEmitter) {
  const start = options.start ?? options.startDate;
  const end = options.end ?? options.endDate;
  const department = options.department || '';
  const outputDir = options.outputDir;

  const scriptsDir = getScriptsDir();
  const scriptPath = path.join(scriptsDir, 'export-date-range.js');
  const outputPath = path.join(outputDir, `chat-audit-${start}.json`);

  const args = [
    scriptPath,
    `--start=${start}`,
    `--end=${end}`,
    `--out=${outputPath}`,
    // 不传时 export-date-range 默认只导出「小米,丽丽,农农,可可」四人
    '--keywords='
  ];
  // 主表部门已在 prepareCrmPage(set-department) 设好；--category 是弹窗内「沟通内容」等，勿传部门名

  const proc = spawn(NODE_CMD, args, {
    cwd: outputDir,
    env: {
      ...process.env,
      CHAT_AUDIT_PAUSE_FILE: PAUSE_FILE,
      CHAT_AUDIT_STOP_FILE: STOP_FILE
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdoutBuf = '';
  let stderrBuf = '';

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    try {
      const evt = JSON.parse(trimmed);
      if (evt.event === 'export-progress' && evt.message) {
        eventEmitter.emit('progress', {
          current: 0,
          total: -1,
          message: evt.message
        });
      }
    } catch {
      /* 非 JSON 行忽略 */
    }
  };

  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() || '';
    lines.forEach(handleLine);
  });

  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
  });

  const done = new Promise((resolve, reject) => {
    proc.on('error', (err) => {
      reject(new Error(`无法启动 Node 导出脚本: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (stdoutBuf.trim()) handleLine(stdoutBuf);
      if (code === 0) {
        let conversationCount = 0;
        try {
          const raw = fs.readFileSync(outputPath, 'utf8');
          const data = JSON.parse(raw);
          conversationCount = data?.conversations?.length ?? 0;
        } catch {
          /* ignore */
        }
        if (conversationCount === 0) {
          reject(
            new Error(
              '导出已结束但未产生任何会话记录。请确认：1) 主表有员工行；2) 日期/部门筛选正确；3) 未使用错误的员工关键词过滤。'
            )
          );
          return;
        }
        resolve({ outputPath, code, conversationCount });
      } else {
        reject(
          new Error(
            `导出进程退出 code=${code}\n${stderrBuf.trim() || stdoutBuf.trim()}`.slice(
              0,
              800
            )
          )
        );
      }
    });
  });

  return { proc, done, outputPath };
}
