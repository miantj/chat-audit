import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Electron / CLI 共用（run-export-engine 动态 import 本模块） */
export const LARGE_JSON_BYTES = 40 * 1024 * 1024;

/**
 * 读取 progress.failed_conversation_ids 数量；大文件避免主进程整文件 JSON.parse。
 */
export function countFailedConversations(
  outputPath,
  nodeBin = process.env.CHAT_AUDIT_NODE_BIN || 'node'
) {
  const resolved = path.resolve(outputPath);
  if (!fs.existsSync(resolved)) {
    return 0;
  }
  const stat = fs.statSync(resolved);
  if (stat.size > LARGE_JSON_BYTES) {
    try {
      const n = execFileSync(
        nodeBin,
        [
          '-e',
          "const fs=require('fs');const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));console.log((d.progress?.failed_conversation_ids||[]).length);",
          resolved
        ],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
      ).trim();
      return Number(n) || 0;
    } catch {
      return 0;
    }
  }
  try {
    const data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return data?.progress?.failed_conversation_ids?.length ?? 0;
  } catch {
    return 0;
  }
}
