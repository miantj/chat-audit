/**
 * 最小 CDP WebSocket 客户端（Node 22+ 内置 WebSocket）
 */
export class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    const WS = globalThis.WebSocket;
    if (!WS) throw new Error('需要 Node 22+（内置 WebSocket）');
    this.ws = new WS(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id == null) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    if (!this.ws) return Promise.reject(new Error('CDP 未连接'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 请求超时：${method}`));
      }, 15000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception;
      const detail =
        (typeof ex?.description === 'string' && ex.description) ||
        (typeof ex?.value === 'string' && ex.value) ||
        r.exceptionDetails.text ||
        'evaluate failed';
      throw new Error(detail.split('\n')[0]);
    }
    return r.result?.value;
  }

  async goto(url) {
    await this.send('Page.enable');
    await this.send('Page.navigate', { url });
  }

  close() {
    for (const { reject } of this.pending.values()) reject(new Error('CDP 已关闭'));
    this.pending.clear();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
