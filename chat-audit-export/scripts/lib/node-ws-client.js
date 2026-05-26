/**
 * 零依赖 WebSocket 客户端（仅 CDP JSON-RPC，文本帧）。
 * 当打包环境无法 require('ws') 时使用，避免 globalThis.WebSocket 占位导致 not a constructor。
 */
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { URL } from 'node:url';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function parseFrames(buffer) {
  const messages = [];
  let close = false;
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let headerLen = 2;
    if (len === 126) {
      if (offset + 4 > buffer.length) break;
      len = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (len === 127) {
      if (offset + 10 > buffer.length) break;
      const hi = buffer.readUInt32BE(offset + 2);
      const lo = buffer.readUInt32BE(offset + 6);
      len = hi * 0x100000000 + lo;
      headerLen = 10;
    }
    const maskStart = offset + headerLen;
    const dataStart = maskStart + (masked ? 4 : 0);
    const frameEnd = dataStart + len;
    if (frameEnd > buffer.length) break;
    let payload = buffer.subarray(dataStart, frameEnd);
    if (masked) {
      const mask = buffer.subarray(maskStart, maskStart + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4];
      }
    }
    if (opcode === 0x1) {
      messages.push(payload.toString('utf8'));
    } else if (opcode === 0x8) {
      close = true;
    }
    offset = frameEnd;
  }
  return { messages, close, rest: buffer.subarray(offset) };
}

function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(6 + len);
    header[0] = 0x81;
    header[1] = 0x80 | len;
    const mask = header.subarray(2, 6);
    crypto.randomFillSync(mask);
    payload.copy(header, 6);
    for (let i = 0; i < len; i++) {
      header[6 + i] ^= mask[i % 4];
    }
    return header;
  }
  if (len < 65536) {
    header = Buffer.alloc(8 + len);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    const mask = header.subarray(4, 8);
    crypto.randomFillSync(mask);
    payload.copy(header, 8);
    for (let i = 0; i < len; i++) {
      header[8 + i] ^= mask[i % 4];
    }
    return header;
  }
  throw new Error('CDP message too large for builtin WebSocket');
}

export class NodeCdpWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.ready = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      if (u.protocol !== 'ws:') {
        reject(new Error(`builtin CDP WebSocket only supports ws: (got ${u.protocol})`));
        return;
      }
      const port = u.port ? Number(u.port) : 80;
      const key = crypto.randomBytes(16).toString('base64');
      const path = `${u.pathname || '/'}${u.search || ''}`;
      const req =
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${u.hostname}${u.port ? `:${u.port}` : ''}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n';

      const expectedAccept = crypto
        .createHash('sha1')
        .update(key + WS_GUID)
        .digest('base64');

      const socket = net.connect(port, u.hostname, () => {
        socket.write(req);
      });
      this.socket = socket;
      let handshakeDone = false;

      const fail = (err) => {
        socket.destroy();
        reject(err);
      };

      socket.once('error', fail);

      socket.on('data', (chunk) => {
        if (!handshakeDone) {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          const end = this.buffer.indexOf('\r\n\r\n');
          if (end === -1) return;
          const head = this.buffer.subarray(0, end).toString('utf8');
          const rest = this.buffer.subarray(end + 4);
          if (!/^HTTP\/1\.1 101/i.test(head)) {
            fail(new Error(`WebSocket handshake failed: ${head.split('\r\n')[0]}`));
            return;
          }
          const accept = head.match(/Sec-WebSocket-Accept:\s*(.+)/i)?.[1]?.trim();
          if (accept !== expectedAccept) {
            fail(new Error('WebSocket handshake: bad Sec-WebSocket-Accept'));
            return;
          }
          handshakeDone = true;
          this.ready = true;
          this.buffer = rest;
          socket.off('error', fail);
          socket.on('error', (err) => this.emit('error', err));
          this.emit('open');
          resolve();
          this._drainFrames();
          return;
        }
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this._drainFrames();
      });

      socket.once('close', () => {
        if (!handshakeDone) {
          fail(new Error('WebSocket closed before handshake'));
        } else {
          this.emit('close');
        }
      });
    });
  }

  _drainFrames() {
    const { messages, rest, close } = parseFrames(this.buffer);
    this.buffer = rest;
    for (const text of messages) {
      this.emit('message', text);
    }
    if (close) {
      this.socket?.end();
      this.emit('close');
    }
  }

  send(data) {
    if (!this.ready || !this.socket) {
      throw new Error('WebSocket not open');
    }
    this.socket.write(encodeTextFrame(String(data)));
  }

  close() {
    if (!this.socket) return;
    try {
      const frame = Buffer.alloc(6);
      frame[0] = 0x88;
      frame[1] = 0x80;
      crypto.randomFillSync(frame.subarray(2, 6));
      this.socket.write(frame);
    } catch {
      /* ignore */
    }
    this.socket.end();
  }
}
