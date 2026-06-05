import fs from 'node:fs';
import path from 'node:path';

/** 续传/调试时保留 JSON 等中间产物 */
export function shouldKeepExportArtifacts() {
  return process.env.CHAT_AUDIT_KEEP_EXPORT_JSON === '1';
}

/** 由 Electron 等在子进程退出后再清理 */
export function shouldDeferArtifactCleanup() {
  return process.env.CHAT_AUDIT_DEFER_ARTIFACT_CLEANUP === '1';
}

export function exportArtifactPaths(exportOut) {
  const jsonPath = exportOut.endsWith('.json') ? exportOut : `${exportOut}.json`;
  const base = jsonPath.replace(/\.json$/i, '');
  return [
    jsonPath,
    `${base}.jsonl`,
    `${base}.checkpoint.json`,
    `${base}.checkpoint.json.tmp`,
    `${base}.json.done`,
    `${base}.export-done`,
    `${base}.failed-retry-meta.json`
  ];
}

/**
 * 删除单次导出产生的中间文件，保留 .business.csv。
 */
export function cleanupExportArtifacts(exportOut, { log = () => {} } = {}) {
  if (shouldKeepExportArtifacts()) {
    return { removed: [], skipped: true };
  }
  const removed = [];
  for (const fp of exportArtifactPaths(exportOut)) {
    try {
      if (!fs.existsSync(fp)) continue;
      fs.unlinkSync(fp);
      removed.push(fp);
      log(`[cleanup] 已删除 ${path.basename(fp)}`);
    } catch (error) {
      log(`[warn] 无法删除 ${fp}: ${error.message}`);
    }
  }
  return { removed, skipped: false };
}

export function enumerateIsoDates(start, end) {
  const dates = [];
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const cur = new Date(sy, sm - 1, sd);
  const last = new Date(ey, em - 1, ed);
  if (Number.isNaN(cur.getTime()) || Number.isNaN(last.getTime()) || last < cur) {
    return dates;
  }
  while (cur <= last) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, '0');
    const d = String(cur.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

/**
 * 按天目标名单：清理每日 + merged 的中间文件，保留所有 .business.csv。
 */
export function cleanupTargetListByDayArtifacts(
  { outDir, basename, start, end, dates = null },
  options = {}
) {
  if (shouldKeepExportArtifacts()) {
    return { removed: [], skipped: true };
  }
  const dayList =
    dates && dates.length > 0 ? dates : enumerateIsoDates(start, end);
  const removed = [];
  for (const day of dayList) {
    const dailyOut = path.join(outDir, `${basename}-${day}.json`);
    const result = cleanupExportArtifacts(dailyOut, options);
    removed.push(...result.removed);
  }
  const mergedOut = path.join(outDir, `${basename}-merged.json`);
  const mergedResult = cleanupExportArtifacts(mergedOut, options);
  removed.push(...mergedResult.removed);
  return { removed, skipped: false };
}
