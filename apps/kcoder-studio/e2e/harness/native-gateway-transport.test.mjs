import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { RunContext } from './run-context.mjs';
import { startNativeGatewayTransport } from '../fixtures/android/gateway-transport.mjs';

test('native transport preserves bytes, drops only owned connections and closes its listener', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'native-owned-transport-boundary' });
  const sockets = new Set();
  const target = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('data', data => socket.write(data)); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(done => target.listen(0, '127.0.0.1', done));
  context.registerPort('native-transport-echo', target.address().port);
  context.addCleanup('close owned native echo', async () => { const closed = new Promise(done => target.close(done)); for (const socket of sockets) socket.destroy(); await closed; });
  try {
    const proxy = await startNativeGatewayTransport(context, { port: target.address().port });
    const exchange = async marker => {
      const socket = connect(proxy.port, '127.0.0.1');
      socket.on('error', () => {});
      const data = new Promise((done, reject) => { socket.once('data', done); socket.once('error', reject); });
      await new Promise((done, reject) => { socket.once('connect', done); socket.once('error', reject); });
      socket.write(marker); assert.equal((await data).toString(), marker); return socket;
    };
    const first = await exchange('NATIVE_OWNED_FIRST');
    const closed = new Promise(done => first.once('close', done));
    proxy.setOnline(false); await closed;
    assert.ok(proxy.droppedConnections >= 2);
    const rejected = connect(proxy.port, '127.0.0.1'); rejected.on('error', () => {});
    await new Promise(done => rejected.once('close', done));
    proxy.setOnline(true);
    const recovered = await exchange('NATIVE_OWNED_RECOVERED'); recovered.destroy();
    await context.finish('passed', { bytePreservation: true, actualConnectionLoss: true, recovered: true });
    await new Promise((done, reject) => {
      const probe = connect(proxy.port, '127.0.0.1');
      probe.once('error', done); probe.once('connect', () => { probe.destroy(); reject(Error('owned native listener survived cleanup')); });
    });
  } finally { if (!context.finished) await context.finish('failed', null, Error('owned native transport test failed')); }
});
