import fs from 'node:fs';

/** 与 export-with-self-heal.sh 中 FAILED_RETRY_MAX 保持一致 */
export const FAILED_RETRY_MAX = 2;

export function failedRetryMetaPath(outputPath) {
  return String(outputPath).replace(/\.json$/i, '.failed-retry-meta.json');
}

export function readFailedRetryPassesUsed(outputPath) {
  const metaPath = failedRetryMetaPath(outputPath);
  if (!fs.existsSync(metaPath)) {
    return 0;
  }
  try {
    const data = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return Math.max(0, Number(data.passes_used) || 0);
  } catch {
    return 0;
  }
}

export function clearFailedRetryMeta(outputPath) {
  const metaPath = failedRetryMetaPath(outputPath);
  if (fs.existsSync(metaPath)) {
    fs.unlinkSync(metaPath);
  }
}
