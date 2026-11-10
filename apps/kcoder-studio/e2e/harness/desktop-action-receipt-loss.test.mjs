import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DesktopActionReceiptLossClient, reconcileOriginalDesktopAction } from './desktop-action-receipt-loss.mjs';

test('native caller loss withholds only the original successful Click event and closes its owner', () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stdin = new PassThrough();
  const client = new DesktopActionReceiptLossClient('owned', child);
  const frame = { jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread', turnId: 'turn',
    item: { id: 'original-click', type: 'toolCall', name: 'mcp__kcoder_computer_use__Click', status: 'failed' } } };
  client.onLine(JSON.stringify(frame));
  assert.equal(client.notificationHistory.length, 1);
  assert.equal(client.lostAction, null);
  frame.params.item.status = 'completed';
  client.onLine(JSON.stringify(frame));
  assert.equal(client.notificationHistory.length, 1);
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(client.lostAction.toolCallId, 'original-click');
  assert.equal(client.lostAction.callerReceivedActionResult, false);
  assert.equal(client.lostAction.nativeBrokerReplyLost, false);
  client.onLine(JSON.stringify({ method: 'computerUse/stateChanged', params: { state: 'stopped' } }));
  assert.equal(client.notificationHistory.length, 2);
  client.closeReader();
});

test('a historical tool-use ID alone cannot stand in for an authoritative completed action receipt', () => {
  const identity = { threadId: 'original', turnId: 'turn-1', toolCallId: 'click-1', tool: 'mcp__kcoder_computer_use__Click' };
  const block = { type: 'tool', tool_use_id: 'click-1', tool_name: identity.tool, status: 'pending' };
  const history = { thread: { id: identity.threadId }, messages: [{ turnId: identity.turnId, blocks: [block] }] };
  assert.throws(() => reconcileOriginalDesktopAction(history, identity), /authoritative/);
  Object.assign(block, { status: 'done', tool_output: 'actual owned click completed', completed_at: 123 });
  assert.equal(reconcileOriginalDesktopAction(history, identity).status, 'done');
  history.messages[0].turnId = 'other-turn';
  assert.throws(() => reconcileOriginalDesktopAction(history, identity), /authoritative/);
});
