import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { createWebSocketFrameCodec } from '../../src/websocket-frame-codec.js';
import { RunContext, waitFor } from './run-context.mjs';
import { startPeerDeviceProxy } from './peer-device-proxy.mjs';

const event = (socket, name) => new Promise((resolve, reject) => {
  socket.addEventListener(name, resolve, { once: true });
  if (name !== 'error') socket.addEventListener('error', reject, { once: true });
});
async function peer(url) {
  const socket = new WebSocket(url); await event(socket, 'open'); return socket;
}
async function echo(socket, text) {
  const received = event(socket, 'message'); socket.send(text); assert.equal((await received).data, text);
}

test('owned network proxy drops only the original Source peer, preserves Receiver and HTTP, and owns cleanup', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'peer-source-only-network-drop', tier: 'model-independent',
    modelPolicy: 'Real loopback HTTP/WebSocket transport only; no Native, login, device grant or model claim.' });
  const token = 'owned-test-token-not-a-product-credential'; context.registerSecret(token);
  const sockets = new Set();
  const server = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer ' + token) { response.writeHead(401).end(); return; }
    request.pipe(response);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket, head) => {
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const { decodeFrames, frame } = createWebSocketFrameCodec({ maxMessageBytes: 65536 });
    let buffered = head;
    const fragments = [];
    socket.on('data', bytes => {
      buffered = Buffer.concat([buffered, bytes]);
      const decoded = decodeFrames(buffered, fragments); buffered = decoded.rest;
      for (const value of decoded.messages) socket.write(frame(value));
      for (const control of decoded.controls) {
        if (control.opcode === 8) socket.end(frame(control.payload, 8));
        else if (control.opcode === 9) socket.write(frame(control.payload, 10));
      }
    });
  });
  context.addCleanup('close owned websocket echo upstream', () => new Promise(resolve => {
    for (const socket of sockets) socket.destroy(); server.close(resolve);
  }));
  let proxy, failure;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context.registerPort('peer-proxy-test-upstream', server.address().port);
    proxy = await startPeerDeviceProxy(context, { baseUrl: `http://127.0.0.1:${server.address().port}` });
    const ws = proxy.baseUrl.replace('http:', 'ws:') + '/rpc?channel=agent-peer&token=' + token;
    const source = await peer(ws);
    assert.throws(() => proxy.closeSourceOnly(), /exactly one Source/);
    await echo(source, 'SOURCE_PRIVATE_BODY');
    const receiver = await peer(ws); await echo(receiver, 'RECEIVER_PRIVATE_BODY');
    await waitFor(() => proxy.snapshot().peerUpgrades === 2, 3000, 'two actual peer upgrades');
    const sourceClosed = event(source, 'close');
    proxy.closeSourceOnly(); await sourceClosed;
    assert.equal(receiver.readyState, WebSocket.OPEN);
    await echo(receiver, 'RECEIVER_STILL_CONNECTED');
    const denied = new WebSocket(ws);
    await event(denied, 'error');
    const http = await fetch(proxy.baseUrl + '/api/owned', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: 'OPAQUE_HTTP_BODY' });
    assert.equal(http.status, 200); assert.equal(await http.text(), 'OPAQUE_HTTP_BODY');
    const value = proxy.snapshot();
    assert.equal(value.sourceDrops, 1); assert.equal(value.sourceConnected, false); assert.equal(value.receiverConnected, true);
    assert.equal(value.peerUpgrades, 2); assert.equal(value.rejectedNewPeerUpgrades, 1);
    const evidence = JSON.stringify(value);
    for (const privateValue of [token, 'SOURCE_PRIVATE_BODY', 'RECEIVER_PRIVATE_BODY', 'OPAQUE_HTTP_BODY', 'token=', '/rpc'])
      assert.equal(evidence.includes(privateValue), false);
    await context.writeArtifactJson('network-assertions.json', { originalReceiverConnected: true, opaqueHttpPreserved: true, ...value });
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', { sourceOnlyTransportFault: !failure }, failure); }
  await new Promise((resolve, reject) => {
    const socket = connect(Number(new URL(proxy.baseUrl).port), '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); reject(new Error('Owned proxy port survived cleanup')); }); socket.once('error', resolve);
  });
});

test('transport fault fixture refuses a non-loopback or non-HTTP upstream before owning resources', async () => {
  for (const baseUrl of ['http://example.invalid:1234', 'https://127.0.0.1:1234'])
    await assert.rejects(startPeerDeviceProxy({ addCleanup() { assert.fail('must not own a listener'); } }, { baseUrl }));
});
