import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";
import { connect as connectTls } from "node:tls";

const MAX_DIAGNOSTIC_EVENTS = 24;
const SAFE_DIAGNOSTIC_EVENTS = new Set([
  "connect_started", "dns_lookup", "tcp_connected", "tls_secure_connect", "socket_error", "socket_close",
  "handshake_write_started", "handshake_write_submitted", "handshake_write_callback", "upgrade_response_bytes",
  "upgrade_response", "upgrade_validation", "open_timeout",
]);
const SAFE_PHASES = new Set([
  "connecting", "tls_handshake", "tls_connected", "tcp_connected", "handshake_write", "upgrade_rejected",
  "upgrade_invalid", "open",
]);
const SAFE_ERROR_KINDS = new Set([
  "dns_failure", "dns_retry", "refused", "reset", "timeout", "unreachable", "tls_certificate", "tls_protocol", "tls_handshake", "protocol", "other",
]);
const SAFE_SOCKET_ERROR_KINDS = new Map([
  ["ENOTFOUND", "dns_failure"], ["EAI_AGAIN", "dns_retry"],
  ["ECONNREFUSED", "refused"], ["ECONNRESET", "reset"], ["EPIPE", "reset"],
  ["ETIMEDOUT", "timeout"], ["EHOSTUNREACH", "unreachable"], ["ENETUNREACH", "unreachable"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_certificate"], ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls_certificate"],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls_certificate"], ["ERR_SSL_WRONG_VERSION_NUMBER", "tls_protocol"],
]);
const SAFE_ALPN = new Set(["h2", "http/1.1"]);

export function safeSocketErrorKind(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  return SAFE_SOCKET_ERROR_KINDS.get(code)
    ?? (code.startsWith("ERR_TLS_") ? "tls_handshake" : null)
    ?? (code.startsWith("ERR_SSL_") ? "tls_protocol" : "other");
}

export function parseUpgradeStatusCode(firstLine) {
  if (typeof firstLine !== "string") return null;
  const match = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?:\s|$)/.exec(firstLine);
  return match ? Number(match[1]) : null;
}

