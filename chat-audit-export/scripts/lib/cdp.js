export class CDPClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });

    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      const handlers = this.eventHandlers.get(message.method) || [];
      for (const handler of handlers) {
        handler(message.params || {});
      }
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
    await new Promise((resolve) => {
      this.ws.addEventListener('close', resolve, { once: true });
    });
  }
}
