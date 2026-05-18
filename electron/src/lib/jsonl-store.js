import fs from 'node:fs/promises';

export async function appendJsonlRecord(filePath, record) {
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

export async function readJsonlRecords(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}