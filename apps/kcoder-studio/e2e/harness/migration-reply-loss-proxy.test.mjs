import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { migrationReplyLossProxy } from './migration-reply-loss-proxy.mjs';

const headers = { 'content-type': 'application/json', authorization: 'Bearer SYNTHETIC_ACCOUNT' };
async function fixture(handler, operation = 'adoption-prepare') {
  const server = createServer(handler), sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const cleanups = [];
  const gateway = { port: server.address().port, baseUrl: `http://127.0.0.1:${server.address().port}` };
  const proxy = await migrationReplyLossProxy({ addCleanup: (_, fn) => cleanups.push(fn), registerPort() {} }, gateway, operation);
  return { server, proxy, async close() {
    for (const cleanup of cleanups.reverse()) await cleanup();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  } };
}

test('reply loss happens only after acceptance and never retries or forwards an unknown lane', async () => {
  let calls = 0;
  const owned = await fixture(async (request, response) => {
    calls++; assert.equal(request.headers.authorization, headers.authorization);
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), '{"id":"stable"}');
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"accepted":true}');
  });
  try {
    const post = () => fetch(`${owned.proxy.baseUrl}/api/migration/source-transfer/adoption-prepare`, { method: 'POST', headers, body: '{"id":"stable"}' });
    await assert.rejects(post()); assert.equal(calls, 1); assert.equal(owned.proxy.dropped(), 1);
    assert.deepEqual(await (await post()).json(), { accepted: true }); assert.equal(calls, 2);
    await assert.rejects(fetch(`${owned.proxy.baseUrl}/unrelated`)); assert.equal(calls, 2);
  } finally { await owned.close(); }
  await assert.rejects(fetch(`${owned.proxy.baseUrl}/api/servers`));
});

test('cleanup aborts the owned pending HTTP request and closes only the owned upgrade peers', async () => {
  let entered;
  const pending = new Promise(resolve => { entered = resolve; });
  const owned = await fixture((_request, _response) => entered());
  const request = fetch(`${owned.proxy.baseUrl}/api/servers`).catch(() => null);
  await pending;
  owned.server.on('upgrade', (_request, socket) => socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
  const socket = connect(new URL(owned.proxy.baseUrl).port, '127.0.0.1');
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write('GET /rpc?target=owned HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  const [response] = await once(socket, 'data'); assert.match(response.toString(), /101 Switching/);
  const closed = once(socket, 'close');
  await owned.close(); await closed;
  assert.equal(await request, null); assert.equal(socket.destroyed, true);
});


test('directory selection acknowledgement loss preserves the exact query and does not replay discovery', async () => {
  const seen = [];
  const owned = await fixture(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    seen.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"selectionId":"fixed"}');
  }, 'directory-select');
  try {
    const body = JSON.stringify({ query: { kind: 'directory_select', params: { selectionId: 'fixed' } } });
    const post = () => fetch(`${owned.proxy.baseUrl}/api/migration/source-session/query`, { method: 'POST', headers, body });
    await assert.rejects(post()); assert.equal(seen.length, 1);
    assert.deepEqual(await (await post()).json(), { selectionId: 'fixed' });
    assert.equal(owned.proxy.dropped(), 1); assert.deepEqual(seen[0], seen[1]);
  } finally { await owned.close(); }
});


test('private prepare reply loss keeps the original complete set and forwards only reviewed private operations', async () => {
  const seen = [];
  const owned = await fixture(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    seen.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"phase":"prepared"}');
  }, 'private-prepare');
  try {
    const body = { requestId:'original-request', offerIds:['first','second'], expectedSequence:9, consent:{apiKeys:true,mcpPrivateFields:true} };
    const post = operation => fetch(`${owned.proxy.baseUrl}/api/migration/source-transfer/private/${operation}`, {method:'POST',headers,body:JSON.stringify(body)});
    await assert.rejects(post('prepare'));
    assert.equal(owned.proxy.dropped(),1); assert.equal(owned.proxy.selectedRequests(),1);
    assert.deepEqual(await (await post('prepare-status')).json(),{phase:'prepared'});
    assert.deepEqual(seen.map(row=>row.body),[body,body]);
    assert.equal(owned.proxy.selectedRequests(),1,'readonly status never replays prepare');
    await assert.rejects(post('unreviewed'));
    assert.equal(seen.length,2);
  } finally { await owned.close(); }
});
