import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";

export class HeaderWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, headers = {}) {
    this.url = new URL(url);
    if (this.url.protocol !== "ws:") throw new Error("HeaderWebSocket currently supports ws:// only");
    this.readyState = HeaderWebSocket.CONNECTING;
    this.listeners = new Map();
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.handshakeComplete = false;
    this.key = randomBytes(16).toString("base64");
    this.socket = connect({ host: this.url.hostname, port: Number(this.url.port || 80) });
    this.socket.once("connect", () => this.writeHandshake(headers));
    this.socket.on("data", chunk => this.onData(chunk));
    this.socket.on("error", error => this.emit("error", { error, message: error.message }));
    this.socket.on("close", () => {
      this.readyState = HeaderWebSocket.CLOSED;
      this.emit("close", {});
    });
  }

  addEventListener(type, callback, options = {}) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({ callback, once: options.once === true });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, callback) {
    const remaining = (this.listeners.get(type) || []).filter(listener => listener.callback !== callback);
    if (remaining.length) this.listeners.set(type, remaining);
    else this.listeners.delete(type);
  }

  send(value) {
    if (this.readyState !== HeaderWebSocket.OPEN) throw new Error("WebSocket is not open");
    this.socket.write(clientFrame(Buffer.from(String(value)), 1));
  }

  close() {
    if (this.readyState >= HeaderWebSocket.CLOSING) return;
    this.readyState = HeaderWebSocket.CLOSING;
    if (this.handshakeComplete) this.socket.end(clientFrame(Buffer.alloc(0), 8));
    else this.socket.destroy();
  }

  endTransportWithoutCloseFrame() {
    if (this.readyState >= HeaderWebSocket.CLOSING) return;
    this.readyState = HeaderWebSocket.CLOSING;
    this.socket.end();
  }

  writeHandshake(headers) {
    const host = this.url.port ? `${this.url.hostname}:${this.url.port}` : this.url.hostname;
    const lines = [
      `GET ${this.url.pathname}${this.url.search} HTTP/1.1`,
      `Host: ${host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${this.key}`,
      "Sec-WebSocket-Version: 13",
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ];
    this.socket.write(lines.join("\r\n"));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshakeComplete) {
      const boundary = this.buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const head = this.buffer.subarray(0, boundary).toString("utf8");
      this.buffer = this.buffer.subarray(boundary + 4);
      if (!head.startsWith("HTTP/1.1 101")) {
        this.emit("error", { error: new Error(`WebSocket upgrade rejected: ${head.split("\r\n", 1)[0]}`) });
        this.socket.destroy();
        return;
      }
      const expected = createHash("sha1").update(`${this.key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      if (!new RegExp(`^Sec-WebSocket-Accept:\\s*${escapeRegex(expected)}$`, "mi").test(head)) {
        this.emit("error", { error: new Error("WebSocket accept hash mismatch") });
        this.socket.destroy();
        return;
      }
      this.handshakeComplete = true;
      this.readyState = HeaderWebSocket.OPEN;
      this.emit("open", {});
    }
    this.decodeFrames();
  }

  decodeFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const opcode = first & 0x0f;
      const fin = Boolean(first & 0x80);
      let length = this.buffer[1] & 0x7f;
      let cursor = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        cursor = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        cursor = 10;
      }
      if (this.buffer.length < cursor + length) return;
      const payload = this.buffer.subarray(cursor, cursor + length);
      this.buffer = this.buffer.subarray(cursor + length);
      if (opcode === 8) {
        this.readyState = HeaderWebSocket.CLOSING;
        this.socket.end(clientFrame(payload, 8));
      } else if (opcode === 9) {
        this.socket.write(clientFrame(payload, 10));
      } else if (opcode === 1 || opcode === 0) {
        this.fragments.push(payload);
        if (fin) {
          const data = Buffer.concat(this.fragments).toString("utf8");
          this.fragments.length = 0;
          this.emit("message", { data });
        }
      }
    }
  }

  emit(type, event) {
    const listeners = this.listeners.get(type) || [];
    for (const listener of [...listeners]) {
      listener.callback(event);
      if (listener.once) this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener));
    }
  }
}

function clientFrame(payload, opcode) {
  const mask = randomBytes(4);
  let head;
  if (payload.length < 126) {
    head = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(payload.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([head, mask, masked]);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
