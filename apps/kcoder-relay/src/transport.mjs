import { Duplex, Transform } from 'node:stream';
import { createWebSocketStream } from 'ws';

// One total deadline from the first orderly EOF; neither progress nor a
// second EOF extends it. Errors and explicit owner cleanup bypass draining.
export const RELAY_EOF_DRAIN_TIMEOUT_MS = 5_000;

export function bridge(socket, ws, onClose = () => {}) {
  const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
  let closed = false;
  let drainTimer = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(drainTimer);
    drainTimer = null;
    socket.unpipe(stream);
    stream.unpipe(socket);
    socket.destroy();
    stream.destroy();
    ws.terminate();
    onClose();
  };
  const finishDrain = () => {
    // A closed TCP sink can leave the now-empty readable paused after unpipe.
    // read(0) consumes no payload; Node schedules an already-pushed EOF's end.
    if (!closed && socket.readableEnded && socket.writableFinished &&
        !stream.destroyed && !stream.readableEnded && stream.readableLength === 0 &&
        ws.readyState === ws.CLOSED)
      stream.read(0);
    // Stream finish includes every ws.send callback and _final's TCP finish.
    // CLOSED includes the close handshake; ws.close() alone proves neither.
    // The opposite direction must also drain before destroying its TCP sink.
    if (!closed && socket.readableEnded && socket.writableFinished &&
        stream.readableEnded && stream.writableFinished && ws.readyState === ws.CLOSED)
      cleanup();
  };
  const beginDrain = () => {
    if (closed) return;
    if (drainTimer === null) {
      drainTimer = setTimeout(cleanup, RELAY_EOF_DRAIN_TIMEOUT_MS);
      drainTimer.unref?.();
    }
    finishDrain();
  };
  socket.on('error', cleanup);
  socket.once('end', beginDrain);
  socket.once('finish', finishDrain);
  socket.once('close', hadError => {
    if (hadError || !socket.readableEnded) cleanup();
    else beginDrain();
  });
  stream.on('error', cleanup);
  stream.once('end', beginDrain);
  stream.once('finish', finishDrain);
  stream.once('close', () => {
    if (!stream.readableEnded || !stream.writableFinished) cleanup();
    else beginDrain();
  });
  ws.on('error', cleanup);
  ws.once('close', code => {
    if (code === 1000 || code === 1001 || code === 1005) beginDrain();
    else cleanup();
  });
  socket.pipe(stream).pipe(socket);
  return cleanup; // Registry revoke/shutdown is still an immediate hard close.
}

export function bridgeRaw(socket, stream, onClose = () => {}, onBytes = () => true) {
  let closed = false;
  let incoming;
  let outgoing;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    socket.destroy();
    stream.destroy();
    incoming?.destroy();
    outgoing?.destroy();
    onClose();
  };
  const gate = () => new Transform({
    transform(chunk, encoding, callback) {
      if (!onBytes(chunk.length)) {
        callback(Object.assign(new Error('Gateway traffic limit reached'), { code: 'RELAY_TRAFFIC_LIMIT' }));
        return;
      }
      callback(null, chunk);
    },
  });
  incoming = gate();
  outgoing = gate();
  socket.on('error', cleanup);
  socket.on('close', cleanup);
  stream.on('error', cleanup);
  stream.on('close', cleanup);
  incoming.on('error', cleanup);
  outgoing.on('error', cleanup);
  socket.pipe(incoming).pipe(stream);
  stream.pipe(outgoing).pipe(socket);
  return cleanup;
}

export class RelayDuplex extends Duplex {
  constructor() {
    super({ allowHalfOpen: false, highWaterMark: 64 * 1024 });
    this.connecting = true;
    this.relayStream = null;
    this.relayClose = null;
    this.pendingWrites = [];
    this.timeoutMs = 0;
    this.timeoutTimer = null;
    this.timeoutListener = null;
  }

  attach(stream, onClose = () => {}) {
    if (this.destroyed || this.relayStream) {
      stream.destroy();
      return false;
    }
    this.relayStream = stream;
    this.relayClose = onClose;
    stream.on('data', chunk => {
      this.touchTimeout();
      if (!this.push(chunk)) stream.pause();
    });
    stream.once('end', () => this.push(null));
    stream.on('error', error => this.destroy(error));
    stream.once('close', () => {
      if (!this.destroyed) this.destroy();
    });
    this.connecting = false;
    this.emit('connect');
    this.touchTimeout();
    for (const [chunk, encoding, callback] of this.pendingWrites.splice(0)) {
      this.writeToRelay(chunk, encoding, callback);
    }
    return true;
  }

  fail(error) {
    this.destroy(error);
  }

  _read() {
    this.relayStream?.resume();
  }

  _write(chunk, encoding, callback) {
    if (!this.relayStream) {
      this.pendingWrites.push([chunk, encoding, callback]);
      return;
    }
    this.writeToRelay(chunk, encoding, callback);
  }

  writeToRelay(chunk, encoding, callback) {
    if (!this.relayStream || this.relayStream.destroyed) {
      callback(new Error('Relay tunnel is closed'));
      return;
    }
    this.touchTimeout();
    this.relayStream.write(chunk, encoding, error => {
      this.touchTimeout();
      callback(error);
    });
  }

  _final(callback) {
    if (!this.relayStream || this.relayStream.destroyed) return callback();
    this.relayStream.end(callback);
  }

  _destroy(error, callback) {
    clearTimeout(this.timeoutTimer);
    this.timeoutTimer = null;
    this.connecting = false;
    const stream = this.relayStream;
    this.relayStream = null;
    if (stream && !stream.destroyed) stream.destroy(error);
    this.relayClose?.();
    this.relayClose = null;
    for (const [, , pendingCallback] of this.pendingWrites.splice(0)) pendingCallback(error ?? new Error('Relay tunnel is closed'));
    callback(error);
  }

  setTimeout(milliseconds, callback) {
    this.timeoutMs = Math.max(0, Number(milliseconds) || 0);
    this.timeoutListener = callback ?? this.timeoutListener;
    this.touchTimeout();
    return this;
  }

  touchTimeout() {
    clearTimeout(this.timeoutTimer);
    this.timeoutTimer = null;
    if (!this.timeoutMs || this.destroyed) return;
    this.timeoutTimer = setTimeout(() => {
      this.emit('timeout');
      this.timeoutListener?.call(this);
    }, this.timeoutMs);
    this.timeoutTimer.unref?.();
  }

  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
  address() { return { address: '127.0.0.1', family: 'IPv4', port: 0 }; }
}

export function heartbeat(ws) {
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const timer = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    if (ws.readyState === 1) ws.ping();
  }, 15000);
  timer.unref();
  ws.once('close', () => clearInterval(timer));
}
