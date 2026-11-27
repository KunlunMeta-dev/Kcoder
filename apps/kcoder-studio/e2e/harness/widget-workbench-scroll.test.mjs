import assert from 'node:assert/strict';
import test from 'node:test';
import { delayWidgetContentReplies } from './widget-workbench-scroll.mjs';

test('owned artifact latency preserves real replies and cleanup rejects late responses', async () => {
  const cleanup = [];
  const sent = [], forwarded = [];
  let inbound, outbound;
  const upstream = { onMessage: callback => { outbound = callback; }, send: raw => forwarded.push(raw) };
  const socket = { connectToServer: () => upstream, onMessage: callback => { inbound = callback; }, send: raw => sent.push(raw) };
  const page = { routeWebSocket: async (_pattern, callback) => callback(socket) };
  const state = await delayWidgetContentReplies({ addCleanup: (_label, callback) => cleanup.push(callback) }, page, 5);
  const request = JSON.stringify({ id: 1, method: 'widget/content/read' });
  const reply = JSON.stringify({ id: 1, result: { offset: 0, dataBase64: 'YWJj' } });
  inbound(request); outbound(reply);
  assert.deepEqual(forwarded, [request]);
  assert.deepEqual(sent, [reply]);
  state.enabled = true;
  inbound(JSON.stringify({ id: 2, method: 'widget/content/read' }));
  outbound(JSON.stringify({ id: 2, result: { offset: 0 } }));
  assert.equal(state.delayed, 1);
  cleanup.forEach(callback => callback());
  outbound(JSON.stringify({ id: 3, result: {} }));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(sent, [reply]);
  assert.equal(state.closed, true);
});
