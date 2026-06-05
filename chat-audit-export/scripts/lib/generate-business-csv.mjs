import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cleanupExportArtifacts,
  shouldDeferArtifactCleanup
} from './cleanup-export-artifacts.mjs';
import { LARGE_JSON_BYTES } from './export-json-stats.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, '..');

/**
 * 将导出 JSON/JSONL 转为 business CSV（与 export-with-self-heal 行为一致）。
 */
export function generateBusinessCsv(
  exportOut,
  {
    log = () => {},
    nodeBin = process.env.CHAT_AUDIT_NODE_BIN || 'node',
    cleanup = true
  } = {}
) {
  const csvOut = exportOut.replace(/\.json$/i, '.business.csv');
  const jsonlPath = exportOut.replace(/\.json$/i, '.jsonl');
  let input = exportOut;
  if (!fs.existsSync(input) && !fs.existsSync(jsonlPath)) {
    log(`[warn] Skip CSV: no JSON/JSONL at ${exportOut}`);
    return null;
  }
  if (!fs.existsSync(input)) {
    input = jsonlPath;
  } else if (fs.existsSync(jsonlPath)) {
    const jsonBytes = fs.statSync(input).size;
    if (jsonBytes > LARGE_JSON_BYTES) {
      log(`[csv] Large JSON (~${Math.round(jsonBytes / 1048576)}MB), using JSONL`);
      input = jsonlPath;
    }
  }
  log('Generating business CSV...');
  try {
    execFileSync(
      nodeBin,
      [
        path.join(SCRIPTS_DIR, 'json-to-csv-business.js'),
        `--in=${input}`,
        `--out=${csvOut}`
      ],
      { cwd: path.dirname(SCRIPTS_DIR), stdio: 'inherit' }
    );
    if (fs.existsSync(csvOut)) {
      log(`[OK] CSV written: ${csvOut}`);
      console.log(JSON.stringify({ event: 'export-csv-complete', csvPath: csvOut }));
      if (cleanup && !shouldDeferArtifactCleanup() && process.env.CHAT_AUDIT_BY_DAY_EXPORT !== '1') {
        cleanupExportArtifacts(exportOut, { log });
      }
      return csvOut;
    }
  } catch (error) {
    log(`[warn] CSV generation failed: ${error.message}`);
  }
  return null;
}
