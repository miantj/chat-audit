import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const app = electron?.app ?? electron?.default?.app;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 开发态：electron 目录的上一级为仓库根 */
export function getScriptsDir() {
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, 'scripts');
  }
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'chat-audit-export', 'scripts'),
    path.join(process.cwd(), 'chat-audit-export', 'scripts'),
    path.join(process.cwd(), '..', 'chat-audit-export', 'scripts')
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'crm-preflight.py'))) {
      return dir;
    }
  }
  return candidates[0];
}
