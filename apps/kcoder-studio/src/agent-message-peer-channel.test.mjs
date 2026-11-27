import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { acceptWebSocket } from './websocket-frame-codec.js';
import { captureNativeRemoteSourceClient } from './remotes/source-client-owner.mjs';
import { captureAuthenticatedPeerChannel, requireAuthenticatedPeerChannel } from './agent-message-peer-channel.js';
import { AgentMessageRouterError } from './agent-message-router-private.js';

// This suite exercises the actual owned TCP/WebSocket channel and captured
// owner lifecycle. HTTP login/Native signatures have separate integration tests.
async function fixture(t, handleRequest = request => ({ accepted: request.method })) {
  const target = { id: 'native-catalog-alias', runtime: 'kcoder', transport: 'local' };
  const client = { initialized: true, authorizationOwner: 'owned-device-family' };
  const broker = { clients: new Set([client]), closed: false };
  const session = { allowedServerIds: new Set([target.id]) };
  let current = true, channel;
  const owner = captureNativeRemoteSourceClient({ client, broker, sourceTarget: target,
    authorizationOwner: client.authorizationOwner, session, verifySession: () => current,
    getTarget: id => id === target.id ? target : undefined, targetSignature: JSON.stringify,
    accountIdentity: () => null, accountGeneration: () => 1 });
  const server = createServer();
  const requests = [], frames = [];
  server.on('upgrade', (request, socket, initialData) => {
    assert.equal(acceptWebSocket(request, socket), true);
    channel = captureAuthenticatedPeerChannel({ socket, initialData, nativeRemoteSourceOwner: owner,
      maxMessageBytes: 4096, onRequest: async request => { requests.push(request); return handleRequest(request); } });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`, 'kcoder-studio');
  ws.on('message', text => frames.push(JSON.parse(text.toString())));
  ws.on('error', () => {});
  await once(ws, 'open');
  t.after(async () => { channel?.close(); ws.terminate(); await new Promise(resolve => server.close(resolve)); });
  const until = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate()) { assert.ok(Date.now() < deadline, 'owned channel deadline'); await new Promise(resolve => setTimeout(resolve, 5)); }
  };
  return { channel, ws, owner, requests, frames, until, revoke() { current = false; } };
}

test('only the captured channel brand is accepted and real masked frames reach the owner', async t => {
  const f = await fixture(t);
  assert.equal(requireAuthenticatedPeerChannel(f.channel), f.channel);
  assert.throws(() => requireAuthenticatedPeerChannel({ ...f.channel }));
  assert.equal(f.channel.hasManagementOwner(f.owner), true);
  assert.equal(f.channel.hasManagementOwner({ ...f.owner }), false);
  f.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'first', method: 'agentPeer/targets', params: {} }));
  await f.until(() => f.frames.length === 1);
  assert.deepEqual(f.frames[0], { jsonrpc: '2.0', id: 'first', result: { accepted: 'agentPeer/targets' } });
  assert.equal(f.requests.length, 1);
});

test('presence is a lease hint, foreign replies do not resolve the original request, and revoke clears the hint', async t => {
  const f = await fixture(t);
  const pending = f.channel.request('agentPeer/sourcePresence', { nonce: 'owned-nonce' });
  await f.until(() => f.frames.length === 1);
  const request = f.frames[0];
  f.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'other-operation', result: { presence: { claims: { leaseId: 'forged' } } } }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.channel.currentLease(), null);
  const result = { presence: { claims: { leaseId: 'actual-bound-lease' } } };
  f.ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  assert.deepEqual((await pending).result, result);
  assert.equal(f.channel.currentLease(), 'actual-bound-lease');
  f.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'agentPeer/sourceRevoked', params: { leaseId: 'old-lease' } }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.channel.currentLease(), 'actual-bound-lease');
  f.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'agentPeer/sourceRevoked', params: { leaseId: 'actual-bound-lease' } }));
  await f.until(() => f.channel.currentLease() === null);
});

test('disconnect rejects outstanding side effects once and never resends them', async t => {
  const f = await fixture(t);
  const pending = f.channel.request('agentPeer/nativeRequest', { request: 'owned-operation' });
  const rejected = assert.rejects(pending, /CHANNEL_CLOSED/);
  await f.until(() => f.frames.length === 1);
  f.ws.close();
  await rejected;
  assert.equal(f.frames.length, 1);
  assert.throws(() => f.channel.request('agentPeer/nativeRequest', {}), /CHANNEL_CLOSED/);
});

test('only a discovery request exposes a recognized cursor error to the TUI', async t => {
  const f = await fixture(t, () => { throw new AgentMessageRouterError('AGENT_MESSAGES_CURSOR_INVALID', -32602); });
  for (const method of ['agentPeer/targets', 'agentPeer/send']) {
    f.ws.send(JSON.stringify({ jsonrpc: '2.0', id: method, method, params: {} }));
  }
  await f.until(() => f.frames.length === 2);
  const byId = Object.fromEntries(f.frames.map(frame => [frame.id, frame.error]));
  assert.deepEqual(byId['agentPeer/targets'], { code: -32602, message: 'AGENT_MESSAGES_CURSOR_INVALID', data: { reason: 'cursor_invalid' } });
  assert.deepEqual(byId['agentPeer/send'], { code: -32034, message: 'AGENT_MESSAGES_DEVICE_REQUEST_UNCONFIRMED' });
});

test('current account revocation fails before any Native handler effects', async t => {
  const f = await fixture(t);
  f.revoke();
  assert.throws(() => f.channel.verify());
  assert.throws(() => f.channel.request('agentPeer/nativeRequest', {}));
  f.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'revoked', method: 'agentPeer/send', params: {} }));
  await f.until(() => f.ws.readyState === WebSocket.CLOSED);
  assert.equal(f.requests.length, 0);
});

test('a no-ID mutation is rejected on a currently authorized channel', async t => {
  const f = await fixture(t);
  f.ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, method: 'agentPeer/send', params: {} }));
  await f.until(() => f.ws.readyState === WebSocket.CLOSED);
  assert.equal(f.requests.length, 0);
});

test('outgoing-list WebSocket failures retain only closed read reasons while send/get errors remain opaque', async t => {
  const f = await fixture(t, () => {
    const error = new AgentMessageRouterError('UNREVIEWED_PRIVATE_MESSAGE', -32602);
    error.data = { reason: 'cursor_filter_mismatch', apiKey: 'fixture-never-expose' };
    throw error;
  });
  for (const method of ['agentPeer/listReceipts', 'agentPeer/send', 'agentPeer/get'])
    f.ws.send(JSON.stringify({ jsonrpc: '2.0', id: method, method, params: {} }));
  await f.until(() => f.frames.length === 3);
  const byId = Object.fromEntries(f.frames.map(frame => [frame.id, frame.error]));
  assert.deepEqual(byId['agentPeer/listReceipts'], { code: -32602, message: 'AGENT_MESSAGES_CURSOR_FILTER_MISMATCH', data: { reason: 'cursor_filter_mismatch' } });
  for (const method of ['agentPeer/send', 'agentPeer/get']) assert.deepEqual(byId[method], { code: -32034, message: 'AGENT_MESSAGES_DEVICE_REQUEST_UNCONFIRMED' });
});

test('a paired send keeps only the closed reply update-required rejection and never strips the reply association', async t => {
  const f = await fixture(t, request => {
    assert.equal(request.params.replyToMessageId, 'received-original');
    throw new AgentMessageRouterError('AGENT_MESSAGES_REPLIES_UNSUPPORTED', -32601);
  });
  f.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'unsupported-reply', method: 'agentPeer/send', params: { replyToMessageId: 'received-original' } }));
  await f.until(() => f.frames.length === 1);
  assert.deepEqual(f.frames[0].error, { code: -32601, message: 'AGENT_MESSAGES_REPLIES_UNSUPPORTED' });
});
