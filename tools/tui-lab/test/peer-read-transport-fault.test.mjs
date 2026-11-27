import assert from 'node:assert/strict';
import test from 'node:test';
import { armPeerReadTransportFault } from '../lib/peer-read-transport-fault.mjs';

test('forwards the selected original read and drops only its actual reply', async () => {
  let route, browserMessage, serverMessage;
  const toServer = [], toBrowser = [], closes = [];
  const server = { onMessage: callback => { serverMessage = callback; }, send: message => toServer.push(message),
    close: options => closes.push({ side: 'server', ...options }) };
  const browser = { connectToServer: () => server, onMessage: callback => { browserMessage = callback; },
    send: message => toBrowser.push(message), close: options => closes.push({ side: 'browser', ...options }) };
  const page = { routeWebSocket: async (match, handler) => { route = { match, handler }; } };
  const observation = await armPeerReadTransportFault(page, 'original-thread');
  assert.equal(route.match(new URL('ws://127.0.0.1/rpc')), true);
  route.handler(browser);
  const unrelated = JSON.stringify({ id: 1, method: 'thread/read', params: { threadId: 'other-thread' } });
  browserMessage(unrelated);
  const unrelatedReply = JSON.stringify({ id: 1, result: { messages: [] } });
  serverMessage(unrelatedReply);
  assert.equal(observation(), null);
  assert.deepEqual(toServer, [unrelated]);
  assert.deepEqual(toBrowser, [unrelatedReply]);
  const selected = JSON.stringify({ id: 2, method: 'thread/read/indexed', params: { threadId: 'original-thread',
    expectedSessionAddress: { targetId: 'original-target', workspaceId: 'original-workspace', threadId: 'original-thread' } } });
  browserMessage(selected);
  assert.equal(toServer.at(-1), selected);
  assert.equal(observation().originalReplyObserved, false);
  assert.equal(closes.length, 0);
  serverMessage(JSON.stringify({ method: 'thread/changed', params: { threadId: 'original-thread' } }));
  assert.equal(closes.length, 0);
  serverMessage(JSON.stringify({ id: 2, result: { messages: [{ role: 'assistant', content: 'Native history' }] } }));
  assert.deepEqual(closes.map(close => close.side), ['browser', 'server']);
  assert.equal(toBrowser.some(message => JSON.parse(message).id === 2), false);
  assert.deepEqual(observation(), { method: 'thread/read/indexed', threadId: 'original-thread',
    requestForwardedUnchanged: true, outcome: 'read_response_unconfirmed', noSyntheticNativeReply: true,
    originalReplyObserved: true, replyDropped: true, originalReplyHadError: false });
});
