// Manual generic-Duplex diagnostic, not the production createWebSocketStream caller.
// Explicit registration retains the counterexample without claiming a failed
// current browser RPC contract or marking an ignored acceptance test as passed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { createServer, connect } from 'node:net';
import { bridgeRaw, RelayDuplex } from '../../src/transport.mjs';
async function bounded(promise, ms = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owned generic probe deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}

export function registerGenericDuplexEofProbe() {
  test('raw bridge preserves a queued TCP tail through an orderly source close', async t => {
    const source = new PassThrough();
    source.on('error', () => {});
    let sink, client, cleanup;
    let closeCount = 0, queuedAtSourceClose = 0;
    const ready = new Promise(resolve => {
      const server = createServer(socket => {
        sink = socket; socket.on('error', () => {}); socket.cork();
        cleanup = bridgeRaw(socket, source, () => { closeCount++; });
        resolve(server);
      });
      server.listen(0, '127.0.0.1', () => {
        client = connect({ host: '127.0.0.1', port: server.address().port });
        client.on('error', () => {});
      });
    });
    const server = await bounded(ready);
    t.after(async () => {
      cleanup?.(); client?.destroy(); sink?.destroy(); source.destroy();
      await bounded(new Promise(resolve => server.close(resolve)));
    });
    const chunks = [];
    client.on('data', chunk => chunks.push(chunk));
    client.pause();
    const end = new Promise(resolve => client.once('end', resolve));
    const sourceClosed = new Promise(resolve => source.once('close', resolve));
    source.prependOnceListener('close', () => { queuedAtSourceClose = sink.writableLength; });
    const body = Buffer.alloc(8 * 1024 * 1024, 0xa5);
    source.end(body);
    await bounded(sourceClosed);
    assert.ok(queuedAtSourceClose > 0, 'causal gate: TCP owns queued tail bytes before the source close handler');
    assert.equal(closeCount, 0, 'orderly EOF must not drop a queued sink');
    client.resume();
    sink.uncork();
    await bounded(end);
    assert.deepEqual(Buffer.concat(chunks), body);
  });
}

export function registerRelayDuplexContractProbes() {
  test('off-caller contract: a naturally closed source must not announce connect', async t => {
    const source = new PassThrough(), tunnel = new RelayDuplex();
    source.on('error', () => {}); tunnel.on('error', () => {});
    t.after(() => { source.destroy(); tunnel.destroy(); });
    const closed = new Promise(resolve => source.once('close', resolve));
    source.resume(); source.end(); await bounded(closed);
    assert.equal(tunnel.attach(source), false);
  });
  test('off-caller contract: an empty pre-attach end must reach the later source', async t => {
    const source = new PassThrough(), tunnel = new RelayDuplex();
    source.on('error', () => {}); tunnel.on('error', () => {}); tunnel.resume();
    t.after(() => { source.destroy(); tunnel.destroy(); });
    const finished = new Promise(resolve => tunnel.once('finish', resolve));
    tunnel.end(); tunnel.attach(source); await bounded(finished);
    assert.equal(source.writableEnded, true);
  });
}
