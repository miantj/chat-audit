import fs from 'node:fs/promises';

export class SharedState {
  constructor(checkpointPath, jsonlPath) {
    this.checkpointPath = checkpointPath;
    this.jsonlPath = jsonlPath;
    this.activeLoginTab = null;
  }

  async loadCheckpoint() {
    try {
      const data = await fs.readFile(this.checkpointPath, 'utf8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async saveCheckpoint(cp) {
    // Bug7 Fix: Atomic write using writeFile + rename
    // This avoids the lock race condition that would occur with a bool flag
    const tmpPath = this.checkpointPath + '.tmp';
    cp.updated_at = new Date().toISOString();
    await fs.writeFile(tmpPath, JSON.stringify(cp, null, 2), 'utf8');
    await fs.rename(tmpPath, this.checkpointPath);
  }

  async appendJsonl(record) {
    // append-only JSONL, naturally safe for concurrent access
    await fs.appendFile(this.jsonlPath, JSON.stringify(record) + '\n', 'utf8');
  }

  setActiveLoginTab(tabIndex) {
    this.activeLoginTab = tabIndex;
  }

  getActiveLoginTab() {
    return this.activeLoginTab;
  }

  clearActiveLoginTab() {
    this.activeLoginTab = null;
  }
}