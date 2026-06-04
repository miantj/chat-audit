/**
 * 将 Node / CDP 异常转为可读中文，避免 UI 只显示 "AggregateError"。
 */
export function formatExportError(err) {
  if (!err) return '未知错误';

  if (err.name === 'AggregateError' && Array.isArray(err.errors) && err.errors.length) {
    const refused = err.errors.some((e) => e?.code === 'ECONNREFUSED');
    const base =
      process.env.CHAT_AUDIT_CRM_CDP_BASE || 'http://localhost:9222';
    if (refused) {
      return (
        `无法连接专用 Chrome 调试端口（${base}）。` +
        '请确认应用已打开专用 Chrome，CRM 已登录，且未占用 9222 端口的其它 Chrome。'
      );
    }
    const parts = err.errors
      .map((e) => e?.message || e?.code || String(e))
      .filter(Boolean);
    return parts.length ? parts.join('；') : err.message || 'AggregateError';
  }

  const msg = err.message || String(err);
  if (/ECONNREFUSED/i.test(msg) && /9222/.test(msg)) {
    const base =
      process.env.CHAT_AUDIT_CRM_CDP_BASE || 'http://localhost:9222';
    return (
      `无法连接专用 Chrome 调试端口（${base}）。` +
      '请确认应用已打开专用 Chrome 并完成 CRM 登录。'
    );
  }

  return msg;
}
