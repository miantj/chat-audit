// electron/src/lib/cdp.js - WebSocket-based CDP client
import { WebSocket } from 'ws';

export class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this._ws = null;
    this._nextId = 1;
    this._handlers = new Map();
    this._pending = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(this.wsUrl);
      this._ws.on('open', () => resolve());
      this._ws.on('error', reject);
      this._ws.on('message', (data) => this._onMessage(JSON.parse(data.toString())));
    });
  }

  on(method, handler) {
    if (!this._handlers.has(method)) this._handlers.set(method, []);
    this._handlers.get(method).push(handler);
  }

  async send(method, params = {}) {
    const id = this._nextId++;
    this._ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`CDP ${method} timeout`));
        }
      }, 30000);
    });
  }

  _onMessage(data) {
    if (data.id === undefined) {
      const handlers = this._handlers.get(data.method) || [];
      handlers.forEach(h => h(data.params));
      return;
    }
    const pending = this._pending.get(data.id);
    if (pending) {
      this._pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error.message));
      else pending.resolve(data.result);
    }
  }

  async close() {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }
}