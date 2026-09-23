import { createSshTerminalSession } from './ssh-terminal.js';

export function bridgeSshTerminal(socket, initialData, { store, frame, decodeFrames }) {
  let buffered = Buffer.from(initialData);
  const fragments = [];
  let closed = false;
  let inFlight = 0;
  const send = message => {
    if (closed || !socket.writable) return false;
    if (socket.writableLength > 1024 * 1024) { socket.destroy(); return false; }
    return socket.write(frame(JSON.stringify(message)));
  };
  const terminal = createSshTerminalSession({ store, send });
  const dispose = () => {
    if (closed) return;
    closed = true;
    terminal.dispose();
  };
  socket.on('close', dispose);
  socket.on('error', dispose);
  socket.on('end', () => { dispose(); socket.destroy(); });
  socket.on('data', chunk => {
    try {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 96 * 1024 + 14) { socket.destroy(); return; }
      const decoded = decodeFrames(buffered, fragments);
      buffered = decoded.rest;
      if (fragments.length > 128 || fragments.reduce((sum, part) => sum + part.length, 0) > 96 * 1024) {
        socket.destroy(); return;
      }
      for (const control of decoded.controls) {
        if (control.opcode === 8) { dispose(); socket.end(frame(control.payload, 8)); return; }
        if (control.opcode === 9) socket.write(frame(control.payload, 10));
      }
      for (const raw of decoded.messages) {
        if (Buffer.byteLength(raw) > 96 * 1024 || ++inFlight > 128) { socket.destroy(); return; }
        const request = JSON.parse(raw);
        if (!request || request.jsonrpc !== '2.0' || !Number.isSafeInteger(request.id) || typeof request.method !== 'string') {
          socket.destroy(); return;
        }
        Promise.resolve().then(() => terminal.handle(request.method, request.params ?? {})).then(
          result => send({ jsonrpc: '2.0', id: request.id, result }),
          error => send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error.message || 'SSH request failed' } }),
        ).finally(() => { inFlight -= 1; });
      }
    } catch {
      dispose();
      socket.destroy();
    }
  });
  if (buffered.length) socket.emit('data', Buffer.alloc(0));
}
