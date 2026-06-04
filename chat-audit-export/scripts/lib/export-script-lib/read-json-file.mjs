import fs from 'node:fs';
import fsp from 'node:fs/promises';

/**
 * 读取 JSON 文件；不存在、0 字节或语法损坏时返回 fallback（避免 Unexpected end of JSON input）。
 */
export function readJsonFileSync(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const text = fs.readFileSync(filePath, 'utf8');
    if (!text.trim()) {
      return fallback;
    }
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
      return fallback;
    }
    throw error;
  }
}

export async function readJsonFile(filePath, fallback = null) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    if (!text.trim()) {
      return fallback;
    }
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
      return fallback;
    }
    throw error;
  }
}
