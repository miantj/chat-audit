import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const PAUSE_FILE = path.join(os.tmpdir(), 'chat-audit-export-pause');
export const STOP_FILE = path.join(os.tmpdir(), 'chat-audit-export-stop');

export function clearExportSignals() {
  for (const file of [PAUSE_FILE, STOP_FILE]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}
