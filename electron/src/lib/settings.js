import fs from 'node:fs/promises';
import path from 'node:path';

export function settingsFilePath(userDataDir) {
  return path.join(userDataDir, 'export-ui-settings.json');
}

export async function loadSettings(userDataDir) {
  try {
    const raw = await fs.readFile(settingsFilePath(userDataDir), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function saveSettings(userDataDir, settings) {
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(
    settingsFilePath(userDataDir),
    JSON.stringify(settings, null, 2),
    'utf8'
  );
}
