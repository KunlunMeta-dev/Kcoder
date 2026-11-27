import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';

function decodeText(payload) {
  // Validate the complete message before decoding can replace invalid bytes.
  if (!isUtf8(payload)) throw new Error("Invalid UTF-8 in WebSocket text message");
  return payload.toString("utf8");
}

export function createWebSocketFrameCodec({ maxMessageBytes }) {
  // One codec can serve several sockets; accounting follows each owned fragment array.
  const fragmentBytes = new WeakMap();
  function frame(value, opcode = 1) {
    const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const first = 0x80 | opcode;
    if (payload.length < 126)
      return Buffer.concat([Buffer.from([first, payload.length]), payload]);
    if (payload.length <= 0xffff) {
      const head = Buffer.alloc(4);
      head[0] = first;
      head[1] = 126;
      head.writeUInt16BE(payload.length, 2);
      return Buffer.concat([head, payload]);
    }
    const head = Buffer.alloc(10);
    head[0] = first;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(payload.length), 2);
    return Buffer.concat([head, payload]);
  }

  function decodeFrames(buffer, fragments, onMessage) {
    const messages = [];
    const deliver = onMessage ?? (message => { messages.push(message); });
    const controls = [];
    let offset = 0;
    while (offset + 2 <= buffer.length) {
      const fin = Boolean(buffer[offset] & 0x80);
      if (buffer[offset] & 0x70)
        throw new Error("WebSocket extensions are not supported");
      const opcode = buffer[offset] & 0x0f;
      const second = buffer[offset + 1];
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let cursor = offset + 2;
      if (length === 126) {
        if (cursor + 2 > buffer.length) break;
        length = buffer.readUInt16BE(cursor);
        cursor += 2;
      } else if (length === 127) {
        if (cursor + 8 > buffer.length) break;
        const wide = buffer.readBigUInt64BE(cursor);
        cursor += 8;
        if (wide > BigInt(Number.MAX_SAFE_INTEGER))
          throw new Error("WebSocket frame too large");
        length = Number(wide);
      }
      if (!masked) throw new Error("Client WebSocket frames must be masked");
      if (length > maxMessageBytes)
        throw new Error("WebSocket message is too large");
      if (opcode >= 8 && (!fin || length > 125))
        throw new Error("Invalid WebSocket control frame");
      const maskSize = 4;
      if (cursor + maskSize + length > buffer.length) break;
      const mask = buffer.subarray(cursor, cursor + maskSize);
      cursor += maskSize;
      const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
      for (let index = 0; index < payload.length; index++)
        payload[index] ^= mask[index % maskSize];
      let message;
      if (opcode === 1) {
        if (fragments.length)
          throw new Error("Unexpected text frame during fragmented message");
        if (fin) message = decodeText(payload);
        else {
          fragments.push(payload);
          fragmentBytes.set(fragments, payload.length);
        }
      } else if (opcode === 0) {
        if (!fragments.length) throw new Error("Unexpected continuation frame");
        const total = (fragmentBytes.get(fragments) ??
          fragments.reduce((sum, part) => sum + part.length, 0)) + payload.length;
        fragments.push(payload);
        fragmentBytes.set(fragments, total);
        if (total > maxMessageBytes)
          throw new Error("WebSocket message is too large");
        if (fin) {
          message = decodeText(Buffer.concat(fragments));
          fragments.length = 0;
          fragmentBytes.delete(fragments);
        }
      } else if (opcode === 8) {
        // A Close ends the application stream, even if more bytes arrived in
        // this read. Return all complete messages that preceded it.
        controls.push({ opcode, payload });
        fragments.length = 0;
        fragmentBytes.delete(fragments);
        offset = buffer.length;
        break;
      } else if (opcode === 9 || opcode === 10)
        controls.push({ opcode, payload });
      else throw new Error("Binary WebSocket frames are not supported");
      offset = cursor + length;
      // A consumer may end its application stream while handling a message.
      if (message !== undefined && deliver(message) === false) {
        fragments.length = 0;
        fragmentBytes.delete(fragments);
        offset = buffer.length;
        break;
      }
    }
    if (buffer.length - offset > maxMessageBytes + 14)
      throw new Error("WebSocket receive buffer is too large");
    return { messages, controls, rest: buffer.subarray(offset) };
  }

  return { frame, decodeFrames };
}


export function acceptWebSocket(request, socket) {
  const key = request.headers["sec-websocket-key"];
  if (!key) return false;
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  const protocols = String(request.headers["sec-websocket-protocol"] || "")
    .split(",")
    .map((value) => value.trim());
  const selectedProtocol = protocols.includes("kcoder-studio")
    ? "Sec-WebSocket-Protocol: kcoder-studio\r\n"
    : "";
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${selectedProtocol}\r\n`,
  );
  return true;
}
