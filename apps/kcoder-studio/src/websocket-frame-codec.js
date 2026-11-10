export function createWebSocketFrameCodec({ maxMessageBytes }) {
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

  function decodeFrames(buffer, fragments) {
    const messages = [];
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
      const mask = masked ? buffer.subarray(cursor, cursor + 4) : null;
      cursor += maskSize;
      const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
      if (mask)
        for (let index = 0; index < payload.length; index++)
          payload[index] ^= mask[index % 4];
      if (opcode === 1) {
        if (fragments.length)
          throw new Error("Unexpected text frame during fragmented message");
        if (fin) messages.push(payload.toString("utf8"));
        else fragments.push(payload);
      } else if (opcode === 0) {
        if (!fragments.length) throw new Error("Unexpected continuation frame");
        fragments.push(payload);
        if (
          fragments.reduce((sum, part) => sum + part.length, 0) > maxMessageBytes
        )
          throw new Error("WebSocket message is too large");
        if (fin) {
          messages.push(Buffer.concat(fragments).toString("utf8"));
          fragments.length = 0;
        }
      } else if (opcode === 8 || opcode === 9 || opcode === 10)
        controls.push({ opcode, payload });
      else throw new Error("Binary WebSocket frames are not supported");
      offset = cursor + length;
    }
    if (buffer.length - offset > maxMessageBytes + 14)
      throw new Error("WebSocket receive buffer is too large");
    return { messages, controls, rest: buffer.subarray(offset) };
  }

  return { frame, decodeFrames };
}
