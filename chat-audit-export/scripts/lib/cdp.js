import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { NodeCdpWebSocket } from './node-ws-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function cdpPortFromBase(cdpBase) {
  const m = String(cdpBase || '')
    .replace(/\/$/, '')
    .match(/:(\d+)(?:\/|$)/);
  return m ? m[1] : '9222';
}

/**
 * Chrome 常返回无端口的 ws://127.0.0.1/devtools/...；npm ws 会默认连 80 导致 ECONNREFUSED。
 */
export function normalizeCdpWebSocketUrl(
  wsUrl,
  cdpBase = process.env.CHAT_AUDIT_CRM_CDP_BASE || 'http://localhost:9222'
) {
  if (!wsUrl || typeof wsUrl !== 'string') return wsUrl;
  try {
    const u = new URL(wsUrl);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return wsUrl;
    if (!u.port) {
      u.port = cdpPortFromBase(cdpBase);
    }
    return u.toString();
  } catch {
    return wsUrl;
  }
}

function pickWebSocketCtor(mod) {
  if (!mod) return null;
  if (typeof mod === 'function') return mod;
  if (typeof mod.WebSocket === 'function') return mod.WebSocket;
  if (mod.default) return pickWebSocketCtor(mod.default);
  return null;
}

function tryLoadWsFromDir(dir) {
  const indexJs = path.join(dir, 'index.js');
  if (!fs.existsSync(indexJs)) return null;
  try {
    const ctor = pickWebSocketCtor(require(indexJs));
    if (typeof ctor === 'function') {
      return { ctor, mode: 'node-ws', source: indexJs };
    }
  } catch {
    // try next
  }
  return null;
}

function loadWsPackage() {
  const candidates = [
    process.env.CHAT_AUDIT_WS_PATH,
    path.join(__dirname, '..', 'node_modules', 'ws'),
    process.env.CHAT_AUDIT_RESOURCES_PATH
      ? path.join(
          process.env.CHAT_AUDIT_RESOURCES_PATH,
          'scripts',
          'node_modules',
          'ws'
        )
      : null,
    process.env.CHAT_AUDIT_RESOURCES_PATH
      ? path.join(
          process.env.CHAT_AUDIT_RESOURCES_PATH,
          'app.asar.unpacked',
          'node_modules',
          'ws'
        )
      : null,
    path.join(__dirname, '..', '..', 'app.asar.unpacked', 'node_modules', 'ws'),
    path.join(__dirname, '..', '..', '..', 'electron', 'node_modules', 'ws')
  ].filter(Boolean);

  for (const candidate of candidates) {
    const loaded = tryLoadWsFromDir(candidate);
    if (loaded) return loaded;
  }
  try {
    const ctor = pickWebSocketCtor(require('ws'));
    if (typeof ctor === 'function') {
      return { ctor, mode: 'node-ws', source: 'ws' };
    }
  } catch {
    // fall through
  }
  return null;
}

function resolveCdpWebSocket() {
  if (process.versions?.node) {
    const loaded = loadWsPackage();
    if (loaded) return loaded;
    return {
      ctor: NodeCdpWebSocket,
      mode: 'builtin',
      source: 'node-ws-client.js'
    };
  }
  if (typeof globalThis.WebSocket === 'function') {
    return { ctor: globalThis.WebSocket, mode: 'native', source: 'globalThis' };
  }
  throw new Error(
    'CDP WebSocket unavailable: install ws or use Node with builtin client'
  );
}

let resolved = null;

function getWebSocketImpl() {
  if (!resolved) {
    resolved = resolveCdpWebSocket();
    if (process.env.CHAT_AUDIT_CDP_WS_DEBUG === '1') {
      console.warn(
        `[CDP] WebSocket backend: mode=${resolved.mode} source=${resolved.source}`
      );
    }
  }
  return resolved;
}

/** 导出启动时诊断（写入导出日志） */
export function logCdpWebSocketBootstrap() {
  const { mode, source } = getWebSocketImpl();
  const wsPath = path.join(__dirname, '..', 'node_modules', 'ws', 'index.js');
  console.warn(
    `[CDP] ws backend=${mode} source=${source} ` +
      `scriptsWsExists=${fs.existsSync(wsPath)} ` +
      `CHAT_AUDIT_WS_PATH=${process.env.CHAT_AUDIT_WS_PATH || '(unset)'}`
  );
}

function usesNodeWsApi(socket) {
  const { mode } = getWebSocketImpl();
  return (
    mode === 'node-ws' ||
    mode === 'builtin' ||
    typeof socket?.on === 'function'
  );
}

function parseMessage(raw) {
  const text = typeof raw === 'string' ? raw : raw.toString();
  return JSON.parse(text);
}

function handleMessage(message, client) {
  if (message.id) {
    const pending = client.pending.get(message.id);
    if (!pending) return;
    client.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message));
    } else {
      pending.resolve(message.result);
    }
    return;
  }

  const handlers = client.eventHandlers.get(message.method) || [];
  for (const handler of handlers) {
    handler(message.params || {});
  }
}

export class CDPClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = normalizeCdpWebSocketUrl(webSocketUrl);
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
  }

  async connect() {
    const { ctor: WebSocketImpl, mode } = getWebSocketImpl();
    const url = this.webSocketUrl;

    if (mode === 'builtin') {
      this.ws = new WebSocketImpl(url);
      this.ws.on('error', () => {}); // 避免未捕获的 error 事件导致 Node 进程崩溃
      await this.ws.connect();
      this.ws.on('message', (raw) => {
        handleMessage(parseMessage(raw), this);
      });
      return;
    }

    if (mode === 'node-ws') {
      await new Promise((resolve, reject) => {
        const ws = new WebSocketImpl(url);
        this.ws = ws;
        const onOpen = () => {
          ws.off('open', onOpen);
          ws.off('error', onError);
          resolve();
        };
        const onError = (err) => {
          ws.off('open', onOpen);
          ws.off('error', onError);
          reject(err);
        };
        ws.on('open', onOpen);
        ws.on('error', onError);
      });
      this.ws.on('error', () => {}); // 避免连接建立后发生错误事件导致进程崩溃
      this.ws.on('message', (raw) => {
        handleMessage(parseMessage(raw), this);
      });
      return;
    }

    await new Promise((resolve, reject) => {
      const ws = new WebSocketImpl(url);
      this.ws = ws;
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      handleMessage(parseMessage(event.data), this);
    });
  }

  on(method, handler) {
    const list = this.eventHandlers.get(method) || [];
    list.push(handler);
    this.eventHandlers.set(method, list);
  }

  async send(method, params = {}) {
    const id = this.nextId++;
    const payload = { id, method, params };
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async close() {
    if (!this.ws) return;
    this.ws.close();
    if (usesNodeWsApi(this.ws)) {
      if (typeof this.ws.once === 'function') {
        await new Promise((resolve) => {
          this.ws.once('close', resolve);
          setTimeout(resolve, 500);
        });
      }
      return;
    }
    await new Promise((resolve) => {
      this.ws.addEventListener('close', resolve, { once: true });
    });
  }
}
