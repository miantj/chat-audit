import http from 'node:http';
import { CDPClient } from '../lib/cdp.js';
import { DEFAULT_CDP } from '../lib/cdp-probe.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CRM_URL = 'https://tmscrm.yishouapp.com/#/salesQuality/chatAudit';

export class TabManager {
  constructor(cdpBase = DEFAULT_CDP, tabCount = 3) {
    this.cdpBase = cdpBase;
    this.tabCount = tabCount;
    this.tabs = [];
    this.tabInfo = [];
    this.deadTabs = new Set();
  }

  async initialize() {
    const targets = await this._listTargets();
    const pages = targets.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
    const crmPages = pages.filter(p => p.url.includes('tmscrm'));

    for (let i = 0; i < this.tabCount; i++) {
      if (i < crmPages.length) {
        await this._attachTab(i, crmPages[i]);
      } else {
        await this._createAndNavigateTab(i);
      }
    }
  }

  async _listTargets() {
    return new Promise((resolve, reject) => {
      http
        .get(`${this.cdpBase}/json/list`, (res) => {
          let data = '';
          res.on('data', (c) => {
            data += c;
          });
          res.on('end', () => resolve(JSON.parse(data)));
          res.on('error', reject);
        })
        .on('error', (err) => {
          reject(
            new Error(
              `无法连接 Chrome CDP（${this.cdpBase}）：${err.code || err.message}`
            )
          );
        });
    });
  }

  /** Chrome /json/new 仅支持 PUT（GET 会返回非 JSON 前缀导致解析失败） */
  _putNewTab(url) {
    const base = this.cdpBase.replace(/\/$/, '');
    const path = `/json/new?${encodeURIComponent(url)}`;
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${base}${path}`,
        { method: 'PUT' },
        (res) => {
          let data = '';
          res.on('data', (c) => {
            data += c;
          });
          res.on('end', () => {
            try {
              const trimmed = data.trim();
              const jsonStart = trimmed.indexOf('{');
              const jsonText =
                jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed;
              resolve(JSON.parse(jsonText));
            } catch {
              reject(
                new Error(
                  `创建新标签页失败，CDP 响应无法解析: ${data.slice(0, 120)}`
                )
              );
            }
          });
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  async _waitForCrmUrl(client) {
    let currentUrl = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(1000);
      const result = await client.send('Runtime.evaluate', {
        expression: 'window.location.href',
        returnByValue: true
      });
      currentUrl = result?.result?.value || '';
      if (currentUrl.includes('tmscrm')) return currentUrl;
    }
    throw new Error(`导航 CRM 失败: ${currentUrl || '(empty)'}`);
  }

  async _createAndNavigateTab(index) {
    const newTarget = await this._putNewTab(CRM_URL);
    if (!newTarget?.webSocketDebuggerUrl) {
      throw new Error('创建新标签页失败：无 webSocketDebuggerUrl');
    }

    const client = new CDPClient(newTarget.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Page.enable').catch(() => {});

    const currentUrl =
      newTarget.url?.includes('tmscrm')
        ? newTarget.url
        : await this._waitForCrmUrl(client);

    this.tabs[index] = client;
    this.tabInfo[index] = { targetId: newTarget.id, url: currentUrl };
  }

  async _attachTab(index, target) {
    const client = new CDPClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Page.enable').catch(() => {});
    const url = target.url || '';
    if (!url.includes('chatAudit')) {
      await client.send('Page.navigate', { url: CRM_URL });
      await this._waitForCrmUrl(client);
    }
    this.tabs[index] = client;
    this.tabInfo[index] = { targetId: target.id, url: target.url || CRM_URL };
  }

  getTab(index) {
    if (this.deadTabs.has(index)) return null;
    return this.tabs[index] ?? null;
  }

  markTabDead(index) {
    this.deadTabs.add(index);
  }

  isTabDead(index) {
    return this.deadTabs.has(index);
  }

  getAliveTabIndices() {
    return Array.from({ length: this.tabCount }, (_, i) => i)
      .filter(i => !this.deadTabs.has(i) && this.tabs[i]);
  }

  async closeTab(index) {
    const tab = this.tabs[index];
    if (tab) {
      try { await tab.send('close'); } catch { /* tab already closed */ }
      await tab.close().catch(() => {});
      this.tabs[index] = null;
    }
  }

  async closeAll() {
    for (let i = 0; i < this.tabCount; i++) {
      await this.closeTab(i);
    }
    this.tabs = [];
  }
}