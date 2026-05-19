import path from 'node:path';

/**
 * 解析导出 JSON 绝对路径（Windows 盘符、OUTPUT_PATH、相对路径）。
 */
export function resolveExportOutputPath(raw, { cwd = process.cwd(), dateStart = '' } = {}) {
  if (process.env.OUTPUT_PATH) {
    return normalizeOutputPath(process.env.OUTPUT_PATH, cwd);
  }
  if (raw === undefined || raw === null || raw === true || raw === '') {
    const dir = process.env.CHAT_AUDIT_EXPORT_DIR;
    const exportDir = dir
      ? path.isAbsolute(dir)
        ? dir
        : path.resolve(cwd, dir)
      : path.join(cwd, 'exports');
    return path.join(exportDir, `chat-audit-${dateStart}.json`);
  }
  return normalizeOutputPath(String(raw), cwd);
}

function normalizeOutputPath(raw, cwd) {
  const trimmed = String(raw).trim();
  const win = path.win32;

  if (process.platform === 'win32') {
    const embedded = trimmed.match(/([A-Za-z]:[\\/].*)$/);
    if (embedded) {
      return win.resolve(embedded[1]);
    }
    if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
      return win.resolve(trimmed);
    }
  }

  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }

  return path.resolve(cwd, trimmed);
}
