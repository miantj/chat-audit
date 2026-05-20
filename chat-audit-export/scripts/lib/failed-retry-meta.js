import fs from 'node:fs';

/** 与 export-with-self-heal.mjs / Electron 一致 */
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

export function writeFailedRetryPassesUsed(outputPath, passesUsed) {
  const metaPath = failedRetryMetaPath(outputPath);
  fs.writeFileSync(
    metaPath,
    JSON.stringify({
      passes_used: passesUsed,
      updated_at: new Date().toISOString()
    }),
    null,
    2
  );
}

/** 即将执行的补跑轮次（1=外部好友搜索，2=指标表直达） */
export function nextFailedRetryPass(outputPath) {
  return readFailedRetryPassesUsed(outputPath) + 1;
}

export function retryPassStrategy(retryPass) {
  return Number(retryPass) >= 2 ? 'metric-table-direct' : 'external-friend-search';
}

/** 子进程环境：pass 1=外部好友搜索，pass 2=指标表直达（搜索兜底） */
export function buildRetryRunEnv(retryPass) {
  const pass = Number(retryPass) || 0;
  if (pass <= 0) return {};
  return {
    CHAT_AUDIT_RETRY_FAILED: '1',
    CHAT_AUDIT_RETRY_PASS: String(pass),
    ...(pass >= 2 ? { CHAT_AUDIT_RETRY_METRIC_DIRECT: '1' } : {})
  };
}

export function applyFailedRetryPassEnv(outputPath) {
  const retryPass = nextFailedRetryPass(outputPath);
  const env = buildRetryRunEnv(retryPass);
  process.env.CHAT_AUDIT_RETRY_PASS = env.CHAT_AUDIT_RETRY_PASS;
  if (env.CHAT_AUDIT_RETRY_METRIC_DIRECT) {
    process.env.CHAT_AUDIT_RETRY_METRIC_DIRECT = env.CHAT_AUDIT_RETRY_METRIC_DIRECT;
  } else {
    delete process.env.CHAT_AUDIT_RETRY_METRIC_DIRECT;
  }
  return retryPass;
}