export class HeaderWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, headers = {}, { onDiagnostic } = {}) {
    this.url = new URL(url);
    if (this.url.protocol !== "ws:" && this.url.protocol !== "wss:") {
      throw new Error("HeaderWebSocket supports ws:// and wss:// only");
    }
    const secure = this.url.protocol === "wss:";
    this.readyState = HeaderWebSocket.CONNECTING;
    this.listeners = new Map();
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.handshakeComplete = false;
    this.onDiagnostic = typeof onDiagnostic === "function" ? onDiagnostic : null;
    this.diagnosticStartedAt = process.hrtime.bigint();
    this.diagnosticEventCount = 0;
    this.transportPhase = "connecting";
    this.upgradeResponseBytesObserved = false;
    this.key = randomBytes(16).toString("base64");
    const host = this.url.hostname.replace(/^\[|\]$/g, "");
    this.socket = secure
      ? connectTls({
        host,
        port: Number(this.url.port || 443),
        ...(host.includes(":") ? {} : { servername: host }),
      })
      : connect({ host, port: Number(this.url.port || 80) });
    this.recordDiagnostic("connect_started", { transport: secure ? "tls" : "tcp" });
    this.socket.on("lookup", (error, _address, family) => this.recordDiagnostic("dns_lookup", {
      outcome: error ? "error" : "complete",
      family: family === 4 || family === 6 ? family : null,
      ...(error ? { errorKind: safeSocketErrorKind(error) } : {}),
    }));
    this.socket.once("connect", () => {
      this.transportPhase = secure ? "tls_handshake" : "tcp_connected";
      this.recordDiagnostic("tcp_connected");
      if (!secure) this.writeHandshake(headers);
    });
    if (secure) this.socket.once("secureConnect", () => {
      this.transportPhase = "tls_connected";
      const alpn = typeof this.socket.alpnProtocol === "string" && SAFE_ALPN.has(this.socket.alpnProtocol)
        ? this.socket.alpnProtocol : this.socket.alpnProtocol ? "other" : "none";
      this.recordDiagnostic("tls_secure_connect", { authorized: this.socket.authorized === true, alpn });
      this.writeHandshake(headers);
    });
    this.socket.on("data", chunk => this.onData(chunk));
    this.socket.on("error", error => {
      this.recordDiagnostic("socket_error", { errorKind: safeSocketErrorKind(error) });
      this.emit("error", { error, message: error.message });
    });
    this.socket.on("close", hadError => {
      this.recordDiagnostic("socket_close", { hadError: hadError === true, handshakeComplete: this.handshakeComplete });
      this.readyState = HeaderWebSocket.CLOSED;
      this.emit("close", {});
    });
  }

  recordDiagnostic(event, details = {}) {
    if (!this.onDiagnostic || !SAFE_DIAGNOSTIC_EVENTS.has(event) || this.diagnosticEventCount >= MAX_DIAGNOSTIC_EVENTS) return;
    const elapsedMs = Number(process.hrtime.bigint() - this.diagnosticStartedAt) / 1_000_000;
    const record = { event, elapsedMs: Math.round(elapsedMs * 1000) / 1000 };
    if (SAFE_PHASES.has(this.transportPhase)) record.phase = this.transportPhase;
    if (event === "connect_started" && ["tcp", "tls"].includes(details.transport)) record.transport = details.transport;
    if (event === "dns_lookup") {
      if (["complete", "error"].includes(details.outcome)) record.outcome = details.outcome;
      if (details.family === 4 || details.family === 6) record.family = details.family;
      if (SAFE_ERROR_KINDS.has(details.errorKind)) record.errorKind = details.errorKind;
    }
    if (event === "tls_secure_connect") {
      if (typeof details.authorized === "boolean") record.authorized = details.authorized;
      if (["h2", "http/1.1", "other", "none"].includes(details.alpn)) record.alpn = details.alpn;
    }
    if (event === "socket_error" && SAFE_ERROR_KINDS.has(details.errorKind)) record.errorKind = details.errorKind;
    if (event === "socket_close") {
      if (typeof details.hadError === "boolean") record.hadError = details.hadError;
      if (typeof details.handshakeComplete === "boolean") record.handshakeComplete = details.handshakeComplete;
    }
    if (event === "handshake_write_submitted" && typeof details.backpressured === "boolean") record.backpressured = details.backpressured;
    if (event === "handshake_write_callback") {
      if (["complete", "error"].includes(details.outcome)) record.outcome = details.outcome;
      if (SAFE_ERROR_KINDS.has(details.errorKind)) record.errorKind = details.errorKind;
    }
    if (event === "upgrade_response_bytes" && Number.isSafeInteger(details.firstChunkBytes) && details.firstChunkBytes >= 0) {
      record.firstChunkBytes = Math.min(details.firstChunkBytes, 1_000_000);
    }
    if (event === "upgrade_response" && (details.statusCode === null ||
      (Number.isInteger(details.statusCode) && details.statusCode >= 100 && details.statusCode <= 599))) {
      record.statusCode = details.statusCode;
      record.statusParsed = details.statusCode !== null;
    }
    if (event === "upgrade_validation") {
      if (["accepted", "rejected"].includes(details.outcome)) record.outcome = details.outcome;
      if (SAFE_ERROR_KINDS.has(details.errorKind)) record.errorKind = details.errorKind;
    }
    Object.freeze(record);
    this.diagnosticEventCount += 1;
    try {
      const result = this.onDiagnostic(record);
      if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
    } catch {}
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
    this.transportPhase = "handshake_write";
    this.recordDiagnostic("handshake_write_started");
    try {
      const queued = this.socket.write(lines.join("\r\n"), error => {
        this.recordDiagnostic("handshake_write_callback", error
          ? { outcome: "error", errorKind: safeSocketErrorKind(error) }
          : { outcome: "complete" });
      });
      this.recordDiagnostic("handshake_write_submitted", { backpressured: queued === false });
    } catch (error) {
      this.recordDiagnostic("handshake_write_callback", { outcome: "error", errorKind: safeSocketErrorKind(error) });
      throw error;
    }
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshakeComplete && !this.upgradeResponseBytesObserved && chunk.byteLength > 0) {
      this.upgradeResponseBytesObserved = true;
      this.recordDiagnostic("upgrade_response_bytes", { firstChunkBytes: chunk.byteLength });
    }
    if (!this.handshakeComplete) {
      const boundary = this.buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const head = this.buffer.subarray(0, boundary).toString("utf8");
      this.buffer = this.buffer.subarray(boundary + 4);
      const firstLine = head.split("\r\n", 1)[0];
      const statusCode = parseUpgradeStatusCode(firstLine);
      this.recordDiagnostic("upgrade_response", { statusCode });
      if (!head.startsWith("HTTP/1.1 101")) {
        this.transportPhase = "upgrade_rejected";
        this.emit("error", { error: new Error(`WebSocket upgrade rejected: ${head.split("\r\n", 1)[0]}`) });
        this.socket.destroy();
        return;
      }
      const expected = createHash("sha1").update(`${this.key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      if (!new RegExp(`^Sec-WebSocket-Accept:\\s*${escapeRegex(expected)}$`, "mi").test(head)) {
        this.transportPhase = "upgrade_invalid";
        this.recordDiagnostic("upgrade_validation", { outcome: "rejected", errorKind: "protocol" });
        this.emit("error", { error: new Error("WebSocket accept hash mismatch") });
        this.socket.destroy();
        return;
      }
      this.recordDiagnostic("upgrade_validation", { outcome: "accepted" });
      this.transportPhase = "open";
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
