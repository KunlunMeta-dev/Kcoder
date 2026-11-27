// A fatal regression may terminate this exact owned child, never the test host.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { WebSocketServer } from 'ws';
import { startClient } from '../../src/client.mjs';
import { bounded, wait, secret } from './client-safety-resources.mjs';

const server = createServer(), peers = new WebSocketServer({ server }), sockets = new Set();
const controls = new Map(), observations = new Map(), clients = [];
let localConnections = 0;
const gateway = tcpServer(socket => {
  localConnections++; sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
});
peers.on('connection', (peer, request) => {
  peer.on('error', () => {});
  if (request.url === '/_relay/control') controls.set(request.headers['x-kcoder-device'], peer);
});
server.listen(0, '127.0.0.1'); gateway.listen(0, '127.0.0.1');
await Promise.all([once(server, 'listening'), once(gateway, 'listening')]);
async function until(predicate) {
  await bounded((async () => { while (!predicate()) await wait(5); })());
}
try {
  for (const id of ['shape-owner', 'independent-owner']) {
    const events = []; observations.set(id, events);
    clients.push(startClient({ url: `http://127.0.0.1:${server.address().port}`, allowInsecure: true,
      gateway: `http://127.0.0.1:${gateway.address().port}`, gatewayId: id, secret,
      onDiagnostic: record => events.push(record) }));
  }
  await until(() => controls.size === 2);
  for (const frame of ['null', '[]', '{"type":"open","id":{"toString":null,"valueOf":null}}', '42', '{"type":"future_message"}'])
    controls.get('shape-owner').send(frame);
  for (const id of controls.keys()) controls.get(id).send(JSON.stringify({ type: 'open', id: 'a'.repeat(48) }));
  await until(() => localConnections === 2);
  assert.equal(observations.get('shape-owner').filter(record => record.event === 'open_rejected').length, 5);
  assert.equal(observations.get('shape-owner').filter(record => record.event === 'control_open').length, 1);
  clients[0].close();
  await until(() => observations.get('shape-owner').some(record => record.event === 'local_close'));
  assert.equal(controls.get('independent-owner').readyState, 1);
  controls.get('independent-owner').send(JSON.stringify({ type: 'open', id: 'b'.repeat(48) }));
  await until(() => localConnections === 3);
} finally {
  for (const client of clients) client.close(); for (const peer of peers.clients) peer.terminate();
  for (const socket of sockets) socket.destroy();
  await bounded(Promise.all([new Promise(resolve => peers.close(resolve)), new Promise(resolve => server.close(resolve)),
    new Promise(resolve => gateway.close(resolve))]));
  assert.equal(peers.clients.size, 0); assert.equal(sockets.size, 0);
}
console.log(JSON.stringify({ rejected: 5, localConnections, independentOwnerSurvived: true, ownedPeersClosed: true }));
